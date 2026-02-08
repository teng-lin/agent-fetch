/**
 * DOM-based content extraction strategies
 *
 * Slim orchestrator: individual strategies live in dedicated sub-modules.
 * All public symbols are re-exported so existing import paths keep working.
 */
import { parseHTML } from 'linkedom';

import {
  type ExtractionResult,
  type MediaElement,
  type SelectorOptions,
  MIN_CONTENT_LENGTH,
  GOOD_CONTENT_LENGTH,
} from './types.js';
import { htmlToMarkdown } from './markdown.js';
import { meetsThreshold } from './utils.js';
import { sitePreferJsonLd, siteUseNextData } from '../sites/site-config.js';
import { tryNuxtPayloadExtraction } from './nuxt-payload.js';
import { tryReactRouterHydrationExtraction } from './react-router-hydration.js';
import { extractMediaFromElement } from './media-extractor.js';
import { logger } from '../logger.js';
import { cleanDocument } from './content-cleanup.js';

// Sub-module imports used by the orchestrator (also re-exported below)
import { tryReadability } from './readability-extractor.js';
import { trySelectorExtraction } from './selector-extractor.js';
import {
  tryJsonLdExtraction,
  detectIsAccessibleForFree,
  extractJsonLdMetadata,
} from './json-ld-extractor.js';
import { tryTextDensityExtraction } from './text-density-extractor.js';
import { tryNextRscExtraction } from './rsc-extractor.js';
import { tryNextDataExtraction } from './next-data-extractor.js';

// ── Re-exports (preserve existing import paths) ─────────────────────────
export {
  extractPublishedTime,
  extractTitle,
  extractSiteName,
  generateExcerpt,
} from './metadata-extractors.js';
export { tryReadability } from './readability-extractor.js';
export { trySelectorExtraction } from './selector-extractor.js';
export {
  tryJsonLdExtraction,
  detectIsAccessibleForFree,
  type JsonLdMetadata,
} from './json-ld-extractor.js';
export { tryTextDensityExtraction } from './text-density-extractor.js';
export { tryNextRscExtraction } from './rsc-extractor.js';
export { tryNextDataExtraction, extractNextBuildId } from './next-data-extractor.js';

/** Minimum length ratio for text-density/RSC to override Readability */
const COMPARATOR_LENGTH_RATIO = 2;

/**
 * Priority order for candidate selection in extractFromHtml.
 * Adding a new strategy = add its result to the results Map + append its name here.
 */
const CANDIDATE_PRIORITY = [
  'readability',
  'next-rsc',
  'nuxt-payload',
  'react-router-hydration',
  'next-data',
  'json-ld',
  'selector',
  'text-density',
] as const;

/** Strategies excluded from the "good candidates" tier (too noisy at threshold). */
const GOOD_CANDIDATES_EXCLUDE = new Set<string>(['selector']);

// ── Composition & markdown helpers ──────────────────────────────────────

/**
 * Compose best metadata from multiple extraction results and JSON-LD metadata.
 * Supplements missing metadata fields on the winner from other sources.
 */
function composeMetadata(
  winner: ExtractionResult,
  candidates: (ExtractionResult | null)[],
  jsonLdMeta: { byline: string | null; publishedTime: string | null } | null
): ExtractionResult {
  const composed = { ...winner };

  // First try JSON-LD metadata (richest structured source)
  if (jsonLdMeta) {
    if (!composed.byline && jsonLdMeta.byline) composed.byline = jsonLdMeta.byline;
    if (!composed.publishedTime && jsonLdMeta.publishedTime)
      composed.publishedTime = jsonLdMeta.publishedTime;
  }

  // Then try other extraction results
  for (const candidate of candidates) {
    if (!candidate || candidate === winner) continue;
    if (!composed.byline && candidate.byline) composed.byline = candidate.byline;
    if (!composed.publishedTime && candidate.publishedTime)
      composed.publishedTime = candidate.publishedTime;
    if (!composed.siteName && candidate.siteName) composed.siteName = candidate.siteName;
    if (!composed.lang && candidate.lang) composed.lang = candidate.lang;
  }
  return composed;
}

const PLAIN_TEXT_METHODS = new Set(['next-data', 'next-rsc']);

/**
 * Methods that skip post-extraction cleanup. These either produce plain text
 * (no HTML to clean) or reconstruct HTML from structured API data that won't
 * contain DOM-based noise like figcaptions, preview duplicates, or UI boilerplate.
 */
const SKIP_CLEANUP_METHODS = new Set([
  ...PLAIN_TEXT_METHODS,
  'json-ld',
  'nuxt-payload',
  'react-router-hydration',
  'wp-ajax-content',
  'prism-content-api',
]);

/**
 * Populate the `markdown` field on an ExtractionResult.
 * Plain-text methods (next-data, next-rsc) have no HTML to convert,
 * so `textContent` is used as-is. HTML-based methods get converted via Turndown.
 */
function withMarkdown(result: ExtractionResult): ExtractionResult {
  let markdown: string | null = null;
  if (PLAIN_TEXT_METHODS.has(result.method)) {
    markdown = result.textContent;
  } else if (result.content) {
    markdown = htmlToMarkdown(result.content);
  }
  return { ...result, markdown };
}

// ── WordPress detection ─────────────────────────────────────────────────

/**
 * Detect WordPress REST API availability from HTML.
 * WordPress sites with the REST API enabled include a link tag like:
 *   <link rel="alternate" type="application/json" href="/wp-json/wp/v2/posts/123" />
 * Returns the API URL if found, points to wp-json, and is same-origin as the page.
 * The same-origin check prevents SSRF via attacker-controlled href values.
 */
export function detectWpRestApi(document: Document, pageUrl: string): string | null {
  const link = document.querySelector('link[rel="alternate"][type="application/json"]');
  const href = link?.getAttribute('href');
  if (!href || !href.includes('/wp-json/')) return null;
  try {
    const apiOrigin = new URL(href).origin;
    const pageOrigin = new URL(pageUrl).origin;
    if (apiOrigin !== pageOrigin) return null;
  } catch {
    return null;
  }
  return href;
}

// ── Selector application ────────────────────────────────────────────────

/** Normalize a selector option to an array. */
function toSelectorArray(sel: string | string[] | undefined): string[] {
  if (!sel) return [];
  return Array.isArray(sel) ? sel : [sel];
}

/**
 * Apply user-provided CSS selectors to raw HTML before extraction.
 * - removeSelector: removes matching elements from the DOM
 * - targetSelector: replaces body with only matched elements (concatenated in document order)
 * Returns the modified HTML string. If targetSelector matches nothing, returns original HTML with a warning.
 */
export function applySelectors(html: string, selectors: SelectorOptions): string {
  const removes = toSelectorArray(selectors.removeSelector);
  const targets = toSelectorArray(selectors.targetSelector);

  if (removes.length === 0 && targets.length === 0) return html;

  const { document } = parseHTML(html);

  // Apply removeSelector first
  for (const selector of removes) {
    for (const el of document.querySelectorAll(selector)) {
      el.remove();
    }
  }

  // Apply targetSelector: keep only matched elements
  if (targets.length > 0) {
    const combined = targets.join(', ');
    const matched = document.querySelectorAll(combined);

    if (matched.length === 0) {
      logger.warn(
        { targetSelector: combined },
        'targetSelector matched no elements, falling back to full document'
      );
    } else {
      // Replace body content with matched elements in document order
      const body = document.body ?? document.documentElement;
      body.innerHTML = '';
      for (const el of matched) {
        body.appendChild(el.cloneNode(true));
      }
    }
  }

  return document.toString();
}

// ── Main extraction orchestrator ────────────────────────────────────────

/**
 * Multi-strategy extraction from HTML
 * Exported for testing and direct HTML extraction use cases
 * Uses linkedom for DOM parsing (crash-resistant, no CSS parsing errors)
 */
export function extractFromHtml(
  html: string,
  url: string,
  selectors?: SelectorOptions
): ExtractionResult | null {
  // Apply user-provided selectors before extraction
  if (selectors) {
    html = applySelectors(html, selectors);
  }

  const { document } = parseHTML(html);

  // Read publisher-declared schema.org access metadata from JSON-LD
  const schemaOrgAccess = detectIsAccessibleForFree(document);

  /**
   * Apply content cleanup, markdown conversion, schema.org access fields, and media extraction.
   * This runs once on the final winning extraction result (not multiple times).
   * Media is extracted from the article content HTML, not the raw page HTML.
   */
  function finalizeResult(result: ExtractionResult): ExtractionResult {
    let cleaned = result;
    let media: MediaElement[] | undefined;

    if (result.content) {
      const { document: contentDoc } = parseHTML(
        `<!DOCTYPE html><html><body>${result.content}</body></html>`
      );

      // Run post-extraction cleanup on HTML-based methods
      if (!SKIP_CLEANUP_METHODS.has(result.method)) {
        try {
          cleanDocument(contentDoc);
          cleaned = {
            ...result,
            content: contentDoc.body.innerHTML,
            textContent: contentDoc.body.textContent?.trim() ?? '',
          };
        } catch (e) {
          logger.debug({ url, method: result.method, error: String(e) }, 'Content cleanup failed');
        }
      }

      // Extract media from same parsed document (avoids second parse)
      try {
        media = extractMediaFromElement(contentDoc.body, url);
      } catch {
        // Non-critical: media extraction failure should not block content delivery
      }
    }

    const md = withMarkdown(cleaned);

    if (!schemaOrgAccess) {
      return { ...md, media };
    }
    return {
      ...md,
      media,
      isAccessibleForFree: schemaOrgAccess.isAccessibleForFree,
      declaredWordCount: schemaOrgAccess.declaredWordCount,
    };
  }

  // Run Next.js __NEXT_DATA__ extraction once (shared between fast-path and waterfall)
  const nextDataResult = tryNextDataExtraction(document, url);

  // Config-driven: Next.js early return (these sites have complete metadata)
  if (siteUseNextData(url) && meetsThreshold(nextDataResult, GOOD_CONTENT_LENGTH)) {
    logger.debug({ url, method: 'next-data' }, 'Extraction succeeded (Next.js data)');
    return finalizeResult(nextDataResult!);
  }

  // Config-driven: JSON-LD preferred sites get early return
  const preferJsonLd = sitePreferJsonLd(url);
  let jsonLdResult: ExtractionResult | null = null;

  if (preferJsonLd) {
    jsonLdResult = tryJsonLdExtraction(document, url);
    if (meetsThreshold(jsonLdResult, GOOD_CONTENT_LENGTH)) {
      logger.debug({ url, method: 'json-ld' }, 'Extraction succeeded (preferred)');
      return finalizeResult(jsonLdResult!);
    }
  }

  // Extract JSON-LD metadata for composition (lightweight, no content threshold)
  const jsonLdMeta = extractJsonLdMetadata(document);

  // Run all strategies
  const readabilityResult = tryReadability(document, url);
  if (!preferJsonLd) {
    jsonLdResult = tryJsonLdExtraction(document, url);
  }
  const selectorResult = trySelectorExtraction(document, url);
  const textDensityResult = tryTextDensityExtraction(html, url, document);
  const rscResult = tryNextRscExtraction(html, url, document);
  const nuxtResult = tryNuxtPayloadExtraction(html, url, document);
  const reactRouterResult = tryReactRouterHydrationExtraction(html, url, document);

  // Comparator: prefer text-density if it found significantly more content
  // than Readability (>2x length). Catches pages where Readability trims too aggressively.
  let effectiveReadability: ExtractionResult | null = readabilityResult;

  if (readabilityResult && textDensityResult) {
    const readLen = readabilityResult.textContent?.length ?? 0;
    const densityLen = textDensityResult.textContent?.length ?? 0;

    if (densityLen > readLen * COMPARATOR_LENGTH_RATIO && densityLen >= GOOD_CONTENT_LENGTH) {
      logger.debug(
        { url, readabilityLen: readLen, textDensityLen: densityLen },
        'Text-density found significantly more content, preferring it over Readability'
      );
      effectiveReadability = null;
    }
  }

  // Comparator: prefer RSC if it found significantly more content than Readability
  if (effectiveReadability && rscResult) {
    const readLen = effectiveReadability.textContent?.length ?? 0;
    const rscLen = rscResult.textContent?.length ?? 0;
    if (rscLen > readLen * COMPARATOR_LENGTH_RATIO && rscLen >= GOOD_CONTENT_LENGTH) {
      logger.debug(
        { url, readabilityLen: readLen, rscLen },
        'RSC found significantly more content, preferring it over Readability'
      );
      effectiveReadability = null;
    }
  }

  // Candidate results keyed by strategy name (order matches CANDIDATE_PRIORITY).
  const results = new Map<string, ExtractionResult | null>([
    ['readability', effectiveReadability],
    ['next-rsc', rscResult],
    ['nuxt-payload', nuxtResult],
    ['react-router-hydration', reactRouterResult],
    ['next-data', nextDataResult],
    ['json-ld', jsonLdResult],
    ['selector', selectorResult],
    ['text-density', textDensityResult],
  ]);

  // All results for metadata composition (use readabilityResult, not effectiveReadability,
  // so Readability's metadata remains available even when the comparator prefers text-density)
  const allResults = [
    readabilityResult,
    nextDataResult,
    jsonLdResult,
    selectorResult,
    textDensityResult,
    rscResult,
    nuxtResult,
    reactRouterResult,
  ];

  // Collect all results that meet the good content threshold
  const goodCandidates = CANDIDATE_PRIORITY.filter((n) => !GOOD_CANDIDATES_EXCLUDE.has(n))
    .map((n) => results.get(n) ?? null)
    .filter((r): r is ExtractionResult => meetsThreshold(r, GOOD_CONTENT_LENGTH));

  // If multiple strategies meet the threshold, prefer the one with the most content
  if (goodCandidates.length > 0) {
    const winner = goodCandidates.reduce((best, current) => {
      const bestLen = best.textContent?.length ?? 0;
      const currentLen = current.textContent?.length ?? 0;
      return currentLen > bestLen ? current : best;
    });
    logger.debug(
      { url, method: winner.method, contentLen: winner.textContent?.length },
      'Extraction succeeded (preferred longest)'
    );
    return finalizeResult(composeMetadata(winner, allResults, jsonLdMeta));
  }

  // Fall back to minimum threshold candidates in priority order
  const fallbackCandidates = CANDIDATE_PRIORITY.map((n) => results.get(n) ?? null);

  for (const result of fallbackCandidates) {
    if (meetsThreshold(result, MIN_CONTENT_LENGTH)) {
      logger.debug({ url, method: result!.method }, 'Extraction succeeded');
      return finalizeResult(composeMetadata(result!, allResults, jsonLdMeta));
    }
  }

  // Return best partial result with composition
  const partialResult = fallbackCandidates.find((r) => r !== null) ?? null;
  if (partialResult) {
    return finalizeResult(composeMetadata(partialResult, allResults, jsonLdMeta));
  }

  logger.debug({ url }, 'All extraction strategies failed');
  return null;
}
