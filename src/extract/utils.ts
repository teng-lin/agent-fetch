/**
 * Utility functions for the extract module
 */
import { parseHTML } from 'linkedom';

import { type ExtractionResult } from './types.js';

/**
 * Get a nested value from an object using dot notation
 */
export function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') {
      return null;
    }
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
 * Count words in text
 */
export function countWords(text: string | null): number {
  if (!text) return 0;
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

/** Elements to strip from API-sourced HTML. */
export const DANGEROUS_SELECTORS = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'applet',
  'base',
  'link',
  'meta',
  'svg',
  'math',
  'form',
  'template',
] as const;

/**
 * Remove dangerous elements, event handler attributes, and dangerous URI schemes from HTML.
 */
export function sanitizeHtml(html: string): string {
  const { document } = parseHTML(`<div>${html}</div>`);
  for (const selector of DANGEROUS_SELECTORS) {
    for (const el of document.querySelectorAll(selector)) {
      el.remove();
    }
  }
  for (const el of document.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (
        /^on/i.test(attr.name) ||
        attr.name.toLowerCase() === 'formaction' ||
        /^(javascript|vbscript|data):/i.test(String(attr.value).replace(/\s/g, ''))
      ) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return document.querySelector('div')?.innerHTML ?? html;
}

/** Strip HTML tags and return plain text content. */
export function htmlToText(html: string): string {
  const { document } = parseHTML(`<div>${html}</div>`);
  return document.querySelector('div')?.textContent?.trim() ?? '';
}
