/**
 * Shared types, interfaces, and constants for the extract module
 */

// Extraction thresholds
export const MIN_CONTENT_LENGTH = 200;
export const GOOD_CONTENT_LENGTH = 500; // Threshold to skip fallback strategies
export const DEFAULT_EXCERPT_LENGTH = 200;
export const MAX_HTML_SIZE_BYTES = 10 * 1024 * 1024; // 10MB limit to prevent memory exhaustion

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
}
