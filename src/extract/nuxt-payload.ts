/**
 * Nuxt 3 payload extraction strategy.
 *
 * Nuxt 3 SSR embeds a dehydrated __NUXT_DATA__ payload as a flat indexed JSON array:
 *   [value0, value1, ...] where objects use index references for their values.
 *   e.g. {"type": 5, "html": 6} means type = payload[5], html = payload[6]
 */
import { parseHTML } from 'linkedom';

import { htmlToMarkdown } from './markdown.js';
import type { ExtractionResult } from './types.js';
import { GOOD_CONTENT_LENGTH } from './types.js';
import { logger } from '../logger.js';

const CONTENT_TYPES = new Set([
  'paragraph',
  'header',
  'subheader',
  'highlights',
  'list',
  'blockquote',
  'pullquote',
]);

const SKIP_TYPES = new Set(['top25list', 'ad', 'related', 'promo', 'newsletter']);

const MIN_PARAGRAPH_HTML_LENGTH = 5;

interface NuxtParagraph {
  type: string;
  html: string;
}

export function extractNuxtPayload(html: string): unknown[] | null {
  const { document } = parseHTML(html);
  const script = document.querySelector('script#__NUXT_DATA__');
  if (!script?.textContent) return null;

  try {
    const payload = JSON.parse(script.textContent);
    return Array.isArray(payload) ? payload : null;
  } catch (e) {
    logger.debug({ error: String(e) }, 'Failed to parse __NUXT_DATA__ payload');
    return null;
  }
}

export function extractParagraphs(payload: unknown[]): NuxtParagraph[] {
  const paragraphs: NuxtParagraph[] = [];

  for (const item of payload) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;

    const obj = item as Record<string, unknown>;
    if (!('type' in obj && 'html' in obj)) continue;

    const typeIdx = obj.type;
    const htmlIdx = obj.html;

    if (typeof typeIdx !== 'number' || typeof htmlIdx !== 'number') continue;

    const type = payload[typeIdx];
    const html = payload[htmlIdx];

    if (typeof type !== 'string' || typeof html !== 'string') continue;
    if (html.length < MIN_PARAGRAPH_HTML_LENGTH) continue;
    if (SKIP_TYPES.has(type)) continue;

    paragraphs.push({ type, html });
  }

  return paragraphs;
}

function htmlToText(html: string): string {
  const { document } = parseHTML(`<div>${html}</div>`);
  return document.querySelector('div')?.textContent?.trim() ?? '';
}

const DANGEROUS_SELECTORS = ['script', 'style', 'iframe'];

function sanitizeHtml(html: string): string {
  const { document } = parseHTML(`<div>${html}</div>`);
  for (const selector of DANGEROUS_SELECTORS) {
    for (const el of document.querySelectorAll(selector)) {
      el.remove();
    }
  }
  return document.querySelector('div')?.innerHTML ?? html;
}

function wrapParagraphHtml(para: NuxtParagraph): string {
  if (!CONTENT_TYPES.has(para.type) && !para.html.startsWith('<')) {
    return `<p>${para.html}</p>`;
  }

  switch (para.type) {
    case 'header':
    case 'subheader':
      return `<h2>${para.html}</h2>`;
    case 'highlights':
      return para.html;
    case 'blockquote':
    case 'pullquote':
      return `<blockquote>${para.html}</blockquote>`;
    default: {
      const isWrapped = /^<(?:p|ul|ol|div|table|blockquote)[\s>]/i.test(para.html);
      return isWrapped ? para.html : `<p>${para.html}</p>`;
    }
  }
}

function paragraphsToContent(paragraphs: NuxtParagraph[]): {
  html: string;
  textContent: string;
} | null {
  if (paragraphs.length === 0) return null;

  const htmlParts = paragraphs.map(wrapParagraphHtml);
  const textParts = paragraphs.map((p) => htmlToText(p.html));

  if (textParts.every((t) => t.length === 0)) return null;

  return {
    html: sanitizeHtml(htmlParts.join('\n')),
    textContent: textParts.join('\n\n'),
  };
}

function extractAuthorFromJsonLd(document: Document): string | null {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const raw = JSON.parse(script.textContent ?? '');
      const items = Array.isArray(raw) ? raw : [raw];
      for (const item of items) {
        if (!item?.author) continue;
        const author = Array.isArray(item.author) ? item.author[0] : item.author;
        if (typeof author === 'string') return author;
        if (author?.name) return author.name;
      }
    } catch {
      // skip malformed JSON-LD
    }
  }
  return null;
}

function extractMetadata(document: Document): {
  title: string | null;
  byline: string | null;
  excerpt: string | null;
  publishedTime: string | null;
} {
  const title =
    document.querySelector('meta[property="og:title"]')?.getAttribute('content') ??
    document.querySelector('h1')?.textContent?.trim() ??
    null;

  const excerpt =
    document.querySelector('meta[property="og:description"]')?.getAttribute('content') ?? null;

  const publishedTime =
    document.querySelector('meta[property="article:published_time"]')?.getAttribute('content') ??
    document.querySelector('meta[name="date"]')?.getAttribute('content') ??
    null;

  const byline =
    document.querySelector('meta[name="author"]')?.getAttribute('content') ??
    extractAuthorFromJsonLd(document);

  return { title, byline, excerpt, publishedTime };
}

export function tryNuxtPayloadExtraction(html: string, url: string): ExtractionResult | null {
  try {
    const payload = extractNuxtPayload(html);
    if (!payload) return null;

    const paragraphs = extractParagraphs(payload);
    if (paragraphs.length === 0) return null;

    const converted = paragraphsToContent(paragraphs);
    if (!converted || converted.textContent.length < GOOD_CONTENT_LENGTH) return null;

    const { document } = parseHTML(html);
    const meta = extractMetadata(document);

    logger.debug(
      { url, paragraphs: paragraphs.length, textLen: converted.textContent.length },
      'Nuxt payload extraction succeeded'
    );

    return {
      ...meta,
      content: converted.html,
      textContent: converted.textContent,
      siteName:
        document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ?? null,
      lang: document.documentElement.lang || null,
      markdown: htmlToMarkdown(converted.html),
      method: 'nuxt-payload',
    };
  } catch (e) {
    logger.debug({ url, error: String(e) }, 'Nuxt payload extraction failed');
    return null;
  }
}
