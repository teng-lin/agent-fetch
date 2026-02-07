/**
 * DOM-based content extraction strategies
 * These are synchronous functions that extract content from parsed HTML documents
 */
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';

import { extractContent } from '@wrtnlabs/web-content-extractor';
import {
  type ExtractionResult,
  type SelectorOptions,
  MIN_CONTENT_LENGTH,
  GOOD_CONTENT_LENGTH,
  DEFAULT_EXCERPT_LENGTH,
} from './types.js';
import { htmlToMarkdown } from './markdown.js';
import { getNestedValue, meetsThreshold, sanitizeHtml } from './utils.js';
import { sitePreferJsonLd, siteUseNextData, getSiteNextDataPath } from '../sites/site-config.js';
import { tryNuxtPayloadExtraction } from './nuxt-payload.js';
import { tryReactRouterHydrationExtraction } from './react-router-hydration.js';
import { extractMedia } from './media-extractor.js';
import { logger } from '../logger.js';
import { cleanExtractedHtml } from './content-cleanup.js';

// Selectors for finding published time
const PUBLISHED_TIME_SELECTORS = [
  'meta[property="article:published_time"]',
  'meta[name="pubdate"]',
  'meta[name="publishdate"]',
  'meta[name="date"]',
  'time[datetime]',
];

// Selectors for finding article content (from Python implementation)
const CONTENT_SELECTORS = [
  'article',
  'main article',
  '[role="main"] article',
  '.article-content',
  '.article-body',
  '.post-content',
  '.entry-content',
  '.story-body',
  '#article-body',
  '[itemprop="articleBody"]',
  'main',
  '[role="main"]',
];

// Elements to remove before extraction
const REMOVE_SELECTORS = [
  'script',
  'style',
  'nav',
  'aside',
  'footer',
  'header',
  'form',
  'iframe',
  '.advertisement',
  '.ads',
  '.social-share',
  '.related-articles',
  '.comments',
];

/** Minimum length ratio for text-density/RSC to override Readability */
const COMPARATOR_LENGTH_RATIO = 2;

/** Minimum length for RSC text segments to be considered article content */
const RSC_MIN_SEGMENT_LENGTH = 100;

/** JSON-LD article types that contain extractable content */
const ARTICLE_TYPES = [
  'Article',
  'NewsArticle',
  'BlogPosting',
  'WebPage',
  'ReportageNewsArticle',
] as const;

/**
 * Priority order for candidate selection in extractFromHtml.
 * Adding a new strategy = add its result to the results Map + append its name here.
 */
const CANDIDATE_PRIORITY = [
  'readability',
  'next-rsc',
  'nuxt-payload',
  'react-router-hydration',
  'next-data',
  'json-ld',
  'selector',
  'text-density',
] as const;

/** Strategies excluded from the "good candidates" tier (too noisy at threshold). */
const GOOD_CANDIDATES_EXCLUDE = new Set<string>(['selector']);

/**
 * Extract published time from meta tags
 */
export function extractPublishedTime(document: Document): string | null {
  for (const selector of PUBLISHED_TIME_SELECTORS) {
    const el = document.querySelector(selector);
    if (el) {
      const value = el.getAttribute('content') ?? el.getAttribute('datetime');
      if (value) return value;
    }
  }
  return null;
}

/**
 * Extract title from document
 */
export function extractTitle(document: Document): string | null {
  // Try og:title first
  const ogTitle = document.querySelector('meta[property="og:title"]');
  if (ogTitle) {
    const content = ogTitle.getAttribute('content');
    if (content) return content;
  }

  // Try title tag
  const titleEl = document.querySelector('title');
  if (titleEl) {
    let title = titleEl.textContent?.trim() ?? '';
    // Clean up common suffixes (e.g., "Article Title - Site Name")
    title = title.split(/\s*[-|–—]\s*/)[0].trim();
    if (title) return title;
  }

  // Try h1
  const h1 = document.querySelector('h1');
  if (h1) {
    return h1.textContent?.trim() ?? null;
  }

  return null;
}

/**
 * Extract site name from document
 */
export function extractSiteName(document: Document): string | null {
  return document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ?? null;
}

/**
 * Generate excerpt from text content if not already provided
 */
export function generateExcerpt(excerpt: string | null, textContent: string | null): string | null {
  if (excerpt) return excerpt;
  if (!textContent) return null;

  const trimmed = textContent.trim();
  if (!trimmed) return null;

  return trimmed.length > DEFAULT_EXCERPT_LENGTH
    ? trimmed.slice(0, DEFAULT_EXCERPT_LENGTH) + '...'
    : trimmed;
}

/**
 * Build an ExtractionResult from a Readability article and the original document.
 */
function buildReadabilityResult(
  article: ReturnType<Readability<string>['parse']>,
  document: Document,
  method: string
): ExtractionResult | null {
  if (!article?.textContent || article.textContent.length < MIN_CONTENT_LENGTH) {
    return null;
  }

  return {
    title: article.title ?? extractTitle(document),
    byline: article.byline ?? null,
    content: article.content ?? null,
    textContent: article.textContent ?? null,
    excerpt: generateExcerpt(article.excerpt ?? null, article.textContent ?? null),
    siteName: article.siteName ?? extractSiteName(document),
    publishedTime: extractPublishedTime(document) ?? article.publishedTime ?? null,
    lang: article.lang ?? null,
    method,
  };
}

/**
 * Strategy 1: Extract using Mozilla Readability
 * Tries strict mode first, then retries with charThreshold: 100 for unusual DOM structures.
 */
export function tryReadability(document: Document, url: string): ExtractionResult | null {
  try {
    // Strict pass (default charThreshold of 500)
    const clone = document.cloneNode(true) as Document;
    const strictResult = buildReadabilityResult(
      new Readability(clone).parse(),
      document,
      'readability'
    );
    if (strictResult) return strictResult;

    // Relaxed pass — lower charThreshold to catch unusual DOM structures
    const relaxedClone = document.cloneNode(true) as Document;
    const relaxedResult = buildReadabilityResult(
      new Readability(relaxedClone, { charThreshold: 100 }).parse(),
      document,
      'readability-relaxed'
    );
    if (relaxedResult) {
      logger.debug({ url }, 'Readability relaxed pass succeeded');
    }
    return relaxedResult;
  } catch (e) {
    logger.debug({ url, error: String(e) }, 'Readability extraction failed');
    return null;
  }
}

/**
 * Strategy 2: Extract using CSS selectors (like Python implementation)
 */
export function trySelectorExtraction(document: Document, url: string): ExtractionResult | null {
  try {
    for (const selector of CONTENT_SELECTORS) {
      const el = document.querySelector(selector);
      if (!el) continue;

      // Clone and clean the element
      const clone = el.cloneNode(true) as Element;

      // Remove unwanted elements
      for (const removeSelector of REMOVE_SELECTORS) {
        const toRemove = clone.querySelectorAll(removeSelector);
        toRemove.forEach((node) => node.remove());
      }

      // Get text content
      const textContent = clone.textContent?.trim() ?? '';

      if (textContent.length >= MIN_CONTENT_LENGTH) {
        return {
          title: extractTitle(document),
          byline: null,
          content: clone.innerHTML,
          textContent,
          excerpt: generateExcerpt(null, textContent),
          siteName: extractSiteName(document),
          publishedTime: extractPublishedTime(document),
          lang: document.documentElement.lang || null,
          method: `selector:${selector}`,
        };
      }
    }
  } catch (e) {
    logger.debug({ url, error: String(e) }, 'Selector extraction failed');
  }

  return null;
}

/**
 * Extract author name from JSON-LD author field
 */
function extractAuthorFromJsonLd(authorData: unknown): string | null {
  if (typeof authorData === 'string') {
    return authorData;
  }
  if (authorData && typeof authorData === 'object') {
    const author = Array.isArray(authorData) ? authorData[0] : authorData;
    if (author && typeof author === 'object') {
      return (author as Record<string, unknown>).name as string | null;
    }
  }
  return null;
}

/**
 * Flatten a parsed JSON-LD blob into a list of individual items.
 * Handles top-level arrays and @graph structures.
 */
function flattenJsonLdItems(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data)) return data.flatMap(flattenJsonLdItems);

  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj['@graph'])) return obj['@graph'].flatMap(flattenJsonLdItems);

  return [obj];
}

/**
 * Check whether a JSON-LD item is a recognized article type.
 */
function isArticleType(item: Record<string, unknown>): boolean {
  const itemType = Array.isArray(item['@type']) ? item['@type'][0] : item['@type'];
  return (
    typeof itemType === 'string' &&
    ARTICLE_TYPES.includes(itemType as (typeof ARTICLE_TYPES)[number])
  );
}

/**
 * Parse a single JSON-LD item to extract article content
 */
function parseJsonLdItem(
  item: Record<string, unknown>
): Omit<ExtractionResult, 'method' | 'lang' | 'siteName' | 'publishedTime'> | null {
  if (!isArticleType(item)) return null;

  const content =
    (item.articleBody as string) ?? (item.text as string) ?? (item.description as string);
  if (!content) return null;

  return {
    title: (item.headline as string) ?? (item.name as string) ?? null,
    byline: extractAuthorFromJsonLd(item.author),
    content,
    textContent: content,
    excerpt: (item.description as string) ?? null,
  };
}

/**
 * Parse all JSON-LD script tags and return flattened article-candidate items.
 */
function parseJsonLdScripts(document: Document): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent ?? '');
      items.push(...flattenJsonLdItems(data));
    } catch {
      // Skip malformed JSON
    }
  }
  return items;
}

/**
 * Strategy 3: Extract from JSON-LD structured data
 */
export function tryJsonLdExtraction(document: Document, url: string): ExtractionResult | null {
  try {
    for (const item of parseJsonLdScripts(document)) {
      const article = parseJsonLdItem(item);
      if (article?.content && article.content.length >= MIN_CONTENT_LENGTH) {
        return {
          ...article,
          siteName: extractSiteName(document),
          publishedTime: extractPublishedTime(document),
          lang: document.documentElement.lang || null,
          method: 'json-ld',
        };
      }
    }
  } catch (e) {
    logger.debug({ url, error: String(e) }, 'JSON-LD extraction failed');
  }

  return null;
}

interface JsonLdMetadata {
  byline: string | null;
  publishedTime: string | null;
}

/**
 * Extract metadata-only fields from JSON-LD (author, dates).
 * Unlike tryJsonLdExtraction, this does NOT require articleBody to meet content threshold.
 * Used for metadata composition when another strategy wins for content.
 */
function extractJsonLdMetadata(document: Document): JsonLdMetadata | null {
  for (const item of parseJsonLdScripts(document)) {
    if (!isArticleType(item)) continue;

    const byline = extractAuthorFromJsonLd(item.author);
    const publishedTime = (item.datePublished as string) ?? (item.dateCreated as string) ?? null;
    if (byline || publishedTime) {
      return { byline, publishedTime };
    }
  }
  return null;
}

interface SchemaOrgAccessInfo {
  isAccessibleForFree: boolean;
  declaredWordCount?: number;
}

/** Parse a schema.org wordCount value (number or numeric string) into a number. */
function parseWordCount(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const num = parseInt(value, 10);
    return isNaN(num) ? undefined : num;
  }
  return undefined;
}

/**
 * Read the schema.org `isAccessibleForFree` property from JSON-LD structured data
 * that publishers embed in their pages. Returns a result only when the field is
 * explicitly set to `false`. Handles both boolean and string representations
 * (e.g. `"False"` as used by some publishers). Also reads `wordCount` when present.
 */
export function detectIsAccessibleForFree(document: Document): SchemaOrgAccessInfo | null {
  for (const item of parseJsonLdScripts(document)) {
    if (!isArticleType(item)) continue;
    if (!('isAccessibleForFree' in item)) continue;

    const raw = item.isAccessibleForFree;
    const isFree = raw === true || (typeof raw === 'string' && raw.toLowerCase() === 'true');
    if (isFree) return null;

    const declaredWordCount = parseWordCount(item.wordCount);
    return { isAccessibleForFree: false, declaredWordCount };
  }
  return null;
}

/**
 * Compose best metadata from multiple extraction results and JSON-LD metadata.
 * Supplements missing metadata fields on the winner from other sources.
 */
function composeMetadata(
  winner: ExtractionResult,
  candidates: (ExtractionResult | null)[],
  jsonLdMeta: JsonLdMetadata | null
): ExtractionResult {
  const composed = { ...winner };

  // First try JSON-LD metadata (richest structured source)
  if (jsonLdMeta) {
    if (!composed.byline && jsonLdMeta.byline) composed.byline = jsonLdMeta.byline;
    if (!composed.publishedTime && jsonLdMeta.publishedTime)
      composed.publishedTime = jsonLdMeta.publishedTime;
  }

  // Then try other extraction results
  for (const candidate of candidates) {
    if (!candidate || candidate === winner) continue;
    if (!composed.byline && candidate.byline) composed.byline = candidate.byline;
    if (!composed.publishedTime && candidate.publishedTime)
      composed.publishedTime = candidate.publishedTime;
    if (!composed.siteName && candidate.siteName) composed.siteName = candidate.siteName;
    if (!composed.lang && candidate.lang) composed.lang = candidate.lang;
  }
  return composed;
}

const PLAIN_TEXT_METHODS = new Set(['next-data', 'next-rsc']);

/**
 * Methods that skip post-extraction cleanup. These either produce plain text
 * (no HTML to clean) or reconstruct HTML from structured API data that won't
 * contain DOM-based noise like figcaptions, preview duplicates, or UI boilerplate.
 */
const SKIP_CLEANUP_METHODS = new Set([
  ...PLAIN_TEXT_METHODS,
  'json-ld',
  'nuxt-payload',
  'react-router-hydration',
  'wp-ajax-content',
  'prism-content-api',
]);

/**
 * Populate the `markdown` field on an ExtractionResult.
 * Plain-text methods (next-data, next-rsc) have no HTML to convert,
 * so `textContent` is used as-is. HTML-based methods get converted via Turndown.
 */
function withMarkdown(result: ExtractionResult): ExtractionResult {
  let markdown: string | null = null;
  if (PLAIN_TEXT_METHODS.has(result.method)) {
    markdown = result.textContent;
  } else if (result.content) {
    markdown = htmlToMarkdown(result.content);
  }
  return { ...result, markdown };
}

/**
 * Extract text content from HTML string
 */
function extractTextFromHtml(html: string): string {
  // Wrap in full HTML structure so linkedom parses correctly
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  return document.body.textContent?.trim() ?? '';
}

/**
 * Extract byline from an authors array
 */
function extractBylineFromAuthors(authors: unknown): string | null {
  if (!Array.isArray(authors) || authors.length === 0) return null;
  const names = authors
    .map((author: unknown) => {
      if (
        author &&
        typeof author === 'object' &&
        'name' in author &&
        typeof (author as { name: unknown }).name === 'string'
      ) {
        return (author as { name: string }).name;
      }
      return null;
    })
    .filter((name): name is string => name !== null && name.length > 0);
  return names.length > 0 ? names.join(', ') : null;
}

/**
 * Content block with type and text/textHtml fields
 */
interface ContentBlock {
  type?: string;
  text?: string;
  textHtml?: string;
  components?: ContentBlock[];
  items?: ContentBlock[];
}

/**
 * Extract text from an array of content blocks.
 * Handles structures where body is an array of typed blocks with text/textHtml fields.
 */
function extractTextFromContentBlocks(blocks: ContentBlock[]): string {
  const textParts: string[] = [];

  function processBlock(block: ContentBlock): void {
    if (!block || typeof block !== 'object') return;
    const blockType = typeof block.type === 'string' ? block.type.toUpperCase() : undefined;

    // Extract text from paragraph-like blocks
    if (blockType === 'PARAGRAPH' || blockType === 'HEADING' || blockType === 'SUBHEADING') {
      const text = block.text ?? (block.textHtml ? extractTextFromHtml(block.textHtml) : '');
      if (text) {
        textParts.push(text);
        textParts.push('\n\n');
      }
      return;
    }

    // Handle list items
    if (blockType === 'UNORDERED_LIST' || blockType === 'ORDERED_LIST') {
      if (Array.isArray(block.items)) {
        for (const item of block.items) {
          if (!item || typeof item !== 'object') continue;
          const text = item.text ?? (item.textHtml ? extractTextFromHtml(item.textHtml) : '');
          if (text) {
            textParts.push(`• ${text}\n`);
          }
        }
        textParts.push('\n');
      }
      return;
    }

    // Recurse into nested components (e.g., INFOBOX)
    if (Array.isArray(block.components)) {
      for (const component of block.components) {
        processBlock(component);
      }
    }
  }

  for (const block of blocks) {
    processBlock(block);
  }

  return textParts.join('').trim();
}

/**
 * Common paths where Next.js sites store article content as arrays of content blocks.
 * These are probed in order when no site-specific config exists.
 */
const NEXT_DATA_CONTENT_PATHS = [
  'props.pageProps.content.body',
  'props.pageProps.article.body',
  'props.pageProps.article.content',
  'props.pageProps.post.body',
  'props.pageProps.post.content',
  'props.pageProps.data.body',
];

/**
 * Check if a value looks like an array of content blocks (has objects with type/text fields).
 */
function isContentBlockArray(value: unknown): value is ContentBlock[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  // Check first few items for content block structure
  const sample = value.slice(0, 5);
  return sample.some(
    (item) =>
      item && typeof item === 'object' && ('type' in item || 'text' in item || 'textHtml' in item)
  );
}

/**
 * Try to extract metadata for content block arrays from various pageProps locations.
 */
function extractContentBlockMetadata(
  pageProps: Record<string, unknown>,
  document: Document
): {
  title: string | null;
  byline: string | null;
  excerpt: string | null;
  publishedTime: string | null;
} {
  // Try content.headline, article.headline, post.title, etc.
  const content = pageProps.content as Record<string, unknown> | undefined;
  const article = pageProps.article as Record<string, unknown> | undefined;
  const post = pageProps.post as Record<string, unknown> | undefined;

  const title =
    (content?.headline as string) ??
    (article?.headline as string) ??
    (article?.title as string) ??
    (post?.title as string) ??
    (pageProps.title as string) ??
    extractTitle(document);

  const byline =
    extractBylineFromAuthors(content?.authors) ??
    extractBylineFromAuthors(article?.authors) ??
    extractBylineFromAuthors(post?.authors) ??
    (pageProps.author as { name?: string })?.name ??
    null;

  const excerpt =
    (content?.description as string) ??
    (article?.description as string) ??
    (article?.excerpt as string) ??
    (post?.excerpt as string) ??
    (pageProps.description as string) ??
    null;

  const publishedTime =
    (content?.datePublished as string) ??
    (article?.datePublished as string) ??
    (article?.publishedAt as string) ??
    (post?.date as string) ??
    (pageProps.publishedAt as string) ??
    extractPublishedTime(document);

  return { title, byline, excerpt, publishedTime };
}

/**
 * Try to extract an ExtractionResult from a string body (HTML or plain text).
 * Shared by both the custom-path and auto-detect branches of tryNextDataExtraction.
 */
function tryStringBodyExtraction(
  content: string,
  meta: Record<string, unknown>,
  document: Document
): ExtractionResult | null {
  if (content.length < MIN_CONTENT_LENGTH) return null;

  const isHtml = /<(?:p|div)>/.test(content);
  const sanitized = isHtml ? sanitizeHtml(content) : content;
  const textContent = isHtml ? extractTextFromHtml(sanitized) : content;
  if (textContent.length < MIN_CONTENT_LENGTH) return null;

  return {
    title: (meta.headline as string) ?? (meta.title as string) ?? extractTitle(document),
    byline: extractBylineFromAuthors(meta.authors) ?? (meta.byline as string) ?? null,
    content: isHtml ? sanitized : textContent,
    textContent,
    excerpt:
      (meta.description as string) ??
      (meta.excerpt as string) ??
      generateExcerpt(null, textContent),
    siteName: extractSiteName(document),
    publishedTime:
      (meta.datePublished as string) ??
      (meta.publishedAt as string) ??
      extractPublishedTime(document),
    lang: document.documentElement.lang || 'en',
    method: isHtml ? 'next-data-html' : 'next-data',
  };
}

/**
 * Strategy 4: Extract from Next.js __NEXT_DATA__
 * Some sites embed full article content in the page props JSON.
 * Supports three modes (tried in order):
 * 1. Site-specific: Use nextDataPath config to specify custom JSON path
 * 2. Auto-detect: Probe common content paths for content block arrays or string bodies
 * 3. Default: Look for story.body.content structured blocks
 */
export function tryNextDataExtraction(document: Document, url: string): ExtractionResult | null {
  try {
    const script = document.querySelector('script#__NEXT_DATA__');
    if (!script?.textContent) return null;

    const data = JSON.parse(script.textContent);
    const pageProps = data?.props?.pageProps;
    if (!pageProps) return null;

    // Try site-specific path first
    const customPath = getSiteNextDataPath(url);
    if (customPath) {
      const content = getNestedValue(data, customPath);

      // Handle array of content blocks
      if (Array.isArray(content)) {
        const textContent = extractTextFromContentBlocks(
          content.filter((item): item is ContentBlock => item && typeof item === 'object')
        );
        if (textContent.length >= MIN_CONTENT_LENGTH) {
          logger.debug(
            { url, path: customPath },
            'Next.js custom path (array) extraction succeeded'
          );
          // Extract metadata from content structure
          const contentMeta = pageProps.content ?? {};
          return {
            title: contentMeta.headline ?? pageProps.title ?? extractTitle(document),
            byline: extractBylineFromAuthors(contentMeta.authors) ?? pageProps.author?.name ?? null,
            content: textContent,
            textContent,
            excerpt:
              contentMeta.description ??
              pageProps.teaser_body ??
              generateExcerpt(null, textContent),
            siteName: extractSiteName(document),
            publishedTime:
              contentMeta.datePublished ??
              pageProps.publishedAt ??
              pageProps.changed_formatted ??
              extractPublishedTime(document),
            lang: document.documentElement.lang || 'en',
            method: 'next-data',
          };
        }
      }

      // Handle string content (HTML or plain text)
      if (typeof content === 'string') {
        // Map pageProps fields to the generic metadata shape expected by tryStringBodyExtraction
        const meta: Record<string, unknown> = {
          title: pageProps.title,
          byline: pageProps.author?.name ?? null,
          description: pageProps.teaser_body ?? pageProps.description,
          publishedAt: pageProps.publishedAt ?? pageProps.changed_formatted,
        };
        const result = tryStringBodyExtraction(content, meta, document);
        if (result) {
          logger.debug({ url, path: customPath }, 'Next.js custom path extraction succeeded');
          return result;
        }
      }
    }

    // Auto-detect: Probe common content paths for content block arrays or string bodies
    for (const path of NEXT_DATA_CONTENT_PATHS) {
      const content = getNestedValue(data, path);
      if (isContentBlockArray(content)) {
        const textContent = extractTextFromContentBlocks(
          content.filter((item): item is ContentBlock => item && typeof item === 'object')
        );
        if (textContent.length >= MIN_CONTENT_LENGTH) {
          logger.debug({ url, path }, 'Next.js auto-detected content path extraction succeeded');
          const meta = extractContentBlockMetadata(pageProps as Record<string, unknown>, document);
          return {
            title: meta.title ?? extractTitle(document),
            byline: meta.byline,
            content: textContent,
            textContent,
            excerpt: meta.excerpt ?? generateExcerpt(null, textContent),
            siteName: extractSiteName(document),
            publishedTime: meta.publishedTime ?? extractPublishedTime(document),
            lang: document.documentElement.lang || 'en',
            method: 'next-data',
          };
        }
      }

      // Handle string content (HTML or plain text)
      if (typeof content === 'string') {
        const parentPath = path.split('.').slice(0, -1).join('.');
        const parent = (getNestedValue(data, parentPath) ?? {}) as Record<string, unknown>;
        // Fall back to pageProps.title when parent has no title fields
        const metaWithFallback = { ...parent, title: parent.title ?? pageProps.title };
        const result = tryStringBodyExtraction(content, metaWithFallback, document);
        if (result) {
          logger.debug({ url, path }, 'Next.js auto-detected string content extraction succeeded');
          return result;
        }
      }
    }

    // Default: Try story.body.content structured blocks
    const story = pageProps?.story;
    if (!story?.body?.content) return null;

    // Extract text from the structured content
    const textParts: string[] = [];

    function extractText(node: unknown): void {
      if (!node || typeof node !== 'object') return;

      const obj = node as Record<string, unknown>;

      // Handle text nodes
      if (obj.type === 'text' && typeof obj.value === 'string') {
        textParts.push(obj.value);
        return;
      }

      // Skip non-content types
      const skipTypes = ['inline-newsletter', 'ad', 'related-content', 'inline-recirc'];
      if (typeof obj.type === 'string' && skipTypes.includes(obj.type)) {
        return;
      }

      // Add newlines after paragraphs
      if (obj.type === 'paragraph') {
        if (Array.isArray(obj.content)) {
          obj.content.forEach(extractText);
        }
        textParts.push('\n\n');
        return;
      }

      // Recurse into content arrays
      if (Array.isArray(obj.content)) {
        obj.content.forEach(extractText);
      }
    }

    // Process all content blocks
    if (Array.isArray(story.body.content)) {
      story.body.content.forEach(extractText);
    }

    const textContent = textParts.join('').trim();
    if (textContent.length < MIN_CONTENT_LENGTH) return null;

    // Extract author
    let byline: string | null = null;
    if (Array.isArray(story.authors) && story.authors.length > 0) {
      byline = story.authors
        .map((a: { name?: string }) => a.name)
        .filter(Boolean)
        .join(', ');
    }

    return {
      title: story.headline ?? story.title ?? extractTitle(document),
      byline,
      content: textContent,
      textContent,
      excerpt: story.abstract?.[0] ?? generateExcerpt(null, textContent),
      siteName: extractSiteName(document),
      publishedTime: story.publishedAt ?? extractPublishedTime(document),
      lang: document.documentElement.lang || 'en',
      method: 'next-data',
    };
  } catch (e) {
    logger.debug({ url, error: String(e) }, 'Next.js data extraction failed');
    return null;
  }
}

/**
 * Strategy 5: Extract using text density analysis (CETD algorithm).
 * Statistical approach based on text-to-tag density ratios per DOM node.
 * Complementary to Readability's heuristic class/id scoring.
 */
export function tryTextDensityExtraction(html: string, url: string): ExtractionResult | null {
  try {
    const extracted = extractContent(html);

    if (extracted.content.length < MIN_CONTENT_LENGTH) {
      return null;
    }

    // Parse with linkedom for metadata extraction (reuses the same DOM lib as other strategies)
    const { document } = parseHTML(html);

    return {
      title: extractTitle(document),
      byline: null,
      content: extracted.contentHtmls.join(''),
      textContent: extracted.content,
      excerpt: generateExcerpt(extracted.description ?? null, extracted.content),
      siteName: extractSiteName(document),
      publishedTime: extractPublishedTime(document),
      lang: document.documentElement.lang || null,
      method: 'text-density',
    };
  } catch (e) {
    logger.debug({ url, error: String(e) }, 'Text density extraction failed');
    return null;
  }
}

/**
 * Check whether a string looks like natural language (not HTML/JS).
 */
function isNaturalLanguage(text: string): boolean {
  const len = text.length;
  if (len === 0) return false;

  // Reject HTML-heavy content (more than 1 tag per 100 chars)
  const tagCount = text.split('<').length - 1;
  if (tagCount > len / 100) return false;

  // Reject JS-heavy content
  if (text.includes('function(') || text.includes('function (')) return false;
  const arrowCount = text.split('=>').length - 1;
  if (arrowCount > 3) return false;

  // Must have word-like content: spaces between words
  const spaceCount = text.split(' ').length - 1;
  return spaceCount / len > 0.1;
}

/**
 * Strategy 6: Extract from Next.js RSC (React Server Components) streaming payload.
 * App Router pages embed article text inside self.__next_f.push() script calls
 * rather than rendering it into the DOM.
 */
export function tryNextRscExtraction(html: string, url: string): ExtractionResult | null {
  try {
    if (!html.includes('self.__next_f.push(')) return null;

    // Extract all self.__next_f.push([...]) calls, anchored on </script> boundary
    const pushPattern = /self\.__next_f\.push\(([\s\S]*?)\)<\/script>/g;
    const chunks: string[] = [];
    let match;
    while ((match = pushPattern.exec(html)) !== null) {
      try {
        const arr = JSON.parse(match[1]);
        if (Array.isArray(arr) && arr[0] === 1 && typeof arr[1] === 'string') {
          chunks.push(arr[1]);
        }
      } catch {
        // Skip malformed JSON (some chunks contain unescaped JS)
      }
    }

    if (chunks.length === 0) return null;

    // Concatenate all type-1 chunks into a single stream
    const stream = chunks.join('');

    // Extract text segments from RSC T markers: id:Thexlen,<content>
    const textSegments: string[] = [];
    const tMarkerPattern = /[0-9a-f]+:T[0-9a-f]+,/g;
    let tMatch;
    const tPositions: number[] = [];
    while ((tMatch = tMarkerPattern.exec(stream)) !== null) {
      tPositions.push(tMatch.index + tMatch[0].length);
    }

    // For each T marker, extract text until next RSC row prefix or end
    const rowPrefixPattern = /\n[0-9a-f]+:[A-Z["$]/;
    for (const pos of tPositions) {
      const rest = stream.slice(pos);
      const nextRow = rest.search(rowPrefixPattern);
      const segment = nextRow === -1 ? rest : rest.slice(0, nextRow);

      if (segment.length >= RSC_MIN_SEGMENT_LENGTH && isNaturalLanguage(segment)) {
        textSegments.push(segment.trim());
      }
    }

    // Also check for continuation chunks (raw text with no row prefix)
    for (const chunk of chunks) {
      if (
        chunk.length >= RSC_MIN_SEGMENT_LENGTH &&
        !/^[0-9a-f]+:/.test(chunk) &&
        isNaturalLanguage(chunk)
      ) {
        textSegments.push(chunk.trim());
      }
    }

    // Deduplicate (continuation chunks may overlap with T marker extraction)
    const unique = [...new Set(textSegments)];
    const textContent = unique.join('\n\n');

    if (textContent.length < MIN_CONTENT_LENGTH) return null;

    const { document } = parseHTML(html);

    return {
      title: extractTitle(document),
      byline: null,
      content: textContent,
      textContent,
      excerpt: generateExcerpt(null, textContent),
      siteName: extractSiteName(document),
      publishedTime: extractPublishedTime(document),
      lang: document.documentElement.lang || null,
      method: 'next-rsc',
    };
  } catch (e) {
    logger.debug({ url, error: String(e) }, 'Next.js RSC extraction failed');
    return null;
  }
}

/**
 * Extract the Next.js buildId from a __NEXT_DATA__ script tag.
 * Returns null if the page is not a Next.js page or has no buildId.
 */
export function extractNextBuildId(document: Document): string | null {
  try {
    const script = document.querySelector('script#__NEXT_DATA__');
    if (!script?.textContent) return null;
    const data = JSON.parse(script.textContent);
    const buildId = data?.buildId;
    return typeof buildId === 'string' && /^[\w-]+$/.test(buildId) ? buildId : null;
  } catch {
    return null;
  }
}

/**
 * Detect WordPress REST API availability from HTML.
 * WordPress sites with the REST API enabled include a link tag like:
 *   <link rel="alternate" type="application/json" href="/wp-json/wp/v2/posts/123" />
 * Returns the API URL if found, points to wp-json, and is same-origin as the page.
 * The same-origin check prevents SSRF via attacker-controlled href values.
 */
export function detectWpRestApi(document: Document, pageUrl: string): string | null {
  const link = document.querySelector('link[rel="alternate"][type="application/json"]');
  const href = link?.getAttribute('href');
  if (!href || !href.includes('/wp-json/')) return null;
  try {
    const apiOrigin = new URL(href).origin;
    const pageOrigin = new URL(pageUrl).origin;
    if (apiOrigin !== pageOrigin) return null;
  } catch {
    return null;
  }
  return href;
}

/** Normalize a selector option to an array. */
function toSelectorArray(sel: string | string[] | undefined): string[] {
  if (!sel) return [];
  return Array.isArray(sel) ? sel : [sel];
}

/**
 * Apply user-provided CSS selectors to raw HTML before extraction.
 * - removeSelector: removes matching elements from the DOM
 * - targetSelector: replaces body with only matched elements (concatenated in document order)
 * Returns the modified HTML string. If targetSelector matches nothing, returns original HTML with a warning.
 */
export function applySelectors(html: string, selectors: SelectorOptions): string {
  const removes = toSelectorArray(selectors.removeSelector);
  const targets = toSelectorArray(selectors.targetSelector);

  if (removes.length === 0 && targets.length === 0) return html;

  const { document } = parseHTML(html);

  // Apply removeSelector first
  for (const selector of removes) {
    for (const el of document.querySelectorAll(selector)) {
      el.remove();
    }
  }

  // Apply targetSelector: keep only matched elements
  if (targets.length > 0) {
    const combined = targets.join(', ');
    const matched = document.querySelectorAll(combined);

    if (matched.length === 0) {
      logger.warn(
        { targetSelector: combined },
        'targetSelector matched no elements, falling back to full document'
      );
    } else {
      // Replace body content with matched elements in document order
      const body = document.body ?? document.documentElement;
      body.innerHTML = '';
      for (const el of matched) {
        body.appendChild(el.cloneNode(true));
      }
    }
  }

  return document.toString();
}

/**
 * Multi-strategy extraction from HTML
 * Exported for testing and direct HTML extraction use cases
 * Uses linkedom for DOM parsing (crash-resistant, no CSS parsing errors)
 */
export function extractFromHtml(
  html: string,
  url: string,
  selectors?: SelectorOptions
): ExtractionResult | null {
  // Apply user-provided selectors before extraction
  if (selectors) {
    html = applySelectors(html, selectors);
  }

  const { document } = parseHTML(html);

  // Read publisher-declared schema.org access metadata from JSON-LD
  const schemaOrgAccess = detectIsAccessibleForFree(document);

  /**
   * Apply content cleanup, markdown conversion, schema.org access fields, and media extraction.
   * This runs once on the final winning extraction result (not multiple times).
   * Media is extracted from the article content HTML, not the raw page HTML.
   */
  function finalizeResult(result: ExtractionResult): ExtractionResult {
    // Run post-extraction cleanup on HTML-based methods
    let cleaned = result;
    if (result.content && !SKIP_CLEANUP_METHODS.has(result.method)) {
      try {
        const out = cleanExtractedHtml(result.content);
        cleaned = { ...result, content: out.html, textContent: out.textContent };
      } catch (e) {
        logger.debug({ url, method: result.method, error: String(e) }, 'Content cleanup failed');
      }
    }

    const md = withMarkdown(cleaned);

    // Extract media from the extracted content HTML
    const media = cleaned.content ? extractMedia(cleaned.content, url) : undefined;

    if (!schemaOrgAccess) {
      return { ...md, media };
    }
    return {
      ...md,
      media,
      isAccessibleForFree: schemaOrgAccess.isAccessibleForFree,
      declaredWordCount: schemaOrgAccess.declaredWordCount,
    };
  }

  // Run Next.js __NEXT_DATA__ extraction once (shared between fast-path and waterfall)
  const nextDataResult = tryNextDataExtraction(document, url);

  // Config-driven: Next.js early return (these sites have complete metadata)
  if (siteUseNextData(url) && meetsThreshold(nextDataResult, GOOD_CONTENT_LENGTH)) {
    logger.debug({ url, method: 'next-data' }, 'Extraction succeeded (Next.js data)');
    return finalizeResult(nextDataResult!);
  }

  // Config-driven: JSON-LD preferred sites get early return
  const preferJsonLd = sitePreferJsonLd(url);
  let jsonLdResult: ExtractionResult | null = null;

  if (preferJsonLd) {
    jsonLdResult = tryJsonLdExtraction(document, url);
    if (meetsThreshold(jsonLdResult, GOOD_CONTENT_LENGTH)) {
      logger.debug({ url, method: 'json-ld' }, 'Extraction succeeded (preferred)');
      return finalizeResult(jsonLdResult!);
    }
  }

  // Extract JSON-LD metadata for composition (lightweight, no content threshold)
  const jsonLdMeta = extractJsonLdMetadata(document);

  // Run all strategies
  const readabilityResult = tryReadability(document, url);
  if (!preferJsonLd) {
    jsonLdResult = tryJsonLdExtraction(document, url);
  }
  const selectorResult = trySelectorExtraction(document, url);
  const textDensityResult = tryTextDensityExtraction(html, url);
  const rscResult = tryNextRscExtraction(html, url);
  const nuxtResult = tryNuxtPayloadExtraction(html, url);
  const reactRouterResult = tryReactRouterHydrationExtraction(html, url, document);

  // Comparator: prefer text-density if it found significantly more content
  // than Readability (>2x length). Catches pages where Readability trims too aggressively.
  let effectiveReadability: ExtractionResult | null = readabilityResult;

  if (readabilityResult && textDensityResult) {
    const readLen = readabilityResult.textContent?.length ?? 0;
    const densityLen = textDensityResult.textContent?.length ?? 0;

    if (densityLen > readLen * COMPARATOR_LENGTH_RATIO && densityLen >= GOOD_CONTENT_LENGTH) {
      logger.debug(
        { url, readabilityLen: readLen, textDensityLen: densityLen },
        'Text-density found significantly more content, preferring it over Readability'
      );
      effectiveReadability = null;
    }
  }

  // Comparator: prefer RSC if it found significantly more content than Readability
  if (effectiveReadability && rscResult) {
    const readLen = effectiveReadability.textContent?.length ?? 0;
    const rscLen = rscResult.textContent?.length ?? 0;
    if (rscLen > readLen * COMPARATOR_LENGTH_RATIO && rscLen >= GOOD_CONTENT_LENGTH) {
      logger.debug(
        { url, readabilityLen: readLen, rscLen },
        'RSC found significantly more content, preferring it over Readability'
      );
      effectiveReadability = null;
    }
  }

  // Candidate results keyed by strategy name (order matches CANDIDATE_PRIORITY).
  const results = new Map<string, ExtractionResult | null>([
    ['readability', effectiveReadability],
    ['next-rsc', rscResult],
    ['nuxt-payload', nuxtResult],
    ['react-router-hydration', reactRouterResult],
    ['next-data', nextDataResult],
    ['json-ld', jsonLdResult],
    ['selector', selectorResult],
    ['text-density', textDensityResult],
  ]);

  // All results for metadata composition (use readabilityResult, not effectiveReadability,
  // so Readability's metadata remains available even when the comparator prefers text-density)
  const allResults = [
    readabilityResult,
    nextDataResult,
    jsonLdResult,
    selectorResult,
    textDensityResult,
    rscResult,
    nuxtResult,
    reactRouterResult,
  ];

  // Collect all results that meet the good content threshold
  const goodCandidates = CANDIDATE_PRIORITY.filter((n) => !GOOD_CANDIDATES_EXCLUDE.has(n))
    .map((n) => results.get(n) ?? null)
    .filter((r): r is ExtractionResult => meetsThreshold(r, GOOD_CONTENT_LENGTH));

  // If multiple strategies meet the threshold, prefer the one with the most content
  if (goodCandidates.length > 0) {
    const winner = goodCandidates.reduce((best, current) => {
      const bestLen = best.textContent?.length ?? 0;
      const currentLen = current.textContent?.length ?? 0;
      return currentLen > bestLen ? current : best;
    });
    logger.debug(
      { url, method: winner.method, contentLen: winner.textContent?.length },
      'Extraction succeeded (preferred longest)'
    );
    return finalizeResult(composeMetadata(winner, allResults, jsonLdMeta));
  }

  // Fall back to minimum threshold candidates in priority order
  const fallbackCandidates = CANDIDATE_PRIORITY.map((n) => results.get(n) ?? null);

  for (const result of fallbackCandidates) {
    if (meetsThreshold(result, MIN_CONTENT_LENGTH)) {
      logger.debug({ url, method: result!.method }, 'Extraction succeeded');
      return finalizeResult(composeMetadata(result!, allResults, jsonLdMeta));
    }
  }

  // Return best partial result with composition
  const partialResult = fallbackCandidates.find((r) => r !== null) ?? null;
  if (partialResult) {
    return finalizeResult(composeMetadata(partialResult, allResults, jsonLdMeta));
  }

  logger.debug({ url }, 'All extraction strategies failed');
  return null;
}
