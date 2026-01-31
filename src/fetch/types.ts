/**
 * Shared types for the fetch module
 */
import type { AntibotDetection } from '../antibot/detector.js';

export type ValidationError =
  | 'http_status_error'
  | 'wrong_content_type'
  | 'body_too_small'
  | 'challenge_detected'
  | 'insufficient_content'
  | 'access_restricted';

export interface ValidationResult {
  valid: boolean;
  error?: ValidationError;
  errorDetails?: {
    statusCode?: number;
    contentType?: string;
    bodySize?: number;
    wordCount?: number;
    challengeType?: string;
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

  // Error fields
  error?: string;
  errorDetails?: {
    type?: string;
    statusCode?: number;
    wordCount?: number;
    challengeType?: string;
  };
  suggestedAction?: 'retry_with_extract' | 'wait_and_retry' | 'skip' | 'update_site_config';
  hint?: string;

  // Antibot detection
  antibot?: AntibotDetection[];
}
