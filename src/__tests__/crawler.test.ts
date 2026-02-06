import { describe, it, expect, vi, beforeEach } from 'vitest';
import { crawl } from '../crawl/crawler.js';
import type { CrawlResult, CrawlSummary } from '../crawl/types.js';
import type { FetchResult } from '../fetch/types.js';

vi.mock('../fetch/http-fetch.js', () => ({
  httpFetch: vi.fn(),
}));

vi.mock('../fetch/http-client.js', () => ({
  httpRequest: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { httpFetch } from '../fetch/http-fetch.js';
import { httpRequest } from '../fetch/http-client.js';

function mockFetchResult(url: string, overrides: Partial<FetchResult> = {}): FetchResult {
  return {
    success: true,
    url,
    latencyMs: 10,
    title: `Title for ${url}`,
    content: `<p>Content for ${url}</p>`,
    textContent: 'Content text. '.repeat(20),
    excerpt: 'Excerpt',
    markdown: `Content for ${url}`,
    extractedWordCount: 40,
    statusCode: 200,
    rawHtml: null,
    extractionMethod: 'readability',
    ...overrides,
  };
}

async function collectResults(
  gen: AsyncGenerator<CrawlResult | CrawlSummary>
): Promise<(CrawlResult | CrawlSummary)[]> {
  const results: (CrawlResult | CrawlSummary)[] = [];
  for await (const item of gen) {
    results.push(item);
  }
  return results;
}

describe('crawl orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: robots.txt and sitemap return nothing
    vi.mocked(httpRequest).mockResolvedValue({
      success: false,
      statusCode: 404,
      html: '',
      headers: {},
      cookies: [],
    });
  });

  describe('BFS link discovery', () => {
    it('yields CrawlResult objects and a final CrawlSummary', async () => {
      vi.mocked(httpFetch).mockResolvedValue(
        mockFetchResult('https://example.com/', { rawHtml: null })
      );

      const results = await collectResults(crawl('https://example.com/', { maxPages: 1 }));

      const crawlResults = results.filter((r): r is CrawlResult => !('type' in r));
      const summaries = results.filter(
        (r): r is CrawlSummary => 'type' in r && r.type === 'summary'
      );

      expect(crawlResults.length).toBe(1);
      expect(crawlResults[0].url).toBe('https://example.com/');
      expect(crawlResults[0]).toHaveProperty('depth');
      expect(summaries.length).toBe(1);
      expect(summaries[0].pagesTotal).toBe(1);
      expect(summaries[0].pagesSuccess).toBe(1);
      expect(summaries[0].source).toBe('links');
    });

    it('follows links discovered in raw HTML', async () => {
      let callCount = 0;
      vi.mocked(httpFetch).mockImplementation(async (url) => {
        callCount++;
        if (url === 'https://example.com/') {
          return mockFetchResult(url, {
            rawHtml: '<html><body><a href="/page-a">A</a><a href="/page-b">B</a></body></html>',
          });
        }
        return mockFetchResult(url, { rawHtml: null });
      });

      const results = await collectResults(crawl('https://example.com/', { maxPages: 3 }));

      const crawlResults = results.filter((r): r is CrawlResult => !('type' in r));
      const urls = crawlResults.map((r) => r.url);
      expect(urls).toContain('https://example.com/');
      expect(urls.length).toBeGreaterThanOrEqual(2);
      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    it('enforces maxPages limit', async () => {
      vi.mocked(httpFetch).mockImplementation(async (url) => {
        return mockFetchResult(url, {
          rawHtml: `<html><body>
            <a href="/a">A</a><a href="/b">B</a>
            <a href="/c">C</a><a href="/d">D</a>
          </body></html>`,
        });
      });

      const results = await collectResults(crawl('https://example.com/', { maxPages: 2 }));

      const crawlResults = results.filter((r): r is CrawlResult => !('type' in r));
      expect(crawlResults.length).toBeLessThanOrEqual(2);

      const summary = results.find((r): r is CrawlSummary => 'type' in r && r.type === 'summary');
      expect(summary).toBeDefined();
      expect(summary!.pagesTotal).toBeLessThanOrEqual(2);
    });
  });

  describe('sitemap-based crawling', () => {
    it('uses sitemap entries when available', async () => {
      // robots.txt returns sitemap URL
      vi.mocked(httpRequest).mockImplementation(async (url) => {
        if (url.endsWith('/robots.txt')) {
          return {
            success: true,
            statusCode: 200,
            html: 'User-agent: *\nDisallow:\n\nSitemap: https://example.com/sitemap.xml',
            headers: {},
            cookies: [],
          };
        }
        if (url.endsWith('/sitemap.xml')) {
          return {
            success: true,
            statusCode: 200,
            html: `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page-1</loc></url>
  <url><loc>https://example.com/page-2</loc></url>
</urlset>`,
            headers: {},
            cookies: [],
          };
        }
        return { success: false, statusCode: 404, html: '', headers: {}, cookies: [] };
      });

      vi.mocked(httpFetch).mockImplementation(async (url) => mockFetchResult(url));

      const results = await collectResults(crawl('https://example.com/', { maxPages: 10 }));

      const summary = results.find((r): r is CrawlSummary => 'type' in r && r.type === 'summary');
      expect(summary).toBeDefined();
      expect(summary!.source).toBe('sitemap');
      expect(summary!.pagesSuccess).toBeGreaterThanOrEqual(2);
    });
  });

  describe('robots.txt integration', () => {
    it('skips URLs disallowed by robots.txt', async () => {
      vi.mocked(httpRequest).mockImplementation(async (url) => {
        if (url.endsWith('/robots.txt')) {
          return {
            success: true,
            statusCode: 200,
            html: 'User-agent: *\nDisallow: /admin\n',
            headers: {},
            cookies: [],
          };
        }
        return { success: false, statusCode: 404, html: '', headers: {}, cookies: [] };
      });

      // Start URL links to /admin/secret
      vi.mocked(httpFetch).mockImplementation(async (url) => {
        if (url === 'https://example.com/') {
          return mockFetchResult(url, {
            rawHtml: '<html><body><a href="/admin/secret">Admin</a></body></html>',
          });
        }
        return mockFetchResult(url);
      });

      const results = await collectResults(crawl('https://example.com/', { maxPages: 10 }));

      const crawlResults = results.filter((r): r is CrawlResult => !('type' in r));
      const urls = crawlResults.map((r) => r.url);
      expect(urls).not.toContain('https://example.com/admin/secret');
    });

    it('counts robots-blocked pages in summary', async () => {
      vi.mocked(httpRequest).mockImplementation(async (url) => {
        if (url.endsWith('/robots.txt')) {
          return {
            success: true,
            statusCode: 200,
            html: 'User-agent: *\nDisallow: /blocked\n',
            headers: {},
            cookies: [],
          };
        }
        return { success: false, statusCode: 404, html: '', headers: {}, cookies: [] };
      });

      vi.mocked(httpFetch).mockImplementation(async (url) => {
        return mockFetchResult(url, {
          rawHtml: '<html><body><a href="/blocked/page">X</a><a href="/open">Y</a></body></html>',
        });
      });

      const results = await collectResults(crawl('https://example.com/', { maxPages: 10 }));

      const summary = results.find((r): r is CrawlSummary => 'type' in r && r.type === 'summary');
      expect(summary).toBeDefined();
      expect(summary!.pagesBlocked).toBeGreaterThanOrEqual(1);
    });
  });

  describe('failed pages', () => {
    it('counts failed pages in summary', async () => {
      vi.mocked(httpFetch).mockResolvedValue({
        success: false,
        url: 'https://example.com/',
        latencyMs: 10,
        error: 'http_error',
        statusCode: 500,
        rawHtml: null,
        extractionMethod: null,
      });

      const results = await collectResults(crawl('https://example.com/', { maxPages: 1 }));

      const summary = results.find((r): r is CrawlSummary => 'type' in r && r.type === 'summary');
      expect(summary).toBeDefined();
      expect(summary!.pagesFailed).toBe(1);
      expect(summary!.pagesSuccess).toBe(0);
    });
  });
});
