import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { httpFetch, resolvePreset, resolveProxy } from '../fetch/http-fetch.js';
import type { ExtractionResult } from '../extract/types.js';

vi.mock('../fetch/http-client.js', () => ({
  httpRequest: vi.fn(),
}));

vi.mock('../fetch/content-validator.js', () => ({
  quickValidate: vi.fn(),
}));

vi.mock('../extract/content-extractors.js', () => ({
  extractFromHtml: vi.fn(),
  detectWpRestApi: vi.fn().mockReturnValue(null),
  tryNextDataExtraction: vi.fn().mockReturnValue(null),
  extractNextBuildId: vi.fn().mockReturnValue(null),
}));

vi.mock('../sites/site-config.js', () => ({
  getSiteUserAgent: vi.fn(),
  getSiteReferer: vi.fn(),
  siteUseWpRestApi: vi.fn().mockReturnValue(false),
  getSiteWpJsonApiPath: vi.fn().mockReturnValue(null),
  siteUseNextData: vi.fn().mockReturnValue(false),
}));

vi.mock('../extract/pdf-extractor.js', () => ({
  isPdfUrl: vi.fn().mockReturnValue(false),
  isPdfContentType: vi.fn().mockReturnValue(false),
  extractPdfFromBuffer: vi.fn(),
}));

vi.mock('../fetch/pdf-fetch.js', () => ({
  fetchRemotePdfBuffer: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { httpRequest } from '../fetch/http-client.js';
import { quickValidate } from '../fetch/content-validator.js';
import {
  extractFromHtml,
  detectWpRestApi,
  extractNextBuildId,
} from '../extract/content-extractors.js';
import {
  getSiteUserAgent,
  getSiteReferer,
  siteUseWpRestApi,
  getSiteWpJsonApiPath,
} from '../sites/site-config.js';
import { isPdfUrl, isPdfContentType, extractPdfFromBuffer } from '../extract/pdf-extractor.js';
import { fetchRemotePdfBuffer } from '../fetch/pdf-fetch.js';

/** Build a minimal ExtractionResult with sensible defaults and overrides. */
function mockExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    title: 'Test',
    byline: null,
    content: null,
    textContent: 'x'.repeat(200),
    excerpt: null,
    siteName: null,
    publishedTime: null,
    lang: null,
    method: 'readability',
    ...overrides,
  };
}

describe('httpFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns successful result with extracted content', async () => {
    const url = 'https://example.com/article';
    const mockHtml = '<html><body>Article content</body></html>';

    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: mockHtml,
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });
    vi.mocked(quickValidate).mockReturnValue({ valid: true });
    vi.mocked(extractFromHtml).mockReturnValue(
      mockExtraction({
        title: 'Test Article',
        byline: 'Test Author',
        content: '<p>Article content</p>',
        textContent: 'Article content. '.repeat(20),
        excerpt: 'Article excerpt',
        siteName: 'Example Site',
        publishedTime: '2024-01-01',
        lang: 'en',
      })
    );
    vi.mocked(getSiteUserAgent).mockReturnValue(null);
    vi.mocked(getSiteReferer).mockReturnValue(null);

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(result.url).toBe(url);
    expect(result.title).toBe('Test Article');
    expect(result.byline).toBe('Test Author');
    expect(result.content).toBe('<p>Article content</p>');
    expect(result.textContent).toBeDefined();
    expect(result.textContent!.length).toBeGreaterThan(100);
    expect(result.excerpt).toBe('Article excerpt');
    expect(result.siteName).toBe('Example Site');
    expect(result.publishedTime).toBe('2024-01-01');
    expect(result.lang).toBe('en');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('applies site-specific user agent and referer headers', async () => {
    const url = 'https://example.com/article';
    const customUA = 'Mozilla/5.0 Custom';
    const customReferer = 'https://search.example.com';

    vi.mocked(getSiteUserAgent).mockReturnValue(customUA);
    vi.mocked(getSiteReferer).mockReturnValue(customReferer);

    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: '<html></html>',
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });
    vi.mocked(extractFromHtml).mockReturnValue(mockExtraction());

    await httpFetch(url);

    expect(httpRequest).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        'User-Agent': customUA,
        Referer: customReferer,
      }),
      undefined,
      undefined,
      undefined,
      undefined
    );
  });

  it('returns rate_limited error for 429 status', async () => {
    const url = 'https://example.com/article';

    vi.mocked(httpRequest).mockResolvedValue({
      success: false,
      statusCode: 429,
      headers: {},
      cookies: [],
      error: 'rate_limited',
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(false);
    expect(result.error).toBe('rate_limited');
    expect(result.suggestedAction).toBe('wait_and_retry');
    expect(result.hint).toBe('Too many requests, wait before retrying');
    expect(result.errorDetails?.statusCode).toBe(429);
  });

  it('returns retry_with_extract suggestion for 403 status', async () => {
    const url = 'https://example.com/article';

    vi.mocked(httpRequest).mockResolvedValue({
      success: false,
      statusCode: 403,
      headers: {},
      cookies: [],
      error: 'forbidden',
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(false);
    expect(result.error).toBe('forbidden');
    expect(result.suggestedAction).toBe('retry_with_extract');
    expect(result.hint).toBe('Site may require browser rendering');
    expect(result.errorDetails?.statusCode).toBe(403);
  });

  it('returns skip suggestion for non-403 HTTP errors', async () => {
    const url = 'https://example.com/article';

    vi.mocked(httpRequest).mockResolvedValue({
      success: false,
      statusCode: 404,
      headers: {},
      cookies: [],
      error: 'not_found',
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(false);
    expect(result.error).toBe('not_found');
    expect(result.suggestedAction).toBe('skip');
    expect(result.errorDetails?.statusCode).toBe(404);
  });

  it('returns skip for insufficient content', async () => {
    const url = 'https://example.com/article';
    const mockHtml = '<html><body>Short</body></html>';

    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: mockHtml,
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({
      valid: false,
      error: 'insufficient_content',
      errorDetails: { wordCount: 10 },
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(false);
    expect(result.error).toBe('insufficient_content');
    expect(result.suggestedAction).toBe('skip');
    expect(result.hint).toBe('Content is too short, may be a stub page');
  });

  it('returns retry_with_extract when extraction returns null', async () => {
    const url = 'https://example.com/article';
    const mockHtml = '<html><body>Content</body></html>';

    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: mockHtml,
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });
    vi.mocked(extractFromHtml).mockReturnValue(null);

    const result = await httpFetch(url);

    expect(result.success).toBe(false);
    expect(result.error).toBe('extraction_failed');
    expect(result.errorDetails?.type).toBe('null_result');
    expect(result.suggestedAction).toBe('retry_with_extract');
    expect(result.hint).toBe('Failed to parse HTML');
  });

  it('returns retry_with_extract when extracted content is too short', async () => {
    const url = 'https://example.com/article';
    const mockHtml = '<html><body>Content</body></html>';

    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: mockHtml,
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });
    vi.mocked(extractFromHtml).mockReturnValue(mockExtraction({ textContent: 'Short' }));

    const result = await httpFetch(url);

    expect(result.success).toBe(false);
    expect(result.error).toBe('insufficient_content');
    expect(result.suggestedAction).toBe('retry_with_extract');
    expect(result.hint).toBe('Extracted content too short');
    expect(result.errorDetails?.wordCount).toBeLessThan(100);
  });

  it('handles network errors gracefully', async () => {
    const url = 'https://example.com/article';

    vi.mocked(httpRequest).mockRejectedValue(new Error('Network timeout'));

    const result = await httpFetch(url);

    expect(result.success).toBe(false);
    expect(result.error).toBe('network_error');
    expect(result.suggestedAction).toBe('retry_with_extract');
    expect(result.hint).toBe('Network request failed');
    expect(result.errorDetails?.type).toBe('Error: Network timeout');
  });

  it('converts null fields to undefined in successful response', async () => {
    const url = 'https://example.com/article';
    const mockHtml = '<html><body>Content</body></html>';

    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: mockHtml,
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });
    vi.mocked(extractFromHtml).mockReturnValue(mockExtraction());

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(result.title).toBe('Test');
    expect(result.byline).toBeUndefined();
    expect(result.content).toBeUndefined();
    expect(result.excerpt).toBeUndefined();
    expect(result.siteName).toBeUndefined();
    expect(result.publishedTime).toBeUndefined();
    expect(result.lang).toBeUndefined();
  });

  it('retries on network timeout and succeeds', async () => {
    const url = 'https://example.com/article';
    const mockHtml = '<html><body>Article content</body></html>';

    vi.mocked(httpRequest)
      .mockResolvedValueOnce({
        success: false,
        statusCode: 0,
        headers: {},
        cookies: [],
        error: 'Error: connect ETIMEDOUT',
      })
      .mockResolvedValueOnce({
        success: true,
        statusCode: 200,
        html: mockHtml,
        headers: { 'content-type': 'text/html' },
        cookies: [],
      });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });
    vi.mocked(extractFromHtml).mockReturnValue(
      mockExtraction({
        title: 'Retry Success',
        content: '<p>Content</p>',
        textContent: 'Article content. '.repeat(20),
      })
    );

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(result.title).toBe('Retry Success');
    expect(httpRequest).toHaveBeenCalledTimes(2);
  });

  it('gives up after max retries on persistent network error', async () => {
    const url = 'https://example.com/article';

    vi.mocked(httpRequest).mockResolvedValue({
      success: false,
      statusCode: 0,
      headers: {},
      cookies: [],
      error: 'Error: connect ETIMEDOUT',
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Error: connect ETIMEDOUT');
    expect(httpRequest).toHaveBeenCalledTimes(3);
  });

  it('does not retry on HTTP errors', async () => {
    const url = 'https://example.com/article';

    vi.mocked(httpRequest).mockResolvedValue({
      success: false,
      statusCode: 403,
      headers: {},
      cookies: [],
      error: 'forbidden',
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(false);
    expect(result.error).toBe('forbidden');
    expect(httpRequest).toHaveBeenCalledTimes(1);
  });

  it('does not retry SSRF protection errors', async () => {
    const url = 'https://evil.example.com/article';

    vi.mocked(httpRequest).mockResolvedValue({
      success: false,
      statusCode: 0,
      headers: {},
      cookies: [],
      error: 'SSRF protection: hostname evil.example.com resolves to private IP 192.168.1.1',
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(false);
    expect(result.error).toContain('SSRF protection');
    expect(httpRequest).toHaveBeenCalledTimes(1);
  });

  it('passes proxy and cookies to httpRequest', async () => {
    const url = 'https://example.com/article';

    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: '<html><body>Content</body></html>',
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });
    vi.mocked(extractFromHtml).mockReturnValue(mockExtraction());
    vi.mocked(getSiteUserAgent).mockReturnValue(null);
    vi.mocked(getSiteReferer).mockReturnValue(null);

    await httpFetch(url, {
      proxy: 'http://proxy.example.com:8080',
      cookies: { session: 'abc123' },
    });

    expect(httpRequest).toHaveBeenCalledWith(
      url,
      expect.any(Object),
      undefined,
      undefined,
      'http://proxy.example.com:8080',
      { session: 'abc123' }
    );
  });

  it('passes proxy and cookies to PDF fetch', async () => {
    const url = 'https://example.com/report.pdf';
    vi.mocked(isPdfUrl).mockReturnValueOnce(true);
    vi.mocked(fetchRemotePdfBuffer).mockResolvedValue({
      buffer: Buffer.from('fake-pdf'),
      statusCode: 200,
    });
    vi.mocked(extractPdfFromBuffer).mockResolvedValue({
      success: true,
      url,
      latencyMs: 50,
      content: 'PDF text',
      textContent: 'PDF text',
      markdown: 'PDF text',
      extractedWordCount: 2,
      statusCode: 200,
      rawHtml: null,
      extractionMethod: 'pdf-parse',
    });

    vi.mocked(getSiteUserAgent).mockReturnValue(null);
    vi.mocked(getSiteReferer).mockReturnValue(null);

    await httpFetch(url, {
      proxy: 'http://proxy.example.com:8080',
      cookies: { session: 'abc123' },
    });

    expect(fetchRemotePdfBuffer).toHaveBeenCalledWith(
      url,
      undefined,
      undefined,
      'http://proxy.example.com:8080',
      { session: 'abc123' }
    );
  });

  it('passes mobile preset to httpRequest for Android Chrome UA', async () => {
    const url = 'https://example.com/article';
    const mobileUA =
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36';

    vi.mocked(getSiteUserAgent).mockReturnValue(mobileUA);
    vi.mocked(getSiteReferer).mockReturnValue(null);

    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: '<html><body>Content</body></html>',
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });
    vi.mocked(extractFromHtml).mockReturnValue(mockExtraction());

    await httpFetch(url);

    const presetArg = vi.mocked(httpRequest).mock.calls[0][2];
    expect(presetArg).toBeDefined();
    expect(typeof presetArg).toBe('string');
  });

  it('passes undefined preset for desktop UA', async () => {
    const url = 'https://example.com/article';

    vi.mocked(getSiteUserAgent).mockReturnValue(null);
    vi.mocked(getSiteReferer).mockReturnValue(null);

    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: '<html><body>Content</body></html>',
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });
    vi.mocked(extractFromHtml).mockReturnValue(mockExtraction());

    await httpFetch(url);

    const presetArg = vi.mocked(httpRequest).mock.calls[0][2];
    expect(presetArg).toBeUndefined();
  });

  describe('WP REST API fallback via resolveWpApiUrl', () => {
    it('detects WP API from HTML link tag and fetches content', async () => {
      // Mock detectWpRestApi to return a URL (simulating link tag detection)
      vi.mocked(detectWpRestApi).mockReturnValueOnce('https://example.com/wp-json/wp/v2/posts/123');

      // First call: returns HTML (DOM extraction returns insufficient content)
      vi.mocked(httpRequest).mockResolvedValueOnce({
        success: true,
        statusCode: 200,
        html: '<html><body><article>Short stub</article></body></html>',
        headers: { 'content-type': 'text/html' },
        cookies: [],
      });

      vi.mocked(quickValidate).mockReturnValueOnce({ valid: true });
      vi.mocked(extractFromHtml).mockReturnValueOnce({
        title: 'WP Article',
        content: '<p>Short stub</p>',
        textContent: 'Short stub',
        byline: null,
        excerpt: null,
        siteName: null,
        publishedTime: null,
        lang: null,
        markdown: null,
        isAccessibleForFree: undefined,
        declaredWordCount: undefined,
        media: undefined,
        method: 'readability',
      });

      // Second call: WP API response with sufficient content
      vi.mocked(httpRequest).mockResolvedValueOnce({
        success: true,
        statusCode: 200,
        html: JSON.stringify({
          id: 123,
          title: { rendered: 'Full WP Article Title' },
          content: {
            rendered: '<p>' + 'Full article content from WordPress REST API. '.repeat(20) + '</p>',
          },
          excerpt: { rendered: '<p>Article excerpt</p>' },
          date: '2025-01-15T10:00:00',
        }),
        headers: { 'content-type': 'application/json' },
        cookies: [],
      });

      const result = await httpFetch('https://example.com/wp-article');
      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('wp-rest-api');
    });

    it('uses config-driven WP REST API with slug from URL', async () => {
      // siteUseWpRestApi triggers the fast path (skips HTML fetch)
      vi.mocked(siteUseWpRestApi).mockReturnValueOnce(true);

      // Fast path: WP API response with sufficient content (first httpRequest call)
      // Content must exceed GOOD_CONTENT_LENGTH (500 chars) to pass the threshold
      vi.mocked(httpRequest).mockResolvedValueOnce({
        success: true,
        statusCode: 200,
        html: JSON.stringify([
          {
            id: 456,
            title: { rendered: 'Config WP Article' },
            content: { rendered: '<p>' + 'WP content word. '.repeat(50) + '</p>' },
            excerpt: { rendered: '<p>Excerpt</p>' },
            date_gmt: '2025-02-01T12:00:00',
            _embedded: { author: [{ name: 'WP Author' }] },
          },
        ]),
        headers: { 'content-type': 'application/json' },
        cookies: [],
      });

      const result = await httpFetch('https://example.com/my-article-slug');

      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('wp-rest-api');
      // Fast path makes a single httpRequest call to the slug-based WP API URL
      expect(vi.mocked(httpRequest)).toHaveBeenCalledTimes(1);
      const firstCallUrl = vi.mocked(httpRequest).mock.calls[0][0];
      expect(firstCallUrl).toContain('/wp-json/wp/v2/posts?slug=my-article-slug');
    });

    it('uses custom wpJsonApiPath from site config', async () => {
      vi.mocked(getSiteWpJsonApiPath).mockReturnValueOnce('/api/v1/posts/');
      vi.mocked(detectWpRestApi).mockReturnValueOnce(null);

      vi.mocked(httpRequest).mockResolvedValueOnce({
        success: true,
        statusCode: 200,
        html: '<html><body><article>Stub</article></body></html>',
        headers: { 'content-type': 'text/html' },
        cookies: [],
      });

      vi.mocked(quickValidate).mockReturnValueOnce({ valid: true });
      vi.mocked(extractFromHtml).mockReturnValueOnce({
        title: 'Custom API',
        content: '<p>Stub</p>',
        textContent: 'Stub',
        byline: null,
        excerpt: null,
        siteName: null,
        publishedTime: null,
        lang: null,
        markdown: null,
        isAccessibleForFree: undefined,
        declaredWordCount: undefined,
        media: undefined,
        method: 'readability',
      });

      vi.mocked(httpRequest).mockResolvedValueOnce({
        success: true,
        statusCode: 200,
        html: JSON.stringify({
          id: 789,
          title: { rendered: 'Custom API Article' },
          content: {
            rendered: '<p>' + 'Content from custom API. '.repeat(20) + '</p>',
          },
          excerpt: { rendered: '<p>Excerpt</p>' },
          date: '2025-02-01',
        }),
        headers: { 'content-type': 'application/json' },
        cookies: [],
      });

      await httpFetch('https://example.com/posts/my-custom-slug');

      const secondCallUrl = vi.mocked(httpRequest).mock.calls[1]?.[0];
      expect(secondCallUrl).toContain('/api/v1/posts/my-custom-slug');
    });
  });
});

describe('resolveProxy', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns explicit proxy when provided', () => {
    expect(resolveProxy('http://proxy.example.com:8080')).toBe('http://proxy.example.com:8080');
  });

  it('falls back to AGENT_FETCH_PROXY env var', () => {
    process.env.AGENT_FETCH_PROXY = 'http://agent-proxy.example.com:3128';
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    expect(resolveProxy()).toBe('http://agent-proxy.example.com:3128');
  });

  it('falls back to HTTPS_PROXY env var', () => {
    delete process.env.AGENT_FETCH_PROXY;
    process.env.HTTPS_PROXY = 'http://https-proxy.example.com:3128';
    delete process.env.HTTP_PROXY;
    expect(resolveProxy()).toBe('http://https-proxy.example.com:3128');
  });

  it('falls back to HTTP_PROXY env var', () => {
    delete process.env.AGENT_FETCH_PROXY;
    delete process.env.HTTPS_PROXY;
    process.env.HTTP_PROXY = 'http://http-proxy.example.com:3128';
    expect(resolveProxy()).toBe('http://http-proxy.example.com:3128');
  });

  it('returns undefined when no proxy configured', () => {
    delete process.env.AGENT_FETCH_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    expect(resolveProxy()).toBeUndefined();
  });

  it('prefers explicit over env vars', () => {
    process.env.AGENT_FETCH_PROXY = 'http://env-proxy.example.com:3128';
    expect(resolveProxy('http://explicit.example.com:8080')).toBe(
      'http://explicit.example.com:8080'
    );
  });

  it('prefers AGENT_FETCH_PROXY over HTTPS_PROXY', () => {
    process.env.AGENT_FETCH_PROXY = 'http://agent.example.com:3128';
    process.env.HTTPS_PROXY = 'http://https.example.com:3128';
    expect(resolveProxy()).toBe('http://agent.example.com:3128');
  });
});

describe('resolvePreset', () => {
  it('returns Android Chrome preset for Android Chrome UA', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36';
    const preset = resolvePreset(ua);
    expect(preset).toBeDefined();
    expect(typeof preset).toBe('string');
  });

  it('returns iOS Chrome preset for iPhone CriOS UA', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/143.0.0.0 Mobile/15E148 Safari/604.1';
    const preset = resolvePreset(ua);
    expect(preset).toBeDefined();
  });

  it('returns iOS Safari preset for iPhone Safari UA (no CriOS)', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    const preset = resolvePreset(ua);
    expect(preset).toBeDefined();
  });

  it('returns undefined for desktop Chrome UA', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
    expect(resolvePreset(ua)).toBeUndefined();
  });

  it('returns undefined for null UA', () => {
    expect(resolvePreset(null)).toBeUndefined();
  });
});

describe('WP REST API primary extraction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prefers WP REST API when DOM content is similar length', async () => {
    const url = 'https://example.com/2024/01/article-slug/';
    const apiUrl = 'https://example.com/wp-json/wp/v2/posts/123';
    const wpContent = 'Full article content. '.repeat(50);

    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: `<html><head><link rel="alternate" type="application/json" href="${apiUrl}" /></head><body>Teaser only.</body></html>`,
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });
    vi.mocked(detectWpRestApi).mockReturnValueOnce(apiUrl);

    // WP API returns full content
    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: JSON.stringify({
        title: { rendered: 'Full Article Title' },
        content: { rendered: '<p>' + wpContent + '</p>' },
        excerpt: { rendered: '<p>Article excerpt</p>' },
        date_gmt: '2024-01-15T10:00:00',
        _embedded: { author: [{ name: 'John Doe' }] },
      }),
      headers: { 'content-type': 'application/json' },
      cookies: [],
    });

    // DOM extraction returns similar-length content (ratio < 2x)
    vi.mocked(extractFromHtml).mockReturnValueOnce(
      mockExtraction({ title: 'DOM Title', textContent: wpContent + ' Some extra words.' })
    );

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(result.title).toBe('Full Article Title');
    expect(result.byline).toBe('John Doe');
    expect(result.extractionMethod).toBe('wp-rest-api');
    expect(httpRequest).toHaveBeenCalledTimes(2);
    expect(extractFromHtml).toHaveBeenCalledTimes(1);
    expect(vi.mocked(httpRequest).mock.calls[1][0]).toContain('?_embed');
  });

  it('prefers DOM content when WP API returns significantly less content', async () => {
    const url = 'https://example.com/2024/01/article-slug/';
    const apiUrl = 'https://example.com/wp-json/wp/v2/posts/123';

    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: `<html><head><link rel="alternate" type="application/json" href="${apiUrl}" /></head><body>Full article here.</body></html>`,
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });
    vi.mocked(detectWpRestApi).mockReturnValueOnce(apiUrl);

    // WP API returns short teaser (no explicit truncation marker)
    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: JSON.stringify({
        title: { rendered: 'WP Title' },
        content: { rendered: '<p>' + 'Short teaser text. '.repeat(30) + '</p>' },
        excerpt: { rendered: '<p>Excerpt</p>' },
        date_gmt: '2024-01-15T10:00:00',
        _embedded: { author: [{ name: 'WP Author' }] },
      }),
      headers: { 'content-type': 'application/json' },
      cookies: [],
    });

    // DOM extraction returns much more content (>2x WP API length)
    const fullArticle = 'Full article paragraph. '.repeat(200);
    vi.mocked(extractFromHtml).mockReturnValueOnce(
      mockExtraction({
        title: 'DOM Title',
        byline: 'DOM Author',
        content: '<p>' + fullArticle + '</p>',
        textContent: fullArticle,
        siteName: 'Example Site',
        lang: 'en',
        method: 'text-density',
      })
    );

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(result.title).toBe('WP Title');
    expect(result.byline).toBe('WP Author');
    expect(result.excerpt).toBe('Excerpt');
    expect(result.publishedTime).toBe('2024-01-15T10:00:00');
    expect(result.textContent).toBe(fullArticle);
    expect(result.extractionMethod).toBe('text-density');
  });

  it('rejects WP API content with teaser tracking parameter', async () => {
    const url = 'https://example.com/article';
    const apiUrl = 'https://example.com/wp-json/wp/v2/posts/456';

    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: `<html><head><link rel="alternate" type="application/json" href="${apiUrl}" /></head><body>Full article</body></html>`,
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });
    vi.mocked(detectWpRestApi).mockReturnValueOnce(apiUrl);

    // WP API returns truncated content with utm_campaign=api link
    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: JSON.stringify({
        title: { rendered: 'Article Title' },
        content: {
          rendered:
            '<p>Teaser paragraph.</p><p><a href="https://example.com/article?utm_campaign=api">Read the rest…</a></p>',
        },
        excerpt: { rendered: '<p>Excerpt</p>' },
        date_gmt: '2024-01-15T10:00:00',
        _embedded: { author: [{ name: 'Author' }] },
      }),
      headers: { 'content-type': 'application/json' },
      cookies: [],
    });

    vi.mocked(extractFromHtml).mockReturnValueOnce(
      mockExtraction({ title: 'Article Title', textContent: 'Good content word. '.repeat(150) })
    );

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(result.extractionMethod).toBe('readability');
    expect(httpRequest).toHaveBeenCalledTimes(2);
    expect(extractFromHtml).toHaveBeenCalledTimes(1);
  });

  it('rejects WP API teaser in config-driven fast path', async () => {
    const url = 'https://wp.example.com/2025/08/15/test-article/';

    vi.mocked(siteUseWpRestApi).mockReturnValueOnce(true);

    // WP API returns truncated content with utm_campaign=api
    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: JSON.stringify([
        {
          title: { rendered: 'Article Title' },
          content: {
            rendered:
              '<p>Teaser only.</p><p><a href="https://wp.example.com/test?utm_campaign=api">Read the rest…</a></p>',
          },
          excerpt: { rendered: '<p>Excerpt</p>' },
          date_gmt: '2025-08-15T10:00:00',
          _embedded: { author: [{ name: 'Author' }] },
        },
      ]),
      headers: { 'content-type': 'application/json' },
      cookies: [],
    });

    // Falls back to HTML fetch
    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: '<html><body>Full article content here</body></html>',
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });

    vi.mocked(extractFromHtml).mockReturnValueOnce(
      mockExtraction({
        title: 'Article Title',
        textContent: 'Full article content. '.repeat(150),
      })
    );

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(result.extractionMethod).toBe('readability');
    expect(httpRequest).toHaveBeenCalledTimes(2);
  });

  it('skips WP REST API when not detected', async () => {
    const url = 'https://example.com/article';

    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: '<html><body>Good content</body></html>',
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });
    vi.mocked(extractFromHtml).mockReturnValueOnce(
      mockExtraction({ textContent: 'Good content word. '.repeat(150) })
    );

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(httpRequest).toHaveBeenCalledTimes(1);
  });

  it('falls back to DOM extraction when WP REST API fails', async () => {
    const url = 'https://example.com/article';
    const apiUrl = 'https://example.com/wp-json/wp/v2/posts/123';

    vi.mocked(httpRequest)
      .mockResolvedValueOnce({
        success: true,
        statusCode: 200,
        html:
          '<html><head><link rel="alternate" type="application/json" href="' +
          apiUrl +
          '" /></head><body>Full article</body></html>',
        headers: { 'content-type': 'text/html' },
        cookies: [],
      })
      // WP API request fails
      .mockResolvedValueOnce({
        success: false,
        statusCode: 403,
        headers: {},
        cookies: [],
        error: 'forbidden',
      });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });
    vi.mocked(detectWpRestApi).mockReturnValueOnce(apiUrl);

    vi.mocked(extractFromHtml).mockReturnValueOnce(
      mockExtraction({ textContent: 'Good content word. '.repeat(150) })
    );

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(result.extractionMethod).toBe('readability');
    expect(httpRequest).toHaveBeenCalledTimes(2);
    expect(extractFromHtml).toHaveBeenCalledTimes(1);
  });

  it('tries WP REST API on insufficient_content validation failure', async () => {
    const url = 'https://example.com/2024/01/my-article/';
    const apiUrl = 'https://example.com/wp-json/wp/v2/posts/456';

    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: `<html><head><link rel="alternate" type="application/json" href="${apiUrl}" /></head><body>Short</body></html>`,
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({
      valid: false,
      error: 'insufficient_content',
      errorDetails: { wordCount: 10 },
    });

    vi.mocked(detectWpRestApi).mockReturnValueOnce(apiUrl);

    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: JSON.stringify({
        title: { rendered: 'Full WP Article' },
        content: { rendered: '<p>' + 'Full article content from WP API. '.repeat(50) + '</p>' },
        excerpt: { rendered: '<p>Excerpt</p>' },
        date_gmt: '2024-01-15T10:00:00',
        _embedded: { author: [{ name: 'WP Author' }] },
      }),
      headers: { 'content-type': 'application/json' },
      cookies: [],
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(result.title).toBe('Full WP Article');
    expect(result.byline).toBe('WP Author');
    expect(result.extractionMethod).toBe('wp-rest-api');
    expect(httpRequest).toHaveBeenCalledTimes(2);
  });

  it('uses config wpJsonApiPath when HTML auto-detection fails', async () => {
    const url = 'https://www.wp.example.com/my-article-slug';

    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: '<html><body>Short content</body></html>',
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });
    vi.mocked(detectWpRestApi).mockReturnValueOnce(null);
    vi.mocked(getSiteWpJsonApiPath).mockReturnValueOnce('/wp-json/custom/2.0/posts/');

    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: JSON.stringify({
        total: 1,
        per_page: 30,
        posts: [
          {
            title: 'Full Article via Custom WP Endpoint',
            content: '<p>' + 'Full article content. '.repeat(50) + '</p>',
            date_gmt: '2024-06-01T08:00:00',
          },
        ],
      }),
      headers: { 'content-type': 'application/json' },
      cookies: [],
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(result.title).toBe('Full Article via Custom WP Endpoint');
    expect(result.extractionMethod).toBe('wp-rest-api');
    const apiCall = vi.mocked(httpRequest).mock.calls[1][0];
    expect(apiCall).toContain('/wp-json/custom/2.0/posts/my-article-slug');
  });

  it('uses config useWpRestApi to skip HTML and go direct to WP API', async () => {
    const url = 'https://wp.example.com/2025/08/15/test-article/';

    vi.mocked(siteUseWpRestApi).mockReturnValueOnce(true);

    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: JSON.stringify([
        {
          title: { rendered: 'Full WP Article' },
          content: { rendered: '<p>' + 'Full article content. '.repeat(50) + '</p>' },
          excerpt: { rendered: '<p>Excerpt</p>' },
          date_gmt: '2025-08-15T10:00:00',
          _embedded: { author: [{ name: 'Test Author' }] },
        },
      ]),
      headers: { 'content-type': 'application/json' },
      cookies: [],
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(result.title).toBe('Full WP Article');
    expect(result.extractionMethod).toBe('wp-rest-api');
    const apiCall = vi.mocked(httpRequest).mock.calls[0][0];
    expect(apiCall).toContain('/wp-json/wp/v2/posts?slug=test-article');
  });
});

describe('Next.js data route fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tries /_next/data/ route when extraction yields short content on a Next.js page', async () => {
    const url = 'https://example.com/section/2026/01/28/article-slug';

    // Initial page fetch
    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: '<html><body>Short teaser</body></html>',
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });

    // Short content (above MIN_EXTRACTION_LENGTH but below GOOD_CONTENT_LENGTH)
    vi.mocked(extractFromHtml).mockReturnValue(
      mockExtraction({
        title: 'Article Title',
        content: '<p>Short teaser</p>',
        textContent: 'Short teaser. '.repeat(10),
        method: 'text-density',
      })
    );

    vi.mocked(extractNextBuildId).mockReturnValue('test-build-id');

    const { tryNextDataExtraction } = await import('../extract/content-extractors.js');
    vi.mocked(tryNextDataExtraction).mockReturnValue(
      mockExtraction({
        title: 'Full Article Title',
        byline: 'Author Name',
        content: 'Full article content. '.repeat(100),
        textContent: 'Full article content. '.repeat(100),
        excerpt: 'Full article excerpt',
        siteName: 'Example Site',
        publishedTime: '2026-01-28',
        lang: 'en',
        method: 'next-data',
      })
    );

    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: JSON.stringify({
        pageProps: {
          content: {
            body: [{ type: 'PARAGRAPH', text: 'Full article content. '.repeat(100) }],
            headline: 'Full Article Title',
          },
        },
      }),
      headers: { 'content-type': 'application/json' },
      cookies: [],
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(result.extractionMethod).toBe('next-data-route');
    expect(result.textContent!.length).toBeGreaterThan(500);
    const dataRouteCall = vi.mocked(httpRequest).mock.calls[1][0];
    expect(dataRouteCall).toContain(
      '/_next/data/test-build-id/section/2026/01/28/article-slug.json'
    );
  });

  it('skips data route when page has no __NEXT_DATA__', async () => {
    const url = 'https://example.com/article';

    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: '<html><body>Short content</body></html>',
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });
    vi.mocked(extractFromHtml).mockReturnValue(
      mockExtraction({ textContent: 'Short content. '.repeat(10) })
    );
    vi.mocked(extractNextBuildId).mockReturnValue(null);

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(httpRequest).toHaveBeenCalledTimes(1);
  });

  it('keeps DOM result when data route fetch fails', async () => {
    const url = 'https://example.com/section/2026/01/28/article-slug';

    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: '<html><body>Short teaser</body></html>',
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });
    vi.mocked(extractFromHtml).mockReturnValue(
      mockExtraction({ title: 'DOM Title', textContent: 'DOM content. '.repeat(10) })
    );

    vi.mocked(extractNextBuildId).mockReturnValue('build-id');

    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: false,
      statusCode: 404,
      headers: {},
      cookies: [],
      error: 'not_found',
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(result.title).toBe('DOM Title');
    expect(result.extractionMethod).toBe('readability');
  });

  it('skips data route when DOM extraction already has good content', async () => {
    const url = 'https://example.com/article';

    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: '<html><body>Full article</body></html>',
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });
    vi.mocked(extractFromHtml).mockReturnValue(
      mockExtraction({ textContent: 'Good content word. '.repeat(150) })
    );
    vi.mocked(extractNextBuildId).mockReturnValue('some-build-id');

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(httpRequest).toHaveBeenCalledTimes(1);
  });

  describe('PDF URL detection', () => {
    it('delegates PDF URLs to fetchRemotePdfBuffer and extractPdfFromBuffer', async () => {
      const url = 'https://example.com/report.pdf';
      vi.mocked(isPdfUrl).mockReturnValue(true);
      vi.mocked(fetchRemotePdfBuffer).mockResolvedValue({
        buffer: Buffer.from('fake-pdf'),
        statusCode: 200,
      });
      vi.mocked(extractPdfFromBuffer).mockResolvedValue({
        success: true,
        url,
        latencyMs: 50,
        content: 'PDF text',
        textContent: 'PDF text',
        markdown: 'PDF text',
        extractedWordCount: 2,
        statusCode: 200,
        rawHtml: null,
        extractionMethod: 'pdf-parse',
      });

      vi.mocked(getSiteUserAgent).mockReturnValue(null);
      vi.mocked(getSiteReferer).mockReturnValue(null);

      const result = await httpFetch(url);

      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('pdf-parse');
      expect(fetchRemotePdfBuffer).toHaveBeenCalledWith(
        url,
        undefined,
        undefined,
        undefined,
        undefined
      );
      expect(extractPdfFromBuffer).toHaveBeenCalledWith(Buffer.from('fake-pdf'), url, 200);
      expect(httpRequest).not.toHaveBeenCalled();
    });

    it('returns failure when PDF fetch fails', async () => {
      const url = 'https://example.com/broken.pdf';
      vi.mocked(isPdfUrl).mockReturnValue(true);
      vi.mocked(fetchRemotePdfBuffer).mockResolvedValue(null);

      vi.mocked(getSiteUserAgent).mockReturnValue(null);
      vi.mocked(getSiteReferer).mockReturnValue(null);

      const result = await httpFetch(url);

      expect(result.success).toBe(false);
      expect(result.error).toBe('pdf_fetch_failed');
      expect(httpRequest).not.toHaveBeenCalled();
    });
  });

  describe('PDF content-type detection', () => {
    it('extracts PDF from response body when content-type is application/pdf', async () => {
      const url = 'https://example.com/document';
      const pdfBody = '%PDF-1.4 binary content';
      vi.mocked(isPdfUrl).mockReturnValueOnce(false);
      vi.mocked(isPdfContentType).mockReturnValueOnce(true);
      vi.mocked(httpRequest).mockResolvedValue({
        success: true,
        statusCode: 200,
        html: pdfBody,
        headers: { 'content-type': 'application/pdf' },
        cookies: [],
      });
      vi.mocked(extractPdfFromBuffer).mockResolvedValue({
        success: true,
        url,
        latencyMs: 50,
        content: 'PDF text',
        textContent: 'PDF text',
        markdown: 'PDF text',
        extractedWordCount: 2,
        statusCode: 200,
        rawHtml: null,
        extractionMethod: 'pdf-parse',
      });
      vi.mocked(getSiteUserAgent).mockReturnValue(null);
      vi.mocked(getSiteReferer).mockReturnValue(null);

      const result = await httpFetch(url);

      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('pdf-parse');
      expect(extractPdfFromBuffer).toHaveBeenCalledWith(Buffer.from(pdfBody, 'latin1'), url, 200);
      expect(fetchRemotePdfBuffer).not.toHaveBeenCalled();
    });
  });

  describe('selector pass-through', () => {
    it('passes targetSelector and removeSelector to extractFromHtml', async () => {
      const url = 'https://example.com/page';
      const mockHtml = '<html><body><article>Content</article></body></html>';

      vi.mocked(isPdfUrl).mockReturnValue(false);
      vi.mocked(httpRequest).mockResolvedValue({
        success: true,
        statusCode: 200,
        html: mockHtml,
        headers: { 'content-type': 'text/html' },
        cookies: [],
      });
      vi.mocked(quickValidate).mockReturnValue({ valid: true });
      vi.mocked(extractFromHtml).mockReturnValue({
        title: 'Test',
        content: '<article>Content</article>',
        textContent: 'Content text. '.repeat(20),
        excerpt: 'Content',
        method: 'readability',
      });
      vi.mocked(getSiteUserAgent).mockReturnValue(null);
      vi.mocked(getSiteReferer).mockReturnValue(null);

      await httpFetch(url, {
        targetSelector: 'article',
        removeSelector: 'nav,.ads',
      });

      expect(extractFromHtml).toHaveBeenCalledWith(mockHtml, url, {
        targetSelector: 'article',
        removeSelector: 'nav,.ads',
      });
    });

    it('includes selector metadata in result', async () => {
      const url = 'https://example.com/page';
      const mockHtml = '<html><body>Content</body></html>';

      vi.mocked(isPdfUrl).mockReturnValue(false);
      vi.mocked(httpRequest).mockResolvedValue({
        success: true,
        statusCode: 200,
        html: mockHtml,
        headers: { 'content-type': 'text/html' },
        cookies: [],
      });
      vi.mocked(quickValidate).mockReturnValue({ valid: true });
      vi.mocked(extractFromHtml).mockReturnValue({
        title: 'Test',
        content: 'Content',
        textContent: 'Content text. '.repeat(20),
        excerpt: 'Content',
        method: 'readability',
      });
      vi.mocked(getSiteUserAgent).mockReturnValue(null);
      vi.mocked(getSiteReferer).mockReturnValue(null);

      const result = await httpFetch(url, {
        targetSelector: 'main',
        removeSelector: 'footer',
      });

      expect(result.success).toBe(true);
      expect(result.selectors).toEqual({
        targetSelector: 'main',
        removeSelector: 'footer',
      });
    });
  });

  describe('includeRawHtml option', () => {
    it('includes raw HTML when includeRawHtml is true', async () => {
      const url = 'https://example.com/page';
      const mockHtml = '<html><body>Full HTML</body></html>';

      vi.mocked(isPdfUrl).mockReturnValue(false);
      vi.mocked(httpRequest).mockResolvedValue({
        success: true,
        statusCode: 200,
        html: mockHtml,
        headers: { 'content-type': 'text/html' },
        cookies: [],
      });
      vi.mocked(quickValidate).mockReturnValue({ valid: true });
      vi.mocked(extractFromHtml).mockReturnValue({
        title: 'Test',
        content: 'Content',
        textContent: 'Content text. '.repeat(20),
        excerpt: 'Content',
        method: 'readability',
      });
      vi.mocked(getSiteUserAgent).mockReturnValue(null);
      vi.mocked(getSiteReferer).mockReturnValue(null);

      const result = await httpFetch(url, { includeRawHtml: true });

      expect(result.success).toBe(true);
      expect(result.rawHtml).toBe(mockHtml);
    });

    it('excludes raw HTML by default', async () => {
      const url = 'https://example.com/page';

      vi.mocked(isPdfUrl).mockReturnValue(false);
      vi.mocked(httpRequest).mockResolvedValue({
        success: true,
        statusCode: 200,
        html: '<html><body>Content</body></html>',
        headers: { 'content-type': 'text/html' },
        cookies: [],
      });
      vi.mocked(quickValidate).mockReturnValue({ valid: true });
      vi.mocked(extractFromHtml).mockReturnValue({
        title: 'Test',
        content: 'Content',
        textContent: 'Content text. '.repeat(20),
        excerpt: 'Content',
        method: 'readability',
      });
      vi.mocked(getSiteUserAgent).mockReturnValue(null);
      vi.mocked(getSiteReferer).mockReturnValue(null);

      const result = await httpFetch(url);

      expect(result.success).toBe(true);
      expect(result.rawHtml).toBeNull();
    });
  });
});
