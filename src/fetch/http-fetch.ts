/**
 * HTTP fetch logic - fast extraction with proper error handling
 */
import { randomUUID } from 'node:crypto';
import httpcloak from 'httpcloak';
import { httpRequest, httpPost, type HttpResponse } from './http-client.js';
import { quickValidate } from './content-validator.js';
import { extractFromHtml, tryNextDataExtraction } from '../extract/content-extractors.js';
import {
  getSiteUserAgent,
  getSiteReferer,
  siteUseWpRestApi,
  siteUseNextData,
  isMobileApiSite,
} from '../sites/site-config.js';
import {
  detectPrismContentApi,
  buildPrismContentApiUrl,
  parseArcAnsContent,
} from '../extract/prism-content-api.js';
import { isPdfUrl, isPdfContentType, extractPdfFromBuffer } from '../extract/pdf-extractor.js';
import { fetchRemotePdfBuffer } from './pdf-fetch.js';
import { countWords } from '../extract/utils.js';
import { detectWpAjaxContent, parseWpAjaxResponse } from '../extract/wp-ajax-content.js';
import { logger } from '../logger.js';
import type { ExtractionResult, SelectorOptions } from '../extract/types.js';
import { GOOD_CONTENT_LENGTH } from '../extract/types.js';
import type { FetchResult, RequestContext, ValidationError } from './types.js';
import { parseHTML } from 'linkedom';
import {
  tryWpRestApiExtraction,
  enrichWpMetadata,
  extractSlugFromUrl,
  resolveWpApiUrl,
} from './wp-rest-api.js';
import { fetchNextDataRoute } from './next-data-route.js';
import { extractFromMobileApi } from '../extract/mobile-extractor.js';
import { resolveCookieFile, loadCookiesFromFile, mergeCookies } from './cookie-file.js';

// Minimum content length (chars) for successful extraction
const MIN_EXTRACTION_LENGTH = 100;

// Retry configuration for transient network errors
const MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 1000;

/**
 * Threshold (chars) below which DOM-extracted content triggers a Next.js data route probe.
 * Higher than GOOD_CONTENT_LENGTH since DOM extraction may capture teasers that pass
 * the minimum threshold but are still far shorter than the full article.
 */
const NEXT_DATA_ROUTE_THRESHOLD = 2000;

/**
 * When DOM extraction yields this many times more content than WP REST API,
 * prefer the DOM content. Catches API responses that return only a teaser.
 */
const WP_DOM_COMPARATOR_RATIO = 2;

/** Logger interface accepted by helper functions. */
type Log = Pick<typeof logger, 'info' | 'debug' | 'warn' | 'error'>;

/** Check if an error is a security error that should not be retried. */
function isSecurityError(error: string | undefined): boolean {
  return error?.includes('SSRF protection') ?? false;
}

const VALIDATION_ERROR_HINTS: Partial<Record<ValidationError, string>> = {
  insufficient_content: 'Content is too short, may be a stub page',
};

/**
 * Select the httpcloak TLS preset that matches a mobile User-Agent string.
 * Returns undefined for desktop UAs (caller uses the default desktop preset).
 */
export function resolvePreset(userAgent: string | null): string | undefined {
  if (!userAgent) return undefined;
  if (/Android/i.test(userAgent) && /Chrome/i.test(userAgent)) {
    return httpcloak.Preset.ANDROID_CHROME_143;
  }
  if (/iPhone/i.test(userAgent) && /CriOS/i.test(userAgent)) {
    return httpcloak.Preset.IOS_CHROME_143;
  }
  if (/iPhone/i.test(userAgent) && /Safari/i.test(userAgent)) {
    return httpcloak.Preset.IOS_SAFARI_18;
  }
  return undefined;
}

/**
 * Resolve proxy URL from explicit option or environment variables.
 * Priority: explicit > AGENT_FETCH_PROXY > HTTPS_PROXY > HTTP_PROXY
 */
export function resolveProxy(explicit?: string): string | undefined {
  return (
    explicit || process.env.AGENT_FETCH_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY
  );
}

/** Build a failure result with common fields pre-filled. */
function failResult(
  url: string,
  startTime: number,
  fields: Omit<FetchResult, 'success' | 'url' | 'latencyMs'>,
  statusCode?: number
): FetchResult {
  return {
    success: false,
    url,
    latencyMs: Date.now() - startTime,
    statusCode: statusCode ?? null,
    rawHtml: null,
    extractionMethod: null,
    ...fields,
  };
}

/** Build a success result from an ExtractionResult, converting nulls to undefined. */
function successResult(
  url: string,
  startTime: number,
  extracted: ExtractionResult,
  extras?: Partial<FetchResult>
): FetchResult {
  return {
    success: true,
    url,
    latencyMs: Date.now() - startTime,
    title: extracted.title ?? undefined,
    byline: extracted.byline ?? undefined,
    content: extracted.content ?? undefined,
    textContent: extracted.textContent ?? undefined,
    excerpt: extracted.excerpt ?? undefined,
    siteName: extracted.siteName ?? undefined,
    publishedTime: extracted.publishedTime ?? undefined,
    lang: extracted.lang ?? undefined,
    markdown: extracted.markdown ?? undefined,
    isAccessibleForFree: extracted.isAccessibleForFree,
    declaredWordCount: extracted.declaredWordCount,
    // countWords returns 0 for empty text; convert to undefined for optional field
    extractedWordCount: countWords(extracted.textContent) || undefined,
    media: extracted.media,
    ...extras,
  };
}

/**
 * Try WP REST API fallback and wrap the result into a FetchResult.
 * Returns a success FetchResult if API returns sufficient content, null otherwise.
 */
async function tryWpRestApiFallback(
  html: string,
  url: string,
  startTime: number,
  response: { statusCode: number; html?: string },
  extracted: ExtractionResult | null,
  ctx: RequestContext,
  log: Log = logger
): Promise<FetchResult | null> {
  const wpApiUrl = resolveWpApiUrl(html, url);
  if (!wpApiUrl) return null;

  const result = await tryWpRestApiExtraction(wpApiUrl, extracted, ctx);
  if (!result) return null;

  log.info({ apiUrl: wpApiUrl }, 'Recovered content from WP REST API');
  return successResult(url, startTime, result, {
    statusCode: response.statusCode,
    rawHtml: process.env.RECORD_HTML === 'true' ? (response.html ?? null) : null,
    extractionMethod: 'wp-rest-api',
  });
}

/**
 * Try Next.js __NEXT_DATA__ extraction for sites configured with useNextData.
 * Returns a success FetchResult if extraction finds sufficient content, null otherwise.
 */
function tryNextDataFallback(
  html: string,
  url: string,
  startTime: number,
  response: { statusCode: number; html?: string },
  log: Log = logger
): FetchResult | null {
  if (!siteUseNextData(url)) return null;

  try {
    const { document } = parseHTML(html);
    const result = tryNextDataExtraction(document, url);
    if (!result || !result.textContent || result.textContent.length < MIN_EXTRACTION_LENGTH)
      return null;

    log.info({ method: 'next-data' }, 'Recovered content from Next.js data');
    return successResult(url, startTime, result, {
      statusCode: response.statusCode,
      rawHtml: process.env.RECORD_HTML === 'true' ? (response.html ?? null) : null,
      extractionMethod: 'next-data',
    });
  } catch (e) {
    log.debug({ err: e }, 'Next.js data fallback failed');
    return null;
  }
}

/**
 * Try fetching full content from the Next.js /_next/data/ route.
 * This route sometimes returns richer content than the SSR HTML.
 * Returns a success FetchResult if the data route yields more content, null otherwise.
 */
async function tryNextDataRoute(
  html: string,
  url: string,
  startTime: number,
  response: { statusCode: number; html?: string },
  domExtracted: ExtractionResult | null,
  ctx: RequestContext,
  log: Log = logger
): Promise<FetchResult | null> {
  const result = await fetchNextDataRoute(html, url, ctx);
  if (!result || !result.textContent) return null;

  // Only use data route result if it has more content than DOM extraction
  const domLen = domExtracted?.textContent?.length ?? 0;
  if (result.textContent.length <= domLen) return null;

  log.info(
    { dataLen: result.textContent.length, domLen },
    'Next.js data route returned more content'
  );

  return successResult(url, startTime, result, {
    statusCode: response.statusCode,
    rawHtml: process.env.RECORD_HTML === 'true' ? (response.html ?? null) : null,
    extractionMethod: 'next-data-route',
  });
}

/**
 * Try fetching article content from a Prism content API endpoint.
 * Returns an ExtractionResult if API returns sufficient content, null otherwise.
 */
async function tryPrismContentApiExtraction(
  apiUrl: string,
  ctx: RequestContext,
  log: Log = logger
): Promise<ExtractionResult | null> {
  try {
    log.info({ apiUrl }, 'Trying Prism content API extraction');

    const response = await httpRequest(
      apiUrl,
      { Accept: 'application/json' },
      ctx.preset,
      ctx.timeout,
      ctx.proxy,
      ctx.cookies
    );
    if (!response.success || !response.html) return null;

    return parseArcAnsContent(JSON.parse(response.html));
  } catch (e) {
    log.debug({ apiUrl, err: e }, 'Prism content API extraction failed');
    return null;
  }
}

/**
 * Try Prism content API fallback and wrap the result into a FetchResult.
 * Auto-detects Prism config from __NEXT_DATA__ and calls the content API.
 * Returns a success FetchResult if API returns sufficient content, null otherwise.
 */
async function tryPrismContentApiFallback(
  html: string,
  url: string,
  startTime: number,
  response: { statusCode: number; html?: string },
  ctx: RequestContext,
  log: Log = logger
): Promise<FetchResult | null> {
  const config = detectPrismContentApi(html);
  if (!config) return null;

  const apiUrl = buildPrismContentApiUrl(config, url);
  if (!apiUrl) return null;
  log.debug({ apiUrl }, 'Detected Prism content API, trying extraction');

  const result = await tryPrismContentApiExtraction(apiUrl, ctx, log);
  if (!result) return null;

  log.info({ apiUrl }, 'Recovered content from Prism content API');
  return successResult(url, startTime, result, {
    statusCode: response.statusCode,
    rawHtml: process.env.RECORD_HTML === 'true' ? (response.html ?? null) : null,
    extractionMethod: 'prism-content-api',
  });
}

/**
 * Try WP AJAX content fallback via admin-ajax.php POST.
 * Detects WP AJAX content patterns and fetches full article content.
 * Enriches result with metadata from DOM extraction when available.
 */
async function tryWpAjaxContentFallback(
  html: string,
  url: string,
  startTime: number,
  response: { statusCode: number; html?: string },
  domExtracted: ExtractionResult | null,
  ctx: RequestContext,
  log: Log = logger
): Promise<FetchResult | null> {
  const config = detectWpAjaxContent(html, url);
  if (!config) return null;

  log.debug(
    { ajaxUrl: config.ajaxUrl, action: config.action },
    'Detected WP AJAX content pattern, trying extraction'
  );

  try {
    const ajaxResponse = await httpPost(
      config.ajaxUrl,
      { action: config.action, 'data[id]': config.articleId },
      undefined,
      ctx.preset,
      ctx.timeout,
      ctx.proxy,
      ctx.cookies
    );

    if (!ajaxResponse.success || !ajaxResponse.html) return null;

    const parsed = parseWpAjaxResponse(ajaxResponse.html, url);
    if (!parsed) return null;

    // Enrich with metadata from DOM extraction (title, byline, Schema.org, etc.)
    const result = domExtracted
      ? {
          ...parsed,
          title: parsed.title ?? domExtracted.title,
          byline: parsed.byline ?? domExtracted.byline,
          excerpt: parsed.excerpt ?? domExtracted.excerpt,
          siteName: parsed.siteName ?? domExtracted.siteName,
          publishedTime: parsed.publishedTime ?? domExtracted.publishedTime,
          lang: parsed.lang ?? domExtracted.lang,
          isAccessibleForFree: parsed.isAccessibleForFree ?? domExtracted.isAccessibleForFree,
          declaredWordCount: parsed.declaredWordCount ?? domExtracted.declaredWordCount,
        }
      : parsed;

    log.info({ ajaxUrl: config.ajaxUrl }, 'Recovered content from WP AJAX endpoint');
    return successResult(url, startTime, result, {
      statusCode: response.statusCode,
      rawHtml: process.env.RECORD_HTML === 'true' ? (response.html ?? null) : null,
      extractionMethod: 'wp-ajax-content',
    });
  } catch (e) {
    log.debug({ err: e }, 'WP AJAX content fallback failed');
    return null;
  }
}

/**
 * Extract page title from HTML <title> tag or og:title meta.
 */
function extractPageTitle(html: string): string | undefined {
  const ogMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (ogMatch) return ogMatch[1];
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return titleMatch?.[1]?.trim() || undefined;
}

/**
 * Extract article ID from <meta name="article.id"> in HTML.
 */
function extractArticleId(html: string): string | null {
  const match = html.match(/<meta[^>]+name=["']article\.id["'][^>]+content=["']([^"']+)["']/i);
  if (match) return match[1];
  // Handle content before name
  const match2 = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']article\.id["']/i);
  return match2?.[1] ?? null;
}

/**
 * Try mobile API extraction and wrap the result into a FetchResult.
 * Returns a success FetchResult if API returns sufficient content, null otherwise.
 */
async function tryMobileApiExtraction(
  html: string,
  url: string,
  startTime: number,
  statusCode: number,
  log: Log = logger
): Promise<FetchResult | null> {
  if (!isMobileApiSite(url)) return null;

  const articleId = extractArticleId(html);
  if (!articleId) {
    log.debug({ url }, 'Mobile API site but no article.id meta tag found');
    return null;
  }

  const result = await extractFromMobileApi(articleId, url);
  if (!result.success || !result.content) return null;

  log.info({ url, articleId, contentLength: result.content.length }, 'Extracted from mobile API');
  return {
    success: true,
    url,
    latencyMs: Date.now() - startTime,
    statusCode,
    title: extractPageTitle(html),
    textContent: result.content,
    extractedWordCount: countWords(result.content) || undefined,
    extractionMethod: 'mobile-api',
    rawHtml: null,
  };
}

/**
 * Build site-specific request headers (User-Agent, Referer) for a URL.
 */
function buildSiteHeaders(url: string): Record<string, string> {
  const headers: Record<string, string> = {};

  const ua = getSiteUserAgent(url);
  if (ua) headers['User-Agent'] = ua;

  const referer = getSiteReferer(url);
  if (referer) headers['Referer'] = referer;

  return headers;
}

/** Check if a failed response is a transient network error worth retrying. */
function isRetryableError(response: HttpResponse): boolean {
  return !response.success && response.statusCode === 0 && !isSecurityError(response.error);
}

/** Exponential backoff delay for a given retry attempt (0-indexed). */
function retryDelay(attempt: number): number {
  return BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
}

/**
 * Options for httpFetch
 */
export interface HttpFetchOptions extends SelectorOptions {
  /**
   * HTTP Cloak TLS preset (e.g. 'chrome-143', 'android-chrome-143', 'ios-safari-18')
   * If not provided, automatically resolved from User-Agent or defaults to Chrome.
   */
  preset?: string;
  /**
   * Request timeout in milliseconds. Default: 20000 (20 seconds)
   */
  timeout?: number;
  /**
   * Include raw HTML in the result. Used by the crawler for link extraction.
   * When false (default), rawHtml is only included if RECORD_HTML env var is set.
   */
  includeRawHtml?: boolean;
  /**
   * HTTP/SOCKS proxy URL. Falls back to AGENT_FETCH_PROXY, HTTPS_PROXY, HTTP_PROXY env vars.
   */
  proxy?: string;
  /**
   * Cookies to send with every request (name -> value).
   */
  cookies?: Record<string, string>;
  /**
   * Path to a Netscape HTTP Cookie File. Falls back to AGENT_FETCH_COOKIE_FILE env var.
   * Cookies are filtered by domain/path/secure for the target URL.
   * Explicit `cookies` take precedence over cookie file entries.
   */
  cookieFile?: string;
}

export async function httpFetch(url: string, options: HttpFetchOptions = {}): Promise<FetchResult> {
  const startTime = Date.now();
  const requestId = randomUUID().slice(0, 8);
  const log: Log = logger.child?.({ requestId, url }) ?? logger;

  // Use provided preset or resolve from UA
  const preset = options.preset ?? resolvePreset(getSiteUserAgent(url));
  const timeout = options.timeout;
  const keepRawHtml = options.includeRawHtml || process.env.RECORD_HTML === 'true';
  const selectorOpts: SelectorOptions | undefined =
    options.targetSelector || options.removeSelector
      ? { targetSelector: options.targetSelector, removeSelector: options.removeSelector }
      : undefined;

  // Resolve proxy from option or env vars
  const proxy = resolveProxy(options.proxy);

  // Resolve cookies: cookie file as base, explicit cookies win on conflict
  const fileCookies = loadCookiesFromFile(resolveCookieFile(options.cookieFile), url);
  const cookies = mergeCookies(fileCookies, options.cookies);
  const ctx: RequestContext = { preset, timeout, proxy, cookies, requestId };

  try {
    // PDF detection: if URL looks like a PDF, fetch as binary and extract
    if (isPdfUrl(url)) {
      log.info('Detected PDF URL, fetching as binary');
      const pdfResult = await fetchRemotePdfBuffer(url, preset, timeout, proxy, cookies);
      if (pdfResult) {
        return extractPdfFromBuffer(pdfResult.buffer, url, pdfResult.statusCode);
      }
      return failResult(url, startTime, {
        error: 'pdf_fetch_failed',
        errorDetails: { type: 'remote_pdf' },
        suggestedAction: 'skip',
        hint: 'Failed to download PDF',
      });
    }

    // Optimization: Try WP REST API first for configured sites (skip HTML fetch)
    // This avoids the overhead of fetching HTML when we know the site has WP API
    if (siteUseWpRestApi(url)) {
      const slug = extractSlugFromUrl(url);
      if (slug) {
        const wpApiUrl = `${new URL(url).origin}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}`;

        log.info({ wpApiUrl }, 'Trying WP REST API (config-driven, skipping HTML)');

        try {
          const wpResult = await tryWpRestApiExtraction(wpApiUrl, null, ctx);
          if (wpResult) {
            log.info({ wpApiUrl }, 'Extracted content from WP REST API (fast path)');
            return successResult(url, startTime, wpResult, {
              statusCode: 200,
              rawHtml: null,
              extractionMethod: 'wp-rest-api',
            });
          }
        } catch (e) {
          log.debug({ err: e }, 'WP REST API fast path failed');
        }

        log.debug('WP REST API fast path returned no content, falling back to HTML fetch');
      }
    }

    log.info('HTTP fetch starting');

    let response: HttpResponse;
    let attempt = 0;

    while (true) {
      response = await httpRequest(url, buildSiteHeaders(url), preset, timeout, proxy, cookies);

      if (!isRetryableError(response) || attempt >= MAX_RETRIES) break;

      attempt++;
      const delay = retryDelay(attempt - 1);
      log.info({ attempt, delay }, 'Retrying after network error');
      await new Promise((r) => setTimeout(r, delay));
    }

    if (!response.success || !response.html) {
      if (response.statusCode === 429) {
        return failResult(
          url,
          startTime,
          {
            error: 'rate_limited',
            errorDetails: { statusCode: response.statusCode },
            suggestedAction: 'wait_and_retry',
            hint: 'Too many requests, wait before retrying',
          },
          response.statusCode
        );
      }

      return failResult(
        url,
        startTime,
        {
          error: response.statusCode === 0 ? 'network_error' : 'http_status_error',
          errorDetails: { statusCode: response.statusCode, type: response.error },
          suggestedAction: response.statusCode === 403 ? 'retry_with_extract' : 'skip',
          hint: response.statusCode === 403 ? 'Site may require browser rendering' : undefined,
        },
        response.statusCode
      );
    }

    // PDF content-type detection: URL may not end in .pdf but response is a PDF.
    // httpcloak returns the body as a latin1 string, so we can convert directly
    // to a Buffer without re-fetching.
    const responseContentType = Array.isArray(response.headers['content-type'])
      ? response.headers['content-type'][0]
      : response.headers['content-type'];
    if (isPdfContentType(responseContentType)) {
      log.info('Detected PDF content-type in response, extracting as PDF');
      const buffer = Buffer.from(response.html, 'latin1');
      return extractPdfFromBuffer(buffer, url, response.statusCode);
    }

    /** Attach raw HTML to a fallback FetchResult when recording is enabled. */
    function attachRawHtml(result: FetchResult): FetchResult {
      if (keepRawHtml) result.rawHtml = response.html;
      return result;
    }

    // Validate content
    const validation = quickValidate(
      response.html,
      response.statusCode,
      response.headers['content-type']
    );

    if (!validation.valid) {
      // Try Next.js data extraction and WP REST API for insufficient content
      if (validation.error === 'insufficient_content') {
        const mobileFallback = await tryMobileApiExtraction(
          response.html,
          url,
          startTime,
          response.statusCode,
          log
        );
        if (mobileFallback) return attachRawHtml(mobileFallback);

        const nextDataFallback = tryNextDataFallback(response.html, url, startTime, response, log);
        if (nextDataFallback) return attachRawHtml(nextDataFallback);

        const wpFallback = await tryWpRestApiFallback(
          response.html,
          url,
          startTime,
          response,
          null,
          ctx,
          log
        );
        if (wpFallback) return attachRawHtml(wpFallback);

        const prismFallback = await tryPrismContentApiFallback(
          response.html,
          url,
          startTime,
          response,
          ctx,
          log
        );
        if (prismFallback) return attachRawHtml(prismFallback);

        const wpAjaxFallback = await tryWpAjaxContentFallback(
          response.html,
          url,
          startTime,
          response,
          null,
          ctx,
          log
        );
        if (wpAjaxFallback) return attachRawHtml(wpAjaxFallback);
      }

      return failResult(
        url,
        startTime,
        {
          error: validation.error,
          errorDetails: validation.errorDetails,
          suggestedAction: 'skip',
          hint: VALIDATION_ERROR_HINTS[validation.error!],
        },
        response.statusCode
      );
    }

    // Try mobile API extraction (highest priority for configured sites)
    const mobileResult = await tryMobileApiExtraction(
      response.html,
      url,
      startTime,
      response.statusCode,
      log
    );
    if (mobileResult) {
      if (keepRawHtml) mobileResult.rawHtml = response.html;
      return mobileResult;
    }

    // Try WP REST API first if available - structured data is more reliable than DOM extraction
    const wpApiUrl = resolveWpApiUrl(response.html, url);
    if (wpApiUrl) {
      const wpResult = await tryWpRestApiExtraction(wpApiUrl, null, ctx);
      if (wpResult) {
        // Compare against DOM extraction to detect silently truncated API responses.
        // Some WordPress sites serve only a teaser via their REST API while the
        // full article is present in the rendered HTML.
        const domResult = extractFromHtml(response.html, url, selectorOpts);
        const wpLen = wpResult.textContent?.length ?? 0;
        const domLen = domResult?.textContent?.length ?? 0;

        if (
          domResult &&
          domLen > wpLen * WP_DOM_COMPARATOR_RATIO &&
          domLen >= GOOD_CONTENT_LENGTH
        ) {
          log.info(
            { apiUrl: wpApiUrl, wpApiLen: wpLen, domLen },
            'DOM extraction found more content than WP API, enriching with API metadata'
          );
          return successResult(url, startTime, enrichWpMetadata(domResult, wpResult), {
            statusCode: response.statusCode,
            rawHtml: keepRawHtml ? response.html : null,
            extractionMethod: domResult.method ?? null,
          });
        }

        log.info({ apiUrl: wpApiUrl }, 'Extracted content from WP REST API');
        return successResult(url, startTime, wpResult, {
          statusCode: response.statusCode,
          rawHtml: keepRawHtml ? response.html : null,
          extractionMethod: 'wp-rest-api',
        });
      }
    }

    // Try Prism content API if available
    const prismResult = await tryPrismContentApiFallback(
      response.html,
      url,
      startTime,
      response,
      ctx,
      log
    );
    if (prismResult) return attachRawHtml(prismResult);

    // Extract content using DOM-based strategies
    const extracted = extractFromHtml(response.html, url, selectorOpts);

    if (!extracted) {
      return failResult(
        url,
        startTime,
        {
          error: 'extraction_failed',
          errorDetails: { type: 'null_result' },
          suggestedAction: 'retry_with_extract',
          hint: 'Failed to parse HTML',
        },
        response.statusCode
      );
    }

    // Handle insufficient extracted content
    if (!extracted.textContent || extracted.textContent.trim().length < MIN_EXTRACTION_LENGTH) {
      // Try WP AJAX fallback before giving up
      const wpAjaxResult = await tryWpAjaxContentFallback(
        response.html,
        url,
        startTime,
        response,
        extracted,
        ctx,
        log
      );
      if (wpAjaxResult) return attachRawHtml(wpAjaxResult);

      const wordCount = extracted.textContent ? extracted.textContent.split(/\s+/).length : 0;
      return failResult(
        url,
        startTime,
        {
          error: 'insufficient_content',
          errorDetails: { wordCount },
          suggestedAction: 'retry_with_extract',
          hint: 'Extracted content too short',
        },
        response.statusCode
      );
    }

    // Try Next.js data route when DOM extraction succeeded but content is short
    if (extracted.textContent && extracted.textContent.length < NEXT_DATA_ROUTE_THRESHOLD) {
      const dataRouteResult = await tryNextDataRoute(
        response.html,
        url,
        startTime,
        response,
        extracted,
        ctx,
        log
      );
      if (dataRouteResult) return attachRawHtml(dataRouteResult);
    }

    const latencyMs = Date.now() - startTime;
    log.info({ latencyMs }, 'HTTP fetch succeeded');

    return successResult(url, startTime, extracted, {
      latencyMs,
      statusCode: response.statusCode,
      rawHtml: keepRawHtml ? response.html : null,
      extractionMethod: extracted.method ?? null,
      selectors: selectorOpts,
    });
  } catch (error) {
    log.error({ err: error }, 'HTTP fetch failed');

    return failResult(url, startTime, {
      error: 'network_error',
      errorDetails: { type: String(error) },
      suggestedAction: 'retry_with_extract',
      hint: 'Network request failed',
    });
  }
}
