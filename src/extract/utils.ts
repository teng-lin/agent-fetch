/**
 * Utility functions for the extract module
 */
import { type ExtractionResult, ACCESS_GATE_INDICATORS } from './types.js';

/**
 * Get a nested value from an object using dot notation
 */
export function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return null;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Check if extraction result meets the content length threshold
 */
export function meetsThreshold(result: ExtractionResult | null, threshold: number): boolean {
  return result !== null && (result.textContent?.length ?? 0) >= threshold;
}

/**
 * Check if extracted content shows access gate indicators
 */
export function hasAccessGateIndicators(textContent: string | null): boolean {
  if (!textContent) return false;
  const lower = textContent.toLowerCase();
  return ACCESS_GATE_INDICATORS.some((indicator) => lower.includes(indicator));
}

/**
 * Count words in text
 */
export function countWords(text: string | null): number {
  if (!text) return 0;
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}
