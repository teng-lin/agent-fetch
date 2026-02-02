import { describe, it, expect, vi, beforeEach } from 'vitest';
import { httpFetch } from '../fetch/http-fetch.js';
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
}));

vi.mock('../sites/site-config.js', () => ({
  getSiteUserAgent: vi.fn(),
  getSiteReferer: vi.fn(),
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
import { extractFromHtml } from '../extract/content-extractors.js';
import { getSiteUserAgent, getSiteReferer } from '../sites/site-config.js';
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
      })
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

  it('should detect DNS rebinding attack', async () => {
    const url = 'https://evil.com/article';

    // Mock httpRequest to simulate DNS rebinding
    let callCount = 0;
    vi.mocked(httpRequest).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First call returns dns_rebinding_detected error
        return {
          success: false,
          statusCode: 0,
          headers: {},
          cookies: [],
          error: 'dns_rebinding_detected',
        };
      }
      // Should not reach here
      throw new Error('Should have detected rebinding on first call');
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(false);
    expect(result.error).toBe('dns_rebinding_detected');
  });

  describe('archive fallback', () => {
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
  });
});
