/**
 * Parse robots.txt for Disallow rules and Sitemap directives
 */
import { logger } from '../logger.js';

export interface RobotsRules {
  disallowPaths: string[];
  sitemapUrls: string[];
}

/**
 * Parse robots.txt content into structured rules.
 * Extracts Disallow rules for the wildcard user-agent (*) and all Sitemap directives.
 */
export function parseRobotsTxt(content: string): RobotsRules {
  const disallowPaths: string[] = [];
  const sitemapUrls: string[] = [];
  let inWildcardBlock = false;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const field = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (field === 'user-agent') {
      inWildcardBlock = value === '*';
      continue;
    }

    if (field === 'sitemap' && value) {
      sitemapUrls.push(value);
      continue;
    }

    if (field === 'disallow' && value && inWildcardBlock) {
      disallowPaths.push(value);
    }
  }

  return { disallowPaths, sitemapUrls };
}

/**
 * Check if a URL path is allowed by robots.txt Disallow rules.
 */
export function isAllowedByRobots(urlPath: string, disallowPaths: string[]): boolean {
  for (const disallowed of disallowPaths) {
    if (urlPath.startsWith(disallowed)) return false;
  }
  return true;
}

/**
 * Fetch and parse robots.txt for a given origin.
 * Returns null if robots.txt is not found or cannot be fetched.
 */
export async function fetchRobotsTxt(
  origin: string,
  fetchFn: (url: string) => Promise<{ ok: boolean; text: string } | null>
): Promise<RobotsRules | null> {
  try {
    const url = `${origin}/robots.txt`;
    const response = await fetchFn(url);
    if (!response?.ok || !response.text) return null;

    const rules = parseRobotsTxt(response.text);
    logger.debug(
      { origin, disallowCount: rules.disallowPaths.length, sitemapCount: rules.sitemapUrls.length },
      'Parsed robots.txt'
    );
    return rules;
  } catch (e) {
    logger.debug({ origin, error: String(e) }, 'Failed to fetch robots.txt');
    return null;
  }
}
