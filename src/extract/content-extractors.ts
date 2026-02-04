/**
 * DOM-based content extraction strategies
 * These are synchronous functions that extract content from parsed HTML documents
 */
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import unfluff from 'unfluff';
import { extractContent } from '@wrtnlabs/web-content-extractor';
import {
  type ExtractionResult,
  MIN_CONTENT_LENGTH,
  GOOD_CONTENT_LENGTH,
  DEFAULT_EXCERPT_LENGTH,
} from './types.js';
import { htmlToMarkdown } from './markdown.js';
import { meetsThreshold } from './utils.js';
import { sitePreferJsonLd, siteUseNextData, getSiteNextDataPath } from '../sites/site-config.js';
import { logger } from '../logger.js';

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

interface AccessibilityInfo {
  isAccessibleForFree: boolean;
  declaredWordCount?: number;
}

/**
 * Detect the schema.org `isAccessibleForFree` field from JSON-LD structured data.
 * Only reports when the field is explicitly `false` (content is paywalled).
 * Handles boolean `false` and string variants like `"False"` (used by FT.com).
 * Also extracts `wordCount` if present on the same item.
 */
export function detectIsAccessibleForFree(document: Document): AccessibilityInfo | null {
  for (const item of parseJsonLdScripts(document)) {
    if (!isArticleType(item)) continue;
    if (!('isAccessibleForFree' in item)) continue;

    const raw = item.isAccessibleForFree;
    const isFree =
      raw === true || (typeof raw === 'string' && raw.toLowerCase() === 'true') ? true : false;

    if (isFree) return null;

    const wordCount =
      typeof item.wordCount === 'number'
        ? item.wordCount
        : typeof item.wordCount === 'string'
          ? parseInt(item.wordCount, 10) || undefined
          : undefined;

    return { isAccessibleForFree: false, declaredWordCount: wordCount };
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

const PLAIN_TEXT_METHODS = new Set(['unfluff', 'next-data', 'next-rsc']);

/**
 * Populate the `markdown` field on an ExtractionResult.
 * Plain-text methods (unfluff, next-data, next-rsc) have no HTML to convert,
 * so `textContent` is used as-is. HTML-based methods get converted via Turndown.
 */
function withMarkdown(result: ExtractionResult): ExtractionResult {
  const markdown = PLAIN_TEXT_METHODS.has(result.method)
    ? result.textContent
    : result.content
      ? htmlToMarkdown(result.content)
      : null;
  return { ...result, markdown };
}

/**
 * Get a value from an object by dot-notation path (e.g., "props.pageProps.paragraph.0.description")
 */
function getByPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
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
 * Strategy 4: Extract from Next.js __NEXT_DATA__
 * Some sites embed full article content in the page props JSON.
 * Supports three modes (tried in order):
 * 1. Site-specific: Use nextDataPath config to specify custom JSON path
 * 2. Auto-detect: Probe common content paths for content block arrays
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
      const content = getByPath(data, customPath);

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

      // Handle string content (existing behavior)
      if (typeof content === 'string' && content.length >= MIN_CONTENT_LENGTH) {
        // Content might be HTML or plain text - check for common HTML tags
        const isHtml = /<(?:p|div)>/.test(content);
        const textContent = isHtml ? extractTextFromHtml(content) : content;

        if (textContent.length >= MIN_CONTENT_LENGTH) {
          logger.debug({ url, path: customPath }, 'Next.js custom path extraction succeeded');
          return {
            title: pageProps.title ?? extractTitle(document),
            byline: pageProps.author?.name ?? null,
            content: isHtml ? content : textContent,
            textContent,
            excerpt:
              pageProps.teaser_body ?? pageProps.description ?? generateExcerpt(null, textContent),
            siteName: extractSiteName(document),
            publishedTime:
              pageProps.publishedAt ??
              pageProps.changed_formatted ??
              extractPublishedTime(document),
            lang: document.documentElement.lang || 'en',
            method: 'next-data',
          };
        }
      }
    }

    // Auto-detect: Probe common content paths for content block arrays
    for (const path of NEXT_DATA_CONTENT_PATHS) {
      const content = getByPath(data, path);
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
 * Strategy 5: Extract using unfluff (python-goose port)
 * Different heuristics than Readability, good for unusual HTML structures
 */
export function tryUnfluffExtraction(html: string, url: string): ExtractionResult | null {
  try {
    const result = unfluff(html);

    if (!result.text || result.text.length < MIN_CONTENT_LENGTH) {
      return null;
    }

    return {
      title: result.title ?? null,
      byline: result.author?.join(', ') ?? null,
      content: result.text, // unfluff returns plain text, not HTML
      textContent: result.text,
      excerpt: result.description ?? generateExcerpt(null, result.text),
      siteName: result.publisher ?? null,
      publishedTime: result.date ?? null,
      lang: result.lang ?? null,
      method: 'unfluff',
    };
  } catch (e) {
    logger.debug({ url, error: String(e) }, 'Unfluff extraction failed');
    return null;
  }
}

/**
 * Strategy 6: Extract using text density analysis (CETD algorithm).
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
 * Strategy 7: Extract from Next.js RSC (React Server Components) streaming payload.
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

/**
 * Multi-strategy extraction from HTML
 * Exported for testing and direct HTML extraction use cases
 * Uses linkedom for DOM parsing (crash-resistant, no CSS parsing errors)
 */
export function extractFromHtml(html: string, url: string): ExtractionResult | null {
  const { document } = parseHTML(html);

  // Detect paywall signal from JSON-LD (lightweight, runs before content extraction)
  const accessibilityInfo = detectIsAccessibleForFree(document);

  /** Attach isAccessibleForFree / declaredWordCount to a result before returning */
  function withAccessibility(result: ExtractionResult): ExtractionResult {
    if (!accessibilityInfo) return result;
    return {
      ...result,
      isAccessibleForFree: accessibilityInfo.isAccessibleForFree,
      declaredWordCount: accessibilityInfo.declaredWordCount,
    };
  }

  // Config-driven: Next.js early return (these sites have complete metadata)
  if (siteUseNextData(url)) {
    const nextDataResult = tryNextDataExtraction(document, url);
    if (meetsThreshold(nextDataResult, GOOD_CONTENT_LENGTH)) {
      logger.debug({ url, method: 'next-data' }, 'Extraction succeeded (Next.js data)');
      return withAccessibility(withMarkdown(nextDataResult!));
    }
  }

  // Config-driven: JSON-LD preferred sites get early return
  const preferJsonLd = sitePreferJsonLd(url);
  let jsonLdResult: ExtractionResult | null = null;

  if (preferJsonLd) {
    jsonLdResult = tryJsonLdExtraction(document, url);
    if (meetsThreshold(jsonLdResult, GOOD_CONTENT_LENGTH)) {
      logger.debug({ url, method: 'json-ld' }, 'Extraction succeeded (preferred)');
      return withAccessibility(withMarkdown(jsonLdResult!));
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
  const unfluffResult = tryUnfluffExtraction(html, url);
  const rscResult = tryNextRscExtraction(html, url);

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

  // All results for metadata composition (use readabilityResult, not effectiveReadability,
  // so Readability's metadata remains available even when the comparator prefers text-density)
  const allResults = [
    readabilityResult,
    jsonLdResult,
    selectorResult,
    textDensityResult,
    unfluffResult,
    rscResult,
  ];

  // Collect all results that meet the good content threshold
  const goodCandidates = [effectiveReadability, rscResult, jsonLdResult, textDensityResult].filter(
    (r): r is ExtractionResult => meetsThreshold(r, GOOD_CONTENT_LENGTH)
  );

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
    return withAccessibility(withMarkdown(composeMetadata(winner, allResults, jsonLdMeta)));
  }

  // Fall back to minimum threshold candidates in priority order
  const fallbackCandidates: [ExtractionResult | null, number][] = [
    [effectiveReadability, MIN_CONTENT_LENGTH],
    [rscResult, MIN_CONTENT_LENGTH],
    [jsonLdResult, MIN_CONTENT_LENGTH],
    [selectorResult, MIN_CONTENT_LENGTH],
    [textDensityResult, MIN_CONTENT_LENGTH],
    [unfluffResult, MIN_CONTENT_LENGTH],
  ];

  for (const [result, threshold] of fallbackCandidates) {
    if (meetsThreshold(result, threshold)) {
      logger.debug({ url, method: result!.method }, 'Extraction succeeded');
      return withAccessibility(withMarkdown(composeMetadata(result!, allResults, jsonLdMeta)));
    }
  }

  // Return best partial result with composition
  const partialResult =
    effectiveReadability ??
    rscResult ??
    jsonLdResult ??
    selectorResult ??
    textDensityResult ??
    unfluffResult;
  if (partialResult) {
    return withAccessibility(withMarkdown(composeMetadata(partialResult, allResults, jsonLdMeta)));
  }

  logger.debug({ url }, 'All extraction strategies failed');
  return null;
}
