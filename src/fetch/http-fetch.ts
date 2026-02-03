/**
 * HTTP fetch logic - fast extraction with proper error handling
 */
import httpcloak from 'httpcloak';
import { httpRequest, type HttpResponse } from './http-client.js';
import { quickValidate } from './content-validator.js';
import { extractFromHtml } from '../extract/content-extractors.js';
import { fetchFromArchives } from './archive-fallback.js';
import { detectFromResponse, detectFromHtml, mergeDetections } from '../antibot/detector.js';
import { getSiteUserAgent, getSiteReferer } from '../sites/site-config.js';
import { logger } from '../logger.js';
import type { ExtractionResult } from '../extract/types.js';
import type { FetchResult, ValidationError } from './types.js';
import type { AntibotDetection } from '../antibot/detector.js';

// Minimum content length (chars) for successful extraction
const MIN_CONTENT_LENGTH = 100;

// Minimum word count to consider content complete (below this, try archive)
const MIN_GOOD_WORD_COUNT = 100;

// Retry configuration for transient network errors
const MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 1000;

// Errors that should NOT be retried even though statusCode is 0
const NON_RETRYABLE_ERRORS = new Set(['dns_rebinding_detected']);

const VALIDATION_ERROR_HINTS: Partial<Record<ValidationError, string>> = {
  challenge_detected: 'This site uses anti-bot challenges',
  access_restricted: 'This site has an access gate',
  insufficient_content: 'Content is too short, may be a stub page',
};

// Validation errors where the page may still contain extractable article content
// alongside challenge widgets or access-gate UI. These also warrant a browser retry
// when extraction fails.
const RECOVERABLE_VALIDATION_ERRORS = new Set<ValidationError>([
  'challenge_detected',
  'access_restricted',
]);

// Errors that should trigger archive fallback
const ARCHIVE_FALLBACK_ERRORS = new Set<ValidationError>([
  'challenge_detected',
  'access_restricted',
  'insufficient_content',
]);

/**
 * Select the httpcloak TLS preset that matches a mobile User-Agent string.
 * Returns undefined for desktop UAs (caller uses the default desktop preset).
 */
export function resolvePreset(userAgent: string | null): string | undefined {
  if (!userAgent) return undefined;
  if (/Android/i.test(userAgent) && /Chrome/i.test(userAgent)) {
    return httpcloak.Preset.ANDROID_CHROME_143;
  }
  if (/iPhone/i.test(userAgent) && /CriOS/i.test(userAgent)) {
    return httpcloak.Preset.IOS_CHROME_143;
  }
  if (/iPhone/i.test(userAgent) && /Safari/i.test(userAgent)) {
    return httpcloak.Preset.IOS_SAFARI_18;
  }
  return undefined;
}

/** Build a failure result with common fields pre-filled. */
function failResult(
  url: string,
  startTime: number,
  fields: Omit<FetchResult, 'success' | 'url' | 'latencyMs'>,
  statusCode?: number
): FetchResult {
  return {
    success: false,
    url,
    latencyMs: Date.now() - startTime,
    statusCode: statusCode ?? null,
    rawHtml: null,
    extractionMethod: null,
    ...fields,
  };
}

/** Build a success result from an ExtractionResult, converting nulls to undefined. */
function successResult(
  url: string,
  startTime: number,
  extracted: ExtractionResult,
  extras?: Partial<FetchResult>
): FetchResult {
  return {
    success: true,
    url,
    latencyMs: Date.now() - startTime,
    title: extracted.title ?? undefined,
    byline: extracted.byline ?? undefined,
    content: extracted.content ?? undefined,
    textContent: extracted.textContent ?? undefined,
    excerpt: extracted.excerpt ?? undefined,
    siteName: extracted.siteName ?? undefined,
    publishedTime: extracted.publishedTime ?? undefined,
    lang: extracted.lang ?? undefined,
    ...extras,
  };
}

/** Check whether an extraction result has enough text content to be useful. */
function hasEnoughContent(extracted: ExtractionResult | null): extracted is ExtractionResult {
  return !!extracted?.textContent && extracted.textContent.trim().length >= MIN_CONTENT_LENGTH;
}

/**
 * Try fetching from archive services and extracting content.
 * Returns a success FetchResult if archive content is sufficient, null otherwise.
 */
async function tryArchiveFallback(
  url: string,
  startTime: number,
  antibot?: AntibotDetection[]
): Promise<FetchResult | null> {
  try {
    const archive = await fetchFromArchives(url);
    if (!archive.success || !archive.html) return null;

    const extracted = extractFromHtml(archive.html, url);
    if (!hasEnoughContent(extracted)) return null;

    logger.info(
      { url, archiveUrl: archive.archiveUrl, method: extracted.method },
      'Recovered content from archive'
    );

    return {
      ...successResult(url, startTime, extracted, { antibot }),
      archiveUrl: archive.archiveUrl,
      statusCode: null,
      rawHtml: null,
      extractionMethod: extracted.method ?? null,
    };
  } catch (error) {
    logger.debug({ url, error: String(error) }, 'Archive fallback failed');
    return null;
  }
}

/**
 * Build site-specific request headers (User-Agent, Referer) for a URL.
 */
function buildSiteHeaders(url: string): Record<string, string> {
  const headers: Record<string, string> = {};

  const ua = getSiteUserAgent(url);
  if (ua) headers['User-Agent'] = ua;

  const referer = getSiteReferer(url);
  if (referer) headers['Referer'] = referer;

  return headers;
}

/**
 * Map antibot detector's suggested action to FetchResult's action type.
 */
function mapAction(action: string): FetchResult['suggestedAction'] {
  if (action === 'give-up') return 'skip';
  if (action === 'retry-headers') return 'wait_and_retry';
  return 'retry_with_extract'; // retry-tls, try-archive, solve-captcha
}

/**
 * Run antibot detection on response headers, cookies, and HTML content.
 */
function runAntibotDetection(
  headers: Record<string, string>,
  cookies: Array<{ name: string; value: string }>,
  html?: string
): AntibotDetection[] {
  const cookieStrings = cookies.map((c) => `${c.name}=${c.value}`);
  const responseDetections = detectFromResponse(headers, cookieStrings);
  const htmlDetections = html ? detectFromHtml(html) : [];
  return mergeDetections(responseDetections, htmlDetections);
}

/** Check if a failed response is a transient network error worth retrying. */
function isRetryableError(response: HttpResponse): boolean {
  return (
    !response.success &&
    response.statusCode === 0 &&
    !NON_RETRYABLE_ERRORS.has(response.error ?? '')
  );
}

/** Exponential backoff delay for a given retry attempt (0-indexed). */
function retryDelay(attempt: number): number {
  return BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
}

/**
 * Perform fast HTTP-only extraction.
 * Returns extracted content on success, clear error with suggested action on failure.
 */

/**
 * Options for httpFetch
 */
export interface HttpFetchOptions {
  /**
   * HTTP Cloak TLS preset (e.g. 'chrome-143', 'android-chrome-143', 'ios-safari-18')
   * If not provided, automatically resolved from User-Agent or defaults to Chrome.
   */
  preset?: string;
}

export async function httpFetch(url: string, options: HttpFetchOptions = {}): Promise<FetchResult> {
  const startTime = Date.now();

  // Use provided preset or resolve from UA
  const preset = options.preset ?? resolvePreset(getSiteUserAgent(url));

  try {
    logger.info({ url }, 'HTTP fetch starting');

    let response: HttpResponse;
    let attempt = 0;

    while (true) {
      response = await httpRequest(url, buildSiteHeaders(url), preset);

      if (!isRetryableError(response) || attempt >= MAX_RETRIES) break;

      attempt++;
      const delay = retryDelay(attempt - 1);
      logger.info({ url, attempt, delay }, 'Retrying after network error');
      await new Promise((r) => setTimeout(r, delay));
    }

    // Run antibot detection on every response
    const antibot = runAntibotDetection(response.headers, response.cookies, response.html);
    const antibotField = antibot.length > 0 ? antibot : undefined;

    if (!response.success || !response.html) {
      if (response.statusCode === 429) {
        return failResult(
          url,
          startTime,
          {
            error: 'rate_limited',
            errorDetails: { statusCode: response.statusCode },
            suggestedAction: 'wait_and_retry',
            hint: 'Too many requests, wait before retrying',
            antibot: antibotField,
          },
          response.statusCode
        );
      }

      // Try archive fallback for 403 (paywall/geo-block often has archived content)
      if (response.statusCode === 403) {
        const archiveResult = await tryArchiveFallback(url, startTime, antibotField);
        if (archiveResult) return archiveResult;
      }

      // Let high-confidence antibot detection override the default suggested action
      const actionable = antibot.find((d) => d.confidence >= 90 && d.suggestedAction !== 'unknown');
      const defaultAction = response.statusCode === 403 ? 'retry_with_extract' : 'skip';

      return failResult(
        url,
        startTime,
        {
          error: response.error || 'http_error',
          errorDetails: { statusCode: response.statusCode },
          suggestedAction: actionable ? mapAction(actionable.suggestedAction) : defaultAction,
          hint: response.statusCode === 403 ? 'Site may require browser rendering' : undefined,
          antibot: antibotField,
        },
        response.statusCode
      );
    }

    // Validate content
    const validation = quickValidate(
      response.html,
      response.statusCode,
      response.headers['content-type']
    );

    if (!validation.valid) {
      // For challenge/access-gate pages, still attempt extraction — many sites serve
      // full article content alongside challenge widgets or paywall UI elements.
      if (RECOVERABLE_VALIDATION_ERRORS.has(validation.error!)) {
        try {
          logger.info(
            { url, validationError: validation.error },
            'Validation flagged issue, attempting extraction anyway'
          );
          const recovered = extractFromHtml(response.html, url);
          if (hasEnoughContent(recovered)) {
            logger.info(
              { url, method: recovered.method },
              'Recovered content despite validation warning'
            );
            return successResult(url, startTime, recovered, { antibot: antibotField });
          }
        } catch (e) {
          logger.debug({ url, error: String(e) }, 'Recovery extraction failed');
        }
      }

      // Try archive fallback for recoverable validation errors
      if (ARCHIVE_FALLBACK_ERRORS.has(validation.error!)) {
        const archiveResult = await tryArchiveFallback(url, startTime, antibotField);
        if (archiveResult) return archiveResult;
      }

      return failResult(
        url,
        startTime,
        {
          error: validation.error,
          errorDetails: validation.errorDetails,
          suggestedAction: RECOVERABLE_VALIDATION_ERRORS.has(validation.error!)
            ? 'retry_with_extract'
            : 'skip',
          hint: VALIDATION_ERROR_HINTS[validation.error!],
          antibot: antibotField,
        },
        response.statusCode
      );
    }

    // Extract content
    const extracted = extractFromHtml(response.html, url);

    if (!extracted) {
      // Try archive fallback when extraction returns null
      const archiveResult = await tryArchiveFallback(url, startTime, antibotField);
      if (archiveResult) return archiveResult;

      return failResult(
        url,
        startTime,
        {
          error: 'extraction_failed',
          errorDetails: { type: 'null_result' },
          suggestedAction: 'retry_with_extract',
          hint: 'Failed to parse HTML',
          antibot: antibotField,
        },
        response.statusCode
      );
    }

    // Handle insufficient extracted content
    if (!extracted.textContent || extracted.textContent.trim().length < MIN_CONTENT_LENGTH) {
      // Try archive fallback for insufficient content
      const archiveResult = await tryArchiveFallback(url, startTime, antibotField);
      if (archiveResult) return archiveResult;

      const wordCount = extracted.textContent ? extracted.textContent.split(/\s+/).length : 0;
      return failResult(
        url,
        startTime,
        {
          error: 'insufficient_content',
          errorDetails: { wordCount },
          suggestedAction: 'retry_with_extract',
          hint: 'Extracted content too short',
          antibot: antibotField,
        },
        response.statusCode
      );
    }

    // Try archive if extraction succeeded but content looks like a stub/teaser
    const wordCount = extracted.textContent!.split(/\s+/).length;
    if (wordCount < MIN_GOOD_WORD_COUNT) {
      logger.debug({ url, wordCount }, 'Low word count, trying archive for fuller content');
      const archiveResult = await tryArchiveFallback(url, startTime, antibotField);
      if (archiveResult) return archiveResult;
    }

    const latencyMs = Date.now() - startTime;
    logger.info({ url, latencyMs }, 'HTTP fetch succeeded');

    return successResult(url, startTime, extracted, {
      latencyMs,
      antibot: antibotField,
      statusCode: response.statusCode,
      rawHtml: process.env.RECORD_HTML === 'true' ? response.html : null,
      extractionMethod: extracted.method ?? null,
    });
  } catch (error) {
    logger.error({ url, error: String(error) }, 'HTTP fetch failed');

    return failResult(url, startTime, {
      error: 'network_error',
      errorDetails: { type: String(error) },
      suggestedAction: 'retry_with_extract',
      hint: 'Network request failed',
    });
  }
}
