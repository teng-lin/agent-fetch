/**
 * Shared httpcloak client with browser-perfect fingerprints.
 * Used by /fetch endpoint and TLS prefetch.
 */
import httpcloak from 'httpcloak';
import { logger } from '../logger.js';
import { promises as dns } from 'dns';
import { isIP } from 'net';

/** httpcloak cookie shape (not exported by library) */
interface HttpcloakCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: string;
  httpOnly?: boolean;
  secure?: boolean;
}

/** Session metadata for lifecycle management */
interface SessionMetadata {
  promise: Promise<httpcloak.Session>;
  created: number;
  lastAccessed: number;
  requestCount: number;
  inFlightRequests: number;
}

/** Session cache keyed by composite key (preset|proxy) */
const sessionCache = new Map<string, SessionMetadata>();

/** Mutex locks for session creation */
const sessionLocks = new Map<string, Promise<void>>();

/** Configuration constants */
const SESSION_TIMEOUT_SEC = 10; // Reduced from 30s to 10s
const SESSION_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const SESSION_MAX_REQUESTS = 10000; // Recycle after 10K requests
const DEFAULT_REQUEST_TIMEOUT_MS = 20000; // 20 second request timeout
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB
const DNS_TIMEOUT_MS = 5000;
const MAX_SESSIONS = 50;

/** Allowed proxy URL schemes */
const VALID_PROXY_SCHEMES = ['http:', 'https:', 'socks5:', 'socks5h:'];

/**
 * Check if an IP address is private/internal.
 * Prevents SSRF attacks by blocking requests to internal networks.
 */
function isPrivateIP(ip: string): boolean {
  // IPv4 private ranges
  const ipv4Private = [
    /^0\./, // 0.0.0.0/8 - "this network"
    /^127\./, // 127.0.0.0/8 - localhost
    /^10\./, // 10.0.0.0/8 - private
    /^172\.(1[6-9]|2[0-9]|3[01])\./, // 172.16.0.0/12 - private
    /^192\.168\./, // 192.168.0.0/16 - private
    /^169\.254\./, // 169.254.0.0/16 - link-local
  ];

  // IPv6 private ranges
  const ipv6Private = [
    /^::$/, // :: - unspecified address (equivalent to 0.0.0.0)
    /^::1$/, // ::1 - localhost
    /^fe80:/i, // fe80::/10 - link-local
    /^fc00:/i, // fc00::/7 - private
    /^fd00:/i, // fd00::/8 - private
  ];

  // Handle IPv4-mapped IPv6 addresses (::ffff:x.x.x.x)
  if (ip.toLowerCase().startsWith('::ffff:')) {
    const ipv4Part = ip.substring(7);
    return ipv4Private.some((pattern) => pattern.test(ipv4Part));
  }

  const patterns = ip.includes(':') ? ipv6Private : ipv4Private;
  return patterns.some((pattern) => pattern.test(ip));
}

/**
 * Validate URL for SSRF protection.
 * Resolves hostname to IP addresses and checks if any point to internal networks.
 *
 * NOTE: This is a defense-in-depth layer. The app-layer validateUrl middleware
 * is the primary gatekeeper for local URLs (respects allowLocalUrls config).
 * This layer provides additional protection for any code paths that call
 * httpRequest() directly.
 */
export async function validateSSRF(url: string): Promise<string[]> {
  const hostname = new URL(url).hostname;

  // If the hostname is already an IP address, validate it directly.
  // dns.resolve4/resolve6 return empty results for IP literals, which
  // would bypass the private-IP check below.
  if (isIP(hostname)) {
    if (isPrivateIP(hostname)) {
      throw new Error(`SSRF protection: hostname ${hostname} is a private IP`);
    }
    return [hostname];
  }

  try {
    // Resolve hostname to IP addresses (both IPv4 and IPv6 concurrently)
    const [ipv4Result, ipv6Result] = await Promise.allSettled([
      dns.resolve4(hostname),
      dns.resolve6(hostname),
    ]);

    const addresses: string[] = [];
    if (ipv4Result.status === 'fulfilled') {
      addresses.push(...ipv4Result.value);
    }
    if (ipv6Result.status === 'fulfilled') {
      addresses.push(...ipv6Result.value);
    }

    // If no addresses resolved, let the request fail naturally
    if (addresses.length === 0) {
      logger.debug({ hostname }, 'DNS resolution failed for both IPv4 and IPv6');
      return [];
    }

    // Check each resolved IP
    for (const ip of addresses) {
      if (isPrivateIP(ip)) {
        throw new Error(`SSRF protection: hostname ${hostname} resolves to private IP ${ip}`);
      }
    }

    return addresses;
  } catch (error) {
    // Only block if we successfully resolved to a private IP
    if (error instanceof Error && error.message.includes('SSRF protection')) {
      throw error;
    }
    // DNS resolution failures are acceptable (let the request fail naturally)
    return [];
  }
}

/** Run SSRF validation with a timeout to prevent DoS from slow DNS lookups. */
function validateSSRFWithTimeout(url: string): Promise<string[]> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('DNS resolution timed out')), DNS_TIMEOUT_MS)
  );
  return Promise.race([validateSSRF(url), timeout]);
}

/**
 * Validate a proxy URL: must use an allowed scheme and pass SSRF checks.
 */
export async function validateProxyUrl(proxy: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(proxy);
  } catch {
    throw new Error(`Invalid proxy URL: ${redactProxyUrl(proxy)}`);
  }

  if (!VALID_PROXY_SCHEMES.includes(parsed.protocol)) {
    throw new Error(
      `Invalid proxy scheme "${parsed.protocol}" — must be one of: ${VALID_PROXY_SCHEMES.join(', ')}`
    );
  }

  await validateSSRF(proxy);
}

/**
 * Redact credentials from a proxy URL for safe logging.
 */
export function redactProxyUrl(proxy: string): string {
  try {
    const url = new URL(proxy);
    if (url.password) url.password = '***';
    if (url.username) url.username = '***';
    return url.toString();
  } catch {
    return '<invalid-proxy-url>';
  }
}

/**
 * Redact proxy credentials from a composite cache key for safe logging.
 * Cache keys have the format "preset|proxy_url" or "preset|direct".
 */
function redactCacheKey(key: string): string {
  const sep = key.indexOf('|');
  if (sep === -1) return key;

  const preset = key.substring(0, sep);
  const proxy = key.substring(sep + 1);

  return proxy === 'direct' ? key : `${preset}|${redactProxyUrl(proxy)}`;
}

/** Default TLS preset */
const DEFAULT_PRESET = httpcloak.Preset.CHROME_143;

/**
 * Evict the least-recently-used session that has no in-flight requests.
 * Called when the session cache exceeds MAX_SESSIONS.
 */
function evictLruSession(): void {
  let oldestKey: string | undefined;
  let oldestAccessed = Infinity;

  for (const [key, meta] of sessionCache) {
    if (meta.inFlightRequests === 0 && meta.lastAccessed < oldestAccessed) {
      oldestAccessed = meta.lastAccessed;
      oldestKey = key;
    }
  }

  if (oldestKey) {
    const evicted = sessionCache.get(oldestKey)!;
    sessionCache.delete(oldestKey);
    evicted.promise
      .then((session) => session.close())
      .catch((error) => {
        logger.warn(
          { key: redactCacheKey(oldestKey), error: String(error) },
          'Error closing evicted session'
        );
      });
    logger.debug({ key: redactCacheKey(oldestKey) }, 'Evicted LRU session');
  }
}

/**
 * Get or create httpcloak session for a given TLS preset and optional proxy.
 * Sessions are cached and reused across requests with proper concurrency control.
 * Sessions are automatically recycled after 1 hour or 10,000 requests to prevent memory leaks.
 * Cache is capped at MAX_SESSIONS entries with LRU eviction.
 */
export async function getSession(preset?: string, proxy?: string): Promise<httpcloak.Session> {
  const presetValue = preset ?? DEFAULT_PRESET;
  const cacheKey = `${presetValue}|${proxy || 'direct'}`;

  // Check if session needs recycling
  const metadata = sessionCache.get(cacheKey);
  if (metadata) {
    const age = Date.now() - metadata.created;
    const needsRecycling =
      age > SESSION_MAX_AGE_MS || metadata.requestCount >= SESSION_MAX_REQUESTS;

    if (needsRecycling) {
      // Only recycle if no active requests are using this session
      if (metadata.inFlightRequests > 0) {
        logger.debug(
          {
            preset: redactCacheKey(cacheKey),
            age: Math.floor(age / 1000),
            requests: metadata.requestCount,
            inFlight: metadata.inFlightRequests,
          },
          'Session needs recycling but has in-flight requests, deferring'
        );
        // Increment counters atomically and return
        // Recycling will happen on the next getSession() call after in-flight requests complete
        metadata.requestCount++;
        metadata.inFlightRequests++;
        metadata.lastAccessed = Date.now();
        return metadata.promise;
      }

      logger.info(
        {
          preset: redactCacheKey(cacheKey),
          age: Math.floor(age / 1000),
          requests: metadata.requestCount,
        },
        'Recycling aged httpcloak session'
      );

      // Close old session (fire-and-forget to avoid blocking)
      metadata.promise
        .then((session) => session.close())
        .catch((error) => {
          logger.warn(
            { preset: redactCacheKey(cacheKey), error: String(error) },
            'Error closing old session'
          );
        });

      sessionCache.delete(cacheKey);
    } else {
      // Session is healthy, increment counters atomically and return
      metadata.requestCount++;
      metadata.inFlightRequests++;
      metadata.lastAccessed = Date.now();
      return metadata.promise;
    }
  }

  // Acquire mutex lock to prevent race conditions
  const existingLock = sessionLocks.get(cacheKey);
  if (existingLock) {
    // Wait for other thread to finish creating session
    await existingLock;

    // Check if session was created by other thread
    const newMetadata = sessionCache.get(cacheKey);
    if (newMetadata) {
      newMetadata.requestCount++;
      newMetadata.inFlightRequests++;
      newMetadata.lastAccessed = Date.now();
      return newMetadata.promise;
    }
  }

  // Create new lock
  let releaseLock!: () => void;
  const lock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  sessionLocks.set(cacheKey, lock);

  try {
    // LRU eviction: ensure we don't exceed MAX_SESSIONS
    while (sessionCache.size >= MAX_SESSIONS) {
      evictLruSession();
      // If we couldn't evict (all in-flight), allow exceeding temporarily
      if (sessionCache.size >= MAX_SESSIONS) break;
    }

    const logProxy = proxy ? redactProxyUrl(proxy) : undefined;
    logger.debug(
      { preset: redactCacheKey(cacheKey), proxy: logProxy },
      'Creating httpcloak session'
    );

    // Create session synchronously so constructor failures are caught
    // before anything is cached, allowing callers to retry cleanly.
    const session = new httpcloak.Session({
      preset: presetValue,
      timeout: SESSION_TIMEOUT_SEC,
      ...(proxy ? { proxy } : {}),
    });

    const now = Date.now();
    sessionCache.set(cacheKey, {
      promise: Promise.resolve(session),
      created: now,
      lastAccessed: now,
      requestCount: 1,
      inFlightRequests: 1,
    });

    return session;
  } catch (error) {
    // Session constructor failed — no promise was cached, so subsequent
    // callers will retry creation instead of awaiting a rejected promise.
    logger.error(
      { preset: redactCacheKey(cacheKey), error: String(error) },
      'Failed to create httpcloak session'
    );
    throw error;
  } finally {
    // Release lock
    sessionLocks.delete(cacheKey);
    releaseLock();
  }
}

/**
 * Close all httpcloak sessions.
 * Call this on server shutdown.
 */
export async function closeAllSessions(): Promise<void> {
  const metadataList = Array.from(sessionCache.values());
  sessionCache.clear();
  sessionLocks.clear();

  for (const metadata of metadataList) {
    try {
      const session = await metadata.promise;
      session.close();
    } catch (error) {
      logger.warn({ error: String(error) }, 'Error closing httpcloak session');
    }
  }
}

export interface HttpResponse {
  success: boolean;
  statusCode: number;
  html?: string;
  headers: Record<string, string>;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: string;
    httpOnly?: boolean;
    secure?: boolean;
  }>;
  error?: string;
}

/** Check whether a cookies map has at least one entry. */
function hasEntries(obj: Record<string, string> | undefined): obj is Record<string, string> {
  return obj !== undefined && Object.keys(obj).length > 0;
}

/** Dispatch a request using the appropriate HTTP method. */
function dispatchRequest(
  session: httpcloak.Session,
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string>,
  body: Record<string, string> | undefined,
  cookies?: Record<string, string>
): Promise<httpcloak.Response> {
  const opts = {
    headers,
    ...(hasEntries(cookies) ? { cookies } : {}),
    ...(method === 'POST' ? { body } : {}),
  } as httpcloak.RequestOptions;

  return method === 'POST' ? session.post(url, opts) : session.get(url, opts);
}

/** Create a timeout promise that rejects after the specified timeout. */
function createRequestTimeout(
  url: string,
  timeoutMs: number
): { promise: Promise<never>; cancel: () => void } {
  let timeoutId: NodeJS.Timeout;
  const promise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Request timeout after ${timeoutMs}ms for ${url}`)),
      timeoutMs
    );
  });
  return { promise, cancel: () => clearTimeout(timeoutId) };
}

/**
 * Internal HTTP request handler shared by httpRequest() and httpPost().
 * Handles SSRF validation, session management, timeout, response parsing, and size limits.
 */
async function httpRequestInternal(
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string>,
  body: Record<string, string> | undefined,
  preset: string | undefined,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  proxy?: string,
  cookies?: Record<string, string>
): Promise<HttpResponse> {
  let sessionMetadata: SessionMetadata | undefined;
  const cacheKey = `${preset ?? DEFAULT_PRESET}|${proxy || 'direct'}`;

  try {
    // SSRF protection: validate proxy URL
    if (proxy) {
      await validateProxyUrl(proxy);
    }

    // SSRF protection: validate target URL and capture resolved IPs
    const preConnectionIPs = await validateSSRFWithTimeout(url);

    // Get session and atomically increment in-flight counter
    // (getSession() increments both requestCount and inFlightRequests)
    const session = await getSession(preset, proxy);
    sessionMetadata = sessionCache.get(cacheKey);

    // Merge caller headers with cache-busting defaults.
    // Cache-Control: no-cache prevents CDNs from returning 304 Not Modified,
    // which would leave us with an empty body we can't extract content from.
    const mergedHeaders: Record<string, string> = {
      'Cache-Control': 'no-cache',
      ...headers,
    };

    const logProxy = proxy ? redactProxyUrl(proxy) : undefined;
    logger.debug(
      { url, method, headers: mergedHeaders, proxy: logProxy },
      'Making httpcloak request'
    );

    let timeout = createRequestTimeout(url, timeoutMs);

    try {
      let response = await Promise.race([
        dispatchRequest(session, method, url, mergedHeaders, body, cookies),
        timeout.promise,
      ]);

      // HTTP 304 means the server thinks we have cached content, but we don't
      // maintain a cache. Retry once with a fresh session to clear any
      // accumulated state in httpcloak's native layer.
      if (response.statusCode === 304) {
        logger.info({ url }, 'Received 304 Not Modified, retrying with fresh session');
        timeout.cancel();

        const freshSession = new httpcloak.Session({
          preset: preset ?? DEFAULT_PRESET,
          timeout: SESSION_TIMEOUT_SEC,
          ...(proxy ? { proxy } : {}),
        });
        timeout = createRequestTimeout(url, timeoutMs);
        try {
          response = await Promise.race([
            dispatchRequest(freshSession, method, url, mergedHeaders, body, cookies),
            timeout.promise,
          ]);
        } finally {
          freshSession.close();
        }
      }

      // DNS rebinding protection: re-validate SSRF after connection
      // This catches attacks where DNS resolves to a private IP after the initial check.
      // Note: We don't require exact IP match because CDNs (CloudFront, Cloudflare, Akamai)
      // use rotating anycast DNS that returns different IPs on each lookup.
      if (preConnectionIPs.length > 0) {
        await validateSSRFWithTimeout(url);
      }

      // Check Content-Length before downloading body to prevent memory exhaustion
      const contentLength = response.headers?.['content-length'];
      if (contentLength) {
        const size = parseInt(contentLength, 10);
        if (!isNaN(size) && size > MAX_RESPONSE_SIZE) {
          logger.warn(
            { url, contentLength: size, limit: MAX_RESPONSE_SIZE },
            'Content-Length exceeds size limit'
          );
          return {
            success: false,
            statusCode: response.statusCode,
            headers: {},
            cookies: [],
            error: 'response_too_large',
          };
        }
      }

      // Parse cookies from response
      const responseCookies = (response.cookies || []).map((c: HttpcloakCookie) => ({
        name: c.name,
        value: c.value,
        domain: c.domain || new URL(url).hostname,
        path: c.path || '/',
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
      }));

      // Get response body
      // NOTE: httpcloak v1.5.9 sometimes returns text as function, sometimes as property
      const textValue = response.text as string | (() => string);
      const html = typeof textValue === 'function' ? textValue() : textValue;

      // Enforce response size limit (fallback for chunked/compressed responses without Content-Length)
      if (html && html.length > MAX_RESPONSE_SIZE) {
        logger.warn(
          { url, size: html.length, limit: MAX_RESPONSE_SIZE },
          'Response exceeds size limit'
        );
        return {
          success: false,
          statusCode: response.statusCode,
          headers: {},
          cookies: [],
          error: 'response_too_large',
        };
      }

      logger.debug(
        {
          url,
          statusCode: response.statusCode,
          cookieCount: responseCookies.length,
          bodyLength: html?.length || 0,
        },
        'httpcloak request complete'
      );

      return {
        success: response.ok,
        statusCode: response.statusCode,
        html,
        headers: response.headers || {},
        cookies: responseCookies,
      };
    } catch (error) {
      logger.warn({ url, error: String(error) }, 'httpcloak request failed');
      return {
        success: false,
        statusCode: 0,
        headers: {},
        cookies: [],
        error: String(error),
      };
    } finally {
      timeout.cancel();
    }
  } catch (error) {
    // Handle SSRF validation failures and session creation failures
    logger.warn({ url, error: String(error) }, 'httpcloak request failed');
    return {
      success: false,
      statusCode: 0,
      headers: {},
      cookies: [],
      error: String(error),
    };
  } finally {
    // Decrement in-flight counter for safe session recycling
    if (sessionMetadata) {
      sessionMetadata.inFlightRequests--;
    }
  }
}

/**
 * Make HTTP GET request with browser-perfect fingerprint.
 */
export async function httpRequest(
  url: string,
  headers: Record<string, string> = {},
  preset?: string,
  timeoutMs?: number,
  proxy?: string,
  cookies?: Record<string, string>
): Promise<HttpResponse> {
  return httpRequestInternal('GET', url, headers, undefined, preset, timeoutMs, proxy, cookies);
}

/**
 * Make HTTP POST request with browser-perfect fingerprint.
 * Form data is sent as application/x-www-form-urlencoded.
 */
export async function httpPost(
  url: string,
  formData: Record<string, string>,
  headers?: Record<string, string>,
  preset?: string,
  timeoutMs?: number,
  proxy?: string,
  cookies?: Record<string, string>
): Promise<HttpResponse> {
  return httpRequestInternal(
    'POST',
    url,
    {
      ...headers,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    formData,
    preset,
    timeoutMs,
    proxy,
    cookies
  );
}
