/**
 * Integration tests for httpFetch fallback chains.
 *
 * Only HTTP transport (httpRequest/httpPost), logger, and pdf-extractor are mocked.
 * Real extraction (extractFromHtml, quickValidate, site-config, etc.) runs end-to-end.
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
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

vi.mock('../extract/pdf-extractor.js', () => ({
  isPdfUrl: vi.fn().mockReturnValue(false),
  isPdfContentType: vi.fn().mockReturnValue(false),
  fetchRemotePdfBuffer: vi.fn(),
  extractPdfFromBuffer: vi.fn(),
}));

vi.mock('../sites/site-config.js', () => ({
  getSiteUserAgent: vi.fn().mockReturnValue(null),
  getSiteReferer: vi.fn().mockReturnValue(null),
  siteUseWpRestApi: vi.fn().mockReturnValue(false),
  siteUseNextData: vi.fn().mockReturnValue(false),
  sitePreferJsonLd: vi.fn().mockReturnValue(false),
  getSiteNextDataPath: vi.fn().mockReturnValue(null),
  getSiteConfig: vi.fn().mockReturnValue(null),
  getSiteWpJsonApiPath: vi.fn().mockReturnValue(null),
}));

import { httpFetch } from '../fetch/http-fetch.js';
import { httpRequest, httpPost } from '../fetch/http-client.js';
import { siteUseNextData } from '../sites/site-config.js';
import { isPdfUrl, isPdfContentType } from '../extract/pdf-extractor.js';
import { logger } from '../logger.js';
import {
  getSiteUserAgent,
  getSiteReferer,
  siteUseWpRestApi,
  sitePreferJsonLd,
  getSiteNextDataPath,
  getSiteConfig,
  getSiteWpJsonApiPath,
} from '../sites/site-config.js';
import { GOOD_CONTENT_LENGTH } from '../extract/types.js';
import {
  makeResponse,
  makeFailedResponse,
  makeJsonResponse,
  buildLongContent,
  buildArticleHtml,
  buildInsufficientContentHtml,
} from './test-helpers.js';

describe('httpFetch fallback chains', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Re-establish default mock return values after resetAllMocks
    vi.mocked(isPdfUrl).mockReturnValue(false);
    vi.mocked(isPdfContentType).mockReturnValue(false);
    vi.mocked(getSiteUserAgent).mockReturnValue(null);
    vi.mocked(getSiteReferer).mockReturnValue(null);
    vi.mocked(siteUseWpRestApi).mockReturnValue(false);
    vi.mocked(siteUseNextData).mockReturnValue(false);
    vi.mocked(sitePreferJsonLd).mockReturnValue(false);
    vi.mocked(getSiteNextDataPath).mockReturnValue(null);
    vi.mocked(getSiteConfig).mockReturnValue(null);
    vi.mocked(getSiteWpJsonApiPath).mockReturnValue(null);
    vi.mocked(logger.child).mockReturnValue({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as ReturnType<typeof logger.child>);
  });

  // -------------------------------------------------------------------------
  // 1. WP AJAX content fallback (tryWpAjaxContentFallback)
  // -------------------------------------------------------------------------
  describe('WP AJAX content fallback', () => {
    it('recovers content via WP AJAX when quickValidate reports insufficient_content', async () => {
      const longContent = buildLongContent();

      // HTML that fails quickValidate (insufficient_content) but has WP AJAX patterns
      const html = buildInsufficientContentHtml(
        '',
        `<script>
          var ajaxurl = 'https://example.com/wp-admin/admin-ajax.php';
          var article_id = '12345';
          action: 'fetch_article_content',
        </script>`
      );

      // First call: main page fetch
      vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(html));

      // Second call: WP AJAX POST returns full article content
      vi.mocked(httpPost).mockResolvedValueOnce(
        makeJsonResponse({ data: `<p>${longContent}</p>` })
      );

      const result = await httpFetch('https://example.com/members/article-slug');

      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('wp-ajax-content');
      expect(result.textContent).toBeDefined();
      expect(result.textContent!.length).toBeGreaterThanOrEqual(GOOD_CONTENT_LENGTH);
    });

    it('WP AJAX response contains extracted article content and markdown', async () => {
      const longContent = buildLongContent();

      // Use insufficient_content path to trigger the WP AJAX fallback
      const html = buildInsufficientContentHtml(
        `<meta property="og:title" content="Enrichment Test Article">`,
        `<script>
          var ajaxurl = 'https://example.com/wp-admin/admin-ajax.php';
          var article_id = '99999';
          action: 'get_article_content',
        </script>`
      );

      vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(html));
      vi.mocked(httpPost).mockResolvedValueOnce({
        success: true,
        statusCode: 200,
        html: `<p>${longContent}</p>`,
        headers: { 'content-type': 'text/html' },
        cookies: [],
      });

      const result = await httpFetch('https://example.com/members/enrichment-test');

      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('wp-ajax-content');
      expect(result.textContent).toBeDefined();
      expect(result.textContent!.length).toBeGreaterThanOrEqual(GOOD_CONTENT_LENGTH);
      expect(result.markdown).toBeDefined();
      // Verify httpPost was called with the correct AJAX parameters
      expect(vi.mocked(httpPost)).toHaveBeenCalledWith(
        'https://example.com/wp-admin/admin-ajax.php',
        expect.objectContaining({
          action: 'get_article_content',
          'data[id]': '99999',
        }),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined
      );
    });

    it('falls through when WP AJAX POST fails', async () => {
      // Use insufficient_content path to trigger AJAX fallback
      const html = buildInsufficientContentHtml(
        '',
        `<script>
          var ajaxurl = 'https://example.com/wp-admin/admin-ajax.php';
          var article_id = '11111';
          action: 'fetch_article_content',
        </script>`
      );

      vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(html));
      vi.mocked(httpPost).mockResolvedValueOnce(makeFailedResponse(500, 'Internal Server Error'));

      const result = await httpFetch('https://example.com/members/ajax-fail');

      // Should fail since AJAX failed and there's insufficient content
      expect(result.success).toBe(false);
      expect(result.extractionMethod).not.toBe('wp-ajax-content');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Prism content API fallback (tryPrismContentApiFallback)
  // -------------------------------------------------------------------------
  describe('Prism content API fallback', () => {
    it('recovers content from Prism/Arc API when __NEXT_DATA__ has config', async () => {
      const longContent = buildLongContent();

      // HTML with __NEXT_DATA__ containing Prism API config
      const nextData = {
        runtimeConfig: {
          CLIENT_SIDE_API_DOMAIN: 'https://api.example.com',
          CONTENT_SOURCE: 'content-api-v4',
        },
        query: { _website: 'example-news' },
        props: { pageProps: {} },
        buildId: 'abc123',
      };

      const html = buildArticleHtml({
        title: 'Arc Publishing Article',
        extraHead: `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>`,
      });

      // First call: main page fetch
      vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(html));

      // Second call: Prism content API returns Arc ANS content
      vi.mocked(httpRequest).mockResolvedValueOnce(
        makeJsonResponse({
          headlines: { basic: 'Arc Publishing Article' },
          credits: { by: [{ name: 'Jane Doe' }] },
          display_date: '2025-01-15T10:00:00Z',
          description: { basic: 'An article from Arc publishing' },
          content_elements: [
            { type: 'text', content: `<p>${longContent}</p>` },
            { type: 'text', content: '<p>Additional paragraph content for the article.</p>' },
          ],
        })
      );

      const result = await httpFetch('https://example.com/news/arc-article');

      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('prism-content-api');
      expect(result.textContent).toBeDefined();
      expect(result.textContent!.length).toBeGreaterThanOrEqual(GOOD_CONTENT_LENGTH);
    });

    it('parses Arc ANS metadata (title, byline, date, excerpt)', async () => {
      const longContent = buildLongContent();

      const nextData = {
        runtimeConfig: {
          CLIENT_SIDE_API_DOMAIN: 'https://api.example.com',
          CONTENT_SOURCE: 'content-api-v4',
        },
        query: { _website: 'example-news' },
        props: { pageProps: {} },
        buildId: 'def456',
      };

      const html = buildArticleHtml({
        title: 'Metadata Test Article',
        extraHead: `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>`,
      });

      vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(html));
      vi.mocked(httpRequest).mockResolvedValueOnce(
        makeJsonResponse({
          headlines: { basic: 'Prism Metadata Title' },
          credits: { by: [{ name: 'Alice Reporter' }, { name: 'Bob Editor' }] },
          display_date: '2025-03-20T14:30:00Z',
          description: { basic: 'This is an excerpt from the Prism API' },
          content_elements: [{ type: 'text', content: `<p>${longContent}</p>` }],
        })
      );

      const result = await httpFetch('https://example.com/news/metadata-test');

      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('prism-content-api');
      expect(result.title).toBe('Prism Metadata Title');
      expect(result.byline).toBe('Alice Reporter, Bob Editor');
      expect(result.publishedTime).toBe('2025-03-20T14:30:00Z');
      expect(result.excerpt).toBe('This is an excerpt from the Prism API');
    });

    it('falls through when Prism API returns insufficient content', async () => {
      const nextData = {
        runtimeConfig: {
          CLIENT_SIDE_API_DOMAIN: 'https://api.example.com',
          CONTENT_SOURCE: 'content-api-v4',
        },
        props: { pageProps: {} },
        buildId: 'ghi789',
      };

      const html = buildArticleHtml({
        title: 'Short API Response',
        extraHead: `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>`,
      });

      vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(html));
      vi.mocked(httpRequest).mockResolvedValueOnce(
        makeJsonResponse({ content_elements: [{ type: 'text', content: '<p>Short.</p>' }] })
      );

      const result = await httpFetch('https://example.com/news/short-prism');

      // Should fall through to DOM extraction (readability), not prism-content-api
      expect(result.extractionMethod).not.toBe('prism-content-api');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Next.js __NEXT_DATA__ fallback (tryNextDataFallback via siteUseNextData)
  // -------------------------------------------------------------------------
  describe('Next.js __NEXT_DATA__ fallback', () => {
    it('extracts content from __NEXT_DATA__ when siteUseNextData is true and content is insufficient', async () => {
      const longContent = buildLongContent();

      // Enable siteUseNextData for this test
      vi.mocked(siteUseNextData).mockReturnValue(true);

      const nextData = {
        props: {
          pageProps: {
            story: {
              headline: 'Next.js Data Headline',
              body: {
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', value: longContent }],
                  },
                ],
              },
              authors: [{ name: 'Next.js Author' }],
              publishedAt: '2025-06-01T09:00:00Z',
              abstract: ['An article extracted from Next.js data'],
            },
          },
        },
        buildId: 'jkl012',
      };

      // HTML with insufficient content (fails quickValidate word count)
      // but has __NEXT_DATA__ with full article
      const html = buildInsufficientContentHtml(
        `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>`
      );

      vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(html));

      const result = await httpFetch('https://example.com/stories/next-data-article');

      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('next-data');
      expect(result.textContent).toBeDefined();
      expect(result.textContent!).toContain('Lorem ipsum');
    });

    it('skips Next.js fallback when siteUseNextData is false', async () => {
      // siteUseNextData returns false (default mock)
      vi.mocked(siteUseNextData).mockReturnValue(false);

      const nextData = {
        props: {
          pageProps: {
            story: {
              headline: 'Should Not Extract',
              body: {
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', value: buildLongContent() }],
                  },
                ],
              },
            },
          },
        },
        buildId: 'mno345',
      };

      const html = buildInsufficientContentHtml(
        `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>`
      );

      vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(html));

      const result = await httpFetch('https://example.com/stories/no-next-data');

      // Should not use next-data method since siteUseNextData is false
      // in the insufficient_content fallback path
      expect(result.extractionMethod).not.toBe('next-data');
    });
  });

  // -------------------------------------------------------------------------
  // 4. Insufficient content → cascading fallback chain
  // -------------------------------------------------------------------------
  describe('insufficient content cascading fallbacks', () => {
    it('tries NextData → WP REST API → Prism → WP AJAX in order for insufficient content', async () => {
      // Enable siteUseNextData so the NextData fallback path is checked
      vi.mocked(siteUseNextData).mockReturnValue(true);

      // Build HTML that fails quickValidate with insufficient_content
      // Has no valid WP REST API link, no Prism config, no WP AJAX patterns
      // so all fallbacks return null and we get the insufficient_content error
      const html = buildInsufficientContentHtml();

      vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(html));

      const result = await httpFetch('https://example.com/stub-page');

      expect(result.success).toBe(false);
      expect(result.error).toBe('insufficient_content');
      // httpRequest was called once for the main page
      // No additional API calls because no fallback patterns were detected
      expect(vi.mocked(httpRequest)).toHaveBeenCalledTimes(1);
    });

    it('WP REST API fallback recovers from insufficient_content', async () => {
      const longContent = buildLongContent();

      // HTML that fails quickValidate word count but has WP REST API link
      const html = buildInsufficientContentHtml(
        `<link rel="alternate" type="application/json" href="https://example.com/wp-json/wp/v2/posts/42" />`
      );

      // First call: main page fetch
      vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(html));

      // Second call: WP REST API returns full article
      vi.mocked(httpRequest).mockResolvedValueOnce(
        makeJsonResponse([
          {
            title: { rendered: 'WP REST API Recovery' },
            content: { rendered: `<p>${longContent}</p>` },
            excerpt: { rendered: '<p>An excerpt</p>' },
            date_gmt: '2025-04-10T12:00:00',
            _embedded: { author: [{ name: 'WP Author' }] },
          },
        ])
      );

      const result = await httpFetch('https://example.com/insufficient-with-wp');

      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('wp-rest-api');
      expect(result.title).toBe('WP REST API Recovery');
    });

    it('Prism fallback recovers from insufficient_content when WP REST API is absent', async () => {
      const longContent = buildLongContent();

      // HTML that fails quickValidate word count, has Prism config but no WP link
      const nextData = {
        runtimeConfig: {
          CLIENT_SIDE_API_DOMAIN: 'https://api.example.com',
          CONTENT_SOURCE: 'content-api-v4',
        },
        query: { _website: 'example-site' },
        props: { pageProps: {} },
        buildId: 'pqr678',
      };

      const html = buildInsufficientContentHtml(
        `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>`
      );

      vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(html));
      vi.mocked(httpRequest).mockResolvedValueOnce(
        makeJsonResponse({
          headlines: { basic: 'Prism Recovery Title' },
          content_elements: [{ type: 'text', content: `<p>${longContent}</p>` }],
        })
      );

      const result = await httpFetch('https://example.com/insufficient-with-prism');

      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('prism-content-api');
      expect(result.title).toBe('Prism Recovery Title');
    });

    it('WP AJAX fallback recovers from insufficient_content as last resort', async () => {
      const longContent = buildLongContent();

      // Disable siteUseNextData so NextData fallback is skipped
      vi.mocked(siteUseNextData).mockReturnValue(false);

      // HTML that fails quickValidate word count, has WP AJAX patterns but no WP REST or Prism
      const html = buildInsufficientContentHtml(
        '',
        `<script>
          var ajaxurl = 'https://example.com/wp-admin/admin-ajax.php';
          var article_id = '55555';
          action: 'unlock_article',
        </script>`
      );

      vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(html));
      vi.mocked(httpPost).mockResolvedValueOnce({
        success: true,
        statusCode: 200,
        html: `<p>${longContent}</p>`,
        headers: { 'content-type': 'text/html' },
        cookies: [],
      });

      const result = await httpFetch('https://example.com/insufficient-with-ajax');

      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('wp-ajax-content');
    });
  });

  // -------------------------------------------------------------------------
  // 5. WP REST API enrichment (DOM content preferred when 2x longer than API)
  // -------------------------------------------------------------------------
  describe('WP REST API enrichment', () => {
    it('uses DOM content with WP metadata when DOM has 2x more content than API', async () => {
      // Build a full article HTML with WP REST API link
      // The article content in the page is much longer than what the API returns
      const longParagraphs = [
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
        'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
        'Curabitur pretium tincidunt lacus. Nulla gravida orci a odio. Nullam varius, turpis et commodo pharetra, est eros bibendum elit, nec luctus magna felis sollicitudin mauris. Integer in mauris eu nibh euismod gravida.',
        'Praesent congue erat at massa. Sed cursus turpis vitae tortor. Donec posuere vulputate arcu. Phasellus accumsan cursus velit. Vestibulum ante ipsum primis in faucibus orci luctus et ultrices posuere cubilia Curae.',
        'Pellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestas. Vestibulum tortor quam, feugiat vitae, ultricies eget, tempor sit amet, ante.',
        'Aenean ultricies mi vitae est. Mauris placerat eleifend leo. Quisque sit amet est et sapien ullamcorper pharetra. Vestibulum erat wisi, condimentum sed.',
        'Fusce fermentum odio nec arcu. Vivamus euismod mauris. In ut quam vitae odio lacinia tincidunt. Praesent ut ligula non mi varius sagittis. Cras sagittis.',
        'Aliquam erat volutpat. Nam dui mi, tincidunt quis, accumsan porttitor, facilisis luctus, metus. Phasellus ultrices nulla quis nibh. Quisque a lectus.',
        'Donec consectetuer ligula vulputate sem tristique cursus. Nam nulla quam, gravida non, commodo a, sodales sit amet, nisi.',
        'Maecenas malesuada elit lectus felis, malesuada ultricies. Curabitur et ligula. Ut molestie a, ultricies porta urna.',
      ];

      const html = buildArticleHtml({
        title: 'Long DOM Article',
        paragraphs: longParagraphs,
        extraHead: `<link rel="alternate" type="application/json" href="https://example.com/wp-json/wp/v2/posts/100" />`,
      });

      // WP API returns only a short teaser (much less than DOM content)
      const shortTeaser =
        'This is just a teaser paragraph that is much shorter than the full article content available in the DOM. It contains some words but not nearly enough to match.';
      // Ensure the teaser is above GOOD_CONTENT_LENGTH (500) but well below 2x DOM length
      const teaserContent = shortTeaser + ' ' + shortTeaser + ' ' + shortTeaser + ' ' + shortTeaser;

      // First call: main page fetch
      vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(html));

      // Second call: WP REST API returns short teaser
      vi.mocked(httpRequest).mockResolvedValueOnce(
        makeJsonResponse([
          {
            title: { rendered: 'WP API Title' },
            content: { rendered: `<p>${teaserContent}</p>` },
            excerpt: { rendered: '<p>WP API Excerpt</p>' },
            date_gmt: '2025-05-01T08:00:00',
            _embedded: { author: [{ name: 'WP API Author' }] },
          },
        ])
      );

      const result = await httpFetch('https://example.com/articles/long-dom');

      expect(result.success).toBe(true);
      // DOM extraction should win since it has >2x content, but metadata is enriched from WP
      expect(result.extractionMethod).not.toBe('wp-rest-api');
      // WP metadata should be used (title from WP API)
      expect(result.title).toBe('WP API Title');
      expect(result.byline).toBe('WP API Author');
      // But the actual content should be from the longer DOM extraction
      expect(result.textContent!.length).toBeGreaterThan(teaserContent.length);
    });

    it('prefers WP REST API when API content is similar length to DOM', async () => {
      const longContent = buildLongContent();

      const html = buildArticleHtml({
        title: 'Equal Content Article',
        extraHead: `<link rel="alternate" type="application/json" href="https://example.com/wp-json/wp/v2/posts/200" />`,
      });

      // First call: main page fetch
      vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(html));

      // Second call: WP REST API returns equally long content
      vi.mocked(httpRequest).mockResolvedValueOnce(
        makeJsonResponse([
          {
            title: { rendered: 'WP Full Content Title' },
            content: { rendered: `<p>${longContent}</p><p>${longContent}</p>` },
            excerpt: { rendered: '<p>Full excerpt</p>' },
            date_gmt: '2025-05-15T10:00:00',
            _embedded: { author: [{ name: 'API Author' }] },
          },
        ])
      );

      const result = await httpFetch('https://example.com/articles/equal-content');

      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('wp-rest-api');
      expect(result.title).toBe('WP Full Content Title');
    });
  });

  // -------------------------------------------------------------------------
  // 6. WP AJAX handles JSON-wrapped response
  // -------------------------------------------------------------------------
  describe('WP AJAX JSON response formats', () => {
    it('parses WP AJAX response where content is nested in JSON data field', async () => {
      const longContent = buildLongContent();

      const html = buildInsufficientContentHtml(
        '',
        `<script>
          var ajaxurl = 'https://example.org/wp-admin/admin-ajax.php';
          var article_id = '77777';
          action: 'fetch_content',
        </script>`
      );

      vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(html));
      vi.mocked(httpPost).mockResolvedValueOnce(
        makeJsonResponse({ data: `<p>${longContent}</p>` })
      );

      const result = await httpFetch('https://example.org/post/json-wrapped');

      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('wp-ajax-content');
      expect(result.textContent).toContain('Lorem ipsum');
    });

    it('parses WP AJAX response where content is in JSON content field', async () => {
      const longContent = buildLongContent();

      const html = buildInsufficientContentHtml(
        '',
        `<script>
          var ajaxurl = 'https://example.org/wp-admin/admin-ajax.php';
          var article_id = '88888';
          action: 'unlock_article',
        </script>`
      );

      vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(html));
      vi.mocked(httpPost).mockResolvedValueOnce(
        makeJsonResponse({ content: `<p>${longContent}</p>` })
      );

      const result = await httpFetch('https://example.org/post/json-content-field');

      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('wp-ajax-content');
    });
  });
});
