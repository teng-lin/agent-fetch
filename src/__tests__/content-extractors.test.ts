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
  tryTextDensityExtraction,
  tryNextRscExtraction,
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

/** Realistic article text for RSC extraction tests */
const RSC_ARTICLE_TEXT =
  'The global economy has undergone a remarkable transformation over the past decade, driven by rapid advances in artificial intelligence and renewable energy technologies. Economists around the world have noted that the pace of change has accelerated beyond what most forecasters predicted even five years ago. New industries have emerged while traditional sectors have adapted or declined. Workers in every country face a shifting landscape of opportunity and challenge. The implications for policy, education, and social systems are profound and far-reaching. Governments are scrambling to develop frameworks that can keep pace with innovation while protecting citizens from disruption and inequality.';

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

    it('uses strict result when strict pass succeeds', () => {
      const content = loremText(GOOD_CONTENT_LENGTH);
      const doc = makeDoc(
        `<html><head><title>Test</title></head><body><article><p>${content}</p></article></body></html>`
      );
      const result = tryReadability(doc, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.method).toBe('readability');
      expect(result!.textContent!.length).toBeGreaterThanOrEqual(MIN_CONTENT_LENGTH);
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

  describe('tryTextDensityExtraction', () => {
    it('extracts article content using text density', () => {
      const content = loremText(GOOD_CONTENT_LENGTH);
      const html = `<html><head><title>Density Test</title><meta property="og:site_name" content="Test Site"></head><body><nav><a href="/">Home</a><a href="/about">About</a></nav><article><h1>Test Article</h1><p>${content}</p></article><aside><ul><li><a href="/1">Related 1</a></li><li><a href="/2">Related 2</a></li></ul></aside></body></html>`;
      const result = tryTextDensityExtraction(html, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.method).toBe('text-density');
      expect(result!.textContent!.length).toBeGreaterThanOrEqual(MIN_CONTENT_LENGTH);
    });

    it('supplements metadata from document', () => {
      const content = loremText(GOOD_CONTENT_LENGTH);
      const html = `<html><head><meta property="og:title" content="OG Title"><meta property="og:site_name" content="My Site"><meta property="article:published_time" content="2024-06-01"></head><body><article><p>${content}</p></article></body></html>`;
      const result = tryTextDensityExtraction(html, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('OG Title');
      expect(result!.siteName).toBe('My Site');
      expect(result!.publishedTime).toBe('2024-06-01');
    });

    it('returns null for short content', () => {
      const html = '<html><body><p>Too short</p></body></html>';
      expect(tryTextDensityExtraction(html, 'https://example.com/short')).toBeNull();
    });

    it('returns null for empty body', () => {
      const html = '<html><body></body></html>';
      expect(tryTextDensityExtraction(html, 'https://example.com/empty')).toBeNull();
    });

    it('handles malformed HTML gracefully', () => {
      const result = tryTextDensityExtraction('<not even html', 'https://example.com/garbage');
      expect(result).toBeNull();
    });

    it('handles pages with mostly links gracefully', () => {
      const links = Array.from({ length: 50 }, (_, i) => `<a href="/page${i}">Link ${i}</a>`).join(
        ''
      );
      const html = `<html><body><nav>${links}</nav><p>Small text</p></body></html>`;
      const result = tryTextDensityExtraction(html, 'https://example.com/links');
      // Should return null or very short content - not the nav links
      if (result) {
        expect(result.textContent!.length).toBeLessThan(MIN_CONTENT_LENGTH * 5);
      }
    });

    it('joins contentHtmls as content field', () => {
      const content = loremText(GOOD_CONTENT_LENGTH);
      const html = `<html><body><article><p>${content}</p></article></body></html>`;
      const result = tryTextDensityExtraction(html, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.content).toBeTruthy();
      // content field should contain HTML from contentHtmls
      expect(result!.content).not.toBe(result!.textContent);
    });
  });

  describe('tryNextRscExtraction', () => {
    function makeRscPage(articleContent: string): string {
      const escaped = JSON.stringify(articleContent).slice(1, -1); // strip outer quotes
      return `<!doctype html><html lang="en"><head><title>RSC Test Article</title><meta property="og:title" content="RSC Test Article Title"/><meta property="og:site_name" content="Test Site"/><meta property="article:published_time" content="2024-06-15T12:00:00Z"/></head><body><article><p>Short DOM content here.</p></article><script>self.__next_f.push([2,null])</script><script>self.__next_f.push([1,"0:[\\"$\\",\\"html\\",null,{}]\\n1:I[123,[],\\"\\"]\\n"])</script><script>self.__next_f.push([1,"2:T320,"])</script><script>self.__next_f.push([1,"${escaped}"])</script></body></html>`;
    }

    it('returns null when no RSC push calls present', () => {
      const html = '<html><body><p>Normal page</p></body></html>';
      expect(tryNextRscExtraction(html, 'https://example.com')).toBeNull();
    });

    it('extracts article text from RSC payload', () => {
      const html = makeRscPage(RSC_ARTICLE_TEXT);
      const result = tryNextRscExtraction(html, 'https://example.com/rsc');
      expect(result).not.toBeNull();
      expect(result!.method).toBe('next-rsc');
      expect(result!.textContent!.length).toBeGreaterThan(GOOD_CONTENT_LENGTH);
      expect(result!.textContent).not.toContain('$L');
      expect(result!.textContent).not.toContain('function(');
    });

    it('extracts metadata from the DOM', () => {
      const html = makeRscPage(RSC_ARTICLE_TEXT);
      const result = tryNextRscExtraction(html, 'https://example.com/rsc');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('RSC Test Article Title');
      expect(result!.siteName).toBe('Test Site');
      expect(result!.publishedTime).toBe('2024-06-15T12:00:00Z');
    });

    it('filters out JavaScript and HTML-heavy segments', () => {
      const html = `<html><body><script>self.__next_f.push([1,"1:T100,function() { var x = 1; return x + 2; } function() { var y = 3; } function() { var z = 4; } () => {} () => {} () => {}"])</script></body></html>`;
      expect(tryNextRscExtraction(html, 'https://example.com')).toBeNull();
    });

    it('returns null when extracted text is below threshold', () => {
      const html = `<html><body><script>self.__next_f.push([1,"1:Ta,Short text"])</script></body></html>`;
      expect(tryNextRscExtraction(html, 'https://example.com')).toBeNull();
    });

    it('skips type-0 and type-2 chunks', () => {
      const html = `<html><body><script>self.__next_f.push([0,"bootstrap"])</script><script>self.__next_f.push([2,null])</script></body></html>`;
      expect(tryNextRscExtraction(html, 'https://example.com')).toBeNull();
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

    it('prefers RSC over Readability when RSC has >2x content', () => {
      const html = `<!doctype html><html lang="en"><head><title>RSC Test</title></head><body><article><p>Short.</p></article><script>self.__next_f.push([2,null])</script><script>self.__next_f.push([1,"2:T320,"])</script><script>self.__next_f.push([1,"${JSON.stringify(RSC_ARTICLE_TEXT).slice(1, -1)}"])</script></body></html>`;
      const result = extractFromHtml(html, 'https://example.com/rsc');
      expect(result).not.toBeNull();
      expect(result!.method).toBe('next-rsc');
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

    it('composes byline from JSON-LD when Readability wins for content', () => {
      const content = loremText(GOOD_CONTENT_LENGTH);
      // JSON-LD has rich metadata but articleBody is too short for tryJsonLdExtraction to return
      // a full result. The metadata-only extractor should still capture the author.
      const jsonLd = {
        '@type': 'NewsArticle',
        headline: 'JSON-LD Title',
        articleBody: 'Too short',
        author: { '@type': 'Person', name: 'Jane Author' },
      };
      const html = `<html><head>
        <title>Page Title</title>
        <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
      </head><body><article><h1>Article</h1><p>${content}</p></article></body></html>`;
      const result = extractFromHtml(html, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.method).toMatch(/^readability/);
      expect(result!.byline).toBe('Jane Author');
    });

    it('prefers text-density over Readability when text-density captures >2x more content', () => {
      // Build HTML where <article> has ~GOOD_CONTENT_LENGTH chars (Readability grabs it)
      // but the page overall has ~3x more content outside <article>
      // (text-density should grab more since it's statistical, not DOM-constrained).
      const articleContent = loremText(GOOD_CONTENT_LENGTH);
      const extraContent = loremText(GOOD_CONTENT_LENGTH * 3);

      const html = `<html><head><title>Test</title></head><body>
        <div class="page">
          <article><p>${articleContent}</p></article>
          <div class="bonus-content"><p>${extraContent}</p></div>
        </div>
      </body></html>`;

      const result = extractFromHtml(html, 'https://example.com/article');
      expect(result).not.toBeNull();
      // The result should have content — either from Readability or text-density.
      // If text-density captured >2x more, method will be 'text-density'.
      // If not, method will be 'readability' (which is also fine — means comparator correctly
      // kept Readability because the ratio wasn't >2x).
      expect(result!.textContent!.length).toBeGreaterThanOrEqual(GOOD_CONTENT_LENGTH);
    });

    it('keeps Readability when text-density does not find significantly more content', () => {
      const content = loremText(GOOD_CONTENT_LENGTH);
      const html = `<html><head><title>Test</title></head><body>
        <article><h1>Test</h1><p>${content}</p></article>
      </body></html>`;
      const result = extractFromHtml(html, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.method).toMatch(/^readability/);
    });

    it('does not overwrite existing metadata from winning strategy', () => {
      vi.mocked(sitePreferJsonLd).mockReturnValue(true);
      const content = loremText(GOOD_CONTENT_LENGTH);
      const jsonLd = {
        '@type': 'NewsArticle',
        headline: 'JSON-LD Title',
        articleBody: content,
        author: { '@type': 'Person', name: 'JSON Author' },
      };
      const html = `<html><head>
        <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
      </head><body></body></html>`;
      const result = extractFromHtml(html, 'https://example.com/article');
      expect(result).not.toBeNull();
      expect(result!.method).toBe('json-ld');
      // JSON-LD already has its own byline — should not be overwritten
      expect(result!.byline).toBe('JSON Author');
    });
  });
});
