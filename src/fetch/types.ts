/**
 * Shared types for the fetch module
 */
import type { MediaElement } from '../extract/types.js';

export type ValidationError =
  | 'http_status_error'
  | 'wrong_content_type'
  | 'body_too_small'
  | 'insufficient_content';

export interface ValidationResult {
  valid: boolean;
  error?: ValidationError;
  errorDetails?: {
    statusCode?: number;
    contentType?: string;
    bodySize?: number;
    wordCount?: number;
  };
}

export interface FetchResult {
  success: boolean;
  url: string;
  latencyMs: number;

  // Success fields
  title?: string;
  byline?: string;
  content?: string;
  textContent?: string;
  excerpt?: string;
  siteName?: string;
  publishedTime?: string;
  lang?: string;
  markdown?: string;

  // Schema.org access metadata (from publisher-embedded JSON-LD)
  isAccessibleForFree?: boolean;
  declaredWordCount?: number;
  extractedWordCount?: number;

  /**
   * Media elements found in extracted content, in document order.
   * Includes images, documents (PDF, Office, etc.), and optionally video/audio.
   * URLs are resolved to absolute.
   */
  media?: MediaElement[];

  // Error fields
  error?: string;
  errorDetails?: {
    type?: string;
    statusCode?: number;
    wordCount?: number;
  };
  suggestedAction?: 'retry_with_extract' | 'wait_and_retry' | 'skip';
  hint?: string;

  // E2E recording fields
  statusCode?: number | null; // HTTP response status (200, 403, 429, etc.)
  rawHtml?: string | null; // Raw HTML response body
  extractionMethod?: string | null; // Which strategy won: 'readability' | 'json-ld' | etc.
}
