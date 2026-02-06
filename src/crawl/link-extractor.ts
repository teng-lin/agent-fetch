/**
 * Extract and normalize links from HTML
 */
import { parseHTML } from 'linkedom';

/**
 * Extract absolute HTTP(S) URLs from <a href> tags in HTML.
 * Resolves relative URLs against the base URL, strips fragments, and deduplicates.
 */
export function extractLinks(html: string, baseUrl: string): string[] {
  const { document } = parseHTML(html);
  const links: string[] = [];
  const seen = new Set<string>();

  for (const anchor of document.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href')?.trim();
    if (!href) continue;

    try {
      const resolved = new URL(href, baseUrl);

      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;

      resolved.hash = '';

      const normalized = resolved.href;
      if (!seen.has(normalized)) {
        seen.add(normalized);
        links.push(normalized);
      }
    } catch {
      // Invalid URL, skip
    }
  }

  return links;
}
