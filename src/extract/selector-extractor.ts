/**
 * Strategy 2: Extract using CSS selectors (like Python implementation)
 */
import { type ExtractionResult, MIN_CONTENT_LENGTH } from './types.js';
import {
  extractPublishedTime,
  extractTitle,
  extractSiteName,
  generateExcerpt,
} from './metadata-extractors.js';
import { logger } from '../logger.js';

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
