/**
 * BFS URL frontier with normalization, dedup, depth tracking, and pattern filtering
 */
import picomatch from 'picomatch';

export interface FrontierEntry {
  url: string;
  depth: number;
}

export interface FrontierOptions {
  sameOrigin?: boolean;
  include?: string[];
  exclude?: string[];
  maxDepth?: number;
  maxPages?: number;
  maxQueued?: number;
}

/**
 * Normalize a URL for deduplication.
 * Strips fragments, removes trailing slashes (except root), lowercases scheme+host.
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';

    // Remove trailing slash unless it's the root path
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    return parsed.href;
  } catch {
    return url;
  }
}

export class UrlFrontier {
  private queue: FrontierEntry[] = [];
  private visited = new Set<string>();
  private origin: string;
  private sameOrigin: boolean;
  private maxDepth: number;
  private maxPages: number;
  private maxQueued: number;
  private includeMatcher: ((path: string) => boolean) | null;
  private excludeMatcher: ((path: string) => boolean) | null;
  private dequeued = 0;

  constructor(startUrl: string, options: FrontierOptions = {}) {
    const parsed = new URL(startUrl);
    this.origin = parsed.origin;
    this.sameOrigin = options.sameOrigin ?? true;
    this.maxDepth = options.maxDepth ?? 3;
    this.maxPages = options.maxPages ?? 100;
    this.maxQueued = options.maxQueued ?? this.maxPages * 10;

    this.includeMatcher =
      options.include && options.include.length > 0
        ? picomatch(options.include, { dot: true })
        : null;

    this.excludeMatcher =
      options.exclude && options.exclude.length > 0
        ? picomatch(options.exclude, { dot: true })
        : null;

    // Add start URL
    this.add(startUrl, 0);
  }

  /** Add a URL to the frontier if it passes all filters. */
  add(url: string, depth: number): boolean {
    if (depth > this.maxDepth) return false;
    if (this.queue.length >= this.maxQueued) return false;

    const normalized = normalizeUrl(url);
    if (this.visited.has(normalized)) return false;

    let parsed: URL;
    try {
      parsed = new URL(normalized);
    } catch {
      return false;
    }

    if (this.sameOrigin && parsed.origin !== this.origin) return false;
    if (this.includeMatcher && !this.includeMatcher(parsed.pathname)) return false;
    if (this.excludeMatcher && this.excludeMatcher(parsed.pathname)) return false;

    this.visited.add(normalized);
    this.queue.push({ url: normalized, depth });
    return true;
  }

  /** Add multiple URLs at the same depth. */
  addAll(urls: string[], depth: number): number {
    let added = 0;
    for (const url of urls) {
      if (this.add(url, depth)) added++;
    }
    return added;
  }

  /** Get the next URL to crawl, or null if the frontier is empty or limit reached. */
  next(): FrontierEntry | null {
    if (this.dequeued >= this.maxPages) return null;
    const entry = this.queue.shift() ?? null;
    if (entry) this.dequeued++;
    return entry;
  }

  /** Check if there are more URLs to process and we haven't hit the limit. */
  hasMore(): boolean {
    return this.queue.length > 0 && this.dequeued < this.maxPages;
  }

  /** Number of URLs that have been dequeued. */
  get processedCount(): number {
    return this.dequeued;
  }

  /** Total URLs seen (visited set size). */
  get visitedCount(): number {
    return this.visited.size;
  }
}
