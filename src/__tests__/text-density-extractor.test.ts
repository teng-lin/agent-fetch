import { describe, it, expect, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { tryTextDensityExtraction } from '../extract/text-density-extractor.js';
import { MIN_CONTENT_LENGTH, DEFAULT_EXCERPT_LENGTH } from '../extract/types.js';
import { loremText } from './test-helpers.js';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('text-density-extractor', () => {
  describe('tryTextDensityExtraction — success path', () => {
    it('returns ExtractionResult with method text-density for sufficient content', () => {
      const content = loremText(500);
      const html = `<html><head><title>Test Article</title></head><body><article><h1>Test</h1><p>${content}</p></article></body></html>`;
      const result = tryTextDensityExtraction(html, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.method).toBe('text-density');
      expect(result!.textContent!.length).toBeGreaterThanOrEqual(MIN_CONTENT_LENGTH);
    });

    it('populates content from contentHtmls', () => {
      const content = loremText(500);
      const html = `<html><body><article><p>${content}</p></article></body></html>`;
      const result = tryTextDensityExtraction(html, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.content).toBeTruthy();
      // content (HTML) should differ from textContent (plain text)
      expect(result!.content).not.toBe(result!.textContent);
    });

    it('sets byline to null', () => {
      const content = loremText(500);
      const html = `<html><body><article><p>${content}</p></article></body></html>`;
      const result = tryTextDensityExtraction(html, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.byline).toBeNull();
    });
  });

  describe('metadata extraction', () => {
    it('extracts title from og:title', () => {
      const content = loremText(500);
      const html = `<html><head><meta property="og:title" content="OG Title"></head><body><article><p>${content}</p></article></body></html>`;
      const result = tryTextDensityExtraction(html, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('OG Title');
    });

    it('extracts siteName from og:site_name', () => {
      const content = loremText(500);
      const html = `<html><head><meta property="og:site_name" content="My Site"></head><body><article><p>${content}</p></article></body></html>`;
      const result = tryTextDensityExtraction(html, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.siteName).toBe('My Site');
    });

    it('extracts publishedTime from article:published_time', () => {
      const content = loremText(500);
      const html = `<html><head><meta property="article:published_time" content="2024-06-01T12:00:00Z"></head><body><article><p>${content}</p></article></body></html>`;
      const result = tryTextDensityExtraction(html, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.publishedTime).toBe('2024-06-01T12:00:00Z');
    });

    it('extracts lang from html lang attribute', () => {
      const content = loremText(500);
      const html = `<html lang="en"><body><article><p>${content}</p></article></body></html>`;
      const result = tryTextDensityExtraction(html, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.lang).toBe('en');
    });

    it('returns null for lang when html has no lang attribute', () => {
      const content = loremText(500);
      const html = `<html><body><article><p>${content}</p></article></body></html>`;
      const result = tryTextDensityExtraction(html, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.lang).toBeNull();
    });
  });

  describe('excerpt generation', () => {
    it('generates excerpt from extracted content', () => {
      const content = loremText(500);
      const html = `<html><body><article><p>${content}</p></article></body></html>`;
      const result = tryTextDensityExtraction(html, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.excerpt).toBeTruthy();
      expect(result!.excerpt!.length).toBeLessThanOrEqual(DEFAULT_EXCERPT_LENGTH + 3); // +3 for "..."
    });
  });

  describe('insufficient content', () => {
    it('returns null for short HTML (<200 chars text)', () => {
      const html = '<html><body><p>Too short</p></body></html>';
      expect(tryTextDensityExtraction(html, 'https://example.com/short')).toBeNull();
    });

    it('returns null for empty HTML', () => {
      const html = '';
      expect(tryTextDensityExtraction(html, 'https://example.com/empty')).toBeNull();
    });

    it('returns null for empty body', () => {
      const html = '<html><body></body></html>';
      expect(tryTextDensityExtraction(html, 'https://example.com/empty')).toBeNull();
    });
  });

  describe('pre-parsed document', () => {
    it('uses pre-parsed document instead of re-parsing', () => {
      const content = loremText(500);
      const html = `<html lang="fr"><head><meta property="og:title" content="Parsed Title"></head><body><article><p>${content}</p></article></body></html>`;
      const doc = parseHTML(html).document;

      const result = tryTextDensityExtraction(html, 'https://example.com/article', doc);
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Parsed Title');
      expect(result!.lang).toBe('fr');
    });
  });

  describe('error handling', () => {
    it('returns null when extractContent throws', () => {
      // Pass something that will cause extractContent to fail
      // @ts-expect-error — intentionally passing invalid type to trigger catch block
      const result = tryTextDensityExtraction(null, 'https://example.com/error');
      expect(result).toBeNull();
    });

    it('returns null when extractContent throws on undefined', () => {
      // @ts-expect-error — intentionally passing invalid type
      const result = tryTextDensityExtraction(undefined, 'https://example.com/error');
      expect(result).toBeNull();
    });
  });
});
