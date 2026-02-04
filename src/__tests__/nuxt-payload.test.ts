import { describe, it, expect } from 'vitest';
import {
  extractNuxtPayload,
  extractParagraphs,
  tryNuxtPayloadExtraction,
} from '../extract/nuxt-payload.js';

/** Build a minimal Nuxt 3 payload with the given paragraph objects. */
function buildNuxtPayload(paragraphs: { type: string; html: string }[]): unknown[] {
  const payload: unknown[] = [['ShallowReactive', 1], { data: 2 }, ['ShallowReactive', 3], {}];

  for (const p of paragraphs) {
    const typeIdx = payload.length;
    payload.push(p.type);
    const htmlIdx = payload.length;
    payload.push(p.html);
    payload.push({ type: typeIdx, html: htmlIdx });
  }

  return payload;
}

/** Wrap a payload array in a full HTML page with __NUXT_DATA__ script tag. */
function wrapInHtml(
  payload: unknown[],
  opts?: { title?: string; description?: string; author?: string; siteName?: string }
): string {
  const title = opts?.title ?? 'Test Article';
  const desc = opts?.description ?? 'A test description';
  const meta = [
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${desc}" />`,
    opts?.siteName ? `<meta property="og:site_name" content="${opts.siteName}" />` : '',
    opts?.author ? `<meta name="author" content="${opts.author}" />` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>${meta}</head>
<body>
<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>
</body></html>`;
}

describe('extractNuxtPayload', () => {
  it('returns parsed array from __NUXT_DATA__ script', () => {
    const payload = [1, 'hello', { a: 0 }];
    const html = `<html><head></head><body><script id="__NUXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></body></html>`;
    expect(extractNuxtPayload(html)).toEqual(payload);
  });

  it('returns null when no __NUXT_DATA__ script exists', () => {
    expect(extractNuxtPayload('<html><body></body></html>')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    const html =
      '<html><body><script id="__NUXT_DATA__" type="application/json">not valid json</script></body></html>';
    expect(extractNuxtPayload(html)).toBeNull();
  });

  it('returns null for non-array payload', () => {
    const html =
      '<html><body><script id="__NUXT_DATA__" type="application/json">{"key": "value"}</script></body></html>';
    expect(extractNuxtPayload(html)).toBeNull();
  });
});

describe('extractParagraphs', () => {
  it('extracts paragraph objects from flat payload', () => {
    const payload = buildNuxtPayload([
      { type: 'paragraph', html: '<p>First paragraph with enough text.</p>' },
      { type: 'header', html: 'Section Title' },
      { type: 'paragraph', html: '<p>Second paragraph here.</p>' },
    ]);

    const paragraphs = extractParagraphs(payload);
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0].type).toBe('paragraph');
    expect(paragraphs[0].html).toContain('First paragraph');
    expect(paragraphs[1].type).toBe('header');
    expect(paragraphs[2].type).toBe('paragraph');
  });

  it('skips non-content types', () => {
    const payload = buildNuxtPayload([
      { type: 'paragraph', html: '<p>Article content.</p>' },
      { type: 'ad', html: '<div>Advertisement</div>' },
      { type: 'top25list', html: '<div>List promo</div>' },
    ]);

    const paragraphs = extractParagraphs(payload);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].type).toBe('paragraph');
  });

  it('skips entries with very short html', () => {
    const payload = buildNuxtPayload([
      { type: 'paragraph', html: 'Hi' },
      { type: 'paragraph', html: '<p>This has enough content to pass.</p>' },
    ]);

    const paragraphs = extractParagraphs(payload);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].html).toContain('enough content');
  });

  it('returns empty for payloads without paragraph objects', () => {
    const payload = [1, 'hello', { notType: 0, notHtml: 1 }, 'world'];
    expect(extractParagraphs(payload)).toHaveLength(0);
  });
});

describe('tryNuxtPayloadExtraction', () => {
  const longParagraph =
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.';

  it('extracts article content from a full Nuxt 3 page', () => {
    const payload = buildNuxtPayload([
      {
        type: 'highlights',
        html: '<ul><li>Key point one.</li><li>Key point two.</li></ul>',
      },
      { type: 'paragraph', html: `<p>${longParagraph}</p>` },
      { type: 'paragraph', html: `<p>${longParagraph}</p>` },
      { type: 'header', html: 'Interview Section' },
      { type: 'paragraph', html: `<p>${longParagraph}</p>` },
    ]);

    const html = wrapInHtml(payload, {
      title: 'CEO Interview',
      author: 'Jane Reporter',
      siteName: 'Business News',
    });

    const result = tryNuxtPayloadExtraction(html, 'https://example.com/article');
    expect(result).not.toBeNull();
    expect(result!.method).toBe('nuxt-payload');
    expect(result!.title).toBe('CEO Interview');
    expect(result!.byline).toBe('Jane Reporter');
    expect(result!.siteName).toBe('Business News');
    expect(result!.textContent!.length).toBeGreaterThan(500);
    expect(result!.content).toContain('Lorem ipsum');
    expect(result!.content).toContain('<h2>Interview Section</h2>');
    expect(result!.markdown).toBeTruthy();
  });

  it('returns null when content is below threshold', () => {
    const payload = buildNuxtPayload([{ type: 'paragraph', html: '<p>Short content only.</p>' }]);

    const html = wrapInHtml(payload);
    expect(tryNuxtPayloadExtraction(html, 'https://example.com/article')).toBeNull();
  });

  it('returns null for non-Nuxt pages', () => {
    const html = '<html><body><p>Regular page</p></body></html>';
    expect(tryNuxtPayloadExtraction(html, 'https://example.com/')).toBeNull();
  });

  it('sanitizes dangerous elements from content', () => {
    const payload = buildNuxtPayload([
      {
        type: 'paragraph',
        html: `<p>${longParagraph}<style>.evil{color:red}</style></p>`,
      },
      {
        type: 'paragraph',
        html: `<p>${longParagraph}<iframe src="evil"></iframe></p>`,
      },
      { type: 'paragraph', html: `<p>${longParagraph}</p>` },
    ]);

    const html = wrapInHtml(payload);
    const result = tryNuxtPayloadExtraction(html, 'https://example.com/article');
    expect(result).not.toBeNull();
    expect(result!.content).not.toContain('<style>');
    expect(result!.content).not.toContain('<iframe');
    expect(result!.content).not.toContain('.evil');
  });

  it('extracts metadata from JSON-LD when meta tags are absent', () => {
    const payload = buildNuxtPayload([
      { type: 'paragraph', html: `<p>${longParagraph}</p>` },
      { type: 'paragraph', html: `<p>${longParagraph}</p>` },
    ]);

    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      headline: 'Test Headline',
      author: { '@type': 'Person', name: 'John Author' },
    });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<script type="application/ld+json">${jsonLd}</script>
</head>
<body>
<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>
</body></html>`;

    const result = tryNuxtPayloadExtraction(html, 'https://example.com/article');
    expect(result).not.toBeNull();
    expect(result!.byline).toBe('John Author');
  });

  it('handles list and blockquote types', () => {
    const payload = buildNuxtPayload([
      { type: 'paragraph', html: `<p>${longParagraph}</p>` },
      { type: 'list', html: '<ul><li>Item one</li><li>Item two</li></ul>' },
      { type: 'blockquote', html: 'Important quote from the interview.' },
      { type: 'paragraph', html: `<p>${longParagraph}</p>` },
    ]);

    const html = wrapInHtml(payload);
    const result = tryNuxtPayloadExtraction(html, 'https://example.com/article');
    expect(result).not.toBeNull();
    expect(result!.content).toContain('<blockquote>');
    expect(result!.content).toContain('Important quote');
  });
});
