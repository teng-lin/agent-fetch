/**
 * Netscape HTTP Cookie File parser and URL-based filter.
 *
 * Parses the standard tab-separated cookie format exported by browsers and curl,
 * then filters cookies by domain, path, secure flag, and expiry for a given URL.
 */
import { readFileSync } from 'fs';

export interface NetscapeCookie {
  domain: string;
  includeSubdomains: boolean;
  path: string;
  secure: boolean;
  expires: number;
  name: string;
  value: string;
}

/**
 * Parse a Netscape HTTP Cookie File into structured cookie entries.
 * Skips comment lines (starting with #), blank lines, and malformed entries.
 */
export function parseNetscapeCookieFile(content: string): NetscapeCookie[] {
  const cookies: NetscapeCookie[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const fields = trimmed.split('\t');
    if (fields.length < 7) continue;

    const expires = parseInt(fields[4], 10);
    if (isNaN(expires)) continue;

    cookies.push({
      domain: fields[0],
      includeSubdomains: fields[1].toUpperCase() === 'TRUE',
      path: fields[2],
      secure: fields[3].toUpperCase() === 'TRUE',
      expires,
      name: fields[5],
      value: fields[6],
    });
  }

  return cookies;
}

/**
 * Filter cookies that apply to a given URL based on domain, path, secure flag, and expiry.
 * Returns a name->value map of matching cookies.
 *
 * Domain matching prevents suffix attacks: `.example.com` must not match `badexample.com`.
 */
export function filterCookiesForUrl(
  cookies: NetscapeCookie[],
  url: string
): Record<string, string> {
  const parsed = new URL(url);
  const hostname = parsed.hostname;
  const path = parsed.pathname;
  const isSecure = parsed.protocol === 'https:';
  const now = Math.floor(Date.now() / 1000);

  const result: Record<string, string> = {};

  for (const cookie of cookies) {
    // Skip expired cookies (0 = session cookie, always valid)
    if (cookie.expires !== 0 && cookie.expires < now) continue;

    // Skip secure cookies on non-HTTPS
    if (cookie.secure && !isSecure) continue;

    // Domain matching
    const domainWithoutDot = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;

    if (cookie.includeSubdomains) {
      // Must match exactly or be a subdomain (with dot boundary)
      if (hostname !== domainWithoutDot && !hostname.endsWith('.' + domainWithoutDot)) continue;
    } else {
      // Exact match only
      if (hostname !== domainWithoutDot) continue;
    }

    // Path matching (prefix)
    if (!path.startsWith(cookie.path)) continue;

    result[cookie.name] = cookie.value;
  }

  return result;
}

/**
 * Resolve cookie file path from explicit option or environment variable.
 * Priority: explicit > AGENT_FETCH_COOKIE_FILE
 */
export function resolveCookieFile(explicit?: string): string | undefined {
  return explicit || process.env.AGENT_FETCH_COOKIE_FILE || undefined;
}

/**
 * Load and parse cookies from a cookie file, filtered for a URL.
 * Returns matching cookies as name->value map, or undefined if no file specified.
 */
export function loadCookiesFromFile(
  cookieFilePath: string | undefined,
  url: string
): Record<string, string> | undefined {
  if (!cookieFilePath) return undefined;

  const content = readFileSync(cookieFilePath, 'utf-8');
  const cookies = parseNetscapeCookieFile(content);
  const filtered = filterCookiesForUrl(cookies, url);

  return Object.keys(filtered).length > 0 ? filtered : undefined;
}
