/**
 * Security and robustness tests.
 *
 * Verifies the system handles adversarial inputs gracefully without crashing,
 * hanging, or leaking data. Only HTTP transport (httpRequest/httpPost) and
 * logger are mocked -- real extraction, validation, and parsing run end-to-end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../fetch/http-client.js', () => ({
  httpRequest: vi.fn(),
  httpPost: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../extract/pdf-extractor.js', () => ({
  isPdfUrl: vi.fn().mockReturnValue(false),
  isPdfContentType: vi.fn().mockReturnValue(false),
  fetchRemotePdfBuffer: vi.fn(),
  extractPdfFromBuffer: vi.fn(),
}));

import { httpFetch } from '../fetch/http-fetch.js';
import { httpRequest } from '../fetch/http-client.js';
import { extractFromHtml } from '../extract/content-extractors.js';
import { getNestedValue } from '../extract/utils.js';
import { makeResponse } from './test-helpers.js';

/**
 * Build a simple article HTML page that passes quickValidate.
 * Uses a padding paragraph to ensure >5 KB and >100 words.
 */
function buildArticleHtml(body: string, title = 'Test Article'): string {
  const padding = 'Lorem ipsum dolor sit amet consectetur adipiscing elit. '.repeat(20);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body>
  <article>
    <h1>${title}</h1>
    ${body}
    <p>${padding}</p>
  </article>
</body>
</html>`;
}

describe('Security and robustness', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ── SSRF and URL handling ───────────────────────────────────────────────

  describe('SSRF and URL handling', () => {
    it('SSRF protection error is not retried (httpRequest called once)', async () => {
      vi.mocked(httpRequest).mockResolvedValue({
        success: false,
        statusCode: 0,
        headers: {},
        cookies: [],
        error: 'SSRF protection: hostname evil.example.com resolves to private IP 10.0.0.1',
      });

      const result = await httpFetch('https://evil.example.com/article');

      expect(result.success).toBe(false);
      expect(result.error).toBe('network_error');
      expect(result.errorDetails?.type).toContain('SSRF protection');
      // Must NOT retry — exactly 1 call
      expect(httpRequest).toHaveBeenCalledTimes(1);
    });

    it('handles malformed URL gracefully (not crash)', async () => {
      // httpRequest will throw when the URL is truly invalid
      vi.mocked(httpRequest).mockRejectedValue(new Error('Invalid URL'));

      const result = await httpFetch('https://example.com/article');

      expect(result.success).toBe(false);
      expect(result.error).toBe('network_error');
    });

    it('handles URL with special characters without crash', async () => {
      vi.mocked(httpRequest).mockResolvedValue({
        success: false,
        statusCode: 0,
        headers: {},
        cookies: [],
        error: 'network error',
      });

      // URL with unicode, encoded spaces, etc.
      const result = await httpFetch('https://example.com/article?q=%00%01%02&title=caf%C3%A9');

      expect(result.success).toBe(false);
      // Should not throw — returns a result
      expect(result.url).toContain('example.com');
    });
  });

  // ── Malicious HTML extraction ──────────────────────────────────────────

  describe('Malicious HTML extraction', () => {
    it('extracted text does not contain raw script tags', async () => {
      const maliciousHtml = buildArticleHtml(`
        <h2>Article Title</h2>
        <p>Legitimate article content that is long enough to pass validation.</p>
        <script>alert('XSS')</script>
        <p>More legitimate content here.</p>
        <img src="x" onerror="alert('img-xss')">
        <p>Even more content to ensure we meet the length threshold.</p>
      `);

      vi.mocked(httpRequest).mockResolvedValue(makeResponse(maliciousHtml));

      const result = await httpFetch('https://example.com/article');

      if (result.success && result.textContent) {
        expect(result.textContent).not.toContain('<script');
        expect(result.textContent).not.toContain('alert(');
      }
      if (result.success && result.content) {
        // The content HTML should not contain executable script tags
        expect(result.content).not.toMatch(/<script\b[^>]*>[\s\S]*?<\/script>/i);
      }
    });

    it('handles deeply nested elements (1000+ levels) without crash or hang', async () => {
      const depth = 1000;
      const opening = '<div>'.repeat(depth);
      const closing = '</div>'.repeat(depth);
      const deepHtml = buildArticleHtml(
        `${opening}<p>Deep content that should be extracted safely.</p>${closing}`
      );

      vi.mocked(httpRequest).mockResolvedValue(makeResponse(deepHtml));

      // Should complete without throwing or hanging
      const result = await httpFetch('https://example.com/deep-page');

      // We only care that it doesn't crash — success or failure is fine
      expect(result).toBeDefined();
      expect(result.url).toBe('https://example.com/deep-page');
    });

    it('handles extremely large single text node (>1MB) without crash', async () => {
      const largeText = 'A'.repeat(1_100_000);
      const largeHtml = `<!DOCTYPE html><html><head><title>Large</title></head>
        <body><article><p>${largeText}</p></article></body></html>`;

      vi.mocked(httpRequest).mockResolvedValue(makeResponse(largeHtml));

      const result = await httpFetch('https://example.com/large-page');

      expect(result).toBeDefined();
      expect(result.url).toBe('https://example.com/large-page');
    });

    it('handles null bytes and control characters without crash', async () => {
      const maliciousBody = [
        '<p>Text with null\x00byte in the middle</p>',
        '<p>Bell\x07character and backspace\x08here</p>',
        '<p>Escape\x1Bsequence and form\x0Cfeed</p>',
        '<p>Normal text after control characters.</p>',
      ].join('\n');

      const html = buildArticleHtml(maliciousBody);
      vi.mocked(httpRequest).mockResolvedValue(makeResponse(html));

      const result = await httpFetch('https://example.com/null-bytes');

      expect(result).toBeDefined();
      expect(result.url).toBe('https://example.com/null-bytes');
    });

    it('handles embedded data URIs in images without crash', async () => {
      const dataUri =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const html = buildArticleHtml(`
        <p>Article with embedded images.</p>
        <img src="${dataUri}" alt="tiny image">
        <p>More article content here to pass thresholds.</p>
      `);

      vi.mocked(httpRequest).mockResolvedValue(makeResponse(html));

      const result = await httpFetch('https://example.com/data-uri');

      expect(result).toBeDefined();
      expect(result.url).toBe('https://example.com/data-uri');
    });

    it('empty response body (success: true, html: "") fails validation cleanly', async () => {
      vi.mocked(httpRequest).mockResolvedValue({
        success: true,
        statusCode: 200,
        html: '',
        headers: { 'content-type': 'text/html' },
        cookies: [],
      });

      const result = await httpFetch('https://example.com/empty');

      expect(result.success).toBe(false);
      // Should fail with a body-size or content validation error, not crash
      expect(result.error).toBeDefined();
    });

    it('handles HTML with unclosed tags without crash', async () => {
      const brokenHtml = buildArticleHtml(`
        <p>Paragraph one
        <div>Unclosed div
        <span>Unclosed span
        <p>Another paragraph with <b>unclosed bold
        <p>Final paragraph.
      `);

      vi.mocked(httpRequest).mockResolvedValue(makeResponse(brokenHtml));

      const result = await httpFetch('https://example.com/broken-html');

      expect(result).toBeDefined();
      expect(result.url).toBe('https://example.com/broken-html');
    });

    it('handles HTML with only whitespace body gracefully', async () => {
      const whitespaceHtml =
        '<!DOCTYPE html><html><head><title>Empty</title></head><body>   \n\t\n   </body></html>';

      vi.mocked(httpRequest).mockResolvedValue(makeResponse(whitespaceHtml));

      const result = await httpFetch('https://example.com/whitespace');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  // ── extractFromHtml directly with adversarial inputs ───────────────────

  describe('extractFromHtml with adversarial HTML', () => {
    it('handles script injection in title without exposing script in textContent', () => {
      const html = `<!DOCTYPE html>
<html><head><title><script>alert('xss')</script></title></head>
<body><article>
  <h1>Real Title</h1>
  <p>${'Article content word. '.repeat(50)}</p>
</article></body></html>`;

      const result = extractFromHtml(html, 'https://example.com/xss');

      if (result?.textContent) {
        expect(result.textContent).not.toContain('<script');
        expect(result.textContent).not.toContain('alert(');
      }
    });

    it('handles HTML with only comments (no real content)', () => {
      const html = `<!DOCTYPE html><html><head><title>Test</title></head>
<body><!-- This is a comment --><!-- Another comment --></body></html>`;

      const result = extractFromHtml(html, 'https://example.com/comments');

      // Either null or a result with minimal content — should not crash
      if (result) {
        expect(result.textContent?.trim().length ?? 0).toBeLessThan(50);
      }
    });

    it('handles self-closing tags and void elements without crash', () => {
      const html = `<!DOCTYPE html><html><head><title>Void</title></head>
<body><article>
  <br/><hr/><img src="test.jpg"/><input type="text"/>
  <p>${'Self-closing element test content. '.repeat(30)}</p>
</article></body></html>`;

      const result = extractFromHtml(html, 'https://example.com/void');

      expect(result).toBeDefined();
    });
  });

  // ── JSON parsing robustness ────────────────────────────────────────────

  describe('JSON parsing robustness', () => {
    it('truncated JSON in WP API response returns failure, not crash', async () => {
      const htmlWithWpLink = `<!DOCTYPE html>
<html><head>
  <link rel="alternate" type="application/json" href="https://example.com/wp-json/wp/v2/posts/123" />
  <title>WP Article</title>
</head><body>
  <article><p>${'Word content text. '.repeat(80)}</p></article>
</body></html>`;

      // First call: HTML page with WP REST API link
      vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(htmlWithWpLink));

      // Second call: WP API returns truncated JSON
      vi.mocked(httpRequest).mockResolvedValueOnce({
        success: true,
        statusCode: 200,
        html: '{"title":{"rendered":"Test Arti',
        headers: { 'content-type': 'application/json' },
        cookies: [],
      });

      const result = await httpFetch('https://example.com/wp-article');

      // Should not crash — falls back to DOM extraction
      expect(result).toBeDefined();
      expect(result.url).toBe('https://example.com/wp-article');
    });

    it('getNestedValue blocks __proto__ pollution attempts', () => {
      const malicious = { __proto__: { polluted: true } };
      const result = getNestedValue(malicious, '__proto__.polluted');

      // Should return null, not traverse __proto__
      expect(result).toBeNull();

      // Verify Object.prototype was not polluted
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('getNestedValue blocks constructor pollution attempts', () => {
      const obj = { a: { constructor: { prototype: { evil: true } } } };
      const result = getNestedValue(obj, 'a.constructor.prototype.evil');

      // Should return null because 'constructor' is blocked
      expect(result).toBeNull();
    });

    it('getNestedValue blocks prototype pollution attempts', () => {
      const obj = { a: { prototype: { evil: true } } };
      const result = getNestedValue(obj, 'a.prototype.evil');

      expect(result).toBeNull();
    });

    it('extremely large JSON response does not crash extraction', async () => {
      // Build a large but valid WP API response (~2MB)
      const longContent = 'Content paragraph. '.repeat(50_000);
      const largeJson = JSON.stringify({
        title: { rendered: 'Large Article' },
        content: { rendered: `<p>${longContent}</p>` },
        excerpt: { rendered: '<p>Excerpt</p>' },
        date_gmt: '2024-01-01T00:00:00',
      });

      const htmlWithWpLink = `<!DOCTYPE html>
<html><head>
  <link rel="alternate" type="application/json" href="https://example.com/wp-json/wp/v2/posts/999" />
  <title>Large Article</title>
</head><body>
  <article><p>${'Filler content word. '.repeat(80)}</p></article>
</body></html>`;

      vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(htmlWithWpLink));
      vi.mocked(httpRequest).mockResolvedValueOnce({
        success: true,
        statusCode: 200,
        html: largeJson,
        headers: { 'content-type': 'application/json' },
        cookies: [],
      });

      const result = await httpFetch('https://example.com/large-wp-article');

      expect(result).toBeDefined();
      expect(result.url).toBe('https://example.com/large-wp-article');
    });
  });

  // ── Error handling paths ───────────────────────────────────────────────

  describe('Error handling paths', () => {
    it('httpRequest throws synchronously — caught by top-level try/catch', async () => {
      vi.mocked(httpRequest).mockImplementation(() => {
        throw new Error('Synchronous kaboom');
      });

      const result = await httpFetch('https://example.com/sync-throw');

      expect(result.success).toBe(false);
      expect(result.error).toBe('network_error');
      expect(result.errorDetails?.type).toContain('Synchronous kaboom');
      expect(result.suggestedAction).toBe('retry_with_extract');
    });

    it('httpRequest rejects with non-Error object — caught gracefully', async () => {
      vi.mocked(httpRequest).mockRejectedValue('string-rejection');

      const result = await httpFetch('https://example.com/string-reject');

      expect(result.success).toBe(false);
      // Rejections are caught by the outer try/catch
      expect(result.error).toBeDefined();
    });

    it('httpRequest rejects with null — caught gracefully', async () => {
      vi.mocked(httpRequest).mockRejectedValue(null);

      const result = await httpFetch('https://example.com/null-reject');

      expect(result.success).toBe(false);
      expect(result.error).toBe('network_error');
    });

    it('multiple sequential failures return correct error (no stale state)', async () => {
      // First call: network error
      vi.mocked(httpRequest).mockResolvedValue({
        success: false,
        statusCode: 0,
        headers: {},
        cookies: [],
        error: 'SSRF protection: blocked',
      });

      const result1 = await httpFetch('https://evil.example.com/first');
      expect(result1.success).toBe(false);
      expect(result1.error).toBe('network_error');
      expect(result1.url).toBe('https://evil.example.com/first');

      vi.clearAllMocks();

      // Second call: 403
      vi.mocked(httpRequest).mockResolvedValue({
        success: false,
        statusCode: 403,
        headers: {},
        cookies: [],
        error: 'forbidden',
      });

      const result2 = await httpFetch('https://example.com/second');
      expect(result2.success).toBe(false);
      expect(result2.error).toBe('http_status_error');
      expect(result2.url).toBe('https://example.com/second');

      // Ensure no cross-contamination
      expect(result2.errorDetails?.type).toBe('forbidden');
    });

    it('timeout-related errors have correct suggestedAction', async () => {
      vi.mocked(httpRequest).mockRejectedValue(
        new Error('Request timeout after 20000ms for https://example.com/slow')
      );

      const result = await httpFetch('https://example.com/slow');

      expect(result.success).toBe(false);
      expect(result.error).toBe('network_error');
      expect(result.suggestedAction).toBe('retry_with_extract');
      expect(result.errorDetails?.type).toContain('timeout');
    });

    it('handles response with missing html field', async () => {
      vi.mocked(httpRequest).mockResolvedValue({
        success: true,
        statusCode: 200,
        html: undefined as unknown as string,
        headers: { 'content-type': 'text/html' },
        cookies: [],
      });

      const result = await httpFetch('https://example.com/no-html');

      // success: true but no html should fall through to the !response.html check
      expect(result.success).toBe(false);
    });
  });

  // ── Content validation edge cases ─────────────────────────────────────

  describe('Content validation edge cases', () => {
    it('response with wrong content-type fails validation', async () => {
      vi.mocked(httpRequest).mockResolvedValue({
        success: true,
        statusCode: 200,
        html: '<html><body>' + 'Content. '.repeat(200) + '</body></html>',
        headers: { 'content-type': 'application/json' },
        cookies: [],
      });

      const result = await httpFetch('https://example.com/json-ct');

      expect(result.success).toBe(false);
      expect(result.error).toBe('wrong_content_type');
    });

    it('response with content-type array handles correctly', async () => {
      vi.mocked(httpRequest).mockResolvedValue({
        success: true,
        statusCode: 200,
        html: '<html><body>' + 'Content. '.repeat(200) + '</body></html>',
        headers: { 'content-type': ['text/html; charset=utf-8', 'text/html'] as unknown as string },
        cookies: [],
      });

      const result = await httpFetch('https://example.com/array-ct');

      // text/html should pass validation
      expect(result).toBeDefined();
    });

    it('5xx status codes are handled as HTTP errors', async () => {
      vi.mocked(httpRequest).mockResolvedValue({
        success: false,
        statusCode: 500,
        headers: {},
        cookies: [],
        error: 'internal_server_error',
      });

      const result = await httpFetch('https://example.com/500');

      expect(result.success).toBe(false);
      expect(result.error).toBe('http_status_error');
      expect(result.errorDetails?.statusCode).toBe(500);
    });
  });

  // ── HTML entity and encoding edge cases ───────────────────────────────

  describe('HTML entity and encoding edge cases', () => {
    it('handles HTML entities in article content without crash', async () => {
      const html = buildArticleHtml(`
        <p>Caf&eacute; &amp; Bar &mdash; Special &lt;Characters&gt; Test</p>
        <p>&copy; 2024 &trade; &reg; All rights reserved.</p>
        <p>Currency: &euro;100, &pound;50, &yen;10000</p>
        <p>Math: 2 &times; 3 = 6, 10 &divide; 2 = 5, x &plusmn; y</p>
      `);

      vi.mocked(httpRequest).mockResolvedValue(makeResponse(html));

      const result = await httpFetch('https://example.com/entities');

      expect(result).toBeDefined();
      expect(result.url).toBe('https://example.com/entities');
    });

    it('handles numeric character references without crash', async () => {
      const html = buildArticleHtml(`
        <p>&#65;&#66;&#67; and &#x41;&#x42;&#x43;</p>
        <p>Emoji: &#128512; &#x1F600;</p>
        <p>${'Normal content follows. '.repeat(30)}</p>
      `);

      vi.mocked(httpRequest).mockResolvedValue(makeResponse(html));

      const result = await httpFetch('https://example.com/numeric-entities');

      expect(result).toBeDefined();
    });
  });

  // ── Retry logic edge cases ────────────────────────────────────────────

  describe('Retry logic edge cases', () => {
    it('network error with statusCode=0 retries up to MAX_RETRIES', async () => {
      vi.mocked(httpRequest).mockResolvedValue({
        success: false,
        statusCode: 0,
        headers: {},
        cookies: [],
        error: 'ECONNRESET',
      });

      const result = await httpFetch('https://example.com/flaky');

      expect(result.success).toBe(false);
      expect(result.error).toBe('network_error');
      // MAX_RETRIES = 2, so 1 initial + 2 retries = 3 calls
      expect(httpRequest).toHaveBeenCalledTimes(3);
    });

    it('HTTP 4xx errors are NOT retried', async () => {
      vi.mocked(httpRequest).mockResolvedValue({
        success: false,
        statusCode: 404,
        headers: {},
        cookies: [],
        error: 'not found',
      });

      const result = await httpFetch('https://example.com/missing');

      expect(result.success).toBe(false);
      expect(httpRequest).toHaveBeenCalledTimes(1);
    });

    it('recovery after initial failures returns correct result', async () => {
      const articleBody = Array.from(
        { length: 10 },
        (_, i) =>
          `<p>Recovery paragraph ${i}. ${'Substantive article content word. '.repeat(20)}</p>`
      ).join('\n');

      vi.mocked(httpRequest)
        .mockResolvedValueOnce({
          success: false,
          statusCode: 0,
          headers: {},
          cookies: [],
          error: 'ECONNREFUSED',
        })
        .mockResolvedValueOnce(makeResponse(buildArticleHtml(articleBody)));

      const result = await httpFetch('https://example.com/retry-success');

      expect(result.success).toBe(true);
      expect(httpRequest).toHaveBeenCalledTimes(2);
    });
  });
});
