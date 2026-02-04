/**
 * Prism Content API extraction strategy.
 * Auto-detects Next.js apps with Arc Publishing's Prism content API
 * and fetches full structured content (ANS format) directly.
 */
import { parseHTML } from 'linkedom';

import { htmlToMarkdown } from './markdown.js';
import type { ExtractionResult } from './types.js';
import { GOOD_CONTENT_LENGTH } from './types.js';
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
 */
export function buildPrismContentApiUrl(config: PrismApiConfig, url: string): string {
  const pathname = new URL(url).pathname;
  const query = JSON.stringify({ canonical_url: pathname });
  const apiBase = config.apiDomain.startsWith('http')
    ? config.apiDomain
    : `https://${config.apiDomain}`;
  const websiteParam = config.website ? `_website=${encodeURIComponent(config.website)}&` : '';
  return `${apiBase}/api/${config.contentSource}?${websiteParam}query=${encodeURIComponent(query)}`;
}

/** Strip HTML tags and decode entities by parsing a fragment and returning its text content. */
function htmlToText(html: string): string {
  const { document } = parseHTML(`<div>${html}</div>`);
  return document.querySelector('div')?.textContent?.trim() ?? '';
}

/** Dangerous elements to strip from API-sourced HTML. */
const DANGEROUS_SELECTORS = ['script', 'style', 'iframe'];

/** Remove script, style, and iframe elements from HTML to prevent XSS. */
function sanitizeHtml(html: string): string {
  const { document } = parseHTML(`<div>${html}</div>`);
  for (const selector of DANGEROUS_SELECTORS) {
    for (const el of document.querySelectorAll(selector)) {
      el.remove();
    }
  }
  return document.querySelector('div')?.innerHTML ?? html;
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
