/**
 * Prism Content API extraction strategy.
 * Auto-detects Next.js apps with Arc Publishing's Prism content API
 * and fetches full structured content (ANS format) directly.
 */
import { parseHTML } from 'linkedom';

import { htmlToMarkdown } from './markdown.js';
import type { ExtractionResult } from './types.js';
import { GOOD_CONTENT_LENGTH } from './types.js';
import { htmlToText, sanitizeHtml } from './utils.js';
import { logger } from '../logger.js';

export interface PrismApiConfig {
  apiDomain: string;
  contentSource: string;
  website: string | null;
}

/**
 * Detect Prism content API configuration from __NEXT_DATA__.
 * Looks for runtimeConfig with CLIENT_SIDE_API_DOMAIN and CONTENT_SOURCE.
 */
export function detectPrismContentApi(html: string): PrismApiConfig | null {
  try {
    const { document } = parseHTML(html);
    const script = document.querySelector('script#__NEXT_DATA__');
    if (!script?.textContent) return null;

    const data = JSON.parse(script.textContent);
    const runtimeConfig = data?.runtimeConfig ?? data?.props?.runtimeConfig;
    if (!runtimeConfig) return null;

    const apiDomain = runtimeConfig.CLIENT_SIDE_API_DOMAIN;
    const contentSource = runtimeConfig.CONTENT_SOURCE;
    if (typeof apiDomain !== 'string' || typeof contentSource !== 'string') return null;
    if (!apiDomain || !contentSource) return null;

    // Derive website identifier from __NEXT_DATA__ query or runtimeConfig (not always present)
    const rawWebsite =
      data?.query?._website ?? runtimeConfig.ARC_SITE ?? runtimeConfig.WEBSITE ?? null;
    const website = typeof rawWebsite === 'string' && rawWebsite ? rawWebsite : null;

    return { apiDomain, contentSource, website };
  } catch (e) {
    logger.debug({ error: String(e) }, 'Failed to detect Prism content API from __NEXT_DATA__');
    return null;
  }
}

/**
 * Build the Prism content API URL for a given page URL.
 * Returns null if the API domain does not share the same site as the page (SSRF protection).
 */
export function buildPrismContentApiUrl(config: PrismApiConfig, url: string): string | null {
  const apiBase = config.apiDomain.startsWith('http')
    ? config.apiDomain
    : `https://${config.apiDomain}`;

  // SSRF protection: reject API domains that don't share the page's registered domain
  try {
    const pageHost = new URL(url).hostname;
    const apiHost = new URL(apiBase).hostname;
    if (!isSameSite(apiHost, pageHost)) {
      logger.debug(
        { url, apiDomain: config.apiDomain },
        'Prism API domain is cross-site, rejecting'
      );
      return null;
    }
  } catch (e) {
    logger.debug({ error: String(e), url }, 'Failed to parse Prism API URL');
    return null;
  }

  const pathname = new URL(url).pathname;
  const query = JSON.stringify({ canonical_url: pathname });
  const websiteParam = config.website ? `_website=${encodeURIComponent(config.website)}&` : '';
  return `${apiBase}/api/${config.contentSource}?${websiteParam}query=${encodeURIComponent(query)}`;
}

/**
 * Check if two hostnames belong to the same site by comparing the last two
 * domain labels (e.g. api.example.com and www.example.com both share example.com).
 *
 * IP addresses and single-label hosts (e.g. localhost) require exact match.
 *
 * Limitation: without a public suffix list, multi-level TLDs like .co.uk are
 * treated as registrable domains, so evil.co.uk and victim.co.uk would match.
 * In practice this is acceptable because: (1) Arc/Prism sites use standard TLDs,
 * and (2) httpcloak's SSRF protection blocks private IPs at the network level.
 */
function isSameSite(a: string, b: string): boolean {
  if (a === b) return true;
  // IP addresses and single-label hosts must match exactly
  if (/^\d+\.\d+\.\d+\.\d+$/.test(a) || /^\d+\.\d+\.\d+\.\d+$/.test(b)) return false;
  if (/^[\d:[\]]+$/.test(a) || /^[\d:[\]]+$/.test(b)) return false;
  const partsA = a.split('.');
  const partsB = b.split('.');
  if (partsA.length < 2 || partsB.length < 2) return false;
  return partsA.slice(-2).join('.') === partsB.slice(-2).join('.');
}

/**
 * Convert Arc ANS content_elements to HTML and plain text.
 */
function convertContentElements(elements: unknown[]): { html: string; textContent: string } | null {
  const htmlParts: string[] = [];
  const textParts: string[] = [];

  for (const el of elements) {
    if (!el || typeof el !== 'object') continue;
    const element = el as Record<string, unknown>;
    const type = element.type as string | undefined;
    const content = element.content as string | undefined;

    switch (type) {
      case 'text':
      case 'raw_html': {
        if (content) {
          htmlParts.push(content);
          textParts.push(htmlToText(content));
        }
        break;
      }
      case 'header': {
        const rawLevel = Number(element.level);
        const level = Number.isInteger(rawLevel) && rawLevel >= 1 && rawLevel <= 6 ? rawLevel : 2;
        if (content) {
          htmlParts.push(`<h${level}>${content}</h${level}>`);
          textParts.push(htmlToText(content));
        }
        break;
      }
      case 'list': {
        const items = element.items as { content?: string }[] | undefined;
        if (Array.isArray(items) && items.length > 0) {
          const listType = (element.list_type as string) === 'ordered' ? 'ol' : 'ul';
          const listItems = items
            .filter((item) => item.content)
            .map((item) => `<li>${item.content}</li>`)
            .join('');
          htmlParts.push(`<${listType}>${listItems}</${listType}>`);
          for (const item of items) {
            if (item.content) textParts.push(htmlToText(item.content));
          }
        }
        break;
      }
      // Skip non-text content types: image, video, interstitial_link, etc.
    }
  }

  if (textParts.length === 0) return null;

  return {
    html: htmlParts.join('\n'),
    textContent: textParts.join('\n\n'),
  };
}

/**
 * Parse an Arc ANS API response into an ExtractionResult.
 * Returns null if response is invalid or content is insufficient.
 */
export function parseArcAnsContent(json: unknown): ExtractionResult | null {
  if (!json || typeof json !== 'object') return null;

  const data = json as Record<string, unknown>;
  const contentElements = data.content_elements as unknown[] | undefined;
  if (!Array.isArray(contentElements) || contentElements.length === 0) return null;

  const raw = convertContentElements(contentElements);
  if (!raw || raw.textContent.length < GOOD_CONTENT_LENGTH) return null;

  const sanitizedHtml = sanitizeHtml(raw.html);

  // Extract metadata
  const headlines = data.headlines as Record<string, unknown> | undefined;
  const title = (headlines?.basic as string) ?? null;

  const credits = data.credits as Record<string, unknown> | undefined;
  const byArray = credits?.by as { name?: string }[] | undefined;
  const byline = Array.isArray(byArray)
    ? byArray
        .map((b) => b.name)
        .filter(Boolean)
        .join(', ') || null
    : null;

  const publishedTime = (data.display_date as string) ?? null;

  const description = data.description as Record<string, unknown> | undefined;
  const excerpt = (description?.basic as string) ?? null;

  return {
    title,
    byline,
    content: sanitizedHtml,
    textContent: raw.textContent,
    excerpt,
    siteName: null,
    publishedTime,
    lang: null,
    markdown: htmlToMarkdown(sanitizedHtml),
    method: 'prism-content-api',
  };
}
