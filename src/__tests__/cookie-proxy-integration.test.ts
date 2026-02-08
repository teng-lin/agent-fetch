import { describe, it, expect, vi, beforeEach } from 'vitest';
import { httpFetch } from '../fetch/http-fetch.js';

vi.mock('../fetch/http-client.js', () => ({
  httpRequest: vi.fn(),
  httpPost: vi.fn(),
  validateProxyUrl: vi.fn().mockResolvedValue(undefined),
  redactProxyUrl: vi.fn((url: string) => url),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock('../extract/pdf-extractor.js', () => ({
  isPdfUrl: vi.fn().mockReturnValue(false),
  isPdfContentType: vi.fn().mockReturnValue(false),
  extractPdfFromBuffer: vi.fn(),
}));

import { httpRequest, httpPost } from '../fetch/http-client.js';
import { isPdfUrl, extractPdfFromBuffer } from '../extract/pdf-extractor.js';
import { makeResponse, makeJsonResponse, HTML_FILLER } from './test-helpers.js';

const TEST_COOKIES = { session: 'abc123', auth: 'token456' };
const TEST_PROXY = 'http://proxy.example.com:8080';

/** Long article content that exceeds all extraction thresholds. */
const LONG_ARTICLE = 'This is a well-written article paragraph with plenty of content. '.repeat(60);
const LONG_HTML_ARTICLE = `<p>${LONG_ARTICLE}</p>`;

/** Build a good HTML page (>5KB, >100 words) with enough content for extraction. */
function goodPage(body: string): string {
  return `<!DOCTYPE html><html><head><title>Test Page</title></head><body><article>${body}</article>${HTML_FILLER}</body></html>`;
}

/** Build WP REST API JSON post with long content. */
function wpApiPost(): Record<string, unknown> {
  return {
    id: 123,
    title: { rendered: 'WP Article Title' },
    content: { rendered: LONG_HTML_ARTICLE },
    excerpt: { rendered: '<p>Excerpt</p>' },
    date_gmt: '2024-06-15T10:30:00',
    _embedded: { author: [{ name: 'WP Author' }] },
  };
}

/**
 * Build HTML with WP REST API link tag that triggers auto-detection.
 * >5KB and >100 words so quickValidate passes — but short article content
 * so the WP API fallback is preferred over DOM extraction.
 */
function wpDetectablePage(apiUrl: string): string {
  // Enough words to pass validation, but article is short
  const fillerText = 'Navigation menu item link text placeholder. '.repeat(20);
  return `<!DOCTYPE html><html><head>
    <title>WP Page</title>
    <link rel="alternate" type="application/json" href="${apiUrl}" />
  </head><body>
    <nav>${fillerText}</nav>
    <article><p>Brief teaser paragraph here.</p></article>
    ${HTML_FILLER}
  </body></html>`;
}

/** Build HTML with WP AJAX content pattern + enough size for insufficient_content. */
function wpAjaxInsufficientPage(): string {
  return `<!DOCTYPE html><html><head><title>AJAX Page</title>
    <script>
      var ajaxurl = 'https://example.com/wp-admin/admin-ajax.php';
      let articleId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
      jQuery.ajax({ action: 'fetch_article_content', data: {id: articleId} });
    </script>
  </head><body><p>Short teaser.</p>${HTML_FILLER}</body></html>`;
}

/** Build HTML with __NEXT_DATA__ containing Prism/Arc config + insufficient content. */
function prismInsufficientPage(): string {
  const nextData = JSON.stringify({
    runtimeConfig: {
      CLIENT_SIDE_API_DOMAIN: 'https://api.example.com',
      CONTENT_SOURCE: 'content-api-v4',
    },
    query: { _website: 'example' },
  });
  return `<!DOCTYPE html><html><head><title>Prism Page</title>
    <script id="__NEXT_DATA__" type="application/json">${nextData}</script>
  </head><body><p>Short.</p>${HTML_FILLER}</body></html>`;
}

/**
 * Build HTML with Next.js __NEXT_DATA__ containing buildId.
 * Content is >100 words to pass extraction, but short enough (<2000 chars)
 * to trigger the data route probe.
 */
function nextJsShortContentPage(): string {
  const nextData = JSON.stringify({
    buildId: 'test-build-123',
    props: { pageProps: {} },
  });
  // ~150 words of article content (should be >100 chars and <2000 chars for data route trigger)
  const articleText = 'This is a short article teaser sentence with some words. '.repeat(10);
  return `<!DOCTYPE html><html><head><title>Next.js Page</title>
    <script id="__NEXT_DATA__" type="application/json">${nextData}</script>
  </head><body>
    <article><p>${articleText}</p></article>
    ${HTML_FILLER}
  </body></html>`;
}

/** Arc ANS content API response with sufficient content. */
function arcAnsResponse(): Record<string, unknown> {
  return {
    headlines: { basic: 'Arc Article Title' },
    credits: { by: [{ name: 'Arc Author' }] },
    display_date: '2024-08-01T12:00:00Z',
    description: { basic: 'Arc excerpt' },
    content_elements: [{ type: 'text', content: LONG_HTML_ARTICLE }],
  };
}

describe('Cookie propagation through httpFetch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isPdfUrl).mockReturnValue(false);
  });

  it('cookies reach httpRequest on the initial page fetch', async () => {
    vi.mocked(httpRequest).mockResolvedValue(makeResponse(goodPage(LONG_HTML_ARTICLE)));

    await httpFetch('https://example.com/article', { cookies: TEST_COOKIES });

    expect(httpRequest).toHaveBeenCalledTimes(1);
    expect(vi.mocked(httpRequest).mock.calls[0][5]).toEqual(TEST_COOKIES);
  });

  it('cookies are forwarded to WP REST API fallback requests', async () => {
    const apiUrl = 'https://example.com/wp-json/wp/v2/posts/123';

    vi.mocked(httpRequest)
      .mockResolvedValueOnce(makeResponse(wpDetectablePage(apiUrl)))
      .mockResolvedValueOnce(makeJsonResponse([wpApiPost()]));

    const result = await httpFetch('https://example.com/article', { cookies: TEST_COOKIES });

    expect(result.success).toBe(true);
    expect(httpRequest).toHaveBeenCalledTimes(2);
    expect(vi.mocked(httpRequest).mock.calls[0][5]).toEqual(TEST_COOKIES);
    expect(vi.mocked(httpRequest).mock.calls[1][5]).toEqual(TEST_COOKIES);
  });

  it('cookies are forwarded to Prism content API fallback requests', async () => {
    vi.mocked(httpRequest)
      .mockResolvedValueOnce(makeResponse(prismInsufficientPage()))
      .mockResolvedValueOnce(makeJsonResponse(arcAnsResponse()));

    const result = await httpFetch('https://example.com/section/article', {
      cookies: TEST_COOKIES,
    });

    expect(result.success).toBe(true);
    expect(httpRequest).toHaveBeenCalledTimes(2);
    expect(vi.mocked(httpRequest).mock.calls[1][5]).toEqual(TEST_COOKIES);
  });

  it('cookies are forwarded to WP AJAX POST requests', async () => {
    const longAjaxContent =
      '<p>' + 'Full article content from AJAX endpoint with many words. '.repeat(30) + '</p>';

    vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(wpAjaxInsufficientPage()));
    vi.mocked(httpPost).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: longAjaxContent,
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    const result = await httpFetch('https://example.com/article', { cookies: TEST_COOKIES });

    expect(result.success).toBe(true);
    expect(result.extractionMethod).toBe('wp-ajax-content');
    expect(vi.mocked(httpPost).mock.calls[0][6]).toEqual(TEST_COOKIES);
  });

  it('cookies are forwarded to Next.js data route requests', async () => {
    const longNextContent = 'Full article content from Next data route with lots of words. '.repeat(
      50
    );
    const nextDataRouteResponse = {
      pageProps: {
        content: {
          body: [{ type: 'PARAGRAPH', text: longNextContent }],
          headline: 'Full Next Article',
        },
      },
    };

    vi.mocked(httpRequest)
      .mockResolvedValueOnce(makeResponse(nextJsShortContentPage()))
      .mockResolvedValueOnce(makeJsonResponse(nextDataRouteResponse));

    await httpFetch('https://example.com/section/2024/01/article-slug', {
      cookies: TEST_COOKIES,
    });

    // Data route call should have cookies (arg index 5)
    const calls = vi.mocked(httpRequest).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1][5]).toEqual(TEST_COOKIES);
  });

  it('multiple cookies (session + auth) propagated correctly', async () => {
    const multiCookies = { session: 'sess123', auth_token: 'bearer-xyz', tracking: 'off' };

    vi.mocked(httpRequest).mockResolvedValue(makeResponse(goodPage(LONG_HTML_ARTICLE)));

    await httpFetch('https://example.com/article', { cookies: multiCookies });

    expect(vi.mocked(httpRequest).mock.calls[0][5]).toEqual(multiCookies);
  });
});

describe('Proxy propagation through httpFetch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isPdfUrl).mockReturnValue(false);
  });

  it('proxy reaches httpRequest on initial fetch', async () => {
    vi.mocked(httpRequest).mockResolvedValue(makeResponse(goodPage(LONG_HTML_ARTICLE)));

    await httpFetch('https://example.com/article', { proxy: TEST_PROXY });

    expect(httpRequest).toHaveBeenCalledTimes(1);
    expect(vi.mocked(httpRequest).mock.calls[0][4]).toBe(TEST_PROXY);
  });

  it('proxy is forwarded to WP REST API fallback requests', async () => {
    const apiUrl = 'https://example.com/wp-json/wp/v2/posts/123';

    vi.mocked(httpRequest)
      .mockResolvedValueOnce(makeResponse(wpDetectablePage(apiUrl)))
      .mockResolvedValueOnce(makeJsonResponse([wpApiPost()]));

    const result = await httpFetch('https://example.com/article', { proxy: TEST_PROXY });

    expect(result.success).toBe(true);
    expect(vi.mocked(httpRequest).mock.calls[0][4]).toBe(TEST_PROXY);
    expect(vi.mocked(httpRequest).mock.calls[1][4]).toBe(TEST_PROXY);
  });

  it('proxy is forwarded to Prism content API fallback', async () => {
    vi.mocked(httpRequest)
      .mockResolvedValueOnce(makeResponse(prismInsufficientPage()))
      .mockResolvedValueOnce(makeJsonResponse(arcAnsResponse()));

    const result = await httpFetch('https://example.com/section/article', {
      proxy: TEST_PROXY,
    });

    expect(result.success).toBe(true);
    expect(vi.mocked(httpRequest).mock.calls[1][4]).toBe(TEST_PROXY);
  });

  it('proxy is forwarded to WP AJAX POST requests', async () => {
    const longAjaxContent =
      '<p>' + 'Full article content from AJAX endpoint with many words. '.repeat(30) + '</p>';

    vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(wpAjaxInsufficientPage()));
    vi.mocked(httpPost).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: longAjaxContent,
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    const result = await httpFetch('https://example.com/article', { proxy: TEST_PROXY });

    expect(result.success).toBe(true);
    expect(vi.mocked(httpPost).mock.calls[0][5]).toBe(TEST_PROXY);
  });

  it('proxy is forwarded to Next.js data route requests', async () => {
    const longNextContent = 'Full article content from Next data route with lots of words. '.repeat(
      50
    );
    const nextDataRouteResponse = {
      pageProps: {
        content: {
          body: [{ type: 'PARAGRAPH', text: longNextContent }],
          headline: 'Full Next Article',
        },
      },
    };

    vi.mocked(httpRequest)
      .mockResolvedValueOnce(makeResponse(nextJsShortContentPage()))
      .mockResolvedValueOnce(makeJsonResponse(nextDataRouteResponse));

    await httpFetch('https://example.com/section/2024/01/article-slug', {
      proxy: TEST_PROXY,
    });

    const calls = vi.mocked(httpRequest).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1][4]).toBe(TEST_PROXY);
  });

  it('proxy from AGENT_FETCH_PROXY env var resolves and propagates', async () => {
    const savedEnv = process.env.AGENT_FETCH_PROXY;
    process.env.AGENT_FETCH_PROXY = 'http://env-proxy.example.com:3128';

    try {
      vi.mocked(httpRequest).mockResolvedValue(makeResponse(goodPage(LONG_HTML_ARTICLE)));

      await httpFetch('https://example.com/article');

      expect(vi.mocked(httpRequest).mock.calls[0][4]).toBe('http://env-proxy.example.com:3128');
    } finally {
      if (savedEnv !== undefined) {
        process.env.AGENT_FETCH_PROXY = savedEnv;
      } else {
        delete process.env.AGENT_FETCH_PROXY;
      }
    }
  });

  it('proxy is forwarded to PDF fetch path', async () => {
    vi.mocked(isPdfUrl).mockReturnValueOnce(true);

    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: '%PDF-1.4 fake pdf content',
      headers: { 'content-type': 'application/pdf' },
      cookies: [],
    });

    vi.mocked(extractPdfFromBuffer).mockResolvedValueOnce({
      success: true,
      url: 'https://example.com/report.pdf',
      latencyMs: 50,
      content: 'PDF text content',
      textContent: 'PDF text content',
      markdown: 'PDF text content',
      extractedWordCount: 3,
      statusCode: 200,
      rawHtml: null,
      extractionMethod: 'pdf-parse',
    });

    await httpFetch('https://example.com/report.pdf', {
      proxy: TEST_PROXY,
      cookies: TEST_COOKIES,
    });

    // fetchRemotePdfBuffer (real) calls httpRequest with proxy=arg[4], cookies=arg[5]
    expect(vi.mocked(httpRequest).mock.calls[0][4]).toBe(TEST_PROXY);
    expect(vi.mocked(httpRequest).mock.calls[0][5]).toEqual(TEST_COOKIES);
  });
});

describe('Combined cookie + proxy propagation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isPdfUrl).mockReturnValue(false);
  });

  it('both cookie and proxy forwarded to WP REST API fallback', async () => {
    const apiUrl = 'https://example.com/wp-json/wp/v2/posts/123';

    vi.mocked(httpRequest)
      .mockResolvedValueOnce(makeResponse(wpDetectablePage(apiUrl)))
      .mockResolvedValueOnce(makeJsonResponse([wpApiPost()]));

    const result = await httpFetch('https://example.com/article', {
      proxy: TEST_PROXY,
      cookies: TEST_COOKIES,
    });

    expect(result.success).toBe(true);

    for (let i = 0; i < 2; i++) {
      expect(vi.mocked(httpRequest).mock.calls[i][4]).toBe(TEST_PROXY);
      expect(vi.mocked(httpRequest).mock.calls[i][5]).toEqual(TEST_COOKIES);
    }
  });

  it('all httpRequest/httpPost calls in WP AJAX flow receive both cookie and proxy', async () => {
    const longAjaxContent =
      '<p>' + 'Full article from WP AJAX endpoint with lots of words. '.repeat(30) + '</p>';

    vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(wpAjaxInsufficientPage()));
    vi.mocked(httpPost).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: longAjaxContent,
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    const result = await httpFetch('https://example.com/article', {
      proxy: TEST_PROXY,
      cookies: TEST_COOKIES,
    });

    expect(result.success).toBe(true);
    expect(result.extractionMethod).toBe('wp-ajax-content');

    // httpRequest (page fetch): proxy=arg[4], cookies=arg[5]
    expect(vi.mocked(httpRequest).mock.calls[0][4]).toBe(TEST_PROXY);
    expect(vi.mocked(httpRequest).mock.calls[0][5]).toEqual(TEST_COOKIES);

    // httpPost (AJAX): proxy=arg[5], cookies=arg[6]
    expect(vi.mocked(httpPost).mock.calls[0][5]).toBe(TEST_PROXY);
    expect(vi.mocked(httpPost).mock.calls[0][6]).toEqual(TEST_COOKIES);
  });
});
