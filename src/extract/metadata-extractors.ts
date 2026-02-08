/**
 * Metadata extraction helpers: title, site name, published time, excerpt.
 */
import { DEFAULT_EXCERPT_LENGTH } from './types.js';

// Selectors for finding published time
const PUBLISHED_TIME_SELECTORS = [
  'meta[property="article:published_time"]',
  'meta[name="pubdate"]',
  'meta[name="publishdate"]',
  'meta[name="date"]',
  'time[datetime]',
];

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
