/**
 * WordPress REST API extraction helpers.
 *
 * Detects WP REST API endpoints, fetches structured post data, and converts
 * it into ExtractionResult objects. Supports standard WP endpoints, custom
 * API paths, and PMC list articles.
 */
import { httpRequest } from './http-client.js';
import { parseHTML } from 'linkedom';
import { detectWpRestApi } from '../extract/content-extractors.js';
import { getSiteWpJsonApiPath, siteUseWpRestApi } from '../sites/site-config.js';
import { htmlToMarkdown } from '../extract/markdown.js';
import { htmlToText } from '../extract/utils.js';
import type { ExtractionResult } from '../extract/types.js';
import { GOOD_CONTENT_LENGTH } from '../extract/types.js';
import type { RequestContext } from './types.js';
import { logger } from '../logger.js';

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
  ctx: RequestContext
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

    const response = await httpRequest(
      apiUrl,
      { Accept: 'application/json' },
      ctx.preset,
      ctx.timeout,
      ctx.proxy,
      ctx.cookies
    );
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
export async function tryWpRestApiExtraction(
  apiUrl: string,
  originalResult: ExtractionResult | null,
  ctx: RequestContext
): Promise<ExtractionResult | null> {
  try {
    const embedUrl = apiUrl + (apiUrl.includes('?') ? '&_embed' : '?_embed');
    logger.info({ apiUrl: embedUrl }, 'Trying WordPress REST API extraction');

    const response = await httpRequest(
      embedUrl,
      { Accept: 'application/json' },
      ctx.preset,
      ctx.timeout,
      ctx.proxy,
      ctx.cookies
    );

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

      const listItemsHtml = await fetchPmcListItems(origin, pmcListOrder, ctx);
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

    const textContent = htmlToText(contentHtml);
    if (textContent.length < GOOD_CONTENT_LENGTH) return null;

    const rawTitle = resolveWpField(json.title);
    const title = rawTitle ? htmlToText(rawTitle) || null : (originalResult?.title ?? null);

    const rawExcerpt = resolveWpField(json.excerpt);
    const excerpt = rawExcerpt ? htmlToText(rawExcerpt) || null : null;

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
export function enrichWpMetadata(
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
export function extractSlugFromUrl(url: string): string | null {
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
export function resolveWpApiUrl(html: string, url: string): string | null {
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
