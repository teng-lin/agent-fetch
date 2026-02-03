/**
 * Shared types, interfaces, and constants for the extract module
 */

// Extraction thresholds
export const MIN_CONTENT_LENGTH = 200;
export const GOOD_CONTENT_LENGTH = 500; // Threshold to skip fallback strategies
export const ACCESS_GATE_MIN_WORDS = 400; // Minimum words for access gate sites (higher threshold)
export const DEFAULT_EXCERPT_LENGTH = 200;
export const MAX_HTML_SIZE_BYTES = 10 * 1024 * 1024; // 10MB limit to prevent memory exhaustion

// Access gate indicators in content
export const ACCESS_GATE_INDICATORS = [
  'subscribe to continue',
  'subscribe to read',
  'subscription required',
  'sign in to read',
  'already a subscriber',
  'start your free trial',
  'this article is for subscribers',
  'bpc > try for full article',
  'unlock this article',
  'get unlimited access',
  'become a member',
  'create your free account',
  'unlock even more',
  'premium content',
  'members only',
  'join now to read',
  'register to continue',
  'log in to read',
  'preview this article',
];

// HTTP errors that are worth retrying (403 excluded - usually permanent access gate/geo-block)
export const RETRYABLE_ERRORS = [429, 500, 502, 503, 504];

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
  archiveUrl?: string | null;
}
