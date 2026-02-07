import { describe, it, expect, vi } from 'vitest';
import {
  detectPrismContentApi,
  buildPrismContentApiUrl,
  parseArcAnsContent,
} from '../extract/prism-content-api.js';
import { GOOD_CONTENT_LENGTH } from '../extract/types.js';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

/** Generate filler text of at least n characters */
function filler(n: number): string {
  const base =
    'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ';
  let text = '';
  while (text.length < n) text += base;
  return text;
}

function makeNextDataHtml(data: unknown): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<html><head><script id="__NEXT_DATA__" type="application/json">${json}</script></head><body></body></html>`;
}

/** Build a realistic ANS response with enough content to pass thresholds */
function makeAnsResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const longText = filler(GOOD_CONTENT_LENGTH + 100);
  return {
    headlines: { basic: 'Test Article Title' },
    credits: { by: [{ name: 'Jane Doe' }, { name: 'John Smith' }] },
    display_date: '2025-06-15T10:00:00Z',
    description: { basic: 'A test article excerpt' },
    content_elements: [
      { type: 'text', content: `<p>${longText}</p>` },
      { type: 'header', content: 'Section Header', level: 2 },
      { type: 'text', content: '<p>Another paragraph of content here.</p>' },
    ],
    ...overrides,
  };
}

describe('detectPrismContentApi', () => {
  it('detects valid Prism config from __NEXT_DATA__', () => {
    const html = makeNextDataHtml({
      runtimeConfig: {
        CLIENT_SIDE_API_DOMAIN: 'https://api.example.com',
        CONTENT_SOURCE: 'content-api-v4',
        ARC_SITE: 'mysite',
      },
      query: { _website: 'mysite' },
    });

    const result = detectPrismContentApi(html);
    expect(result).toEqual({
      apiDomain: 'https://api.example.com',
      contentSource: 'content-api-v4',
      website: 'mysite',
    });
  });

  it('prefers query._website over runtimeConfig.ARC_SITE', () => {
    const html = makeNextDataHtml({
      runtimeConfig: {
        CLIENT_SIDE_API_DOMAIN: 'https://api.example.com',
        CONTENT_SOURCE: 'content-api-v4',
        ARC_SITE: 'fallback-site',
      },
      query: { _website: 'preferred-site' },
    });

    const result = detectPrismContentApi(html);
    expect(result?.website).toBe('preferred-site');
  });

  it('falls back to ARC_SITE when query._website is missing', () => {
    const html = makeNextDataHtml({
      runtimeConfig: {
        CLIENT_SIDE_API_DOMAIN: 'https://api.example.com',
        CONTENT_SOURCE: 'content-api-v4',
        ARC_SITE: 'fallback-site',
      },
    });

    const result = detectPrismContentApi(html);
    expect(result?.website).toBe('fallback-site');
  });

  it('returns null for non-Next.js pages', () => {
    const html = '<html><head></head><body>Hello</body></html>';
    expect(detectPrismContentApi(html)).toBeNull();
  });

  it('returns null when runtimeConfig is missing', () => {
    const html = makeNextDataHtml({ props: { pageProps: {} } });
    expect(detectPrismContentApi(html)).toBeNull();
  });

  it('returns null when CLIENT_SIDE_API_DOMAIN is missing', () => {
    const html = makeNextDataHtml({
      runtimeConfig: { CONTENT_SOURCE: 'content-api-v4', ARC_SITE: 'site' },
    });
    expect(detectPrismContentApi(html)).toBeNull();
  });

  it('returns null when CONTENT_SOURCE is missing', () => {
    const html = makeNextDataHtml({
      runtimeConfig: { CLIENT_SIDE_API_DOMAIN: 'https://api.example.com', ARC_SITE: 'site' },
    });
    expect(detectPrismContentApi(html)).toBeNull();
  });

  it('returns null website when website cannot be determined', () => {
    const html = makeNextDataHtml({
      runtimeConfig: {
        CLIENT_SIDE_API_DOMAIN: 'https://api.example.com',
        CONTENT_SOURCE: 'content-api-v4',
      },
    });
    const result = detectPrismContentApi(html);
    expect(result).not.toBeNull();
    expect(result!.website).toBeNull();
  });

  it('returns null for malformed JSON in __NEXT_DATA__', () => {
    const html =
      '<html><head><script id="__NEXT_DATA__" type="application/json">{bad json</script></head><body></body></html>';
    expect(detectPrismContentApi(html)).toBeNull();
  });

  it('returns null for empty string values', () => {
    const html = makeNextDataHtml({
      runtimeConfig: {
        CLIENT_SIDE_API_DOMAIN: '',
        CONTENT_SOURCE: '',
        ARC_SITE: 'site',
      },
    });
    expect(detectPrismContentApi(html)).toBeNull();
  });
});

describe('buildPrismContentApiUrl', () => {
  const config = {
    apiDomain: 'https://api.example.com',
    contentSource: 'content-api-v4',
    website: 'mysite',
  };

  it('builds correct URL with encoded query', () => {
    const url = buildPrismContentApiUrl(
      config,
      'https://www.example.com/politics/2025/article-slug/'
    );
    expect(url).toContain('https://api.example.com/api/content-api-v4');
    expect(url).toContain('_website=mysite');
    expect(url).toContain(
      encodeURIComponent(JSON.stringify({ canonical_url: '/politics/2025/article-slug/' }))
    );
  });

  it('handles root path', () => {
    const url = buildPrismContentApiUrl(config, 'https://www.example.com/');
    expect(url).toContain(encodeURIComponent(JSON.stringify({ canonical_url: '/' })));
  });

  it('strips query params from page URL', () => {
    const url = buildPrismContentApiUrl(
      config,
      'https://www.example.com/article?utm_source=twitter'
    );
    expect(url).toContain(encodeURIComponent(JSON.stringify({ canonical_url: '/article' })));
    expect(url).not.toContain('utm_source');
  });

  it('adds https:// when apiDomain lacks protocol', () => {
    const configNoProto = { ...config, apiDomain: 'api.example.com' };
    const url = buildPrismContentApiUrl(configNoProto, 'https://www.example.com/article');
    expect(url.startsWith('https://api.example.com/')).toBe(true);
  });

  it('encodes website with special characters', () => {
    const configSpecial = { ...config, website: 'my site' };
    const url = buildPrismContentApiUrl(configSpecial, 'https://www.example.com/article');
    expect(url).toContain('_website=my%20site');
  });

  it('omits _website param when website is null', () => {
    const configNoSite = { ...config, website: null };
    const url = buildPrismContentApiUrl(configNoSite, 'https://www.example.com/article');
    expect(url).not.toContain('_website');
    expect(url).toContain('query=');
  });

  it('returns null when API domain is a different site (SSRF prevention)', () => {
    const crossSiteConfig = {
      apiDomain: 'https://evil.example.com',
      contentSource: 'content-api-v4',
      website: 'site',
    };
    expect(
      buildPrismContentApiUrl(crossSiteConfig, 'https://www.news.example.org/article')
    ).toBeNull();
  });

  it('allows API on sibling subdomain of the same site', () => {
    const siblingConfig = {
      apiDomain: 'https://api.news.example.org',
      contentSource: 'content-api-v4',
      website: 'site',
    };
    const url = buildPrismContentApiUrl(siblingConfig, 'https://www.news.example.org/article');
    expect(url).not.toBeNull();
    expect(url).toContain('api.news.example.org');
  });

  it('rejects cross-site IP addresses', () => {
    const ipConfig = {
      apiDomain: 'https://192.168.1.1',
      contentSource: 'content-api-v4',
      website: 'site',
    };
    expect(buildPrismContentApiUrl(ipConfig, 'https://192.168.1.2/article')).toBeNull();
  });

  it('allows same IP address', () => {
    const ipConfig = {
      apiDomain: 'https://10.0.0.1',
      contentSource: 'content-api-v4',
      website: 'site',
    };
    expect(buildPrismContentApiUrl(ipConfig, 'https://10.0.0.1/article')).not.toBeNull();
  });
});

describe('parseArcAnsContent', () => {
  it('parses a full ANS response with all metadata', () => {
    const ans = makeAnsResponse();
    const result = parseArcAnsContent(ans);

    expect(result).not.toBeNull();
    expect(result!.method).toBe('prism-content-api');
    expect(result!.title).toBe('Test Article Title');
    expect(result!.byline).toBe('Jane Doe, John Smith');
    expect(result!.publishedTime).toBe('2025-06-15T10:00:00Z');
    expect(result!.excerpt).toBe('A test article excerpt');
    expect(result!.textContent!.length).toBeGreaterThanOrEqual(GOOD_CONTENT_LENGTH);
    expect(result!.content).toContain('<p>');
    expect(result!.markdown).toBeTruthy();
  });

  it('handles header elements', () => {
    const ans = makeAnsResponse({
      content_elements: [
        { type: 'text', content: `<p>${filler(GOOD_CONTENT_LENGTH + 100)}</p>` },
        { type: 'header', content: 'My Header', level: 3 },
      ],
    });
    const result = parseArcAnsContent(ans);
    expect(result).not.toBeNull();
    expect(result!.content).toContain('<h3>My Header</h3>');
  });

  it('handles header with default level 2', () => {
    const ans = makeAnsResponse({
      content_elements: [
        { type: 'text', content: `<p>${filler(GOOD_CONTENT_LENGTH + 100)}</p>` },
        { type: 'header', content: 'Default Header' },
      ],
    });
    const result = parseArcAnsContent(ans);
    expect(result!.content).toContain('<h2>Default Header</h2>');
  });

  it('clamps header level to valid range 1-6', () => {
    const ans = makeAnsResponse({
      content_elements: [
        { type: 'text', content: `<p>${filler(GOOD_CONTENT_LENGTH + 100)}</p>` },
        { type: 'header', content: 'Zero', level: 0 },
        { type: 'header', content: 'Negative', level: -1 },
        { type: 'header', content: 'Too High', level: 99 },
        { type: 'header', content: 'Non-numeric', level: 'bad' },
      ],
    });
    const result = parseArcAnsContent(ans);
    // All invalid levels should default to h2
    expect(result!.content).toContain('<h2>Zero</h2>');
    expect(result!.content).toContain('<h2>Negative</h2>');
    expect(result!.content).toContain('<h2>Too High</h2>');
    expect(result!.content).toContain('<h2>Non-numeric</h2>');
  });

  it('handles raw_html elements', () => {
    const rawContent = `<div class="embed">${filler(GOOD_CONTENT_LENGTH + 100)}</div>`;
    const ans = makeAnsResponse({
      content_elements: [{ type: 'raw_html', content: rawContent }],
    });
    const result = parseArcAnsContent(ans);
    expect(result).not.toBeNull();
    expect(result!.content).toContain('class="embed"');
  });

  it('strips script, style, and iframe tags from output HTML', () => {
    const ans = makeAnsResponse({
      content_elements: [
        { type: 'text', content: `<p>${filler(GOOD_CONTENT_LENGTH + 100)}</p>` },
        { type: 'raw_html', content: '<script>alert("xss")</script><p>Safe content</p>' },
        { type: 'raw_html', content: '<style>body{display:none}</style><p>More safe</p>' },
        {
          type: 'raw_html',
          content: '<iframe src="https://evil.example.com"></iframe><p>Also safe</p>',
        },
      ],
    });
    const result = parseArcAnsContent(ans);
    expect(result).not.toBeNull();
    expect(result!.content).not.toContain('<script');
    expect(result!.content).not.toContain('<style');
    expect(result!.content).not.toContain('<iframe');
    expect(result!.content).toContain('Safe content');
    expect(result!.content).toContain('More safe');
    expect(result!.content).toContain('Also safe');
  });

  it('handles list elements', () => {
    const ans = makeAnsResponse({
      content_elements: [
        { type: 'text', content: `<p>${filler(GOOD_CONTENT_LENGTH + 100)}</p>` },
        {
          type: 'list',
          list_type: 'unordered',
          items: [{ content: 'Item one' }, { content: 'Item two' }],
        },
      ],
    });
    const result = parseArcAnsContent(ans);
    expect(result!.content).toContain('<ul>');
    expect(result!.content).toContain('<li>Item one</li>');
  });

  it('handles ordered lists', () => {
    const ans = makeAnsResponse({
      content_elements: [
        { type: 'text', content: `<p>${filler(GOOD_CONTENT_LENGTH + 100)}</p>` },
        {
          type: 'list',
          list_type: 'ordered',
          items: [{ content: 'First' }, { content: 'Second' }],
        },
      ],
    });
    const result = parseArcAnsContent(ans);
    expect(result!.content).toContain('<ol>');
  });

  it('skips non-text content types (image, video)', () => {
    const ans = makeAnsResponse({
      content_elements: [
        { type: 'text', content: `<p>${filler(GOOD_CONTENT_LENGTH + 100)}</p>` },
        { type: 'image', url: 'https://example.com/img.jpg' },
        { type: 'video', url: 'https://example.com/vid.mp4' },
        { type: 'interstitial_link', url: 'https://example.com/link' },
      ],
    });
    const result = parseArcAnsContent(ans);
    expect(result).not.toBeNull();
    expect(result!.content).not.toContain('img.jpg');
    expect(result!.content).not.toContain('vid.mp4');
  });

  it('returns null for empty content_elements', () => {
    const ans = makeAnsResponse({ content_elements: [] });
    expect(parseArcAnsContent(ans)).toBeNull();
  });

  it('returns null for missing content_elements', () => {
    expect(parseArcAnsContent({ headlines: { basic: 'Title' } })).toBeNull();
  });

  it('returns null for content below threshold', () => {
    const ans = makeAnsResponse({
      content_elements: [{ type: 'text', content: '<p>Short.</p>' }],
    });
    expect(parseArcAnsContent(ans)).toBeNull();
  });

  it('returns null for null input', () => {
    expect(parseArcAnsContent(null)).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseArcAnsContent('string')).toBeNull();
    expect(parseArcAnsContent(42)).toBeNull();
  });

  it('handles missing metadata gracefully', () => {
    const ans = {
      content_elements: [{ type: 'text', content: `<p>${filler(GOOD_CONTENT_LENGTH + 100)}</p>` }],
    };
    const result = parseArcAnsContent(ans);
    expect(result).not.toBeNull();
    expect(result!.title).toBeNull();
    expect(result!.byline).toBeNull();
    expect(result!.publishedTime).toBeNull();
    expect(result!.excerpt).toBeNull();
  });

  it('handles credits.by with missing names', () => {
    const ans = makeAnsResponse({
      credits: { by: [{ name: 'Author' }, {}, { name: '' }] },
    });
    const result = parseArcAnsContent(ans);
    expect(result!.byline).toBe('Author');
  });

  it('handles credits.by as non-array', () => {
    const ans = makeAnsResponse({ credits: { by: 'not an array' } });
    const result = parseArcAnsContent(ans);
    expect(result!.byline).toBeNull();
  });
});
