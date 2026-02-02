/**
 * Tests for Readability progressive relaxation (the two-pass logic in tryReadability).
 *
 * These tests mock @mozilla/readability to control strict vs relaxed pass behavior,
 * which cannot be done in the main test file since ESM exports are not configurable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseHTML } from 'linkedom';
import { GOOD_CONTENT_LENGTH } from '../extract/types.js';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../sites/site-config.js', () => ({
  sitePreferJsonLd: vi.fn(() => false),
  siteUseNextData: vi.fn(() => false),
}));

const { mockReadabilityClass } = vi.hoisted(() => ({
  mockReadabilityClass: vi.fn(),
}));
vi.mock('@mozilla/readability', () => ({
  Readability: mockReadabilityClass,
}));

// Import tryReadability AFTER mocking
import { tryReadability } from '../extract/content-extractors.js';

/** Generate lorem-ish text of at least n characters */
function loremText(n: number): string {
  const base =
    'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ';
  let text = '';
  while (text.length < n) text += base;
  return text;
}

function makeDoc(html: string): Document {
  return parseHTML(html).document;
}

function makeParseResult(textContent: string | null) {
  if (textContent === null) return null;
  return {
    textContent,
    title: 'Mock Title',
    content: textContent,
    byline: null,
    excerpt: null,
    siteName: null,
    publishedTime: null,
    lang: null,
  };
}

describe('tryReadability relaxed path', () => {
  beforeEach(() => {
    mockReadabilityClass.mockReset();
  });

  it('returns readability-relaxed when strict pass returns short content', () => {
    const goodText = loremText(GOOD_CONTENT_LENGTH);
    let callCount = 0;

    mockReadabilityClass.mockImplementation(function (this: unknown) {
      callCount++;
      const text = callCount === 1 ? 'Too short' : goodText;
      return { parse: () => makeParseResult(text) };
    });

    const doc = makeDoc('<html><body><article><p>Content</p></article></body></html>');
    const result = tryReadability(doc, 'https://example.com/article');

    expect(result).not.toBeNull();
    expect(result!.method).toBe('readability-relaxed');
    expect(result!.textContent).toBe(goodText);
    expect(callCount).toBe(2);

    // Verify the second call used charThreshold: 100
    const secondCallArgs = mockReadabilityClass.mock.calls[1];
    expect(secondCallArgs[1]).toEqual({ charThreshold: 100 });
  });

  it('returns readability when strict pass succeeds', () => {
    const goodText = loremText(GOOD_CONTENT_LENGTH);

    mockReadabilityClass.mockImplementation(function (this: unknown) {
      return { parse: () => makeParseResult(goodText) };
    });

    const doc = makeDoc('<html><body><article><p>Content</p></article></body></html>');
    const result = tryReadability(doc, 'https://example.com/article');

    expect(result).not.toBeNull();
    expect(result!.method).toBe('readability');
    expect(mockReadabilityClass).toHaveBeenCalledTimes(1);
  });

  it('returns null when both passes return short content', () => {
    mockReadabilityClass.mockImplementation(function (this: unknown) {
      return { parse: () => makeParseResult('Tiny') };
    });

    const doc = makeDoc('<html><body><p>Short</p></body></html>');
    const result = tryReadability(doc, 'https://example.com/short');

    expect(result).toBeNull();
    expect(mockReadabilityClass).toHaveBeenCalledTimes(2);
  });

  it('returns null when both passes return null from parse', () => {
    mockReadabilityClass.mockImplementation(function (this: unknown) {
      return { parse: () => null };
    });

    const doc = makeDoc('<html><body></body></html>');
    const result = tryReadability(doc, 'https://example.com/empty');

    expect(result).toBeNull();
    expect(mockReadabilityClass).toHaveBeenCalledTimes(2);
  });

  it('strict pass gets no options, relaxed pass gets charThreshold: 100', () => {
    const goodText = loremText(GOOD_CONTENT_LENGTH);
    let callCount = 0;

    mockReadabilityClass.mockImplementation(function (this: unknown) {
      callCount++;
      const text = callCount === 1 ? null : goodText;
      return { parse: () => makeParseResult(text) };
    });

    const doc = makeDoc('<html><body><p>Content</p></body></html>');
    tryReadability(doc, 'https://example.com/test');

    // First call: strict pass, no options object for charThreshold
    const firstCallArgs = mockReadabilityClass.mock.calls[0];
    expect(firstCallArgs.length).toBe(1); // Just the document, no options

    // Second call: relaxed pass, charThreshold: 100
    const secondCallArgs = mockReadabilityClass.mock.calls[1];
    expect(secondCallArgs[1]).toEqual({ charThreshold: 100 });
  });
});
