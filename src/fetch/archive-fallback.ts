/**
 * Archive fallback — fetch articles from Wayback Machine and Archive.is
 * when direct fetch fails (paywall, challenge, insufficient content).
 */
import { httpRequest } from './http-client.js';
import { logger } from '../logger.js';

export interface ArchiveFetchResult {
  success: boolean;
  html?: string;
  archiveUrl?: string;
  error?: string;
}

/**
 * Strip Wayback Machine toolbar and injected scripts from archived HTML.
 */
function stripWaybackToolbar(html: string): string {
  let cleaned = html.replace(
    /<!-- BEGIN WAYBACK TOOLBAR INSERT -->[\s\S]*?<!-- END WAYBACK TOOLBAR INSERT -->/g,
    ''
  );
  cleaned = cleaned.replace(
    /<script[^>]*src=["'][^"']*\/_static\/[^"']*["'][^>]*><\/script>/gi,
    ''
  );
  return cleaned;
}

/**
 * Validate URL protocol to prevent SSRF.
 */
function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Patterns indicating Archive.is has no snapshot for the page. */
const NOT_ARCHIVED_PATTERNS = [
  'no results',
  'not been archived',
  'no snapshots',
  'webpage not found',
];

/**
 * Validate that an Archive.is response contains an actual archived page
 * rather than a "not found" placeholder.
 */
function isArchiveIsPlaceholder(html: string): boolean {
  if (html.length >= 5000) return false;
  const lower = html.toLowerCase();
  return NOT_ARCHIVED_PATTERNS.some((p) => lower.includes(p));
}

interface ArchiveSource {
  name: string;
  buildUrl: (url: string) => string;
  postProcess?: (html: string) => string;
  validate?: (html: string) => string | null; // returns error string or null
}

const WAYBACK: ArchiveSource = {
  name: 'Wayback Machine',
  buildUrl: (url) => `https://web.archive.org/web/2if_/${url}`,
  postProcess: stripWaybackToolbar,
};

const ARCHIVE_IS: ArchiveSource = {
  name: 'Archive.is',
  buildUrl: (url) => `https://archive.is/latest/${url}`,
  validate: (html) => (isArchiveIsPlaceholder(html) ? 'not_archived' : null),
};

/**
 * Fetch from a single archive source. Handles URL validation, HTTP request,
 * error handling, and optional post-processing in one place.
 */
async function fetchFromSource(url: string, source: ArchiveSource): Promise<ArchiveFetchResult> {
  if (!isHttpUrl(url)) {
    return { success: false, error: 'invalid_url' };
  }

  const archiveUrl = source.buildUrl(url);
  logger.debug({ url, archiveUrl }, `Trying ${source.name}`);

  try {
    const response = await httpRequest(archiveUrl);

    if (!response.success || !response.html) {
      logger.debug({ url, statusCode: response.statusCode }, `${source.name} returned no content`);
      return { success: false, error: response.error || 'no_content' };
    }

    if (source.validate) {
      const validationError = source.validate(response.html);
      if (validationError) {
        logger.debug({ url }, `${source.name} reports page not archived`);
        return { success: false, error: validationError };
      }
    }

    const html = source.postProcess ? source.postProcess(response.html) : response.html;
    return { success: true, html, archiveUrl };
  } catch (error) {
    logger.debug({ url, error: String(error) }, `${source.name} fetch failed`);
    return { success: false, error: 'network_error' };
  }
}

/**
 * Fetch a page from the Wayback Machine using the `web/2if_/` shortcut.
 * This auto-redirects to the latest snapshot with raw (id_) content.
 */
export function fetchFromWayback(url: string): Promise<ArchiveFetchResult> {
  return fetchFromSource(url, WAYBACK);
}

/**
 * Fetch a page from Archive.is using the `latest/` endpoint.
 */
export function fetchFromArchiveIs(url: string): Promise<ArchiveFetchResult> {
  return fetchFromSource(url, ARCHIVE_IS);
}

/**
 * Try fetching from archive services: Wayback first, then Archive.is.
 * Sequential to avoid unnecessary load on Archive.is when Wayback succeeds.
 */
export async function fetchFromArchives(url: string): Promise<ArchiveFetchResult> {
  const wayback = await fetchFromWayback(url);
  if (wayback.success) return wayback;

  const archiveIs = await fetchFromArchiveIs(url);
  if (archiveIs.success) return archiveIs;

  return { success: false, error: 'no_archive_available' };
}
