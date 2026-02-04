/**
 * HTTP fetch logic - fast extraction with proper error handling
 */
import httpcloak from 'httpcloak';
import { httpRequest, httpPost, type HttpResponse } from './http-client.js';
import { quickValidate } from './content-validator.js';
import {
  extractFromHtml,
  detectWpRestApi,
  tryNextDataExtraction,
  extractNextBuildId,
} from '../extract/content-extractors.js';
import {
  getSiteUserAgent,
  getSiteReferer,
  siteUseWpRestApi,
  getSiteWpJsonApiPath,
  siteUseNextData,
} from '../sites/site-config.js';
import {
  detectPrismContentApi,
  buildPrismContentApiUrl,
  parseArcAnsContent,
} from '../extract/prism-content-api.js';
import { detectWpAjaxContent, parseWpAjaxResponse } from '../extract/wp-ajax-content.js';
import { logger } from '../logger.js';
import { htmlToMarkdown } from '../extract/markdown.js';
import type { ExtractionResult } from '../extract/types.js';
import type { FetchResult, ValidationError } from './types.js';
import { parseHTML } from 'linkedom';
import { GOOD_CONTENT_LENGTH } from '../extract/types.js';

// Minimum content length (chars) for successful extraction
const MIN_CONTENT_LENGTH = 100;

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

/** Count whitespace-delimited words in a string. Returns undefined for empty/null input. */
function countWords(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  return text.split(/\s+/).filter(Boolean).length;
}

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
    extractedWordCount: countWords(extracted.textContent),
    ...extras,
  };
}

/** Strip HTML tags and decode entities by parsing a fragment and returning its text content. */
function htmlToText(html: string): string | null {
  const { document } = parseHTML(`<div>${html}</div>`);
  return document.querySelector('div')?.textContent?.trim() ?? null;
}

/**
 * Detect if a WP REST API response is a PMC list (has pmc_list_order in meta).
 * Returns the array of list item IDs if found, null otherwise.
 */
function detectPmcListOrder(post: Record<string, unknown>): number[] | null {
  const meta = post.meta as Record<string, unknown> | undefined;
  const listOrder = meta?.pmc_list_order;

  if (!Array.isArray(listOrder) || listOrder.length === 0) return null;
  if (!listOrder.every((id) => typeof id === 'number')) return null;

  return listOrder as number[];
}

/** Maximum list items to fetch to prevent abuse */
const MAX_LIST_ITEMS = 200;

/** Batch size for WP REST API requests */
const WP_LIST_BATCH_SIZE = 50;

/**
 * Fetch WP list items in batch and concatenate their content.
 * Returns combined HTML content from all list items.
 */
async function fetchPmcListItems(
  origin: string,
  itemIds: number[],
  preset?: string
): Promise<string | null> {
  // Limit items to prevent abuse
  const limitedIds = itemIds.slice(0, MAX_LIST_ITEMS);
  if (itemIds.length > MAX_LIST_ITEMS) {
    logger.debug(
      { itemCount: itemIds.length, limit: MAX_LIST_ITEMS },
      'WP list truncated to maximum items'
    );
  }

  const allContents: string[] = [];

  for (let i = 0; i < limitedIds.length; i += WP_LIST_BATCH_SIZE) {
    const batch = limitedIds.slice(i, i + WP_LIST_BATCH_SIZE);
    const includeParam = batch.join(',');
    const apiUrl = `${origin}/wp-json/wp/v2/pmc_list_item?include=${includeParam}&per_page=${WP_LIST_BATCH_SIZE}`;

    logger.debug({ apiUrl, count: batch.length }, 'Fetching WP list items batch');

    const response = await httpRequest(apiUrl, { Accept: 'application/json' }, preset);
    if (!response.success || !response.html) continue;

    let items: unknown[];
    try {
      const parsed = JSON.parse(response.html);
      if (!Array.isArray(parsed)) continue;
      items = parsed;
    } catch {
      logger.debug({ apiUrl }, 'Failed to parse WP list items response');
      continue;
    }

    // Create a map for ordering
    const itemMap = new Map<number, string>();
    for (const item of items) {
      if (typeof item !== 'object' || !item) continue;
      const id = (item as Record<string, unknown>).id;
      if (typeof id !== 'number') continue;
      const contentHtml = resolveWpField((item as Record<string, unknown>).content);
      if (contentHtml) {
        itemMap.set(id, contentHtml);
      }
    }

    // Add in original order
    for (const id of batch) {
      const content = itemMap.get(id);
      if (content) {
        allContents.push(content);
      }
    }
  }

  if (allContents.length === 0) return null;

  return allContents.join('\n\n');
}

/**
 * Resolve a WP REST API field that may be a plain string (custom endpoints)
 * or an object with a `rendered` property (standard WP).
 */
function resolveWpField(field: unknown): string | undefined {
  if (typeof field === 'string') return field;
  if (typeof field === 'object' && field !== null && 'rendered' in field) {
    const rendered = (field as { rendered: unknown }).rendered;
    if (typeof rendered === 'string') return rendered;
  }
  return undefined;
}

/**
 * Extract the first post object from a WP REST API response.
 *
 * Handles three response shapes:
 * - Standard ?slug= query: [{...}]
 * - Standard /posts/123:   {...}
 * - Custom envelope:       {posts: [{...}]}
 */
function resolveWpPost(raw: unknown): Record<string, unknown> | null {
  if (Array.isArray(raw)) {
    const post = raw[0];
    return typeof post === 'object' && post !== null ? (post as Record<string, unknown>) : null;
  }
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.posts)) {
      const post = obj.posts[0];
      return typeof post === 'object' && post !== null ? (post as Record<string, unknown>) : null;
    }
    return obj;
  }
  return null;
}

/**
 * Check if WP REST API content contains a teaser link added by WordPress
 * when content is split at the <!--more--> tag. WordPress appends a tracking
 * parameter (utm_campaign=api) to the "read more" link in API responses.
 */
function hasWpApiTruncationMarker(html: string): boolean {
  return /href="[^"]*utm_campaign=api/.test(html);
}

/**
 * Try fetching article content from WordPress REST API.
 * Appends ?_embed to the URL to get author data in the response.
 * Detects PMC lists and fetches all list items for complete content.
 * Returns an ExtractionResult if API returns sufficient content, null otherwise.
 */
async function tryWpRestApiExtraction(
  apiUrl: string,
  originalResult: ExtractionResult | null,
  preset?: string
): Promise<ExtractionResult | null> {
  try {
    const embedUrl = apiUrl + (apiUrl.includes('?') ? '&_embed' : '?_embed');
    logger.info({ apiUrl: embedUrl }, 'Trying WordPress REST API extraction');

    const response = await httpRequest(embedUrl, { Accept: 'application/json' }, preset);

    if (!response.success || !response.html) return null;

    const json = resolveWpPost(JSON.parse(response.html));
    if (!json) return null;

    // Check for PMC list structure (has pmc_list_order in meta)
    const pmcListOrder = detectPmcListOrder(json);
    let contentHtml = resolveWpField(json.content) ?? '';
    let method = 'wp-rest-api';

    if (pmcListOrder && pmcListOrder.length > 0) {
      // This is a PMC list - fetch all list items
      const origin = new URL(apiUrl).origin;
      logger.info(
        { apiUrl, itemCount: pmcListOrder.length },
        'Detected PMC list, fetching list items'
      );

      const listItemsHtml = await fetchPmcListItems(origin, pmcListOrder, preset);
      if (listItemsHtml) {
        // Combine intro content with list items, avoiding leading whitespace
        contentHtml = contentHtml ? contentHtml + '\n\n' + listItemsHtml : listItemsHtml;
        method = 'wp-rest-api-pmc-list';
      }
    }

    if (!contentHtml) return null;

    // Reject content that contains a WordPress API teaser link, indicating the
    // full article was not included in the API response.
    if (hasWpApiTruncationMarker(contentHtml)) {
      logger.debug({ apiUrl }, 'WP API returned teaser content, skipping');
      return null;
    }

    const textContent = htmlToText(contentHtml) ?? '';
    if (textContent.length < GOOD_CONTENT_LENGTH) return null;

    const rawTitle = resolveWpField(json.title);
    const title = rawTitle ? (htmlToText(rawTitle) ?? null) : (originalResult?.title ?? null);

    const rawExcerpt = resolveWpField(json.excerpt);
    const excerpt = rawExcerpt ? (htmlToText(rawExcerpt) ?? null) : null;

    const embedded = json._embedded as { author?: { name?: string }[] } | undefined;
    const byline = embedded?.author?.[0]?.name ?? originalResult?.byline ?? null;
    const dateGmt = typeof json.date_gmt === 'string' ? json.date_gmt : null;

    return {
      title,
      byline,
      content: contentHtml,
      textContent,
      excerpt,
      siteName: originalResult?.siteName ?? null,
      publishedTime: dateGmt ?? originalResult?.publishedTime ?? null,
      lang: originalResult?.lang ?? null,
      markdown: htmlToMarkdown(contentHtml),
      method,
    };
  } catch (e) {
    logger.debug({ apiUrl, error: String(e) }, 'WordPress REST API extraction failed');
    return null;
  }
}

/**
 * Enrich a DOM extraction result with structured metadata from a WP REST API response.
 * API metadata (title, byline, date, excerpt) is preferred when available since
 * the REST API provides well-structured fields independent of page layout.
 */
function enrichWpMetadata(
  domResult: ExtractionResult,
  wpResult: ExtractionResult
): ExtractionResult {
  return {
    ...domResult,
    title: wpResult.title ?? domResult.title,
    byline: wpResult.byline ?? domResult.byline,
    excerpt: wpResult.excerpt ?? domResult.excerpt,
    publishedTime: wpResult.publishedTime ?? domResult.publishedTime,
    markdown: wpResult.markdown ?? domResult.markdown,
  };
}

/**
 * Extract the last non-empty path segment from a URL to use as a post slug.
 */
function extractSlugFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split('/').filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : null;
  } catch {
    return null;
  }
}

/**
 * Resolve WP REST API URL using auto-detection from HTML, then config-driven construction.
 * Returns the API endpoint URL or null if no WP API is available.
 *
 * Order of operations:
 * 1. Auto-detect WP API URL from HTML (<link rel="alternate" type="application/json">)
 * 2. If not found + site has wpJsonApiPath -> construct custom API URL from slug
 * 3. If not found + site has useWpRestApi -> construct standard API URL from slug
 */
function resolveWpApiUrl(html: string, url: string): string | null {
  // 1. Auto-detect from HTML
  const detected = detectWpRestApi(parseHTML(html).document, url);
  if (detected) return detected;

  // 2. Config-driven: custom API path
  const customPath = getSiteWpJsonApiPath(url);
  if (customPath) {
    const slug = extractSlugFromUrl(url);
    if (slug) return `${new URL(url).origin}${customPath}${encodeURIComponent(slug)}`;
  }

  // 3. Config-driven: standard WP REST API
  if (siteUseWpRestApi(url)) {
    const slug = extractSlugFromUrl(url);
    if (slug) return `${new URL(url).origin}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}`;
  }

  return null;
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
  preset: string | undefined
): Promise<FetchResult | null> {
  const wpApiUrl = resolveWpApiUrl(html, url);
  if (!wpApiUrl) return null;

  const result = await tryWpRestApiExtraction(wpApiUrl, extracted, preset);
  if (!result) return null;

  logger.info({ url, apiUrl: wpApiUrl }, 'Recovered content from WP REST API');
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
  response: { statusCode: number; html?: string }
): FetchResult | null {
  if (!siteUseNextData(url)) return null;

  try {
    const { document } = parseHTML(html);
    const result = tryNextDataExtraction(document, url);
    if (!result || !result.textContent || result.textContent.length < MIN_CONTENT_LENGTH)
      return null;

    logger.info({ url, method: 'next-data' }, 'Recovered content from Next.js data');
    return successResult(url, startTime, result, {
      statusCode: response.statusCode,
      rawHtml: process.env.RECORD_HTML === 'true' ? (response.html ?? null) : null,
      extractionMethod: 'next-data',
    });
  } catch (e) {
    logger.debug({ url, error: String(e) }, 'Next.js data fallback failed');
    return null;
  }
}

/**
 * Construct the Next.js data route URL from a buildId and page URL.
 * Example: buildId="abc", url="https://example.com/section/slug"
 *   => "https://example.com/_next/data/abc/section/slug.json"
 */
function buildNextDataRouteUrl(url: string, buildId: string): string {
  const parsed = new URL(url);
  const pathname = parsed.pathname.replace(/\/$/, '') || '/index';
  return `${parsed.origin}/_next/data/${buildId}${pathname}.json`;
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
  preset: string | undefined
): Promise<FetchResult | null> {
  const { document } = parseHTML(html);
  const buildId = extractNextBuildId(document);
  if (!buildId) return null;

  const dataRouteUrl = buildNextDataRouteUrl(url, buildId);

  try {
    logger.debug({ url, dataRouteUrl }, 'Trying Next.js data route');

    const dataResponse = await httpRequest(dataRouteUrl, { Accept: 'application/json' }, preset);
    if (!dataResponse.success || !dataResponse.html) return null;

    const json = JSON.parse(dataResponse.html);
    const pageProps = json.pageProps;
    if (!pageProps) return null;

    // Build a synthetic __NEXT_DATA__ document so tryNextDataExtraction can process it
    const syntheticData = JSON.stringify({ buildId, props: { pageProps } }).replace(
      /</g,
      '\\u003c'
    );
    const syntheticHtml = `<html><head><script id="__NEXT_DATA__" type="application/json">${syntheticData}</script></head><body></body></html>`;
    const { document: syntheticDoc } = parseHTML(syntheticHtml);

    const result = tryNextDataExtraction(syntheticDoc, url);
    if (!result || !result.textContent) return null;

    // Only use data route result if it has more content than DOM extraction
    const domLen = domExtracted?.textContent?.length ?? 0;
    if (result.textContent.length <= domLen) return null;

    logger.info(
      { url, dataRouteUrl, dataLen: result.textContent.length, domLen },
      'Next.js data route returned more content'
    );

    return successResult(url, startTime, result, {
      statusCode: response.statusCode,
      rawHtml: process.env.RECORD_HTML === 'true' ? (response.html ?? null) : null,
      extractionMethod: 'next-data-route',
    });
  } catch (e) {
    logger.debug({ url, dataRouteUrl, error: String(e) }, 'Next.js data route failed');
    return null;
  }
}

/**
 * Try fetching article content from a Prism content API endpoint.
 * Returns an ExtractionResult if API returns sufficient content, null otherwise.
 */
async function tryPrismContentApiExtraction(
  apiUrl: string,
  preset?: string
): Promise<ExtractionResult | null> {
  try {
    logger.info({ apiUrl }, 'Trying Prism content API extraction');

    const response = await httpRequest(apiUrl, { Accept: 'application/json' }, preset);
    if (!response.success || !response.html) return null;

    return parseArcAnsContent(JSON.parse(response.html));
  } catch (e) {
    logger.debug({ apiUrl, error: String(e) }, 'Prism content API extraction failed');
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
  preset: string | undefined
): Promise<FetchResult | null> {
  const config = detectPrismContentApi(html);
  if (!config) return null;

  const apiUrl = buildPrismContentApiUrl(config, url);
  logger.debug({ url, apiUrl }, 'Detected Prism content API, trying extraction');

  const result = await tryPrismContentApiExtraction(apiUrl, preset);
  if (!result) return null;

  logger.info({ url, apiUrl }, 'Recovered content from Prism content API');
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
  preset: string | undefined
): Promise<FetchResult | null> {
  const config = detectWpAjaxContent(html, url);
  if (!config) return null;

  logger.debug(
    { url, ajaxUrl: config.ajaxUrl, action: config.action },
    'Detected WP AJAX content pattern, trying extraction'
  );

  try {
    const ajaxResponse = await httpPost(
      config.ajaxUrl,
      { action: config.action, 'data[id]': config.articleId },
      undefined,
      preset
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

    logger.info({ url, ajaxUrl: config.ajaxUrl }, 'Recovered content from WP AJAX endpoint');
    return successResult(url, startTime, result, {
      statusCode: response.statusCode,
      rawHtml: process.env.RECORD_HTML === 'true' ? (response.html ?? null) : null,
      extractionMethod: 'wp-ajax-content',
    });
  } catch (e) {
    logger.debug({ url, error: String(e) }, 'WP AJAX content fallback failed');
    return null;
  }
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
export interface HttpFetchOptions {
  /**
   * HTTP Cloak TLS preset (e.g. 'chrome-143', 'android-chrome-143', 'ios-safari-18')
   * If not provided, automatically resolved from User-Agent or defaults to Chrome.
   */
  preset?: string;
}

export async function httpFetch(url: string, options: HttpFetchOptions = {}): Promise<FetchResult> {
  const startTime = Date.now();

  // Use provided preset or resolve from UA
  const preset = options.preset ?? resolvePreset(getSiteUserAgent(url));

  try {
    // Optimization: Try WP REST API first for configured sites (skip HTML fetch)
    // This avoids the overhead of fetching HTML when we know the site has WP API
    if (siteUseWpRestApi(url)) {
      const slug = extractSlugFromUrl(url);
      if (slug) {
        const wpApiUrl = `${new URL(url).origin}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}`;

        logger.info({ url, wpApiUrl }, 'Trying WP REST API (config-driven, skipping HTML)');

        try {
          const wpResult = await tryWpRestApiExtraction(wpApiUrl, null, preset);
          if (wpResult) {
            logger.info({ url, wpApiUrl }, 'Extracted content from WP REST API (fast path)');
            return successResult(url, startTime, wpResult, {
              statusCode: 200,
              rawHtml: null,
              extractionMethod: 'wp-rest-api',
            });
          }
        } catch (e) {
          logger.debug({ url, error: String(e) }, 'WP REST API fast path failed');
        }

        logger.debug(
          { url },
          'WP REST API fast path returned no content, falling back to HTML fetch'
        );
      }
    }

    logger.info({ url }, 'HTTP fetch starting');

    let response: HttpResponse;
    let attempt = 0;

    while (true) {
      response = await httpRequest(url, buildSiteHeaders(url), preset);

      if (!isRetryableError(response) || attempt >= MAX_RETRIES) break;

      attempt++;
      const delay = retryDelay(attempt - 1);
      logger.info({ url, attempt, delay }, 'Retrying after network error');
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
          error: response.error || 'http_error',
          errorDetails: { statusCode: response.statusCode },
          suggestedAction: response.statusCode === 403 ? 'retry_with_extract' : 'skip',
          hint: response.statusCode === 403 ? 'Site may require browser rendering' : undefined,
        },
        response.statusCode
      );
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
        const nextDataFallback = tryNextDataFallback(response.html, url, startTime, response);
        if (nextDataFallback) return nextDataFallback;

        const wpFallback = await tryWpRestApiFallback(
          response.html,
          url,
          startTime,
          response,
          null,
          preset
        );
        if (wpFallback) return wpFallback;

        const prismFallback = await tryPrismContentApiFallback(
          response.html,
          url,
          startTime,
          response,
          preset
        );
        if (prismFallback) return prismFallback;

        const wpAjaxFallback = await tryWpAjaxContentFallback(
          response.html,
          url,
          startTime,
          response,
          null,
          preset
        );
        if (wpAjaxFallback) return wpAjaxFallback;
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

    // Try WP REST API first if available - structured data is more reliable than DOM extraction
    const wpApiUrl = resolveWpApiUrl(response.html, url);
    if (wpApiUrl) {
      const wpResult = await tryWpRestApiExtraction(wpApiUrl, null, preset);
      if (wpResult) {
        // Compare against DOM extraction to detect silently truncated API responses.
        // Some WordPress sites serve only a teaser via their REST API while the
        // full article is present in the rendered HTML.
        const domResult = extractFromHtml(response.html, url);
        const wpLen = wpResult.textContent?.length ?? 0;
        const domLen = domResult?.textContent?.length ?? 0;

        if (
          domResult &&
          domLen > wpLen * WP_DOM_COMPARATOR_RATIO &&
          domLen >= GOOD_CONTENT_LENGTH
        ) {
          logger.info(
            { url, apiUrl: wpApiUrl, wpApiLen: wpLen, domLen },
            'DOM extraction found more content than WP API, enriching with API metadata'
          );
          return successResult(url, startTime, enrichWpMetadata(domResult, wpResult), {
            statusCode: response.statusCode,
            rawHtml: process.env.RECORD_HTML === 'true' ? response.html : null,
            extractionMethod: domResult.method ?? null,
          });
        }

        logger.info({ url, apiUrl: wpApiUrl }, 'Extracted content from WP REST API');
        return successResult(url, startTime, wpResult, {
          statusCode: response.statusCode,
          rawHtml: process.env.RECORD_HTML === 'true' ? response.html : null,
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
      preset
    );
    if (prismResult) return prismResult;

    // Extract content using DOM-based strategies
    const extracted = extractFromHtml(response.html, url);

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
    if (!extracted.textContent || extracted.textContent.trim().length < MIN_CONTENT_LENGTH) {
      // Try WP AJAX fallback before giving up
      const wpAjaxResult = await tryWpAjaxContentFallback(
        response.html,
        url,
        startTime,
        response,
        extracted,
        preset
      );
      if (wpAjaxResult) return wpAjaxResult;

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
        preset
      );
      if (dataRouteResult) return dataRouteResult;
    }

    const latencyMs = Date.now() - startTime;
    logger.info({ url, latencyMs }, 'HTTP fetch succeeded');

    return successResult(url, startTime, extracted, {
      latencyMs,
      statusCode: response.statusCode,
      rawHtml: process.env.RECORD_HTML === 'true' ? response.html : null,
      extractionMethod: extracted.method ?? null,
    });
  } catch (error) {
    logger.error({ url, error: String(error) }, 'HTTP fetch failed');

    return failResult(url, startTime, {
      error: 'network_error',
      errorDetails: { type: String(error) },
      suggestedAction: 'retry_with_extract',
      hint: 'Network request failed',
    });
  }
}
