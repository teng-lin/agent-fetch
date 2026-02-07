import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

function filterCrawlResults(results: (CrawlResult | CrawlSummary)[]): CrawlResult[] {
  return results.filter((r): r is CrawlResult => !('type' in r));
}

function findSummary(results: (CrawlResult | CrawlSummary)[]): CrawlSummary {
  const summary = results.find((r): r is CrawlSummary => 'type' in r && r.type === 'summary');
  expect(summary).toBeDefined();
  return summary!;
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
      const crawlResults = filterCrawlResults(results);
      const summary = findSummary(results);

      expect(crawlResults.length).toBe(1);
      expect(crawlResults[0].url).toBe('https://example.com/');
      expect(crawlResults[0]).toHaveProperty('depth');
      expect(summary.pagesTotal).toBe(1);
      expect(summary.pagesSuccess).toBe(1);
      expect(summary.source).toBe('links');
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
      const urls = filterCrawlResults(results).map((r) => r.url);

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

      expect(filterCrawlResults(results).length).toBeLessThanOrEqual(2);
      expect(findSummary(results).pagesTotal).toBeLessThanOrEqual(2);
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
      const summary = findSummary(results);

      expect(summary.source).toBe('sitemap');
      expect(summary.pagesSuccess).toBeGreaterThanOrEqual(2);
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
      const urls = filterCrawlResults(results).map((r) => r.url);

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

      expect(findSummary(results).pagesBlocked).toBeGreaterThanOrEqual(1);
    });
  });

  describe('proxy and cookies', () => {
    it('passes proxy and cookies to httpFetch', async () => {
      vi.mocked(httpFetch).mockResolvedValue(
        mockFetchResult('https://example.com/', { rawHtml: null })
      );

      const results = await collectResults(
        crawl('https://example.com/', {
          maxPages: 1,
          proxy: 'http://proxy.example.com:8080',
          cookies: { session: 'abc123' },
        })
      );

      expect(results.length).toBeGreaterThan(0);
      expect(httpFetch).toHaveBeenCalledWith(
        'https://example.com/',
        expect.objectContaining({
          proxy: 'http://proxy.example.com:8080',
          cookies: { session: 'abc123' },
        })
      );
    });

    it('passes proxy and cookies to simpleFetch for robots.txt', async () => {
      vi.mocked(httpFetch).mockResolvedValue(
        mockFetchResult('https://example.com/', { rawHtml: null })
      );

      await collectResults(
        crawl('https://example.com/', {
          maxPages: 1,
          proxy: 'http://proxy.example.com:8080',
          cookies: { session: 'abc123' },
        })
      );

      // httpRequest is used for robots.txt and sitemap fetches via simpleFetch
      const robotsCall = vi
        .mocked(httpRequest)
        .mock.calls.find((call) => (call[0] as string).includes('robots.txt'));
      expect(robotsCall).toBeDefined();
      // proxy is 5th arg (index 4), cookies is 6th arg (index 5)
      expect(robotsCall![4]).toBe('http://proxy.example.com:8080');
      expect(robotsCall![5]).toEqual({ session: 'abc123' });
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
      const summary = findSummary(results);

      expect(summary.pagesFailed).toBe(1);
      expect(summary.pagesSuccess).toBe(0);
    });
  });

  describe('delay between batches', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('waits between batches when delay is configured', async () => {
      vi.useFakeTimers();

      // Start page discovers 2 more pages, so we get 2 batches
      let fetchCount = 0;
      vi.mocked(httpFetch).mockImplementation(async (url) => {
        fetchCount++;
        if (url === 'https://example.com/') {
          return mockFetchResult(url, {
            rawHtml: '<html><body><a href="/page-a">A</a><a href="/page-b">B</a></body></html>',
          });
        }
        return mockFetchResult(url, { rawHtml: null });
      });

      const gen = crawl('https://example.com/', {
        maxPages: 3,
        concurrency: 1,
        delay: 500,
      });

      const results: (CrawlResult | CrawlSummary)[] = [];
      // Manually iterate the generator to control timing
      const iterate = async () => {
        for await (const item of gen) {
          results.push(item);
        }
      };

      const done = iterate();

      // Allow first batch to complete
      await vi.advanceTimersByTimeAsync(0);
      // First batch fetched, now delay timer should be pending
      await vi.advanceTimersByTimeAsync(500);
      // Allow second batch
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(500);
      // Allow third batch
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(500);

      await done;

      expect(fetchCount).toBeGreaterThanOrEqual(2);
      findSummary(results);
    });
  });

  describe('concurrency limiting', () => {
    it('processes pages sequentially when concurrency is 1', async () => {
      const callOrder: string[] = [];

      vi.mocked(httpFetch).mockImplementation(async (url) => {
        callOrder.push(`start:${new URL(url).pathname}`);
        // Simulate some async work
        await new Promise((r) => setTimeout(r, 0));
        callOrder.push(`end:${new URL(url).pathname}`);
        if (url === 'https://example.com/') {
          return mockFetchResult(url, {
            rawHtml: '<html><body><a href="/a">A</a><a href="/b">B</a></body></html>',
          });
        }
        return mockFetchResult(url, { rawHtml: null });
      });

      await collectResults(crawl('https://example.com/', { maxPages: 3, concurrency: 1 }));

      // With concurrency=1, each batch has only 1 item, so pages are sequential.
      // The first page must complete before the second starts.
      expect(callOrder[0]).toBe('start:/');
      expect(callOrder[1]).toBe('end:/');
      // Second page starts after first ends
      if (callOrder.length >= 4) {
        expect(callOrder[2]).toMatch(/^start:/);
        expect(callOrder[3]).toMatch(/^end:/);
      }
    });

    it('processes multiple pages per batch when concurrency > 1', async () => {
      const concurrent: number[] = [];
      let inFlight = 0;

      vi.mocked(httpFetch).mockImplementation(async (url) => {
        inFlight++;
        concurrent.push(inFlight);
        await new Promise((r) => setTimeout(r, 0));
        inFlight--;
        if (url === 'https://example.com/') {
          return mockFetchResult(url, {
            rawHtml:
              '<html><body><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></body></html>',
          });
        }
        return mockFetchResult(url, { rawHtml: null });
      });

      await collectResults(crawl('https://example.com/', { maxPages: 4, concurrency: 3 }));

      // With concurrency=3, the second batch (pages /a, /b, /c) should have
      // multiple in-flight requests simultaneously
      const maxConcurrent = Math.max(...concurrent);
      // The second batch processes 3 discovered links concurrently,
      // so at least 2 should be in-flight at the same time.
      expect(maxConcurrent).toBeGreaterThanOrEqual(2);
    });
  });
});
