import { SIGNATURES } from './signatures.js';
import type { CookiePattern, HeaderPattern, ContentPattern } from './signatures.js';

/**
 * Anti-bot detection module
 *
 * Detects which anti-bot system is blocking requests based on response headers and cookies.
 * Patterns extracted from scrapfly/Antibot-Detector (https://github.com/scrapfly/Antibot-Detector)
 *
 * @module antibot-detector
 * @version 1.0.0
 * @lastUpdated 2026-01-26
 * @source scrapfly/Antibot-Detector@2024-01-15
 */

/**
 * Suggested action when a protection is detected
 */
export type SuggestedAction =
  | 'retry-tls' // TLS fingerprint issue - retry with proper TLS fingerprint
  | 'try-archive' // Difficult protection - try archive.is/org
  | 'retry-headers' // Header issue - retry with different headers
  | 'solve-captcha' // CAPTCHA detected - use solver or try archive
  | 'give-up' // Too difficult to bypass
  | 'unknown'; // No specific recommendation

/**
 * Detection category
 */
export type DetectionCategory = 'antibot' | 'captcha' | 'fingerprint' | 'bot-detection';

/**
 * Detection result for a single anti-bot system or CAPTCHA
 */
export interface AntibotDetection {
  /** Provider identifier (e.g., 'cloudflare', 'perimeterx', 'recaptcha') */
  provider: string;
  /** Human-readable name */
  name: string;
  /** Detection category */
  category: DetectionCategory;
  /** Confidence score 0-100 */
  confidence: number;
  /** Evidence that triggered detection */
  evidence: string[];
  /** Suggested bypass action */
  suggestedAction: SuggestedAction;
}

/**
 * Test if a value matches a pattern (regex or substring/exact match).
 */
function matchesPattern(
  value: string,
  pattern: string,
  isRegex: boolean | undefined,
  mode: 'partial' | 'exact'
): boolean {
  const lowerValue = value.toLowerCase();
  const lowerPattern = pattern.toLowerCase();

  if (isRegex) {
    try {
      return new RegExp(lowerPattern, 'i').test(lowerValue);
    } catch {
      return false;
    }
  }

  return mode === 'exact' ? lowerValue === lowerPattern : lowerValue.includes(lowerPattern);
}

function matchesCookiePattern(cookieName: string, pattern: CookiePattern): boolean {
  return matchesPattern(cookieName, pattern.name, pattern.nameRegex, 'partial');
}

function matchesHeaderPattern(headerName: string, pattern: HeaderPattern): boolean {
  return matchesPattern(headerName, pattern.name, pattern.nameRegex, 'exact');
}

function matchesContentPattern(html: string, pattern: ContentPattern): boolean {
  return matchesPattern(html, pattern.text, pattern.textRegex, 'partial');
}

/**
 * Extract cookie names from Set-Cookie headers or cookie strings
 *
 * @param cookies - Array of cookie strings (from Set-Cookie headers or document.cookie)
 * @returns Array of cookie names
 */
function extractCookieNames(cookies: string[]): string[] {
  const names: string[] = [];

  for (const cookie of cookies) {
    // Handle "name=value; attributes" format
    const eqIndex = cookie.indexOf('=');
    if (eqIndex > 0) {
      names.push(cookie.substring(0, eqIndex).trim());
    }
  }

  return names;
}

/**
 * Detect anti-bot systems from response headers and cookies
 *
 * Call this function when extraction fails (403, timeout, low word count)
 * to identify which protection is blocking you.
 *
 * @param headers - Response headers as key-value pairs
 * @param cookies - Cookie strings from Set-Cookie headers or existing cookies
 * @returns Array of detected anti-bot systems, sorted by confidence (highest first)
 *
 * @example
 * ```typescript
 * const detections = detectFromResponse(
 *   { 'x-amzn-waf-action': 'block', 'content-type': 'text/html' },
 *   ['aws-waf-token=abc123; Path=/']
 * );
 * // Returns: [{ provider: 'aws-waf', name: 'AWS WAF', confidence: 100, ... }]
 * ```
 */
export function detectFromResponse(
  headers: Record<string, string>,
  cookies: string[]
): AntibotDetection[] {
  const detections: AntibotDetection[] = [];
  const cookieNames = extractCookieNames(cookies);
  const headerNames = Object.keys(headers);

  for (const signature of SIGNATURES) {
    const evidence: string[] = [];
    let maxConfidence = 0;

    // Check cookies
    for (const cookieName of cookieNames) {
      for (const pattern of signature.cookies) {
        if (matchesCookiePattern(cookieName, pattern)) {
          evidence.push(`cookie: ${cookieName}`);
          maxConfidence = Math.max(maxConfidence, pattern.confidence);
        }
      }
    }

    // Check headers
    for (const headerName of headerNames) {
      for (const pattern of signature.headers) {
        if (matchesHeaderPattern(headerName, pattern)) {
          evidence.push(`header: ${headerName}`);
          maxConfidence = Math.max(maxConfidence, pattern.confidence);
        }
      }
    }

    // If we found evidence, add detection
    if (evidence.length > 0) {
      detections.push({
        provider: signature.id,
        name: signature.name,
        category: signature.category,
        confidence: maxConfidence,
        evidence,
        suggestedAction: signature.suggestedAction,
      });
    }
  }

  // Sort by confidence (highest first)
  detections.sort((a, b) => b.confidence - a.confidence);

  return detections;
}

/**
 * Get the primary (highest confidence) detection, if any
 *
 * @param headers - Response headers
 * @param cookies - Cookie strings
 * @returns The highest confidence detection, or null if none found
 */
export function detectPrimaryAntibot(
  headers: Record<string, string>,
  cookies: string[]
): AntibotDetection | null {
  const detections = detectFromResponse(headers, cookies);
  return detections.length > 0 ? detections[0] : null;
}

/**
 * Format detection results for logging
 *
 * @param detections - Array of detections from detectFromResponse
 * @returns Human-readable string for logging
 */
export function formatDetections(detections: AntibotDetection[]): string {
  if (detections.length === 0) {
    return 'No anti-bot protection detected';
  }

  return detections
    .map(
      (d) =>
        `${d.name} (${d.confidence}% confidence, action: ${d.suggestedAction}) [${d.evidence.join(', ')}]`
    )
    .join('; ');
}

/**
 * Detect anti-bot systems from HTML content
 *
 * Call this function to analyze page HTML for anti-bot signatures.
 * Note: Higher false positive risk than cookie/header detection.
 * Use primarily for additional confirmation, not as sole signal.
 *
 * @param html - Page HTML content
 * @returns Array of detected anti-bot systems, sorted by confidence (highest first)
 *
 * @example
 * ```typescript
 * const detections = detectFromHtml('<script>window._pxAppId = "abc123"</script>');
 * // Returns: [{ provider: 'perimeterx', name: 'PerimeterX (HUMAN)', confidence: 100, ... }]
 * ```
 */
export function detectFromHtml(html: string): AntibotDetection[] {
  const detections: AntibotDetection[] = [];

  for (const signature of SIGNATURES) {
    if (signature.content.length === 0) continue;

    const evidence: string[] = [];
    let maxConfidence = 0;

    for (const pattern of signature.content) {
      if (matchesContentPattern(html, pattern)) {
        evidence.push(`content: ${pattern.description || pattern.text}`);
        maxConfidence = Math.max(maxConfidence, pattern.confidence);
      }
    }

    if (evidence.length > 0) {
      detections.push({
        provider: signature.id,
        name: signature.name,
        category: signature.category,
        confidence: maxConfidence,
        evidence,
        suggestedAction: signature.suggestedAction,
      });
    }
  }

  detections.sort((a, b) => b.confidence - a.confidence);
  return detections;
}

/**
 * Get window object paths to check for anti-bot detection
 *
 * Returns an array of {provider, paths} objects that can be used with
 * page.evaluate() to detect anti-bot systems via window object inspection.
 *
 * @returns Array of providers with their window paths to check
 *
 * @example
 * ```typescript
 * const windowChecks = getWindowObjectChecks();
 * // Use in Playwright:
 * const results = await page.evaluate((checks) => {
 *   return checks.map(check => ({
 *     provider: check.provider,
 *     detected: check.paths.some(p => {
 *       try { return eval(`typeof window.${p.path}`) !== 'undefined'; }
 *       catch { return false; }
 *     })
 *   }));
 * }, windowChecks);
 * ```
 */
export function getWindowObjectChecks(): Array<{
  provider: string;
  name: string;
  category: DetectionCategory;
  paths: Array<{ path: string; confidence: number; description?: string }>;
  suggestedAction: SuggestedAction;
}> {
  return SIGNATURES.filter((s) => s.window.length > 0).map((s) => ({
    provider: s.id,
    name: s.name,
    category: s.category,
    paths: s.window,
    suggestedAction: s.suggestedAction,
  }));
}

/**
 * Detect anti-bot systems from window object check results
 *
 * Call this after running window object checks in the browser context.
 *
 * @param results - Results from window object checks: { path: string, exists: boolean }[]
 * @returns Array of detected anti-bot systems
 *
 * @example
 * ```typescript
 * // In Playwright:
 * const windowResults = await page.evaluate(() => {
 *   const paths = ['_pxAppId', 'bmak', '__kasada', '_cf_chl_opt'];
 *   return paths.map(p => ({
 *     path: p,
 *     exists: typeof (window as any)[p] !== 'undefined'
 *   }));
 * });
 * const detections = detectFromWindowResults(windowResults);
 * ```
 */
export function detectFromWindowResults(
  results: Array<{ path: string; exists: boolean }>
): AntibotDetection[] {
  const detections: AntibotDetection[] = [];
  const existingPaths = new Set(results.filter((r) => r.exists).map((r) => r.path));

  for (const signature of SIGNATURES) {
    if (signature.window.length === 0) continue;

    const evidence: string[] = [];
    let maxConfidence = 0;

    for (const pattern of signature.window) {
      if (existingPaths.has(pattern.path)) {
        evidence.push(`window: ${pattern.description || pattern.path}`);
        maxConfidence = Math.max(maxConfidence, pattern.confidence);
      }
    }

    if (evidence.length > 0) {
      detections.push({
        provider: signature.id,
        name: signature.name,
        category: signature.category,
        confidence: maxConfidence,
        evidence,
        suggestedAction: signature.suggestedAction,
      });
    }
  }

  detections.sort((a, b) => b.confidence - a.confidence);
  return detections;
}

/**
 * Merge multiple detection arrays, combining evidence for the same provider
 *
 * @param detectionArrays - Multiple detection arrays to merge
 * @returns Merged detections with combined evidence, highest confidence wins
 */
export function mergeDetections(...detectionArrays: AntibotDetection[][]): AntibotDetection[] {
  const merged = new Map<string, AntibotDetection>();

  for (const detections of detectionArrays) {
    for (const detection of detections) {
      const existing = merged.get(detection.provider);
      if (existing) {
        // Create new object instead of mutating existing
        const combinedEvidence = [...new Set([...existing.evidence, ...detection.evidence])];
        merged.set(detection.provider, {
          ...existing,
          evidence: combinedEvidence,
          confidence: Math.max(existing.confidence, detection.confidence),
        });
      } else {
        merged.set(detection.provider, { ...detection, evidence: [...detection.evidence] });
      }
    }
  }

  const result = Array.from(merged.values());
  result.sort((a, b) => b.confidence - a.confidence);
  return result;
}

/**
 * Filter detections to only anti-bot systems (exclude CAPTCHAs)
 */
export function filterAntibotOnly(detections: AntibotDetection[]): AntibotDetection[] {
  return detections.filter((d) => d.category === 'antibot');
}

/**
 * Filter detections to only CAPTCHAs (exclude anti-bot systems)
 */
export function filterCaptchaOnly(detections: AntibotDetection[]): AntibotDetection[] {
  return detections.filter((d) => d.category === 'captcha');
}

/**
 * Check if any CAPTCHA was detected
 */
export function hasCaptcha(detections: AntibotDetection[]): boolean {
  return detections.some((d) => d.category === 'captcha');
}

/**
 * Check if any anti-bot system was detected
 */
export function hasAntibot(detections: AntibotDetection[]): boolean {
  return detections.some((d) => d.category === 'antibot');
}

/**
 * Filter detections to only fingerprint techniques
 */
export function filterFingerprintOnly(detections: AntibotDetection[]): AntibotDetection[] {
  return detections.filter((d) => d.category === 'fingerprint');
}

/**
 * Check if any fingerprinting technique was detected
 */
export function hasFingerprinting(detections: AntibotDetection[]): boolean {
  return detections.some((d) => d.category === 'fingerprint');
}

/**
 * Filter detections to only bot-detection techniques
 */
export function filterBotDetectionOnly(detections: AntibotDetection[]): AntibotDetection[] {
  return detections.filter((d) => d.category === 'bot-detection');
}

/**
 * Check if any bot-detection technique was detected
 */
export function hasBotDetection(detections: AntibotDetection[]): boolean {
  return detections.some((d) => d.category === 'bot-detection');
}
