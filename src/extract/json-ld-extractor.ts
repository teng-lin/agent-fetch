/**
 * Strategy 3: Extract from JSON-LD structured data
 */
import { type ExtractionResult, MIN_CONTENT_LENGTH } from './types.js';
import { extractPublishedTime, extractSiteName } from './metadata-extractors.js';
import { logger } from '../logger.js';

/** JSON-LD article types that contain extractable content */
const ARTICLE_TYPES = [
  'Article',
  'NewsArticle',
  'BlogPosting',
  'WebPage',
  'ReportageNewsArticle',
] as const;

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

export interface JsonLdMetadata {
  byline: string | null;
  publishedTime: string | null;
}

/**
 * Extract metadata-only fields from JSON-LD (author, dates).
 * Unlike tryJsonLdExtraction, this does NOT require articleBody to meet content threshold.
 * Used for metadata composition when another strategy wins for content.
 */
export function extractJsonLdMetadata(document: Document): JsonLdMetadata | null {
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
