/**
 * DOM-based content extraction strategies
 * These are synchronous functions that extract content from parsed HTML documents
 */
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import unfluff from 'unfluff';
import {
  type ExtractionResult,
  MIN_CONTENT_LENGTH,
  GOOD_CONTENT_LENGTH,
  DEFAULT_EXCERPT_LENGTH,
} from './types.js';
import { meetsThreshold } from './utils.js';
import { sitePreferJsonLd, siteUseNextData } from '../sites/site-config.js';
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
 * Strategy 1: Extract using Mozilla Readability
 */
export function tryReadability(document: Document, url: string): ExtractionResult | null {
  try {
    // Clone document since Readability modifies it
    const clone = document.cloneNode(true) as Document;
    const reader = new Readability(clone);
    const article = reader.parse();

    if (!article || !article.textContent || article.textContent.length < MIN_CONTENT_LENGTH) {
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
      method: 'readability',
    };
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
 * Parse a single JSON-LD item to extract article content
 */
function parseJsonLdItem(
  data: unknown
): Omit<ExtractionResult, 'method' | 'lang' | 'siteName' | 'publishedTime'> | null {
  if (!data || typeof data !== 'object') return null;

  // Handle arrays and @graph structure
  if (Array.isArray(data)) {
    return findFirstJsonLdResult(data);
  }

  const obj = data as Record<string, unknown>;

  if (Array.isArray(obj['@graph'])) {
    return findFirstJsonLdResult(obj['@graph']);
  }

  // Check if this is an article type
  const itemType = Array.isArray(obj['@type']) ? obj['@type'][0] : obj['@type'];
  if (
    typeof itemType !== 'string' ||
    !ARTICLE_TYPES.includes(itemType as (typeof ARTICLE_TYPES)[number])
  ) {
    return null;
  }

  // Extract content
  const content =
    (obj.articleBody as string) ?? (obj.text as string) ?? (obj.description as string);
  if (!content) return null;

  return {
    title: (obj.headline as string) ?? (obj.name as string) ?? null,
    byline: extractAuthorFromJsonLd(obj.author),
    content,
    textContent: content,
    excerpt: (obj.description as string) ?? null,
  };
}

/**
 * Find first valid result by recursively parsing JSON-LD items
 */
function findFirstJsonLdResult(
  items: unknown[]
): Omit<ExtractionResult, 'method' | 'lang' | 'siteName' | 'publishedTime'> | null {
  for (const item of items) {
    const result = parseJsonLdItem(item);
    if (result) return result;
  }
  return null;
}

/**
 * Strategy 3: Extract from JSON-LD structured data
 */
export function tryJsonLdExtraction(document: Document, url: string): ExtractionResult | null {
  try {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');

    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent ?? '');
        const article = parseJsonLdItem(data);

        if (article && article.content && article.content.length >= MIN_CONTENT_LENGTH) {
          return {
            ...article,
            siteName: extractSiteName(document),
            publishedTime: extractPublishedTime(document),
            lang: document.documentElement.lang || null,
            method: 'json-ld',
          };
        }
      } catch {
        // Continue to next script
      }
    }
  } catch (e) {
    logger.debug({ url, error: String(e) }, 'JSON-LD extraction failed');
  }

  return null;
}

/**
 * Strategy 4: Extract from Next.js __NEXT_DATA__
 * Some sites embed full article content in the page props JSON
 * (configured via siteUseNextData in site configs)
 */
export function tryNextDataExtraction(document: Document, url: string): ExtractionResult | null {
  try {
    const script = document.querySelector('script#__NEXT_DATA__');
    if (!script?.textContent) return null;

    const data = JSON.parse(script.textContent);
    const story = data?.props?.pageProps?.story;
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
 * Multi-strategy extraction from HTML
 * Exported for testing and direct HTML extraction use cases
 * Uses linkedom for DOM parsing (crash-resistant, no CSS parsing errors)
 */
export function extractFromHtml(html: string, url: string): ExtractionResult | null {
  // Use linkedom instead of JSDOM - more crash-resistant with malformed HTML
  const { document } = parseHTML(html);

  // Check if this site uses Next.js __NEXT_DATA__ extraction (config-driven)
  if (siteUseNextData(url)) {
    const nextDataResult = tryNextDataExtraction(document, url);
    if (meetsThreshold(nextDataResult, GOOD_CONTENT_LENGTH)) {
      logger.debug({ url, method: 'next-data' }, 'Extraction succeeded (Next.js data)');
      return nextDataResult;
    }
  }

  // Check if this site prefers JSON-LD (full content in structured data)
  const preferJsonLd = sitePreferJsonLd(url);

  if (preferJsonLd) {
    // For sites with full content in JSON-LD, try it first
    const jsonLdResult = tryJsonLdExtraction(document, url);
    if (meetsThreshold(jsonLdResult, GOOD_CONTENT_LENGTH)) {
      logger.debug({ url, method: 'json-ld' }, 'Extraction succeeded (preferred)');
      return jsonLdResult;
    }
  }

  // Strategy 1: Try Readability first (most reliable for clean content)
  const readabilityResult = tryReadability(document, url);
  if (meetsThreshold(readabilityResult, GOOD_CONTENT_LENGTH)) {
    logger.debug({ url, method: 'readability' }, 'Extraction succeeded');
    return readabilityResult;
  }

  // Strategy 2: Try JSON-LD (structured data, often has full article)
  const jsonLdResult = preferJsonLd ? null : tryJsonLdExtraction(document, url);
  if (meetsThreshold(jsonLdResult, GOOD_CONTENT_LENGTH)) {
    logger.debug({ url, method: 'json-ld' }, 'Extraction succeeded');
    return jsonLdResult;
  }

  // Strategy 3: Try selector-based extraction
  const selectorResult = trySelectorExtraction(document, url);
  if (meetsThreshold(selectorResult, MIN_CONTENT_LENGTH)) {
    logger.debug({ url, method: selectorResult!.method }, 'Extraction succeeded');
    return selectorResult;
  }

  // Strategy 4: Try unfluff (different heuristics, good for unusual HTML)
  const unfluffResult = tryUnfluffExtraction(html, url);
  if (meetsThreshold(unfluffResult, MIN_CONTENT_LENGTH)) {
    logger.debug({ url, method: 'unfluff' }, 'Extraction succeeded');
    return unfluffResult;
  }

  // Return best partial result if we have one
  const partialResult = readabilityResult ?? jsonLdResult ?? selectorResult ?? unfluffResult;
  if (!partialResult) {
    logger.debug({ url }, 'All extraction strategies failed');
  }
  return partialResult;
}
