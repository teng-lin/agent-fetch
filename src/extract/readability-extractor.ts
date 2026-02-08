/**
 * Strategy 1: Extract using Mozilla Readability
 */
import { Readability } from '@mozilla/readability';

import { type ExtractionResult, type ExtractionMethod, MIN_CONTENT_LENGTH } from './types.js';
import {
  extractPublishedTime,
  extractTitle,
  extractSiteName,
  generateExcerpt,
} from './metadata-extractors.js';
import { logger } from '../logger.js';

/**
 * Build an ExtractionResult from a Readability article and the original document.
 */
function buildReadabilityResult(
  article: ReturnType<Readability<string>['parse']>,
  document: Document,
  method: ExtractionMethod
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
