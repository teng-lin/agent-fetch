import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  tryWpRestApiExtraction,
  enrichWpMetadata,
  extractSlugFromUrl,
  resolveWpApiUrl,
} from '../fetch/wp-rest-api.js';
import { GOOD_CONTENT_LENGTH } from '../extract/types.js';
import type { RequestContext } from '../fetch/types.js';

vi.mock('../fetch/http-client.js', () => ({
  httpRequest: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../sites/site-config.js', () => ({
  getSiteWpJsonApiPath: vi.fn().mockReturnValue(null),
  siteUseWpRestApi: vi.fn().mockReturnValue(false),
}));

vi.mock('../extract/content-extractors.js', () => ({
  detectWpRestApi: vi.fn().mockReturnValue(null),
}));

import { httpRequest } from '../fetch/http-client.js';
import { getSiteWpJsonApiPath, siteUseWpRestApi } from '../sites/site-config.js';
import { detectWpRestApi } from '../extract/content-extractors.js';
import { makeJsonResponse, makeFailedResponse, mockExtraction } from './test-helpers.js';

/** Generate HTML content that exceeds GOOD_CONTENT_LENGTH when converted to text. */
function longHtml(words = 40): string {
  return '<p>' + 'This is a sentence with several words in it. '.repeat(words) + '</p>';
}

/** Generate a standard WP REST API post object. */
function wpPost(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 123,
    title: { rendered: 'Test Article Title' },
    content: { rendered: longHtml() },
    excerpt: { rendered: '<p>A short excerpt of the article.</p>' },
    date_gmt: '2024-06-15T10:30:00',
    _embedded: { author: [{ name: 'Jane Doe' }] },
    ...overrides,
  };
}

const ctx: RequestContext = {};

describe('tryWpRestApiExtraction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts from standard WP array response [{...}]', async () => {
    vi.mocked(httpRequest).mockResolvedValue(makeJsonResponse([wpPost()]));

    const result = await tryWpRestApiExtraction(
      'https://example.com/wp-json/wp/v2/posts?slug=test',
      null,
      ctx
    );

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Test Article Title');
    expect(result!.byline).toBe('Jane Doe');
    expect(result!.excerpt).toBe('A short excerpt of the article.');
    expect(result!.publishedTime).toBe('2024-06-15T10:30:00');
    expect(result!.method).toBe('wp-rest-api');
    expect(result!.textContent!.length).toBeGreaterThanOrEqual(GOOD_CONTENT_LENGTH);
    expect(result!.markdown).toBeDefined();
    expect(result!.markdown!.length).toBeGreaterThan(0);
  });

  it('extracts from single object response {...}', async () => {
    vi.mocked(httpRequest).mockResolvedValue(makeJsonResponse(wpPost()));

    const result = await tryWpRestApiExtraction(
      'https://example.com/wp-json/wp/v2/posts/123',
      null,
      ctx
    );

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Test Article Title');
    expect(result!.method).toBe('wp-rest-api');
  });

  it('extracts from custom envelope {posts: [{...}]}', async () => {
    vi.mocked(httpRequest).mockResolvedValue(makeJsonResponse({ posts: [wpPost()] }));

    const result = await tryWpRestApiExtraction('https://example.com/api/v1/posts/test', null, ctx);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Test Article Title');
    expect(result!.method).toBe('wp-rest-api');
  });

  it('detects PMC list and fetches batch items', async () => {
    const pmcPost = wpPost({
      content: { rendered: '<p>List intro paragraph.</p>' },
      meta: { pmc_list_order: [10, 20, 30] },
    });

    vi.mocked(httpRequest)
      .mockResolvedValueOnce(makeJsonResponse([pmcPost]))
      .mockResolvedValueOnce(
        makeJsonResponse([
          { id: 10, content: { rendered: longHtml(15) } },
          { id: 20, content: { rendered: longHtml(15) } },
          { id: 30, content: { rendered: longHtml(15) } },
        ])
      );

    const result = await tryWpRestApiExtraction(
      'https://example.com/wp-json/wp/v2/posts?slug=best-of-list',
      null,
      ctx
    );

    expect(result).not.toBeNull();
    expect(result!.method).toBe('wp-rest-api-pmc-list');
    // Should contain intro + list items content
    expect(result!.textContent!.length).toBeGreaterThan(GOOD_CONTENT_LENGTH);
    // Verify batch API was called with correct URL
    const batchCall = vi.mocked(httpRequest).mock.calls[1][0];
    expect(batchCall).toContain('/wp-json/wp/v2/pmc_list_item?include=10,20,30');
  });

  it('truncates PMC list to MAX_LIST_ITEMS (200) for large lists', async () => {
    const largeList = Array.from({ length: 250 }, (_, i) => i + 1);
    const pmcPost = wpPost({
      content: { rendered: '<p>Intro</p>' },
      meta: { pmc_list_order: largeList },
    });

    vi.mocked(httpRequest).mockResolvedValueOnce(makeJsonResponse([pmcPost]));

    // 4 batch calls for 200 items (50 per batch)
    for (let i = 0; i < 4; i++) {
      vi.mocked(httpRequest).mockResolvedValueOnce(
        makeJsonResponse(
          Array.from({ length: 50 }, (_, j) => ({
            id: i * 50 + j + 1,
            content: { rendered: `<p>Item ${i * 50 + j + 1} content sentence here.</p>` },
          }))
        )
      );
    }

    const result = await tryWpRestApiExtraction(
      'https://example.com/wp-json/wp/v2/posts?slug=huge-list',
      null,
      ctx
    );

    expect(result).not.toBeNull();
    expect(result!.method).toBe('wp-rest-api-pmc-list');
    // 1 main request + 4 batch requests (200 items / 50 per batch)
    expect(vi.mocked(httpRequest)).toHaveBeenCalledTimes(5);
  });

  it('rejects content with WP API teaser (utm_campaign=api)', async () => {
    const teaserContent =
      '<p>Teaser paragraph.</p><p><a href="https://example.com/article?utm_campaign=api">Read more…</a></p>';

    vi.mocked(httpRequest).mockResolvedValue(
      makeJsonResponse([wpPost({ content: { rendered: teaserContent.repeat(20) } })])
    );

    const result = await tryWpRestApiExtraction(
      'https://example.com/wp-json/wp/v2/posts?slug=teaser',
      null,
      ctx
    );

    expect(result).toBeNull();
  });

  it('returns null when textContent is below GOOD_CONTENT_LENGTH', async () => {
    vi.mocked(httpRequest).mockResolvedValue(
      makeJsonResponse([wpPost({ content: { rendered: '<p>Short</p>' } })])
    );

    const result = await tryWpRestApiExtraction(
      'https://example.com/wp-json/wp/v2/posts?slug=short',
      null,
      ctx
    );

    expect(result).toBeNull();
  });

  it('returns null when API request fails', async () => {
    vi.mocked(httpRequest).mockResolvedValue(makeFailedResponse(403, 'forbidden'));

    const result = await tryWpRestApiExtraction(
      'https://example.com/wp-json/wp/v2/posts?slug=forbidden',
      null,
      ctx
    );

    expect(result).toBeNull();
  });

  it('returns null on malformed JSON response', async () => {
    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: '<!DOCTYPE html><html><body>Not JSON</body></html>',
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    const result = await tryWpRestApiExtraction(
      'https://example.com/wp-json/wp/v2/posts?slug=bad',
      null,
      ctx
    );

    expect(result).toBeNull();
  });

  it('extracts _embedded.author for byline', async () => {
    vi.mocked(httpRequest).mockResolvedValue(
      makeJsonResponse([wpPost({ _embedded: { author: [{ name: 'Special Author' }] } })])
    );

    const result = await tryWpRestApiExtraction(
      'https://example.com/wp-json/wp/v2/posts?slug=author-test',
      null,
      ctx
    );

    expect(result).not.toBeNull();
    expect(result!.byline).toBe('Special Author');
  });

  it('falls back to originalResult byline when _embedded.author missing', async () => {
    vi.mocked(httpRequest).mockResolvedValue(makeJsonResponse([wpPost({ _embedded: undefined })]));

    const original = mockExtraction({ byline: 'Original Author' });
    const result = await tryWpRestApiExtraction(
      'https://example.com/wp-json/wp/v2/posts?slug=no-author',
      original,
      ctx
    );

    expect(result).not.toBeNull();
    expect(result!.byline).toBe('Original Author');
  });

  it('extracts date_gmt for publishedTime', async () => {
    vi.mocked(httpRequest).mockResolvedValue(
      makeJsonResponse([wpPost({ date_gmt: '2025-03-20T14:00:00' })])
    );

    const result = await tryWpRestApiExtraction(
      'https://example.com/wp-json/wp/v2/posts?slug=date-test',
      null,
      ctx
    );

    expect(result).not.toBeNull();
    expect(result!.publishedTime).toBe('2025-03-20T14:00:00');
  });

  it('handles string fields (custom endpoints) instead of {rendered} objects', async () => {
    vi.mocked(httpRequest).mockResolvedValue(
      makeJsonResponse([
        wpPost({
          title: 'Plain String Title',
          content: longHtml(),
          excerpt: 'Plain string excerpt',
        }),
      ])
    );

    const result = await tryWpRestApiExtraction('https://example.com/api/v1/posts/test', null, ctx);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Plain String Title');
    expect(result!.excerpt).toBe('Plain string excerpt');
  });

  it('appends _embed parameter with & when URL already has query params', async () => {
    vi.mocked(httpRequest).mockResolvedValue(makeJsonResponse([wpPost()]));

    await tryWpRestApiExtraction('https://example.com/wp-json/wp/v2/posts?slug=test', null, ctx);

    const calledUrl = vi.mocked(httpRequest).mock.calls[0][0];
    expect(calledUrl).toBe('https://example.com/wp-json/wp/v2/posts?slug=test&_embed');
  });

  it('appends _embed parameter with ? when URL has no query params', async () => {
    vi.mocked(httpRequest).mockResolvedValue(makeJsonResponse(wpPost()));

    await tryWpRestApiExtraction('https://example.com/wp-json/wp/v2/posts/123', null, ctx);

    const calledUrl = vi.mocked(httpRequest).mock.calls[0][0];
    expect(calledUrl).toBe('https://example.com/wp-json/wp/v2/posts/123?_embed');
  });

  it('inherits siteName from originalResult', async () => {
    vi.mocked(httpRequest).mockResolvedValue(makeJsonResponse([wpPost()]));

    const original = mockExtraction({ siteName: 'My Site' });
    const result = await tryWpRestApiExtraction(
      'https://example.com/wp-json/wp/v2/posts?slug=test',
      original,
      ctx
    );

    expect(result).not.toBeNull();
    expect(result!.siteName).toBe('My Site');
  });

  it('inherits lang from originalResult', async () => {
    vi.mocked(httpRequest).mockResolvedValue(makeJsonResponse([wpPost()]));

    const original = mockExtraction({ lang: 'fr' });
    const result = await tryWpRestApiExtraction(
      'https://example.com/wp-json/wp/v2/posts?slug=test',
      original,
      ctx
    );

    expect(result).not.toBeNull();
    expect(result!.lang).toBe('fr');
  });

  it('returns null when response html is empty', async () => {
    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: '',
      headers: {},
      cookies: [],
    });

    const result = await tryWpRestApiExtraction(
      'https://example.com/wp-json/wp/v2/posts?slug=empty',
      null,
      ctx
    );

    expect(result).toBeNull();
  });

  it('returns null when array response is empty []', async () => {
    vi.mocked(httpRequest).mockResolvedValue(makeJsonResponse([]));

    const result = await tryWpRestApiExtraction(
      'https://example.com/wp-json/wp/v2/posts?slug=not-found',
      null,
      ctx
    );

    expect(result).toBeNull();
  });

  it('PMC list items are returned in original order', async () => {
    const pmcPost = wpPost({
      content: { rendered: '' },
      meta: { pmc_list_order: [30, 10, 20] },
    });

    vi.mocked(httpRequest)
      .mockResolvedValueOnce(makeJsonResponse([pmcPost]))
      // API may return items in arbitrary order
      .mockResolvedValueOnce(
        makeJsonResponse([
          {
            id: 20,
            content: {
              rendered: '<p>' + 'Item Twenty content here for ordering test. '.repeat(15) + '</p>',
            },
          },
          {
            id: 10,
            content: {
              rendered: '<p>' + 'Item Ten content here for ordering test. '.repeat(15) + '</p>',
            },
          },
          {
            id: 30,
            content: {
              rendered: '<p>' + 'Item Thirty content here for ordering test. '.repeat(15) + '</p>',
            },
          },
        ])
      );

    const result = await tryWpRestApiExtraction(
      'https://example.com/wp-json/wp/v2/posts?slug=ordered-list',
      null,
      ctx
    );

    expect(result).not.toBeNull();
    // Content should respect pmc_list_order: [30, 10, 20]
    const text = result!.textContent!;
    const thirtyIdx = text.indexOf('Item Thirty');
    const tenIdx = text.indexOf('Item Ten');
    const twentyIdx = text.indexOf('Item Twenty');
    expect(thirtyIdx).toBeLessThan(tenIdx);
    expect(tenIdx).toBeLessThan(twentyIdx);
  });

  it('returns null when content field is missing from post', async () => {
    vi.mocked(httpRequest).mockResolvedValue(makeJsonResponse([wpPost({ content: undefined })]));

    const result = await tryWpRestApiExtraction(
      'https://example.com/wp-json/wp/v2/posts?slug=no-content',
      null,
      ctx
    );

    expect(result).toBeNull();
  });

  it('falls back to originalResult title when wp title is missing', async () => {
    vi.mocked(httpRequest).mockResolvedValue(makeJsonResponse([wpPost({ title: undefined })]));

    const original = mockExtraction({ title: 'Fallback Title' });
    const result = await tryWpRestApiExtraction(
      'https://example.com/wp-json/wp/v2/posts?slug=no-title',
      original,
      ctx
    );

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Fallback Title');
  });

  it('returns null publishedTime when date_gmt is not a string', async () => {
    vi.mocked(httpRequest).mockResolvedValue(makeJsonResponse([wpPost({ date_gmt: 12345 })]));

    const result = await tryWpRestApiExtraction(
      'https://example.com/wp-json/wp/v2/posts?slug=bad-date',
      null,
      ctx
    );

    expect(result).not.toBeNull();
    expect(result!.publishedTime).toBeNull();
  });
});

describe('enrichWpMetadata', () => {
  it('overwrites DOM metadata with WP metadata', () => {
    const dom = mockExtraction();
    const wp = mockExtraction({
      title: 'WP Title',
      byline: 'WP Author',
      excerpt: 'WP Excerpt',
      publishedTime: '2024-12-25',
      markdown: '# WP Markdown',
      method: 'wp-rest-api',
    });

    const result = enrichWpMetadata(dom, wp);

    expect(result.title).toBe('WP Title');
    expect(result.byline).toBe('WP Author');
    expect(result.excerpt).toBe('WP Excerpt');
    expect(result.publishedTime).toBe('2024-12-25');
    expect(result.markdown).toBe('# WP Markdown');
    // Content and textContent stay from DOM
    expect(result.content).toBe('<p>DOM content</p>');
    expect(result.textContent).toBe('DOM content');
    expect(result.siteName).toBe('DOM Site');
    expect(result.lang).toBe('en');
  });

  it('falls back to DOM metadata when WP fields are null', () => {
    const dom = mockExtraction({
      title: 'DOM Title',
      byline: 'DOM Author',
      excerpt: 'DOM Excerpt',
      publishedTime: '2024-01-01',
      markdown: '# DOM Markdown',
    });
    const wp = mockExtraction({
      title: null,
      byline: null,
      excerpt: null,
      publishedTime: null,
      markdown: null,
      method: 'wp-rest-api',
    });

    const result = enrichWpMetadata(dom, wp);

    expect(result.title).toBe('DOM Title');
    expect(result.byline).toBe('DOM Author');
    expect(result.excerpt).toBe('DOM Excerpt');
    expect(result.publishedTime).toBe('2024-01-01');
    expect(result.markdown).toBe('# DOM Markdown');
  });
});

describe('extractSlugFromUrl', () => {
  it('extracts slug from simple path', () => {
    expect(extractSlugFromUrl('https://example.com/article-slug')).toBe('article-slug');
  });

  it('extracts last segment from nested path', () => {
    expect(extractSlugFromUrl('https://example.com/2024/01/article-slug/')).toBe('article-slug');
  });

  it('returns null for invalid URL', () => {
    expect(extractSlugFromUrl('not a url')).toBeNull();
  });

  it('returns null for root path', () => {
    expect(extractSlugFromUrl('https://example.com/')).toBeNull();
  });

  it('handles URL with query parameters', () => {
    expect(extractSlugFromUrl('https://example.com/my-post?page=2')).toBe('my-post');
  });
});

describe('resolveWpApiUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns auto-detected URL from HTML link tag', () => {
    vi.mocked(detectWpRestApi).mockReturnValueOnce('https://example.com/wp-json/wp/v2/posts/123');

    const result = resolveWpApiUrl('<html></html>', 'https://example.com/article');

    expect(result).toBe('https://example.com/wp-json/wp/v2/posts/123');
  });

  it('constructs URL from config-driven wpJsonApiPath', () => {
    vi.mocked(detectWpRestApi).mockReturnValueOnce(null);
    vi.mocked(getSiteWpJsonApiPath).mockReturnValueOnce('/api/v1/posts/');

    const result = resolveWpApiUrl('<html></html>', 'https://example.com/2024/01/my-slug');

    expect(result).toBe('https://example.com/api/v1/posts/my-slug');
  });

  it('constructs standard WP REST API URL from useWpRestApi config', () => {
    vi.mocked(detectWpRestApi).mockReturnValueOnce(null);
    vi.mocked(getSiteWpJsonApiPath).mockReturnValueOnce(null);
    vi.mocked(siteUseWpRestApi).mockReturnValueOnce(true);

    const result = resolveWpApiUrl('<html></html>', 'https://example.com/2024/01/my-slug');

    expect(result).toBe('https://example.com/wp-json/wp/v2/posts?slug=my-slug');
  });

  it('returns null when no detection method succeeds', () => {
    vi.mocked(detectWpRestApi).mockReturnValueOnce(null);
    vi.mocked(getSiteWpJsonApiPath).mockReturnValueOnce(null);
    vi.mocked(siteUseWpRestApi).mockReturnValueOnce(false);

    const result = resolveWpApiUrl('<html></html>', 'https://example.com/article');

    expect(result).toBeNull();
  });

  it('prefers auto-detection over config-driven paths', () => {
    vi.mocked(detectWpRestApi).mockReturnValueOnce('https://example.com/wp-json/wp/v2/posts/999');

    const result = resolveWpApiUrl('<html></html>', 'https://example.com/article');

    expect(result).toBe('https://example.com/wp-json/wp/v2/posts/999');
    // Config functions should not be called since auto-detect succeeded
    expect(getSiteWpJsonApiPath).not.toHaveBeenCalled();
  });

  it('encodes slug in constructed URLs', () => {
    vi.mocked(detectWpRestApi).mockReturnValueOnce(null);
    vi.mocked(getSiteWpJsonApiPath).mockReturnValueOnce(null);
    vi.mocked(siteUseWpRestApi).mockReturnValueOnce(true);

    // extractSlugFromUrl gets the last path segment as-is from pathname (percent-encoded)
    // then encodeURIComponent re-encodes it for the API URL
    const result = resolveWpApiUrl('<html></html>', 'https://example.com/my-article-slug');

    expect(result).toBe('https://example.com/wp-json/wp/v2/posts?slug=my-article-slug');
  });
});
