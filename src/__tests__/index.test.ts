import { describe, it, expect } from 'vitest';

const EXPECTED_EXPORTS = [
  'httpFetch',
  'resolvePreset',
  'closeAllSessions',
  'extractFromHtml',
  'htmlToMarkdown',
  'extractPdfFromBuffer',
  'isPdfUrl',
  'isPdfContentType',
  'crawl',
] as const;

describe('public API exports', () => {
  it.each(EXPECTED_EXPORTS)('exports %s as a function', async (name) => {
    const mod = await import('../index.js');
    expect(typeof (mod as Record<string, unknown>)[name]).toBe('function');
  });
});
