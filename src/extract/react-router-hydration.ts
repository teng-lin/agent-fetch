/**
 * Extraction strategy for pages that embed a hydration payload via
 * `window.__staticRouterHydrationData = JSON.parse("...")`.
 *
 * The payload is double-escaped JSON containing loaderData whose values
 * often include the full article body as HTML, even when the visible DOM
 * only renders a truncated preview.
 */
import { parseHTML } from 'linkedom';

import { logger } from '../logger.js';
import type { ExtractionResult } from './types.js';
import { GOOD_CONTENT_LENGTH } from './types.js';

const HYDRATION_PATTERN =
  /window\.__staticRouterHydrationData\s*=\s*JSON\.parse\("((?:[^"\\]|\\.)*)"\)/;

/**
 * Parse the double-escaped hydration JSON from raw HTML.
 * Returns the parsed object when it contains loaderData, null otherwise.
 */
export function parseHydrationData(html: string): Record<string, unknown> | null {
  const match = HYDRATION_PATTERN.exec(html);
  if (!match) return null;

  try {
    const unescaped = JSON.parse(`"${match[1]}"`);
    const data = JSON.parse(unescaped);

    if (
      !data ||
      typeof data !== 'object' ||
      !data.loaderData ||
      typeof data.loaderData !== 'object'
    )
      return null;
    return data as Record<string, unknown>;
  } catch (e) {
    logger.debug({ error: String(e) }, 'Failed to parse hydration data');
    return null;
  }
}

const MIN_BODY_LENGTH = 200;
const MAX_WALK_DEPTH = 20;
const HTML_TAG_PATTERN = /<(?:p|div|h[1-6]|ul|ol|li|blockquote|figure|img|a|em|strong)[\s>]/i;

export interface ArticleBody {
  /** The HTML body string */
  body: string;
  /** The parent object containing the body, for metadata extraction */
  parent: Record<string, unknown>;
}

/**
 * Walk an object tree to find the longest HTML string that looks like
 * article content. Returns the string together with its parent object
 * so callers can read sibling metadata fields. Depth-limited to avoid
 * runaway recursion on deeply nested payloads.
 */
export function findArticleBody(loaderData: Record<string, unknown>): ArticleBody | null {
  let best: ArticleBody | null = null;

  function walk(obj: unknown, parent: Record<string, unknown>, depth: number): void {
    if (depth > MAX_WALK_DEPTH) return;
    if (obj === null || obj === undefined) return;

    if (typeof obj === 'string') {
      if (
        obj.length >= MIN_BODY_LENGTH &&
        HTML_TAG_PATTERN.test(obj) &&
        obj.length > (best?.body.length ?? 0)
      ) {
        best = { body: obj, parent };
      }
      return;
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        walk(item, parent, depth + 1);
      }
      return;
    }

    if (typeof obj === 'object') {
      const record = obj as Record<string, unknown>;
      for (const value of Object.values(record)) {
        walk(value, record, depth + 1);
      }
    }
  }

  walk(loaderData, loaderData, 0);
  return best;
}

export interface HydrationMetadata {
  title: string | null;
  byline: string | null;
  excerpt: string | null;
  publishedTime: string | null;
}

/** Safely traverse a chain of object keys and return the leaf value as a string. */
function getString(obj: Record<string, unknown>, ...keys: string[]): string | null {
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && current.length > 0 ? current : null;
}

/** Extract author name(s) from common payload structures. */
function findByline(obj: Record<string, unknown>): string | null {
  if (typeof obj.byline === 'string' && obj.byline.length > 0) return obj.byline;

  const authorSources = [
    obj.authors,
    (obj.participants as Record<string, unknown> | undefined)?.authors,
  ];

  for (const source of authorSources) {
    if (!Array.isArray(source)) continue;
    const names = source
      .map((a: unknown) => {
        if (!a || typeof a !== 'object' || !('name' in a)) return null;
        const name = (a as { name: unknown }).name;
        return typeof name === 'string' && name.length > 0 ? name : null;
      })
      .filter((n): n is string => n !== null);
    if (names.length > 0) return names.join(', ');
  }

  if (typeof obj.author === 'string' && obj.author.length > 0) return obj.author;

  return null;
}

/**
 * Extract metadata from the parent object that contains the article body.
 * Probes common field names for title, author, excerpt, and publication date,
 * trying nested structures first before falling back to flat fields.
 */
export function extractMetadataFromParent(parent: Record<string, unknown>): HydrationMetadata {
  const title =
    getString(parent, 'headlines', 'headline') ??
    getString(parent, 'headline') ??
    getString(parent, 'title') ??
    getString(parent, 'name');

  const byline = findByline(parent);

  const excerpt =
    getString(parent, 'about') ??
    getString(parent, 'description') ??
    getString(parent, 'excerpt') ??
    getString(parent, 'summary');

  const publishedTime =
    getString(parent, 'dates', 'firstPublished') ??
    getString(parent, 'dates', 'published') ??
    getString(parent, 'datePublished') ??
    getString(parent, 'publishedAt') ??
    getString(parent, 'publishedTime');

  return { title, byline, excerpt, publishedTime };
}

const DANGEROUS_SELECTORS = ['script', 'style', 'iframe'];

/** Remove script, style, and iframe elements from an HTML fragment. */
function sanitizeHtml(html: string): string {
  const { document } = parseHTML(`<div>${html}</div>`);
  for (const selector of DANGEROUS_SELECTORS) {
    for (const el of document.querySelectorAll(selector)) {
      el.remove();
    }
  }
  return document.querySelector('div')?.innerHTML?.trim() ?? '';
}

function htmlToText(html: string): string {
  const { document } = parseHTML(`<div>${html}</div>`);
  return document.querySelector('div')?.textContent?.trim() ?? '';
}

/**
 * Attempt to extract article content from the hydration payload embedded in
 * the page HTML. Returns an ExtractionResult when content that meets the
 * GOOD_CONTENT_LENGTH threshold is found, null otherwise.
 *
 * The `markdown` field is intentionally left unset; the caller handles
 * markdown conversion to avoid redundant work.
 */
export function tryReactRouterHydrationExtraction(
  html: string,
  url: string,
  document: Document
): ExtractionResult | null {
  try {
    const data = parseHydrationData(html);
    if (!data) return null;

    const found = findArticleBody(data.loaderData as Record<string, unknown>);
    if (!found) return null;

    const cleanBody = sanitizeHtml(found.body);
    const textContent = htmlToText(cleanBody);
    if (textContent.length < GOOD_CONTENT_LENGTH) return null;

    const hydrationMeta = extractMetadataFromParent(found.parent);

    // Fall back to DOM metadata for fields the hydration payload does not provide
    const title =
      hydrationMeta.title ??
      document.querySelector('meta[property="og:title"]')?.getAttribute('content') ??
      document.querySelector('title')?.textContent?.trim() ??
      null;

    const siteName =
      document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ?? null;

    const publishedTime =
      hydrationMeta.publishedTime ??
      document.querySelector('meta[property="article:published_time"]')?.getAttribute('content') ??
      null;

    logger.debug({ url, textLen: textContent.length }, 'Hydration extraction succeeded');

    return {
      title,
      byline: hydrationMeta.byline,
      content: cleanBody,
      textContent,
      excerpt: hydrationMeta.excerpt,
      siteName,
      publishedTime,
      lang: document.documentElement.lang || null,
      method: 'react-router-hydration',
    };
  } catch (e) {
    logger.debug({ url, error: String(e) }, 'Hydration extraction failed');
    return null;
  }
}
