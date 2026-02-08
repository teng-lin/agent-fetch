/**
 * Next.js data route extraction.
 *
 * Fetches content from the Next.js /_next/data/ route, which sometimes
 * returns richer content than the SSR HTML.
 */
import { httpRequest } from './http-client.js';
import { parseHTML } from 'linkedom';
import { tryNextDataExtraction, extractNextBuildId } from '../extract/content-extractors.js';
import type { ExtractionResult } from '../extract/types.js';
import type { RequestContext } from './types.js';
import { logger } from '../logger.js';

/**
 * Construct the Next.js data route URL from a buildId and page URL.
 * Example: buildId="abc", url="https://example.com/section/slug"
 *   => "https://example.com/_next/data/abc/section/slug.json"
 */
export function buildNextDataRouteUrl(url: string, buildId: string): string {
  const parsed = new URL(url);
  const pathname = parsed.pathname.replace(/\/$/, '') || '/index';
  return `${parsed.origin}/_next/data/${buildId}${pathname}.json`;
}

/**
 * Fetch content from the Next.js /_next/data/ route and extract it.
 * Returns an ExtractionResult if the data route yields content, null otherwise.
 *
 * The caller is responsible for comparing against DOM extraction length
 * and wrapping the result in a FetchResult.
 */
export async function fetchNextDataRoute(
  html: string,
  url: string,
  ctx: RequestContext
): Promise<ExtractionResult | null> {
  const { document } = parseHTML(html);
  const buildId = extractNextBuildId(document);
  if (!buildId) return null;

  const dataRouteUrl = buildNextDataRouteUrl(url, buildId);

  try {
    logger.debug({ url, dataRouteUrl }, 'Trying Next.js data route');

    const dataResponse = await httpRequest(
      dataRouteUrl,
      { Accept: 'application/json' },
      ctx.preset,
      ctx.timeout,
      ctx.proxy,
      ctx.cookies
    );
    if (!dataResponse.success || !dataResponse.html) return null;

    const json = JSON.parse(dataResponse.html);
    const pageProps = json.pageProps;
    if (!pageProps) return null;

    // Build a synthetic __NEXT_DATA__ document so tryNextDataExtraction can process it
    const syntheticData = JSON.stringify({ buildId, props: { pageProps } }).replace(
      /</g,
      '\\u003c'
    );
    const syntheticHtml = `<html><head><script id="__NEXT_DATA__" type="application/json">${syntheticData}</script></head><body></body></html>`;
    const { document: syntheticDoc } = parseHTML(syntheticHtml);

    const result = tryNextDataExtraction(syntheticDoc, url);
    return result?.textContent ? result : null;
  } catch (e) {
    logger.debug({ url, dataRouteUrl, error: String(e) }, 'Next.js data route failed');
    return null;
  }
}
