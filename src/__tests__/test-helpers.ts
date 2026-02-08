/**
 * Shared test helpers for unit and integration tests.
 *
 * Provides reusable response builders, HTML generators, and content factories
 * to reduce duplication across test files.
 */
import type { HttpResponse } from '../fetch/http-client.js';
import type { ExtractionResult } from '../extract/types.js';
import type { FetchResult } from '../fetch/types.js';

// ---------------------------------------------------------------------------
// HTTP response builders
// ---------------------------------------------------------------------------

/** Build a successful HTML HttpResponse. */
export function makeResponse(html: string, statusCode = 200): HttpResponse {
  return {
    success: true,
    statusCode,
    html,
    headers: { 'content-type': 'text/html' },
    cookies: [],
  };
}

/** Build a failed HttpResponse with no HTML. */
export function makeFailedResponse(statusCode = 0, error = 'Connection refused'): HttpResponse {
  return {
    success: false,
    statusCode,
    headers: {},
    cookies: [],
    error,
  };
}

/** Build a successful JSON API HttpResponse. */
export function makeJsonResponse(data: unknown, statusCode = 200): HttpResponse {
  return {
    success: true,
    statusCode,
    html: JSON.stringify(data),
    headers: { 'content-type': 'application/json' },
    cookies: [],
  };
}

// ---------------------------------------------------------------------------
// Content generators
// ---------------------------------------------------------------------------

/** Generate lorem-ish text of at least `n` characters. */
export function loremText(n: number): string {
  const base =
    'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ';
  let text = '';
  while (text.length < n) text += base;
  return text;
}

/**
 * Build ~800 characters of lorem ipsum text, guaranteed to exceed
 * GOOD_CONTENT_LENGTH (500 chars).
 */
export function buildLongContent(): string {
  return [
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
    'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
    'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.',
    'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
    'Curabitur pretium tincidunt lacus. Nulla gravida orci a odio. Nullam varius, turpis et commodo pharetra.',
    'Praesent congue erat at massa. Sed cursus turpis vitae tortor. Donec posuere vulputate arcu.',
    'Pellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestas.',
    'Vestibulum tortor quam, feugiat vitae, ultricies eget, tempor sit amet, ante.',
  ].join(' ');
}

// ---------------------------------------------------------------------------
// HTML page builders
// ---------------------------------------------------------------------------

/** Filler HTML that adds byte size without adding word count (blank divs). */
export const HTML_FILLER = '<div class="spacer"></div>\n'.repeat(300);

/**
 * Build a realistic article HTML page that passes quickValidate:
 * - Body >5 KB (padding added if needed)
 * - Word count >100 (stripped text)
 * - Status 200 with text/html content-type
 */
export function buildArticleHtml(options: {
  title?: string;
  paragraphs?: string[];
  extraHead?: string;
  extraBody?: string;
  lang?: string;
}): string {
  const {
    title = 'Test Article Title',
    paragraphs,
    extraHead = '',
    extraBody = '',
    lang = 'en',
  } = options;

  const defaultParagraphs = [
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
    'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
    'Curabitur pretium tincidunt lacus. Nulla gravida orci a odio. Nullam varius, turpis et commodo pharetra, est eros bibendum elit, nec luctus magna felis sollicitudin mauris. Integer in mauris eu nibh euismod gravida.',
    'Praesent congue erat at massa. Sed cursus turpis vitae tortor. Donec posuere vulputate arcu. Phasellus accumsan cursus velit. Vestibulum ante ipsum primis in faucibus orci luctus et ultrices posuere cubilia Curae.',
    'Pellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestas. Vestibulum tortor quam, feugiat vitae, ultricies eget, tempor sit amet, ante. Donec eu libero sit amet quam egestas semper.',
    'Aenean ultricies mi vitae est. Mauris placerat eleifend leo. Quisque sit amet est et sapien ullamcorper pharetra. Vestibulum erat wisi, condimentum sed, commodo vitae, ornare sit amet, wisi.',
    'Fusce fermentum odio nec arcu. Vivamus euismod mauris. In ut quam vitae odio lacinia tincidunt. Praesent ut ligula non mi varius sagittis. Cras sagittis.',
  ];

  const paras = paragraphs ?? defaultParagraphs;
  const paragraphHtml = paras.map((p) => `      <p>${p}</p>`).join('\n');

  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta property="og:title" content="${title}">
  <meta property="og:site_name" content="Example News">
  <title>${title} - Example News</title>
  ${extraHead}
</head>
<body>
  <header><nav>Navigation</nav></header>
  <article>
    <h1>${title}</h1>
${paragraphHtml}
  </article>
  ${extraBody}
  <footer>Footer content</footer>
</body>
</html>`;

  // Ensure >5 KB body size for quickValidate
  const byteLength = Buffer.byteLength(html, 'utf8');
  if (byteLength < 5120) {
    const padding = ' '.repeat(5120 - byteLength);
    return html.replace('</body>', `<!-- ${padding} --></body>`);
  }

  return html;
}

/**
 * Build HTML that fails quickValidate with `insufficient_content`:
 * - >5 KB body size (passes body_too_small check)
 * - <100 words (fails word count check)
 *
 * Uses a large script block to push byte size over 5 KB while keeping
 * readable text under the word count threshold.
 */
export function buildInsufficientContentHtml(extraHead = '', extraBody = ''): string {
  const scriptPadding = `<script>var x = "${' '.repeat(5200)}";</script>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Short Page</title>
  ${extraHead}
</head>
<body>
  ${scriptPadding}
  <p>A short teaser with only a few words visible.</p>
  ${extraBody}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Extraction result builders
// ---------------------------------------------------------------------------

/** Build a minimal ExtractionResult with sensible defaults. */
export function mockExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    title: 'DOM Title',
    byline: 'DOM Author',
    content: '<p>DOM content</p>',
    textContent: 'DOM content',
    excerpt: 'DOM excerpt',
    siteName: 'DOM Site',
    publishedTime: '2024-01-01',
    lang: 'en',
    method: 'readability',
    ...overrides,
  };
}

/** Build a minimal successful FetchResult. */
export function mockFetchResult(url: string, overrides: Partial<FetchResult> = {}): FetchResult {
  return {
    success: true,
    url,
    latencyMs: 10,
    title: `Title for ${url}`,
    content: `<p>Content for ${url}</p>`,
    textContent: 'Content text. '.repeat(20),
    excerpt: 'Excerpt',
    markdown: `Content for ${url}`,
    extractedWordCount: 40,
    statusCode: 200,
    rawHtml: null,
    extractionMethod: 'readability',
    ...overrides,
  };
}
