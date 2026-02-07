/**
 * Parse sitemap.xml and sitemap index files
 */
import { parseHTML } from 'linkedom';
import { logger } from '../logger.js';

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
  priority?: number;
}

/**
 * Parse a sitemap XML string and extract URL entries.
 * Handles both <urlset> (regular sitemap) and <sitemapindex> (sitemap index).
 * Returns entries from <url><loc> tags and nested sitemap URLs from <sitemap><loc>.
 */
const DEFAULT_MAX_SITEMAP_ENTRIES = 100_000;

function isHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

function getOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function parseSitemapXml(
  xml: string,
  maxEntries: number = DEFAULT_MAX_SITEMAP_ENTRIES
): {
  entries: SitemapEntry[];
  nestedSitemaps: string[];
} {
  const entries: SitemapEntry[] = [];
  const nestedSitemaps: string[] = [];

  // Use linkedom's HTML parser for XML-like parsing (it handles both)
  const { document } = parseHTML(xml);

  // Extract regular URL entries
  const urlElements = document.querySelectorAll('url');
  for (const urlEl of urlElements) {
    if (entries.length >= maxEntries) break;

    const loc = urlEl.querySelector('loc')?.textContent?.trim();
    if (!loc || !isHttpUrl(loc)) continue;

    const lastmod = urlEl.querySelector('lastmod')?.textContent?.trim();
    const priority = parseFloat(urlEl.querySelector('priority')?.textContent?.trim() ?? '');

    entries.push({ loc, lastmod, priority: isNaN(priority) ? undefined : priority });
  }

  // Extract nested sitemap URLs from sitemap index
  const sitemapElements = document.querySelectorAll('sitemap');
  for (const sitemapEl of sitemapElements) {
    const loc = sitemapEl.querySelector('loc')?.textContent?.trim();
    if (loc && isHttpUrl(loc)) nestedSitemaps.push(loc);
  }

  return { entries, nestedSitemaps };
}

/**
 * Fetch and parse sitemaps recursively (handles sitemap index files).
 * Returns all URL entries found across all sitemaps.
 */
export async function fetchSitemapEntries(
  sitemapUrls: string[],
  fetchFn: (url: string) => Promise<{ ok: boolean; text: string } | null>,
  maxDepth: number = 2,
  maxEntries: number = DEFAULT_MAX_SITEMAP_ENTRIES
): Promise<SitemapEntry[]> {
  const allEntries: SitemapEntry[] = [];
  const visited = new Set<string>();

  // Collect allowed origins from the initial sitemap URLs
  const allowedOrigins = new Set<string>();
  for (const url of sitemapUrls) {
    const origin = getOrigin(url);
    if (origin) allowedOrigins.add(origin);
  }

  async function fetchSitemap(url: string, depth: number): Promise<void> {
    if (depth > maxDepth || visited.has(url)) return;
    if (allEntries.length >= maxEntries) return;
    visited.add(url);

    try {
      const response = await fetchFn(url);
      if (!response?.ok || !response.text) return;

      const remaining = maxEntries - allEntries.length;
      const { entries, nestedSitemaps } = parseSitemapXml(response.text, remaining);

      allEntries.push(...entries);

      for (const nestedUrl of nestedSitemaps) {
        if (allEntries.length >= maxEntries) break;

        const nestedOrigin = getOrigin(nestedUrl);
        if (!nestedOrigin || !allowedOrigins.has(nestedOrigin)) {
          logger.debug({ nestedUrl, url }, 'Skipping cross-origin nested sitemap');
          continue;
        }

        await fetchSitemap(nestedUrl, depth + 1);
      }

      logger.debug(
        { url, entryCount: entries.length, nestedCount: nestedSitemaps.length },
        'Parsed sitemap'
      );
    } catch (e) {
      logger.debug({ url, error: String(e) }, 'Failed to fetch sitemap');
    }
  }

  for (const url of sitemapUrls) {
    if (allEntries.length >= maxEntries) break;
    await fetchSitemap(url, 0);
  }

  return allEntries;
}
