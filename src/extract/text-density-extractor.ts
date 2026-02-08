/**
 * Strategy 5: Extract using text density analysis (CETD algorithm).
 * Statistical approach based on text-to-tag density ratios per DOM node.
 * Complementary to Readability's heuristic class/id scoring.
 */
import { parseHTML } from 'linkedom';
import { extractContent } from '@wrtnlabs/web-content-extractor';

import { type ExtractionResult, MIN_CONTENT_LENGTH } from './types.js';
import {
  extractPublishedTime,
  extractTitle,
  extractSiteName,
  generateExcerpt,
} from './metadata-extractors.js';
import { logger } from '../logger.js';

export function tryTextDensityExtraction(
  html: string,
  url: string,
  document?: Document
): ExtractionResult | null {
  try {
    const extracted = extractContent(html);

    if (extracted.content.length < MIN_CONTENT_LENGTH) {
      return null;
    }

    const doc = document ?? parseHTML(html).document;

    return {
      title: extractTitle(doc),
      byline: null,
      content: extracted.contentHtmls.join(''),
      textContent: extracted.content,
      excerpt: generateExcerpt(extracted.description ?? null, extracted.content),
      siteName: extractSiteName(doc),
      publishedTime: extractPublishedTime(doc),
      lang: doc.documentElement.lang || null,
      method: 'text-density',
    };
  } catch (e) {
    logger.debug({ url, error: String(e) }, 'Text density extraction failed');
    return null;
  }
}
