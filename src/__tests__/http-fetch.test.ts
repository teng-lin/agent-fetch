import { describe, it, expect, vi, beforeEach } from 'vitest';
import { httpFetch, resolvePreset } from '../fetch/http-fetch.js';
import type { ExtractionResult } from '../extract/types.js';

// Mock dependencies
vi.mock('../fetch/http-client.js', () => ({
  httpRequest: vi.fn(),
}));

vi.mock('../fetch/content-validator.js', () => ({
  quickValidate: vi.fn(),
}));

vi.mock('../extract/content-extractors.js', () => ({
  extractFromHtml: vi.fn(),
  detectWpRestApi: vi.fn().mockReturnValue(null),
}));

vi.mock('../sites/site-config.js', () => ({
  getSiteUserAgent: vi.fn(),
  getSiteReferer: vi.fn(),
  siteUseWpRestApi: vi.fn().mockReturnValue(false),
  getSiteWpJsonApiPath: vi.fn().mockReturnValue(null),
}));

vi.mock('../fetch/archive-fallback.js', () => ({
  fetchFromArchives: vi.fn().mockResolvedValue({ success: false }),
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
import { extractFromHtml, detectWpRestApi } from '../extract/content-extractors.js';
import {
  getSiteUserAgent,
  getSiteReferer,
  siteUseWpRestApi,
  getSiteWpJsonApiPath,
} from '../sites/site-config.js';
import { fetchFromArchives } from '../fetch/archive-fallback.js';

describe('httpFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns successful result with extracted content', async () => {
    const url = 'https://example.com/article';
    const mockHtml = '<html><body>Article content</body></html>';

    // Mock HTTP request success
    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: mockHtml,
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    // Mock validation success
    vi.mocked(quickValidate).mockReturnValue({ valid: true });

    // Mock extraction success (textContent must be >100 chars)
    const mockExtracted: ExtractionResult = {
      title: 'Test Article',
      byline: 'Test Author',
      content: '<p>Article content</p>',
      textContent: 'Article content. '.repeat(20), // >100 chars
      excerpt: 'Article excerpt',
      siteName: 'Example Site',
      publishedTime: '2024-01-01',
      lang: 'en',
      method: 'readability',
    };
    vi.mocked(extractFromHtml).mockReturnValue(mockExtracted);

    // Mock site config (no custom headers)
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
    const customReferer = 'https://google.com';

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
    vi.mocked(extractFromHtml).mockReturnValue({
      title: 'Test',
      byline: null,
      content: null,
      textContent: 'x'.repeat(200),
      excerpt: null,
      siteName: null,
      publishedTime: null,
      lang: null,
      method: 'readability',
    });

    await httpFetch(url);

    expect(httpRequest).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        'User-Agent': customUA,
        Referer: customReferer,
      }),
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

  it('returns retry_with_extract for challenge detection when extraction fails', async () => {
    const url = 'https://example.com/article';
    const mockHtml = '<html><body><div class="cf-turnstile"></div></body></html>';

    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: mockHtml,
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({
      valid: false,
      error: 'challenge_detected',
      errorDetails: { challengeType: 'cloudflare_turnstile' },
    });

    // Extraction also fails — no content to recover
    vi.mocked(extractFromHtml).mockReturnValue(null);

    const result = await httpFetch(url);

    expect(result.success).toBe(false);
    expect(result.error).toBe('challenge_detected');
    expect(result.suggestedAction).toBe('retry_with_extract');
    expect(result.hint).toBe('This site uses anti-bot challenges');
  });

  it('recovers content from challenge page when extraction succeeds', async () => {
    const url = 'https://example.com/article';
    const mockHtml =
      '<html><body><div class="cf-turnstile"></div><article>Full article...</article></body></html>';

    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: mockHtml,
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({
      valid: false,
      error: 'challenge_detected',
      errorDetails: { challengeType: 'cloudflare_turnstile' },
    });

    // Extraction succeeds — full article content is present
    vi.mocked(extractFromHtml).mockReturnValue({
      title: 'Recovered Article',
      byline: 'Author',
      content: '<article>Full article...</article>',
      textContent: 'Full article content. '.repeat(20),
      excerpt: 'Full article content.',
      siteName: 'Example',
      publishedTime: '2024-01-01',
      lang: 'en',
      method: 'readability',
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(result.title).toBe('Recovered Article');
    expect(result.textContent!.length).toBeGreaterThan(100);
    expect(extractFromHtml).toHaveBeenCalledWith(mockHtml, url);
  });

  it('returns retry_with_extract for access gate when extraction fails', async () => {
    const url = 'https://example.com/article';
    const mockHtml = '<html><body>Subscribe now</body></html>';

    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: mockHtml,
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({
      valid: false,
      error: 'access_restricted',
      errorDetails: { wordCount: 50 },
    });

    // Extraction also fails
    vi.mocked(extractFromHtml).mockReturnValue(null);

    const result = await httpFetch(url);

    expect(result.success).toBe(false);
    expect(result.error).toBe('access_restricted');
    expect(result.suggestedAction).toBe('retry_with_extract');
    expect(result.hint).toBe('This site has an access gate');
  });

  it('recovers content from access-gated page when extraction succeeds', async () => {
    const url = 'https://example.com/article';
    const mockHtml = '<html><body>Subscribe now<article>Full article...</article></body></html>';

    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: mockHtml,
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({
      valid: false,
      error: 'access_restricted',
      errorDetails: { wordCount: 50 },
    });

    vi.mocked(extractFromHtml).mockReturnValue({
      title: 'Gated Article',
      byline: null,
      content: '<article>Full article...</article>',
      textContent: 'Full article content behind gate. '.repeat(10),
      excerpt: null,
      siteName: null,
      publishedTime: null,
      lang: null,
      method: 'readability',
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(result.title).toBe('Gated Article');
    expect(result.textContent!.length).toBeGreaterThan(100);
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
    vi.mocked(extractFromHtml).mockReturnValue({
      title: 'Test',
      byline: null,
      content: null,
      textContent: 'Short',
      excerpt: null,
      siteName: null,
      publishedTime: null,
      lang: null,
      method: 'readability',
    });

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

    // Return extraction with null fields
    vi.mocked(extractFromHtml).mockReturnValue({
      title: 'Test',
      byline: null,
      content: null,
      textContent: 'x'.repeat(200),
      excerpt: null,
      siteName: null,
      publishedTime: null,
      lang: null,
      method: 'readability',
    });

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

    // First call: network error (statusCode 0), second call: success
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
    vi.mocked(extractFromHtml).mockReturnValue({
      title: 'Retry Success',
      byline: null,
      content: '<p>Content</p>',
      textContent: 'Article content. '.repeat(20),
      excerpt: null,
      siteName: null,
      publishedTime: null,
      lang: null,
      method: 'readability',
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(result.title).toBe('Retry Success');
    expect(httpRequest).toHaveBeenCalledTimes(2);
  });

  it('gives up after max retries on persistent network error', async () => {
    const url = 'https://example.com/article';

    // All 3 calls fail with network error
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
    expect(httpRequest).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
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

  it('does not retry dns_rebinding_detected errors', async () => {
    const url = 'https://evil.com/article';

    vi.mocked(httpRequest).mockResolvedValue({
      success: false,
      statusCode: 0,
      headers: {},
      cookies: [],
      error: 'dns_rebinding_detected',
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(false);
    expect(result.error).toBe('dns_rebinding_detected');
    expect(httpRequest).toHaveBeenCalledTimes(1);
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
    vi.mocked(extractFromHtml).mockReturnValue({
      title: 'Test',
      byline: null,
      content: null,
      textContent: 'x'.repeat(200),
      excerpt: null,
      siteName: null,
      publishedTime: null,
      lang: null,
      method: 'readability',
    });

    await httpFetch(url);

    // 3rd argument should be the Android Chrome preset (not undefined)
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
    vi.mocked(extractFromHtml).mockReturnValue({
      title: 'Test',
      byline: null,
      content: null,
      textContent: 'x'.repeat(200),
      excerpt: null,
      siteName: null,
      publishedTime: null,
      lang: null,
      method: 'readability',
    });

    await httpFetch(url);

    const presetArg = vi.mocked(httpRequest).mock.calls[0][2];
    expect(presetArg).toBeUndefined();
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

  describe('archive fallback', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('recovers from challenge page via archive when direct extraction fails', async () => {
      const url = 'https://example.com/article';

      vi.mocked(httpRequest).mockResolvedValue({
        success: true,
        statusCode: 200,
        html: '<html><body><div class="cf-turnstile"></div></body></html>',
        headers: { 'content-type': 'text/html' },
        cookies: [],
      });

      vi.mocked(quickValidate).mockReturnValue({
        valid: false,
        error: 'challenge_detected',
        errorDetails: { challengeType: 'cloudflare_turnstile' },
      });

      // Direct extraction fails
      vi.mocked(extractFromHtml)
        .mockReturnValueOnce(null)
        // Archive extraction succeeds
        .mockReturnValueOnce({
          title: 'Archived Article',
          byline: 'Author',
          content: '<p>Full archived content</p>',
          textContent: 'Full archived content. '.repeat(20),
          excerpt: 'Full archived content.',
          siteName: 'Example',
          publishedTime: null,
          lang: 'en',
          method: 'readability',
        });

      vi.mocked(fetchFromArchives).mockResolvedValueOnce({
        success: true,
        html: '<html><body><p>Full archived content</p></body></html>',
        archiveUrl: 'https://web.archive.org/web/2if_/https://example.com/article',
      });

      const result = await httpFetch(url);

      expect(result.success).toBe(true);
      expect(result.title).toBe('Archived Article');
      expect(result.archiveUrl).toBe(
        'https://web.archive.org/web/2if_/https://example.com/article'
      );
      expect(fetchFromArchives).toHaveBeenCalledWith(url);
    });

    it('does not try archive for 404 errors', async () => {
      const url = 'https://example.com/missing';

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
      expect(fetchFromArchives).not.toHaveBeenCalled();
    });

    it('returns original error when archive also fails', async () => {
      const url = 'https://example.com/article';

      vi.mocked(httpRequest).mockResolvedValue({
        success: true,
        statusCode: 200,
        html: '<html><body>Content</body></html>',
        headers: { 'content-type': 'text/html' },
        cookies: [],
      });

      vi.mocked(quickValidate).mockReturnValue({ valid: true });
      vi.mocked(extractFromHtml).mockReturnValue(null);
      vi.mocked(fetchFromArchives).mockResolvedValueOnce({ success: false });

      const result = await httpFetch(url);

      expect(result.success).toBe(false);
      expect(result.error).toBe('extraction_failed');
      expect(fetchFromArchives).toHaveBeenCalledWith(url);
    });

    it('recovers from insufficient content via archive', async () => {
      const url = 'https://example.com/article';

      vi.mocked(httpRequest).mockResolvedValue({
        success: true,
        statusCode: 200,
        html: '<html><body>Short</body></html>',
        headers: { 'content-type': 'text/html' },
        cookies: [],
      });

      vi.mocked(quickValidate).mockReturnValue({ valid: true });

      // Direct extraction returns insufficient content
      vi.mocked(extractFromHtml)
        .mockReturnValueOnce({
          title: 'Test',
          byline: null,
          content: null,
          textContent: 'Short',
          excerpt: null,
          siteName: null,
          publishedTime: null,
          lang: null,
          method: 'readability',
        })
        // Archive extraction succeeds
        .mockReturnValueOnce({
          title: 'Archived Article',
          byline: null,
          content: '<p>Full content from archive</p>',
          textContent: 'Full content from archive. '.repeat(20),
          excerpt: null,
          siteName: null,
          publishedTime: null,
          lang: 'en',
          method: 'readability',
        });

      vi.mocked(fetchFromArchives).mockResolvedValueOnce({
        success: true,
        html: '<html><body><p>Full content from archive</p></body></html>',
        archiveUrl: 'https://archive.is/latest/https://example.com/article',
      });

      const result = await httpFetch(url);

      expect(result.success).toBe(true);
      expect(result.title).toBe('Archived Article');
      expect(fetchFromArchives).toHaveBeenCalledWith(url);
    });

    it('tries archive on 403 HTTP error', async () => {
      const url = 'https://example.com/paywalled';

      vi.mocked(httpRequest).mockResolvedValue({
        success: false,
        statusCode: 403,
        headers: {},
        cookies: [],
        error: 'forbidden',
      });

      vi.mocked(extractFromHtml).mockReturnValueOnce({
        title: 'Archived Paywall Article',
        byline: null,
        content: '<p>Full archived content</p>',
        textContent: 'Full archived content from wayback. '.repeat(20),
        excerpt: null,
        siteName: null,
        publishedTime: null,
        lang: 'en',
        method: 'readability',
      });

      vi.mocked(fetchFromArchives).mockResolvedValueOnce({
        success: true,
        html: '<html><body><p>Full archived content</p></body></html>',
        archiveUrl: 'https://web.archive.org/web/2if_/https://example.com/paywalled',
      });

      const result = await httpFetch(url);

      expect(result.success).toBe(true);
      expect(result.title).toBe('Archived Paywall Article');
      expect(result.archiveUrl).toBe(
        'https://web.archive.org/web/2if_/https://example.com/paywalled'
      );
      expect(fetchFromArchives).toHaveBeenCalledWith(url);
    });

    it('tries archive when extraction succeeds but word count is low', async () => {
      const url = 'https://example.com/teaser';

      vi.mocked(httpRequest).mockResolvedValue({
        success: true,
        statusCode: 200,
        html: '<html><body>Short teaser</body></html>',
        headers: { 'content-type': 'text/html' },
        cookies: [],
      });

      vi.mocked(quickValidate).mockReturnValue({ valid: true });

      // Direct extraction returns valid but short content (< 100 words, > 100 chars)
      vi.mocked(extractFromHtml)
        .mockReturnValueOnce({
          title: 'Teaser',
          byline: null,
          content: '<p>Subscribe to read more about this topic.</p>',
          textContent: 'Subscribe to read more about this very interesting topic. '.repeat(3),
          excerpt: null,
          siteName: null,
          publishedTime: null,
          lang: 'en',
          method: 'readability',
        })
        // Archive extraction succeeds with full content
        .mockReturnValueOnce({
          title: 'Full Article',
          byline: 'Author',
          content: '<p>Full article from archive</p>',
          textContent: 'Full article from archive with much more content. '.repeat(20),
          excerpt: null,
          siteName: null,
          publishedTime: null,
          lang: 'en',
          method: 'readability',
        });

      vi.mocked(fetchFromArchives).mockResolvedValueOnce({
        success: true,
        html: '<html><body><p>Full article from archive</p></body></html>',
        archiveUrl: 'https://web.archive.org/web/2if_/https://example.com/teaser',
      });

      const result = await httpFetch(url);

      expect(result.success).toBe(true);
      expect(result.title).toBe('Full Article');
      expect(result.archiveUrl).toBe('https://web.archive.org/web/2if_/https://example.com/teaser');
      expect(fetchFromArchives).toHaveBeenCalledWith(url);
    });

    it('keeps direct result when word count is low but archive also fails', async () => {
      const url = 'https://example.com/teaser';

      vi.mocked(httpRequest).mockResolvedValue({
        success: true,
        statusCode: 200,
        html: '<html><body>Short teaser</body></html>',
        headers: { 'content-type': 'text/html' },
        cookies: [],
      });

      vi.mocked(quickValidate).mockReturnValue({ valid: true });

      vi.mocked(extractFromHtml).mockReturnValueOnce({
        title: 'Teaser',
        byline: null,
        content: '<p>Short teaser content.</p>',
        textContent: 'Short teaser content about an interesting topic here. '.repeat(3),
        excerpt: null,
        siteName: null,
        publishedTime: null,
        lang: 'en',
        method: 'readability',
      });

      vi.mocked(fetchFromArchives).mockResolvedValueOnce({ success: false });

      const result = await httpFetch(url);

      // Should still succeed with the direct extraction result
      expect(result.success).toBe(true);
      expect(result.title).toBe('Teaser');
      expect(result.archiveUrl).toBeUndefined();
    });
  });
});

describe('WP REST API fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches from WP REST API when detected and content is insufficient', async () => {
    const url = 'https://example.com/2024/01/article-slug/';
    const apiUrl = 'https://example.com/wp-json/wp/v2/posts/123';

    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: `<html><head><link rel="alternate" type="application/json" href="${apiUrl}" /></head><body>Teaser only.</body></html>`,
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });

    // extractFromHtml returns content >= 100 chars but < 100 words (triggers low word count path)
    vi.mocked(extractFromHtml).mockReturnValueOnce({
      title: 'Article',
      byline: null,
      content: '<p>Teaser only.</p>',
      textContent: 'Teaser only. Subscribe to read more about this very interesting topic. '.repeat(
        3
      ),
      excerpt: null,
      siteName: null,
      publishedTime: null,
      lang: null,
      method: 'readability',
    });

    // detectWpRestApi finds the API URL
    vi.mocked(detectWpRestApi).mockReturnValueOnce(apiUrl);

    // Second httpRequest to WP API returns JSON
    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: JSON.stringify({
        title: { rendered: 'Full Article Title' },
        content: { rendered: '<p>' + 'Full article content. '.repeat(50) + '</p>' },
        excerpt: { rendered: '<p>Article excerpt</p>' },
        date_gmt: '2024-01-15T10:00:00',
        _embedded: { author: [{ name: 'John Doe' }] },
      }),
      headers: { 'content-type': 'application/json' },
      cookies: [],
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(result.title).toBe('Full Article Title');
    expect(result.byline).toBe('John Doe');
    expect(result.extractionMethod).toBe('wp-rest-api');
    expect(httpRequest).toHaveBeenCalledTimes(2);
    // Verify ?_embed was appended to the API URL
    expect(vi.mocked(httpRequest).mock.calls[1][0]).toContain('?_embed');
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
    vi.mocked(extractFromHtml).mockReturnValueOnce({
      title: 'Test',
      byline: null,
      content: null,
      textContent: 'Good content word. '.repeat(150),
      excerpt: null,
      siteName: null,
      publishedTime: null,
      lang: null,
      method: 'readability',
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(httpRequest).toHaveBeenCalledTimes(1);
  });

  it('skips WP REST API when initial extraction has enough content (>= 100 words)', async () => {
    const url = 'https://example.com/article';
    const apiUrl = 'https://example.com/wp-json/wp/v2/posts/123';

    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html:
        '<html><head><link rel="alternate" type="application/json" href="' +
        apiUrl +
        '" /></head><body>Full article</body></html>',
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });

    vi.mocked(extractFromHtml).mockReturnValueOnce({
      title: 'Test',
      byline: null,
      content: null,
      textContent: 'Good content word. '.repeat(150),
      excerpt: null,
      siteName: null,
      publishedTime: null,
      lang: null,
      method: 'readability',
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(httpRequest).toHaveBeenCalledTimes(1);
  });

  it('falls through to archive when WP API also fails', async () => {
    const url = 'https://example.com/article';
    const apiUrl = 'https://example.com/wp-json/wp/v2/posts/123';

    vi.mocked(httpRequest)
      .mockResolvedValueOnce({
        success: true,
        statusCode: 200,
        html:
          '<html><head><link rel="alternate" type="application/json" href="' +
          apiUrl +
          '" /></head><body>Teaser</body></html>',
        headers: { 'content-type': 'text/html' },
        cookies: [],
      })
      .mockResolvedValueOnce({
        success: false,
        statusCode: 403,
        headers: {},
        cookies: [],
        error: 'forbidden',
      });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });
    vi.mocked(extractFromHtml).mockReturnValueOnce({
      title: 'Teaser',
      byline: null,
      content: null,
      textContent: 'Short teaser content about an interesting topic that is long enough. '.repeat(
        3
      ),
      excerpt: null,
      siteName: null,
      publishedTime: null,
      lang: null,
      method: 'readability',
    });

    vi.mocked(detectWpRestApi).mockReturnValueOnce(apiUrl);
    vi.mocked(fetchFromArchives).mockResolvedValueOnce({ success: false });

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(httpRequest).toHaveBeenCalledTimes(2);
  });

  it('tries WP REST API on insufficient_content validation failure', async () => {
    const url = 'https://example.com/2024/01/my-article/';
    const apiUrl = 'https://example.com/wp-json/wp/v2/posts/456';

    // Page returns HTML with WP link tag but validator says insufficient_content
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

    // detectWpRestApi finds the API URL from HTML
    vi.mocked(detectWpRestApi).mockReturnValueOnce(apiUrl);

    // WP API returns full content
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
    const url = 'https://www.example-wp-site.com/my-article-slug';

    // Page HTML has no WP link tag
    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: '<html><body>Short paywall content</body></html>',
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });

    // extractFromHtml returns short content (< 100 words, > 100 chars)
    vi.mocked(extractFromHtml).mockReturnValueOnce({
      title: 'Paywalled Article',
      byline: null,
      content: '<p>Subscribe to read more.</p>',
      textContent: 'Subscribe to read more about this interesting topic here. '.repeat(3),
      excerpt: null,
      siteName: null,
      publishedTime: null,
      lang: null,
      method: 'readability',
    });

    // HTML detection returns null
    vi.mocked(detectWpRestApi).mockReturnValueOnce(null);

    // Config returns custom API path
    vi.mocked(getSiteWpJsonApiPath).mockReturnValueOnce('/wp-json/custom/2.0/posts/');

    // WP API returns full content in custom envelope: {posts: [{content: "..."}]}
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
    // Verify the constructed API URL uses the config path + slug
    const apiCall = vi.mocked(httpRequest).mock.calls[1][0];
    expect(apiCall).toContain('/wp-json/custom/2.0/posts/my-article-slug');
  });

  it('uses config useWpRestApi to construct standard WP API URL', async () => {
    const url = 'https://www.crikey.com.au/2025/08/15/ai-regulation/';

    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: '<html><body>Short paywall content</body></html>',
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });

    vi.mocked(extractFromHtml).mockReturnValueOnce({
      title: 'Paywalled',
      byline: null,
      content: '<p>Subscribe.</p>',
      textContent: 'Subscribe to read this article about AI regulation today. '.repeat(3),
      excerpt: null,
      siteName: null,
      publishedTime: null,
      lang: null,
      method: 'readability',
    });

    // HTML detection returns null, no custom path
    vi.mocked(detectWpRestApi).mockReturnValueOnce(null);
    vi.mocked(getSiteWpJsonApiPath).mockReturnValueOnce(null);
    vi.mocked(siteUseWpRestApi).mockReturnValueOnce(true);

    // WP API returns full content (array for ?slug= queries)
    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: JSON.stringify([
        {
          title: { rendered: 'Full Crikey Article' },
          content: { rendered: '<p>' + 'Full article content. '.repeat(50) + '</p>' },
          excerpt: { rendered: '<p>Excerpt</p>' },
          date_gmt: '2025-08-15T10:00:00',
          _embedded: { author: [{ name: 'Crikey Author' }] },
        },
      ]),
      headers: { 'content-type': 'application/json' },
      cookies: [],
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(result.title).toBe('Full Crikey Article');
    expect(result.extractionMethod).toBe('wp-rest-api');
    // Verify the constructed API URL uses standard WP path + slug
    const apiCall = vi.mocked(httpRequest).mock.calls[1][0];
    expect(apiCall).toContain('/wp-json/wp/v2/posts?slug=ai-regulation');
  });
});
