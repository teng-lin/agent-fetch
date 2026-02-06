/**
 * Types for the crawl module
 */
import type { FetchResult } from '../fetch/types.js';
import type { SelectorOptions } from '../extract/types.js';

export interface CrawlOptions extends SelectorOptions {
  maxDepth?: number;
  maxPages?: number;
  concurrency?: number;
  include?: string[];
  exclude?: string[];
  sameOrigin?: boolean;
  delay?: number;
  preset?: string;
  timeout?: number;
}

export interface CrawlResult extends FetchResult {
  depth: number;
}

export interface CrawlSummary {
  type: 'summary';
  pagesTotal: number;
  pagesSuccess: number;
  pagesFailed: number;
  pagesBlocked: number;
  durationMs: number;
  source: 'sitemap' | 'links';
  startUrl: string;
}
