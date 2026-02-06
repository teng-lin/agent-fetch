/**
 * Shared types, interfaces, and constants for the extract module
 */

// Extraction thresholds
export const MIN_CONTENT_LENGTH = 200;
export const GOOD_CONTENT_LENGTH = 500; // Threshold to skip fallback strategies
export const DEFAULT_EXCERPT_LENGTH = 200;
export const MAX_HTML_SIZE_BYTES = 10 * 1024 * 1024; // 10MB limit to prevent memory exhaustion

/**
 * A media element extracted from article content.
 * Discriminated union preserving document order.
 */
export type MediaElement =
  | { type: 'image'; src: string; alt?: string }
  | { type: 'document'; href: string; text?: string; extension: string }
  | { type: 'video'; src: string; provider?: string }
  | { type: 'audio'; src: string };

export interface SelectorOptions {
  targetSelector?: string | string[];
  removeSelector?: string | string[];
}

export interface ExtractionResult {
  title: string | null;
  byline: string | null;
  content: string | null;
  textContent: string | null;
  excerpt: string | null;
  siteName: string | null;
  publishedTime: string | null;
  lang: string | null;
  markdown?: string | null;
  method: string;

  // Schema.org access metadata (from publisher-embedded JSON-LD)
  isAccessibleForFree?: boolean;
  declaredWordCount?: number;

  /**
   * Media elements found in extracted content, in document order.
   */
  media?: MediaElement[];
}
