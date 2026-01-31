import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseHTML } from 'linkedom';
import {
  extractPublishedTime,
  extractTitle,
  extractSiteName,
  generateExcerpt,
  tryReadability,
  trySelectorExtraction,
  tryJsonLdExtraction,
  tryNextDataExtraction,
  tryUnfluffExtraction,
  extractFromHtml,
} from '../extract/content-extractors.js';
import {
  MIN_CONTENT_LENGTH,
  GOOD_CONTENT_LENGTH,
  DEFAULT_EXCERPT_LENGTH,
} from '../extract/types.js';

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

import { sitePreferJsonLd, siteUseNextData } from '../sites/site-config.js';

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

describe('content-extractors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sitePreferJsonLd).mockReturnValue(false);
    vi.mocked(siteUseNextData).mockReturnValue(false);
  });

  describe('extractPublishedTime', () => {
    it('extracts from article:published_time meta', () => {
      const doc = makeDoc(
        '<html><head><meta property="article:published_time" content="2024-01-15T10:00:00Z"></head><body></body></html>'
      );
      expect(extractPublishedTime(doc)).toBe('2024-01-15T10:00:00Z');
    });

    it('extracts from time[datetime]', () => {
      const doc = makeDoc('<html><body><time datetime="2024-03-20">March 20</time></body></html>');
      expect(extractPublishedTime(doc)).toBe('2024-03-20');
    });

    it('extracts from meta[name=date]', () => {
      const doc = makeDoc(
        '<html><head><meta name="date" content="2024-06-01"></head><body></body></html>'
      );
      expect(extractPublishedTime(doc)).toBe('2024-06-01');
    });

    it('returns null when no date found', () => {
      const doc = makeDoc('<html><body><p>No dates here</p></body></html>');
      expect(extractPublishedTime(doc)).toBeNull();
    });
  });

  describe('extractTitle', () => {
    it('prefers og:title', () => {
      const doc = makeDoc(
        '<html><head><meta property="og:title" content="OG Title"><title>Page Title - Site</title></head><body><h1>H1 Title</h1></body></html>'
      );
      expect(extractTitle(doc)).toBe('OG Title');
    });

    it('strips suffix from title tag using dash separator', () => {
      const doc = makeDoc(
        '<html><head><title>Article Title - Example Site</title></head><body></body></html>'
      );
      expect(extractTitle(doc)).toBe('Article Title');
    });

    it('strips suffix from title tag using pipe separator', () => {
      const doc = makeDoc(
        '<html><head><title>Article Title | Example Site</title></head><body></body></html>'
      );
      expect(extractTitle(doc)).toBe('Article Title');
    });

    it('falls back to h1', () => {
      const doc = makeDoc('<html><body><h1>Heading Title</h1></body></html>');
      expect(extractTitle(doc)).toBe('Heading Title');
    });

    it('returns null when nothing found', () => {
      const doc = makeDoc('<html><body><p>No title here</p></body></html>');
      expect(extractTitle(doc)).toBeNull();
    });
  });

  describe('extractSiteName', () => {
    it('returns og:site_name when present', () => {
      const doc = makeDoc(
        '<html><head><meta property="og:site_name" content="Example News"></head><body></body></html>'
      );
      expect(extractSiteName(doc)).toBe('Example News');
    });

    it('returns null when absent', () => {
      const doc = makeDoc('<html><body></body></html>');
      expect(extractSiteName(doc)).toBeNull();
    });
  });

  describe('generateExcerpt', () => {
    it('returns existing excerpt when provided', () => {
      expect(generateExcerpt('Existing excerpt', 'Some text content')).toBe('Existing excerpt');
    });

    it('truncates long text with ellipsis', () => {
      const longText = 'a'.repeat(300);
      const result = generateExcerpt(null, longText);
      expect(result).toHaveLength(DEFAULT_EXCERPT_LENGTH + 3); // +3 for "..."
      expect(result!.endsWith('...')).toBe(true);
    });

    it('returns short text as-is', () => {
      expect(generateExcerpt(null, 'Short text')).toBe('Short text');
    });

    it('returns null when both are null', () => {
      expect(generateExcerpt(null, null)).toBeNull();
    });

    it('returns null for whitespace-only text', () => {
      expect(generateExcerpt(null, '   \n\t  ')).toBeNull();
    });
  });

  describe('tryReadability', () => {
    it('extracts well-structured article content', () => {
      const content = loremText(GOOD_CONTENT_LENGTH);
      const doc = makeDoc(
        `<html><head><title>Test Article</title></head><body><article><h1>Test Article</h1><p>${content}</p></article></body></html>`
      );
      const result = tryReadability(doc, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.method).toBe('readability');
      expect(result!.textContent!.length).toBeGreaterThanOrEqual(MIN_CONTENT_LENGTH);
    });

    it('returns null for short content', () => {
      const doc = makeDoc('<html><body><p>Short</p></body></html>');
      expect(tryReadability(doc, 'https://example.com/short')).toBeNull();
    });
  });

  describe('trySelectorExtraction', () => {
    it('extracts from article element', () => {
      const content = loremText(MIN_CONTENT_LENGTH);
      const doc = makeDoc(`<html><body><article><p>${content}</p></article></body></html>`);
      const result = trySelectorExtraction(doc, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.method).toMatch(/^selector:/);
    });

    it('removes script and nav elements', () => {
      const content = loremText(MIN_CONTENT_LENGTH);
      const doc = makeDoc(
        `<html><body><article><script>alert("x")</script><nav>Menu</nav><p>${content}</p></article></body></html>`
      );
      const result = trySelectorExtraction(doc, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.textContent).not.toContain('alert');
      expect(result!.textContent).not.toContain('Menu');
    });

    it('returns null when content is insufficient', () => {
      const doc = makeDoc('<html><body><article><p>Too short</p></article></body></html>');
      expect(trySelectorExtraction(doc, 'https://example.com/short')).toBeNull();
    });
  });

  describe('tryJsonLdExtraction', () => {
    it('extracts NewsArticle from JSON-LD', () => {
      const content = loremText(MIN_CONTENT_LENGTH);
      const doc = makeDoc(
        `<html><head><script type="application/ld+json">${JSON.stringify({
          '@type': 'NewsArticle',
          headline: 'Test Headline',
          articleBody: content,
          author: { '@type': 'Person', name: 'Jane Doe' },
        })}</script></head><body></body></html>`
      );
      const result = tryJsonLdExtraction(doc, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.method).toBe('json-ld');
      expect(result!.title).toBe('Test Headline');
      expect(result!.byline).toBe('Jane Doe');
    });

    it('extracts from @graph structure', () => {
      const content = loremText(MIN_CONTENT_LENGTH);
      const doc = makeDoc(
        `<html><head><script type="application/ld+json">${JSON.stringify({
          '@graph': [
            { '@type': 'WebSite', name: 'Example' },
            { '@type': 'Article', headline: 'Graph Article', articleBody: content },
          ],
        })}</script></head><body></body></html>`
      );
      const result = tryJsonLdExtraction(doc, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Graph Article');
    });

    it('extracts from array of objects', () => {
      const content = loremText(MIN_CONTENT_LENGTH);
      const doc = makeDoc(
        `<html><head><script type="application/ld+json">${JSON.stringify([
          { '@type': 'BlogPosting', headline: 'Blog Post', articleBody: content },
        ])}</script></head><body></body></html>`
      );
      const result = tryJsonLdExtraction(doc, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Blog Post');
    });

    it('handles string author', () => {
      const content = loremText(MIN_CONTENT_LENGTH);
      const doc = makeDoc(
        `<html><head><script type="application/ld+json">${JSON.stringify({
          '@type': 'Article',
          headline: 'Test',
          articleBody: content,
          author: 'John Smith',
        })}</script></head><body></body></html>`
      );
      const result = tryJsonLdExtraction(doc, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.byline).toBe('John Smith');
    });

    it('returns null for non-article type', () => {
      const doc = makeDoc(
        `<html><head><script type="application/ld+json">${JSON.stringify({
          '@type': 'Product',
          name: 'Widget',
        })}</script></head><body></body></html>`
      );
      expect(tryJsonLdExtraction(doc, 'https://example.com/product')).toBeNull();
    });

    it('returns null when content is too short', () => {
      const doc = makeDoc(
        `<html><head><script type="application/ld+json">${JSON.stringify({
          '@type': 'Article',
          headline: 'Short',
          articleBody: 'Too short',
        })}</script></head><body></body></html>`
      );
      expect(tryJsonLdExtraction(doc, 'https://example.com/short')).toBeNull();
    });

    it('handles invalid JSON gracefully', () => {
      const doc = makeDoc(
        '<html><head><script type="application/ld+json">{invalid json}</script></head><body></body></html>'
      );
      expect(tryJsonLdExtraction(doc, 'https://example.com/bad')).toBeNull();
    });
  });

  describe('tryNextDataExtraction', () => {
    it('extracts from full __NEXT_DATA__ structure', () => {
      const nextData = {
        props: {
          pageProps: {
            story: {
              headline: 'Next Article',
              authors: [{ name: 'Alice' }],
              abstract: ['Article abstract here'],
              publishedAt: '2024-01-01',
              body: {
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', value: loremText(MIN_CONTENT_LENGTH) }],
                  },
                ],
              },
            },
          },
        },
      };
      const doc = makeDoc(
        `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`
      );
      const result = tryNextDataExtraction(doc, 'https://example.com/next-article');
      expect(result).not.toBeNull();
      expect(result!.method).toBe('next-data');
      expect(result!.title).toBe('Next Article');
      expect(result!.byline).toBe('Alice');
    });

    it('returns null when script is missing', () => {
      const doc = makeDoc('<html><body><p>No next data</p></body></html>');
      expect(tryNextDataExtraction(doc, 'https://example.com/no-next')).toBeNull();
    });

    it('returns null when body.content is missing', () => {
      const nextData = { props: { pageProps: { story: { headline: 'Test' } } } };
      const doc = makeDoc(
        `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`
      );
      expect(tryNextDataExtraction(doc, 'https://example.com/no-body')).toBeNull();
    });

    it('skips ad and newsletter content types', () => {
      const nextData = {
        props: {
          pageProps: {
            story: {
              headline: 'Test',
              body: {
                content: [
                  { type: 'ad', content: [{ type: 'text', value: 'Buy stuff' }] },
                  { type: 'inline-newsletter', content: [{ type: 'text', value: 'Subscribe' }] },
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', value: loremText(MIN_CONTENT_LENGTH) }],
                  },
                ],
              },
            },
          },
        },
      };
      const doc = makeDoc(
        `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`
      );
      const result = tryNextDataExtraction(doc, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.textContent).not.toContain('Buy stuff');
      expect(result!.textContent).not.toContain('Subscribe');
    });
  });

  describe('tryUnfluffExtraction', () => {
    it('extracts from well-structured article HTML', () => {
      const content = loremText(GOOD_CONTENT_LENGTH);
      const html = `<html><head><title>Unfluff Test</title></head><body><article><p>${content}</p></article></body></html>`;
      const result = tryUnfluffExtraction(html, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.method).toBe('unfluff');
    });

    it('returns null for minimal HTML', () => {
      const result = tryUnfluffExtraction(
        '<html><body><p>Short</p></body></html>',
        'https://example.com/short'
      );
      expect(result).toBeNull();
    });
  });

  describe('extractFromHtml', () => {
    it('extracts with default strategy', () => {
      const content = loremText(GOOD_CONTENT_LENGTH);
      const html = `<html><head><title>Test Article</title></head><body><article><h1>Test</h1><p>${content}</p></article></body></html>`;
      const result = extractFromHtml(html, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.textContent!.length).toBeGreaterThanOrEqual(MIN_CONTENT_LENGTH);
    });

    it('uses json-ld when preferJsonLd is true', () => {
      vi.mocked(sitePreferJsonLd).mockReturnValue(true);
      const content = loremText(GOOD_CONTENT_LENGTH);
      const html = `<html><head><script type="application/ld+json">${JSON.stringify({
        '@type': 'Article',
        headline: 'JSON-LD Article',
        articleBody: content,
      })}</script></head><body></body></html>`;
      const result = extractFromHtml(html, 'https://demo.example.net/article');
      expect(result).not.toBeNull();
      expect(result!.method).toBe('json-ld');
    });

    it('uses next-data when siteUseNextData is true', () => {
      vi.mocked(siteUseNextData).mockReturnValue(true);
      const nextData = {
        props: {
          pageProps: {
            story: {
              headline: 'Next Article',
              body: {
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', value: loremText(GOOD_CONTENT_LENGTH) }],
                  },
                ],
              },
            },
          },
        },
      };
      const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`;
      const result = extractFromHtml(html, 'https://example.com/next-article');
      expect(result).not.toBeNull();
      expect(result!.method).toBe('next-data');
    });

    it('returns null when all strategies fail', () => {
      const result = extractFromHtml('<html><body></body></html>', 'https://example.com/empty');
      expect(result).toBeNull();
    });

    it('returns best partial result when no strategy meets GOOD threshold', () => {
      // Content above MIN_CONTENT_LENGTH but below GOOD_CONTENT_LENGTH
      const shortContent = loremText(MIN_CONTENT_LENGTH);
      const html = `<html><body><main><p>${shortContent}</p></main></body></html>`;
      const result = extractFromHtml(html, 'https://example.com/partial');
      expect(result).not.toBeNull();
      expect(result!.textContent!.length).toBeGreaterThanOrEqual(MIN_CONTENT_LENGTH);
    });

    it('handles multiple JSON-LD scripts, selecting the article one', () => {
      vi.mocked(sitePreferJsonLd).mockReturnValue(true);
      const content = loremText(GOOD_CONTENT_LENGTH);
      const html = `<html><head>
        <script type="application/ld+json">${JSON.stringify({ '@type': 'Organization', name: 'Example Corp' })}</script>
        <script type="application/ld+json">${JSON.stringify({ '@type': 'Article', headline: 'Found It', articleBody: content })}</script>
      </head><body></body></html>`;
      const result = extractFromHtml(html, 'https://demo.example.net/article');
      expect(result).not.toBeNull();
      expect(result!.method).toBe('json-ld');
      expect(result!.title).toBe('Found It');
    });

    it('extracts first author from JSON-LD author array', () => {
      vi.mocked(sitePreferJsonLd).mockReturnValue(true);
      const content = loremText(GOOD_CONTENT_LENGTH);
      const html = `<html><head><script type="application/ld+json">${JSON.stringify({
        '@type': 'NewsArticle',
        headline: 'Multi Author',
        articleBody: content,
        author: [
          { '@type': 'Person', name: 'Alice' },
          { '@type': 'Person', name: 'Bob' },
        ],
      })}</script></head><body></body></html>`;
      const result = extractFromHtml(html, 'https://demo.example.net/article');
      expect(result).not.toBeNull();
      expect(result!.byline).toBe('Alice');
    });
  });
});
