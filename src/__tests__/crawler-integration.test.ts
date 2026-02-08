/**
 * Crawler integration tests -- link discovery, sitemap interaction, URL frontier edge cases,
 * error resilience, and link extraction.
 *
 * Only httpFetch, httpRequest, and logger are mocked.
 * robots-parser, sitemap-parser, link-extractor, and url-frontier run for real.
 */
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
import { mockFetchResult } from './test-helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockHttpResponse(overrides: { success?: boolean; statusCode?: number; html?: string }) {
  return {
    success: overrides.success ?? true,
    statusCode: overrides.statusCode ?? 200,
    html: overrides.html ?? '',
    headers: {},
    cookies: [],
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

function robotsTxt404() {
  return mockHttpResponse({ success: false, statusCode: 404 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('crawler integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: robots.txt and sitemap return 404
    vi.mocked(httpRequest).mockResolvedValue(robotsTxt404());
  });

  // =========================================================================
  // Sliding-window concurrency (processFrontier)
  // =========================================================================
  describe('sliding-window concurrency', () => {
    it('immediately enqueues next URL when one request completes', async () => {
      // Track concurrent in-flight requests over time
      const concurrentSnapshots: number[] = [];
      let inFlight = 0;

      // Seed page discovers 4 links; concurrency=2
      vi.mocked(httpFetch).mockImplementation(async (url) => {
        inFlight++;
        concurrentSnapshots.push(inFlight);
        // Simulate variable latency
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        if (url === 'https://example.com/') {
          return mockFetchResult(url, {
            rawHtml: `<html><body>
              <a href="/a">A</a><a href="/b">B</a>
              <a href="/c">C</a><a href="/d">D</a>
            </body></html>`,
          });
        }
        return mockFetchResult(url, { rawHtml: null });
      });

      const results = await collectResults(
        crawl('https://example.com/', { maxPages: 5, concurrency: 2 })
      );

      // Should have fetched the seed + up to 4 discovered pages (limited to maxPages=5)
      expect(filterCrawlResults(results).length).toBe(5);
      // Sliding window: should have had 2 concurrent at some point
      expect(Math.max(...concurrentSnapshots)).toBe(2);
    });

    it('discovers links across multiple depths (depth 2+)', async () => {
      vi.mocked(httpFetch).mockImplementation(async (url) => {
        if (url === 'https://example.com/') {
          return mockFetchResult(url, {
            rawHtml: '<html><body><a href="/level-1">L1</a></body></html>',
          });
        }
        if (url === 'https://example.com/level-1') {
          return mockFetchResult(url, {
            rawHtml: '<html><body><a href="/level-2">L2</a></body></html>',
          });
        }
        if (url === 'https://example.com/level-2') {
          return mockFetchResult(url, {
            rawHtml: '<html><body><a href="/level-3">L3</a></body></html>',
          });
        }
        return mockFetchResult(url, { rawHtml: null });
      });

      const results = await collectResults(
        crawl('https://example.com/', { maxPages: 10, concurrency: 1 })
      );
      const urls = filterCrawlResults(results).map((r) => r.url);
      const depths = filterCrawlResults(results).map((r) => r.depth);

      expect(urls).toContain('https://example.com/');
      expect(urls).toContain('https://example.com/level-1');
      expect(urls).toContain('https://example.com/level-2');
      expect(urls).toContain('https://example.com/level-3');

      // Verify depth tracking
      expect(depths).toContain(0); // seed
      expect(depths).toContain(1); // level-1
      expect(depths).toContain(2); // level-2
    });

    it('exhausts frontier before maxPages when no more links', async () => {
      vi.mocked(httpFetch).mockImplementation(async (url) => {
        if (url === 'https://example.com/') {
          return mockFetchResult(url, {
            rawHtml: '<html><body><a href="/only-child">Only</a></body></html>',
          });
        }
        return mockFetchResult(url, { rawHtml: null });
      });

      const results = await collectResults(crawl('https://example.com/', { maxPages: 100 }));
      const summary = findSummary(results);

      expect(summary.pagesTotal).toBe(2); // seed + only-child
      expect(summary.pagesTotal).toBeLessThan(100);
    });
  });

  // =========================================================================
  // Sitemap + robots.txt interaction
  // =========================================================================
  describe('sitemap + robots.txt interaction', () => {
    it('filters sitemap entries by robots.txt Disallow rules', async () => {
      vi.mocked(httpRequest).mockImplementation(async (url) => {
        if (typeof url === 'string' && url.endsWith('/robots.txt')) {
          return mockHttpResponse({
            html: 'User-agent: *\nDisallow: /admin/\n\nSitemap: https://example.com/sitemap.xml',
          });
        }
        if (typeof url === 'string' && url.endsWith('/sitemap.xml')) {
          return mockHttpResponse({
            html: `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/public-page</loc></url>
  <url><loc>https://example.com/admin/secret</loc></url>
  <url><loc>https://example.com/about</loc></url>
</urlset>`,
          });
        }
        return robotsTxt404();
      });

      vi.mocked(httpFetch).mockImplementation(async (url) => mockFetchResult(url));

      const results = await collectResults(crawl('https://example.com/', { maxPages: 10 }));
      const urls = filterCrawlResults(results).map((r) => r.url);
      const summary = findSummary(results);

      expect(summary.source).toBe('sitemap');
      expect(urls).toContain('https://example.com/public-page');
      expect(urls).toContain('https://example.com/about');
      expect(urls).not.toContain('https://example.com/admin/secret');
      expect(summary.pagesBlocked).toBeGreaterThanOrEqual(1);
    });

    it('follows nested sitemap index → child sitemap → URLs', async () => {
      vi.mocked(httpRequest).mockImplementation(async (url) => {
        if (typeof url === 'string' && url.endsWith('/robots.txt')) {
          return mockHttpResponse({
            html: 'User-agent: *\nDisallow:\n\nSitemap: https://example.com/sitemap-index.xml',
          });
        }
        if (typeof url === 'string' && url.endsWith('/sitemap-index.xml')) {
          return mockHttpResponse({
            html: `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-posts.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
</sitemapindex>`,
          });
        }
        if (typeof url === 'string' && url.endsWith('/sitemap-posts.xml')) {
          return mockHttpResponse({
            html: `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/post-1</loc></url>
  <url><loc>https://example.com/post-2</loc></url>
</urlset>`,
          });
        }
        if (typeof url === 'string' && url.endsWith('/sitemap-pages.xml')) {
          return mockHttpResponse({
            html: `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/about</loc></url>
</urlset>`,
          });
        }
        return robotsTxt404();
      });

      vi.mocked(httpFetch).mockImplementation(async (url) => mockFetchResult(url));

      const results = await collectResults(crawl('https://example.com/', { maxPages: 10 }));
      const urls = filterCrawlResults(results).map((r) => r.url);
      const summary = findSummary(results);

      expect(summary.source).toBe('sitemap');
      expect(urls).toContain('https://example.com/post-1');
      expect(urls).toContain('https://example.com/post-2');
      expect(urls).toContain('https://example.com/about');
    });

    it('limits sitemap entries to maxPages', async () => {
      const sitemapEntries = Array.from(
        { length: 20 },
        (_, i) => `<url><loc>https://example.com/page-${i}</loc></url>`
      ).join('\n');

      vi.mocked(httpRequest).mockImplementation(async (url) => {
        if (typeof url === 'string' && url.endsWith('/robots.txt')) {
          return mockHttpResponse({
            html: 'User-agent: *\nDisallow:\n\nSitemap: https://example.com/sitemap.xml',
          });
        }
        if (typeof url === 'string' && url.endsWith('/sitemap.xml')) {
          return mockHttpResponse({
            html: `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${sitemapEntries}
</urlset>`,
          });
        }
        return robotsTxt404();
      });

      vi.mocked(httpFetch).mockImplementation(async (url) => mockFetchResult(url));

      const results = await collectResults(crawl('https://example.com/', { maxPages: 5 }));
      const summary = findSummary(results);

      // maxPages=5: seed + sitemap entries, total should not exceed 5
      expect(summary.pagesTotal).toBeLessThanOrEqual(5);
    });
  });

  // =========================================================================
  // URL frontier edge cases
  // =========================================================================
  describe('URL frontier edge cases', () => {
    it('deduplicates links across multiple pages — each URL fetched once', async () => {
      const fetchedUrls: string[] = [];
      vi.mocked(httpFetch).mockImplementation(async (url) => {
        fetchedUrls.push(url);
        if (url === 'https://example.com/') {
          return mockFetchResult(url, {
            rawHtml: `<html><body>
              <a href="/shared">Shared</a>
              <a href="/page-a">A</a>
            </body></html>`,
          });
        }
        if (url === 'https://example.com/page-a') {
          return mockFetchResult(url, {
            rawHtml: `<html><body>
              <a href="/shared">Shared Again</a>
              <a href="/page-b">B</a>
            </body></html>`,
          });
        }
        return mockFetchResult(url, { rawHtml: null });
      });

      await collectResults(crawl('https://example.com/', { maxPages: 10, concurrency: 1 }));

      const sharedFetches = fetchedUrls.filter((u) => u === 'https://example.com/shared');
      expect(sharedFetches.length).toBe(1);
    });

    it('filters cross-origin links when sameOrigin is true (default)', async () => {
      vi.mocked(httpFetch).mockImplementation(async (url) => {
        if (url === 'https://example.com/') {
          return mockFetchResult(url, {
            rawHtml: `<html><body>
              <a href="https://other.example.net/external">External</a>
              <a href="/local">Local</a>
            </body></html>`,
          });
        }
        return mockFetchResult(url, { rawHtml: null });
      });

      const results = await collectResults(crawl('https://example.com/', { maxPages: 10 }));
      const urls = filterCrawlResults(results).map((r) => r.url);

      expect(urls).toContain('https://example.com/local');
      expect(urls).not.toContain('https://other.example.net/external');
    });

    it('normalizes fragment-only and query links correctly', async () => {
      const fetchedUrls: string[] = [];
      vi.mocked(httpFetch).mockImplementation(async (url) => {
        fetchedUrls.push(url);
        if (url === 'https://example.com/') {
          return mockFetchResult(url, {
            rawHtml: `<html><body>
              <a href="#section-1">Fragment</a>
              <a href="?page=2">Query</a>
              <a href="/page#anchor">Page with fragment</a>
              <a href="/page">Same page without fragment</a>
            </body></html>`,
          });
        }
        return mockFetchResult(url, { rawHtml: null });
      });

      await collectResults(crawl('https://example.com/', { maxPages: 10, concurrency: 1 }));

      // Fragment-only link (#section-1) resolves to the same page → deduped as already visited
      // /page#anchor and /page normalize to the same URL → fetched only once
      const pageFetches = fetchedUrls.filter((u) => u === 'https://example.com/page');
      expect(pageFetches.length).toBe(1);
    });

    it('applies include pattern filtering', async () => {
      vi.mocked(httpFetch).mockImplementation(async (url) => {
        if (url === 'https://example.com/blog') {
          return mockFetchResult(url, {
            rawHtml: `<html><body>
              <a href="/blog/post-1">Blog Post</a>
              <a href="/about">About</a>
              <a href="/blog/post-2">Blog Post 2</a>
            </body></html>`,
          });
        }
        return mockFetchResult(url, { rawHtml: null });
      });

      const results = await collectResults(
        crawl('https://example.com/blog/', { maxPages: 10, include: ['/blog/**', '/blog'] })
      );
      const urls = filterCrawlResults(results).map((r) => r.url);

      // Seed URL matches /blog (normalized) so it should be included
      expect(urls).toContain('https://example.com/blog');
      // Blog posts should be included
      expect(urls).toContain('https://example.com/blog/post-1');
      expect(urls).toContain('https://example.com/blog/post-2');
      // About should be excluded by the include filter
      expect(urls).not.toContain('https://example.com/about');
    });

    it('applies exclude pattern filtering', async () => {
      vi.mocked(httpFetch).mockImplementation(async (url) => {
        if (url === 'https://example.com/') {
          return mockFetchResult(url, {
            rawHtml: `<html><body>
              <a href="/blog/post-1">Blog Post</a>
              <a href="/admin/dashboard">Admin</a>
              <a href="/about">About</a>
            </body></html>`,
          });
        }
        return mockFetchResult(url, { rawHtml: null });
      });

      const results = await collectResults(
        crawl('https://example.com/', { maxPages: 10, exclude: ['/admin/**'] })
      );
      const urls = filterCrawlResults(results).map((r) => r.url);

      expect(urls).toContain('https://example.com/blog/post-1');
      expect(urls).toContain('https://example.com/about');
      expect(urls).not.toContain('https://example.com/admin/dashboard');
    });
  });

  // =========================================================================
  // Error resilience
  // =========================================================================
  describe('error resilience', () => {
    it('continues crawling when httpFetch returns failure for some pages', async () => {
      let callCount = 0;
      vi.mocked(httpFetch).mockImplementation(async (url) => {
        callCount++;
        if (url === 'https://example.com/') {
          return mockFetchResult(url, {
            rawHtml: `<html><body>
              <a href="/good">Good</a>
              <a href="/bad">Bad</a>
              <a href="/also-good">Also Good</a>
            </body></html>`,
          });
        }
        if (url === 'https://example.com/bad') {
          return {
            success: false,
            url,
            latencyMs: 10,
            error: 'network_error' as const,
            statusCode: null,
            rawHtml: null,
            extractionMethod: null,
          } as FetchResult;
        }
        return mockFetchResult(url, { rawHtml: null });
      });

      const results = await collectResults(
        crawl('https://example.com/', { maxPages: 10, concurrency: 1 })
      );
      const urls = filterCrawlResults(results).map((r) => r.url);

      // Good pages should still be fetched despite /bad failing
      expect(urls).toContain('https://example.com/');
      expect(urls).toContain('https://example.com/good');
      expect(urls).toContain('https://example.com/also-good');
      expect(callCount).toBeGreaterThanOrEqual(4); // seed + good + bad + also-good
    });

    it('proceeds without restrictions when robots.txt fetch fails', async () => {
      vi.mocked(httpRequest).mockRejectedValue(new Error('Connection refused'));

      vi.mocked(httpFetch).mockImplementation(async (url) => {
        if (url === 'https://example.com/') {
          return mockFetchResult(url, {
            rawHtml: '<html><body><a href="/page-1">P1</a></body></html>',
          });
        }
        return mockFetchResult(url, { rawHtml: null });
      });

      const results = await collectResults(crawl('https://example.com/', { maxPages: 5 }));
      const urls = filterCrawlResults(results).map((r) => r.url);
      const summary = findSummary(results);

      expect(summary.source).toBe('links');
      expect(urls).toContain('https://example.com/');
      expect(urls).toContain('https://example.com/page-1');
    });

    it('falls back to link discovery when sitemap fetch fails', async () => {
      vi.mocked(httpRequest).mockImplementation(async (url) => {
        if (typeof url === 'string' && url.endsWith('/robots.txt')) {
          return mockHttpResponse({
            html: 'User-agent: *\nDisallow:\n\nSitemap: https://example.com/sitemap.xml',
          });
        }
        // Sitemap returns 500
        if (typeof url === 'string' && url.endsWith('/sitemap.xml')) {
          return mockHttpResponse({ success: false, statusCode: 500 });
        }
        return robotsTxt404();
      });

      vi.mocked(httpFetch).mockImplementation(async (url) => {
        if (url === 'https://example.com/') {
          return mockFetchResult(url, {
            rawHtml: '<html><body><a href="/discovered">Discovered</a></body></html>',
          });
        }
        return mockFetchResult(url, { rawHtml: null });
      });

      const results = await collectResults(crawl('https://example.com/', { maxPages: 10 }));
      const urls = filterCrawlResults(results).map((r) => r.url);
      const summary = findSummary(results);

      expect(summary.source).toBe('links');
      expect(urls).toContain('https://example.com/');
      expect(urls).toContain('https://example.com/discovered');
    });

    it('produces accurate summary counts with mixed success/failure', async () => {
      vi.mocked(httpFetch).mockImplementation(async (url) => {
        if (url === 'https://example.com/') {
          return mockFetchResult(url, {
            rawHtml: `<html><body>
              <a href="/ok-1">OK</a>
              <a href="/fail-1">Fail</a>
              <a href="/ok-2">OK2</a>
            </body></html>`,
          });
        }
        if (url.includes('fail')) {
          return {
            success: false,
            url,
            latencyMs: 10,
            error: 'http_error' as const,
            statusCode: 500,
            rawHtml: null,
            extractionMethod: null,
          } as FetchResult;
        }
        return mockFetchResult(url, { rawHtml: null });
      });

      const results = await collectResults(
        crawl('https://example.com/', { maxPages: 10, concurrency: 1 })
      );
      const summary = findSummary(results);

      expect(summary.pagesTotal).toBe(4); // seed + 3 discovered
      expect(summary.pagesSuccess).toBe(3); // seed + ok-1 + ok-2
      expect(summary.pagesFailed).toBe(1); // fail-1
    });
  });

  // =========================================================================
  // Link extraction integration
  // =========================================================================
  describe('link extraction integration', () => {
    it('discovers links from nav, footer, and sidebar in realistic HTML', async () => {
      vi.mocked(httpFetch).mockImplementation(async (url) => {
        if (url === 'https://example.com/') {
          return mockFetchResult(url, {
            rawHtml: `<html><body>
              <nav><a href="/nav-page">Nav Link</a></nav>
              <main>
                <article><p>Article content</p><a href="/article-link">In Article</a></article>
              </main>
              <aside><a href="/sidebar-link">Sidebar</a></aside>
              <footer><a href="/footer-page">Footer Link</a></footer>
            </body></html>`,
          });
        }
        return mockFetchResult(url, { rawHtml: null });
      });

      const results = await collectResults(
        crawl('https://example.com/', { maxPages: 10, concurrency: 1 })
      );
      const urls = filterCrawlResults(results).map((r) => r.url);

      expect(urls).toContain('https://example.com/nav-page');
      expect(urls).toContain('https://example.com/article-link');
      expect(urls).toContain('https://example.com/sidebar-link');
      expect(urls).toContain('https://example.com/footer-page');
    });

    it('resolves relative URLs correctly against base URL', async () => {
      vi.mocked(httpFetch).mockImplementation(async (url) => {
        if (url === 'https://example.com/blog/post-1') {
          return mockFetchResult(url, {
            rawHtml: `<html><body>
              <a href="../about">Relative parent</a>
              <a href="post-2">Relative sibling</a>
              <a href="/absolute">Absolute</a>
            </body></html>`,
          });
        }
        return mockFetchResult(url, { rawHtml: null });
      });

      const results = await collectResults(
        crawl('https://example.com/blog/post-1', { maxPages: 10, concurrency: 1 })
      );
      const urls = filterCrawlResults(results).map((r) => r.url);

      expect(urls).toContain('https://example.com/about');
      expect(urls).toContain('https://example.com/blog/post-2');
      expect(urls).toContain('https://example.com/absolute');
    });

    it('filters out javascript: links', async () => {
      vi.mocked(httpFetch).mockImplementation(async (url) => {
        if (url === 'https://example.com/') {
          return mockFetchResult(url, {
            rawHtml: `<html><body>
              <a href="javascript:void(0)">JS Link</a>
              <a href="javascript:alert('xss')">XSS</a>
              <a href="/real-page">Real</a>
            </body></html>`,
          });
        }
        return mockFetchResult(url, { rawHtml: null });
      });

      const results = await collectResults(
        crawl('https://example.com/', { maxPages: 10, concurrency: 1 })
      );
      const urls = filterCrawlResults(results).map((r) => r.url);

      expect(urls).toContain('https://example.com/real-page');
      // javascript: links should not appear
      expect(urls.every((u) => !u.includes('javascript:'))).toBe(true);
    });

    it('filters out mailto: and tel: links', async () => {
      vi.mocked(httpFetch).mockImplementation(async (url) => {
        if (url === 'https://example.com/') {
          return mockFetchResult(url, {
            rawHtml: `<html><body>
              <a href="mailto:user@example.com">Email</a>
              <a href="tel:+1234567890">Phone</a>
              <a href="/contact">Contact</a>
            </body></html>`,
          });
        }
        return mockFetchResult(url, { rawHtml: null });
      });

      const results = await collectResults(
        crawl('https://example.com/', { maxPages: 10, concurrency: 1 })
      );
      const urls = filterCrawlResults(results).map((r) => r.url);

      expect(urls).toContain('https://example.com/contact');
      expect(urls.every((u) => !u.includes('mailto:'))).toBe(true);
      expect(urls.every((u) => !u.includes('tel:'))).toBe(true);
    });
  });
});
