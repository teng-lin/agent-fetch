import { describe, it, expect } from 'vitest';
import {
  getNestedValue,
  meetsThreshold,
  countWords,
  sanitizeHtml,
  htmlToText,
} from '../extract/utils.js';
import type { ExtractionResult } from '../extract/types.js';

describe('extract/utils', () => {
  describe('getNestedValue', () => {
    it('returns top-level property', () => {
      expect(getNestedValue({ name: 'Alice' }, 'name')).toBe('Alice');
    });

    it('returns nested dot-path property', () => {
      expect(getNestedValue({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
    });

    it('returns undefined for missing key', () => {
      expect(getNestedValue({ a: 1 }, 'b')).toBeUndefined();
    });

    it('returns null for null object', () => {
      expect(getNestedValue(null, 'a')).toBeNull();
    });

    it('returns null for undefined object', () => {
      expect(getNestedValue(undefined, 'a')).toBeNull();
    });

    it('returns null when traversing a primitive', () => {
      expect(getNestedValue({ a: 'hello' }, 'a.b')).toBeNull();
    });

    it('returns array value at path', () => {
      const obj = { items: [1, 2, 3] };
      expect(getNestedValue(obj, 'items')).toEqual([1, 2, 3]);
    });
  });

  describe('meetsThreshold', () => {
    const makeResult = (textContent: string | null): ExtractionResult => ({
      title: null,
      byline: null,
      content: null,
      textContent,
      excerpt: null,
      siteName: null,
      publishedTime: null,
      lang: null,
      method: 'test',
    });

    it('returns true when content meets threshold', () => {
      expect(meetsThreshold(makeResult('a'.repeat(100)), 100)).toBe(true);
    });

    it('returns true when content exceeds threshold', () => {
      expect(meetsThreshold(makeResult('a'.repeat(200)), 100)).toBe(true);
    });

    it('returns false when content is below threshold', () => {
      expect(meetsThreshold(makeResult('short'), 100)).toBe(false);
    });

    it('returns false for null result', () => {
      expect(meetsThreshold(null, 100)).toBe(false);
    });

    it('returns false when textContent is null', () => {
      expect(meetsThreshold(makeResult(null), 100)).toBe(false);
    });
  });

  describe('countWords', () => {
    it('counts words in normal text', () => {
      expect(countWords('hello world foo')).toBe(3);
    });

    it('handles mixed whitespace', () => {
      expect(countWords('hello\tworld\n  foo')).toBe(3);
    });

    it('returns 0 for null', () => {
      expect(countWords(null)).toBe(0);
    });

    it('returns 0 for empty string', () => {
      expect(countWords('')).toBe(0);
    });

    it('returns 0 for whitespace-only string', () => {
      expect(countWords('   \t\n  ')).toBe(0);
    });
  });

  describe('sanitizeHtml', () => {
    it('removes script tags', () => {
      expect(sanitizeHtml('<p>Safe</p><script>alert(1)</script>')).toBe('<p>Safe</p>');
    });

    it('removes style tags', () => {
      expect(sanitizeHtml('<p>Safe</p><style>body{display:none}</style>')).toBe('<p>Safe</p>');
    });

    it('removes iframe tags', () => {
      expect(sanitizeHtml('<p>Safe</p><iframe src="https://example.com"></iframe>')).toBe(
        '<p>Safe</p>'
      );
    });

    it('strips event handler attributes', () => {
      const result = sanitizeHtml('<img src="x.jpg" onerror="alert(1)">');
      expect(result).not.toContain('onerror');
      expect(result).toContain('src="x.jpg"');
    });

    it('strips javascript: URIs', () => {
      const result = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
      expect(result).not.toContain('javascript:');
    });

    it('strips javascript: URIs with leading whitespace', () => {
      const result = sanitizeHtml('<a href="  javascript:alert(1)">click</a>');
      expect(result).not.toContain('javascript:');
    });

    it('strips vbscript: URIs', () => {
      const result = sanitizeHtml('<a href="vbscript:MsgBox(1)">click</a>');
      expect(result).not.toContain('vbscript:');
    });

    it('strips data: URIs', () => {
      const result = sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">click</a>');
      expect(result).not.toContain('data:');
    });

    it('preserves safe content', () => {
      const html = '<p>Hello <strong>world</strong></p>';
      expect(sanitizeHtml(html)).toBe(html);
    });

    it('returns original html for empty input', () => {
      expect(sanitizeHtml('')).toBe('');
    });
  });

  describe('htmlToText', () => {
    it('strips HTML tags and returns text', () => {
      expect(htmlToText('<p>Hello <strong>world</strong></p>')).toBe('Hello world');
    });

    it('returns empty string for empty input', () => {
      expect(htmlToText('')).toBe('');
    });

    it('trims whitespace', () => {
      expect(htmlToText('<p>  hello  </p>')).toBe('hello');
    });

    it('handles text-only input', () => {
      expect(htmlToText('plain text')).toBe('plain text');
    });
  });
});
