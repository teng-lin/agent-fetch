/**
 * Content validation logic for HTTP probe
 */
import type { ValidationResult } from './types.js';

// Conservative thresholds based on e2e test analysis
const MIN_WORD_COUNT = 100;
const MIN_BODY_SIZE = 5 * 1024; // 5KB

function countWords(text: string | null): number {
  if (!text) return 0;
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

/**
 * Quickly validate if HTTP response contains valid article content.
 * Checks 5 signals in order, bailing early on failure.
 */
export function quickValidate(
  html: string,
  statusCode: number,
  contentType?: string | string[]
): ValidationResult {
  // Check 1: HTTP status (200-299)
  if (statusCode < 200 || statusCode >= 300) {
    return {
      valid: false,
      error: 'http_status_error',
      errorDetails: { statusCode },
    };
  }

  // Check 2: Content-Type (should be text/html)
  if (contentType) {
    // Handle both string and array (HTTP headers can be arrays)
    const ctValue = Array.isArray(contentType) ? contentType[0] : contentType;
    if (ctValue && !ctValue.toLowerCase().includes('text/html')) {
      return {
        valid: false,
        error: 'wrong_content_type',
        errorDetails: { contentType: ctValue },
      };
    }
  }

  // Check 3: Body size (>5KB to filter out stub pages)
  const bodySize = Buffer.byteLength(html, 'utf8');
  if (bodySize < MIN_BODY_SIZE) {
    return {
      valid: false,
      error: 'body_too_small',
      errorDetails: { bodySize },
    };
  }

  // Check 4: Extract text content and count words
  // Quick and dirty: strip HTML tags, decode common entities
  const textContent = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .trim();

  const wordCount = countWords(textContent);

  if (wordCount < MIN_WORD_COUNT) {
    return {
      valid: false,
      error: 'insufficient_content',
      errorDetails: { wordCount },
    };
  }

  return { valid: true };
}
