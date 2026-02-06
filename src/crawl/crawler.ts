/**
 * Main crawl orchestrator — AsyncGenerator that yields CrawlResult objects
 */
import { httpFetch } from '../fetch/http-fetch.js';
import { httpRequest } from '../fetch/http-client.js';
import { extractLinks } from './link-extractor.js';
import { UrlFrontier } from './url-frontier.js';
import { fetchRobotsTxt, isAllowedByRobots } from './robots-parser.js';
import { fetchSitemapEntries } from './sitemap-parser.js';
import type { CrawlOptions, CrawlResult, CrawlSummary } from './types.js';
import { logger } from '../logger.js';

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_CONCURRENCY = 5;

/**
 * Simple fetch wrapper for robots.txt and sitemap fetching.
 * Uses httpRequest under the hood.
 */
async function simpleFetch(
  url: string,
  preset?: string,
  timeout?: number
): Promise<{ ok: boolean; text: string } | null> {
  try {
    const response = await httpRequest(url, {}, preset, timeout);
    return { ok: response.success, text: response.html ?? '' };
  } catch {
    return null;
  }
}

/**
 * Crawl a website starting from the given URL.
 * Yields CrawlResult objects as pages are fetched.
 *
 * Strategy:
 * 1. Fetch robots.txt for Disallow rules and Sitemap directives
 * 2. If sitemap found, use sitemap URLs as crawl queue
 * 3. Otherwise, use link discovery (BFS)
 */
export async function* crawl(
  startUrl: string,
  options: CrawlOptions = {}
): AsyncGenerator<CrawlResult | CrawlSummary> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const delay = options.delay ?? 0;
  const crawlStartTime = Date.now();

  let pagesTotal = 0;
  let pagesSuccess = 0;
  let pagesFailed = 0;
  let pagesBlocked = 0;

  function trackResult(success: boolean): void {
    pagesTotal++;
    if (success) pagesSuccess++;
    else pagesFailed++;
  }

  function trackBlocked(): void {
    pagesBlocked++;
  }

  const origin = new URL(startUrl).origin;
  const fetchFn = (url: string) => simpleFetch(url, options.preset, options.timeout);

  // Step 1: Fetch robots.txt
  const robots = await fetchRobotsTxt(origin, fetchFn);
  const disallowPaths = robots?.disallowPaths ?? [];

  // Step 2: Try sitemap
  const sitemapUrls = robots?.sitemapUrls ?? [];
  if (sitemapUrls.length === 0) {
    sitemapUrls.push(`${origin}/sitemap.xml`);
  }

  const sitemapEntries = await fetchSitemapEntries(sitemapUrls, fetchFn);
  const useSitemap = sitemapEntries.length > 0;
  let source: 'sitemap' | 'links';
  let frontier: UrlFrontier;

  if (useSitemap) {
    source = 'sitemap';
    logger.info({ startUrl, entries: sitemapEntries.length }, 'Using sitemap-based crawling');

    frontier = new UrlFrontier(startUrl, {
      sameOrigin: options.sameOrigin,
      include: options.include,
      exclude: options.exclude,
      maxDepth: 0,
      maxPages,
    });

    for (const entry of sitemapEntries) {
      frontier.add(entry.loc, 0);
    }
  } else {
    source = 'links';
    logger.info({ startUrl, maxDepth }, 'Using link discovery crawling');

    frontier = new UrlFrontier(startUrl, {
      sameOrigin: options.sameOrigin ?? true,
      include: options.include,
      exclude: options.exclude,
      maxDepth,
      maxPages,
    });
  }

  yield* processFrontier(frontier, {
    concurrency,
    delay,
    disallowPaths,
    options,
    discoverLinks: !useSitemap,
    onResult: trackResult,
    onBlocked: trackBlocked,
  });

  // Emit summary
  yield {
    type: 'summary',
    pagesTotal,
    pagesSuccess,
    pagesFailed,
    pagesBlocked,
    durationMs: Date.now() - crawlStartTime,
    source,
    startUrl,
  };
}

interface ProcessOptions {
  concurrency: number;
  delay: number;
  disallowPaths: string[];
  options: CrawlOptions;
  discoverLinks: boolean;
  onResult: (success: boolean) => void;
  onBlocked: () => void;
}

/**
 * Collect up to `count` entries from the frontier.
 */
function collectBatch(frontier: UrlFrontier, count: number): { url: string; depth: number }[] {
  const batch: { url: string; depth: number }[] = [];
  while (batch.length < count && frontier.hasMore()) {
    const entry = frontier.next();
    if (!entry) break;
    batch.push(entry);
  }
  return batch;
}

/**
 * Check if a URL is allowed by robots.txt Disallow rules.
 * Returns false (blocked) if the URL cannot be parsed.
 */
function isUrlAllowed(url: string, disallowPaths: string[]): boolean {
  try {
    return isAllowedByRobots(new URL(url).pathname, disallowPaths);
  } catch {
    return false;
  }
}

/**
 * Process frontier entries with concurrency control.
 * When discoverLinks is true, extracts links from fetched pages for BFS crawling.
 */
async function* processFrontier(
  frontier: UrlFrontier,
  opts: ProcessOptions
): AsyncGenerator<CrawlResult> {
  const { concurrency, delay, disallowPaths, options, discoverLinks, onResult, onBlocked } = opts;

  while (frontier.hasMore()) {
    const batch = collectBatch(frontier, concurrency);
    if (batch.length === 0) break;

    const results = await Promise.all(
      batch.map(async (entry) => {
        if (!isUrlAllowed(entry.url, disallowPaths)) {
          logger.debug({ url: entry.url }, 'Blocked by robots.txt');
          onBlocked();
          return null;
        }

        const result = await httpFetch(entry.url, {
          preset: options.preset,
          timeout: options.timeout,
          targetSelector: options.targetSelector,
          removeSelector: options.removeSelector,
          includeRawHtml: discoverLinks,
        });

        if (discoverLinks && result.success && result.rawHtml) {
          frontier.addAll(extractLinks(result.rawHtml, entry.url), entry.depth + 1);
          result.rawHtml = null;
        }

        return { ...result, depth: entry.depth } as CrawlResult;
      })
    );

    for (const result of results) {
      if (result) {
        onResult(result.success);
        yield result;
      }
    }

    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
