import { describe, it, expect, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import {
  parseHydrationData,
  findArticleBody,
  extractMetadataFromParent,
  tryReactRouterHydrationExtraction,
} from '../extract/react-router-hydration.js';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('parseHydrationData', () => {
  it('extracts and parses double-escaped JSON from __staticRouterHydrationData', () => {
    const payload = { loaderData: { '1': { title: 'Test' } } };
    const escaped = JSON.stringify(JSON.stringify(payload));
    const html = `<html><body><script>window.__staticRouterHydrationData = JSON.parse(${escaped});</script></body></html>`;
    expect(parseHydrationData(html)).toEqual(payload);
  });

  it('returns null when no __staticRouterHydrationData exists', () => {
    expect(parseHydrationData('<html><body></body></html>')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    const html = `<html><body><script>window.__staticRouterHydrationData = JSON.parse("not valid");</script></body></html>`;
    expect(parseHydrationData(html)).toBeNull();
  });

  it('returns null when parsed result has no loaderData', () => {
    const escaped = JSON.stringify(JSON.stringify({ other: 'data' }));
    const html = `<html><body><script>window.__staticRouterHydrationData = JSON.parse(${escaped});</script></body></html>`;
    expect(parseHydrationData(html)).toBeNull();
  });
});

describe('findArticleBody', () => {
  it('finds the longest HTML string in loaderData', () => {
    const loaderData = {
      '1': null,
      '1-0': {
        content: {
          asset: {
            about: 'Short description',
            body: '<p>First paragraph of the article.</p><p>Second paragraph with more content that makes it significantly longer than the minimum.</p><p>Third paragraph adds even more content to this test article body to ensure it exceeds the two hundred character minimum threshold.</p>',
          },
        },
      },
    };
    const result = findArticleBody(loaderData);
    expect(result).not.toBeNull();
    expect(result!.body).toContain('<p>First paragraph');
    expect(result!.body).toContain('Second paragraph');
  });

  it('returns null when no HTML strings found', () => {
    const loaderData = { '1': null, '2': { title: 'no html here' } };
    expect(findArticleBody(loaderData)).toBeNull();
  });

  it('returns null for empty loaderData', () => {
    expect(findArticleBody({})).toBeNull();
  });

  it('picks the longest HTML string when multiple exist', () => {
    const short =
      '<p>Short paragraph that is still over two hundred characters because we need to meet the minimum body length threshold for detection to work properly in the test.</p><p>Extra padding paragraph.</p>';
    const long =
      short +
      '<p>Much longer with additional paragraphs of content here.</p><p>And even more content to make this clearly the longest candidate.</p>';
    const loaderData = {
      '1': { snippet: short, body: long },
    };
    const result = findArticleBody(loaderData);
    expect(result!.body).toBe(long);
  });

  it('ignores strings that contain HTML but are too short', () => {
    const loaderData = { '1': { body: '<p>Short</p>' } };
    expect(findArticleBody(loaderData)).toBeNull();
  });

  it('returns the parent object alongside the body for metadata extraction', () => {
    const body =
      '<p>Long enough article content that meets the minimum threshold for extraction.</p><p>More content here to ensure we pass the two hundred character minimum body length requirement for detection.</p><p>Third paragraph for good measure.</p>';
    const loaderData = {
      '1-0': {
        content: {
          asset: {
            body,
            headlines: { headline: 'Test Headline' },
            byline: 'Test Author',
          },
        },
      },
    };
    const result = findArticleBody(loaderData);
    expect(result).not.toBeNull();
    expect(result!.parent).toHaveProperty('headlines');
    expect(result!.parent).toHaveProperty('byline');
  });

  it('respects max depth to prevent stack overflow on deep objects', () => {
    // Build a deeply nested object (deeper than MAX_WALK_DEPTH)
    let obj: Record<string, unknown> = {
      body: '<p>Deep content that should not be found because it is nested too deeply.</p><p>More content to pad the length past the two hundred character minimum for body detection.</p><p>Even more padding.</p>',
    };
    for (let i = 0; i < 25; i++) {
      obj = { nested: obj };
    }
    const loaderData = { '1': obj };
    expect(findArticleBody(loaderData)).toBeNull();
  });
});

describe('extractMetadataFromParent', () => {
  it('extracts metadata from sibling fields of the body', () => {
    const parent = {
      body: '<p>content</p>',
      headlines: { headline: 'The Headline' },
      byline: 'Jane Doe',
      about: 'Article description',
      wordCount: 500,
      dates: { firstPublished: '2026-01-25T10:00:00Z' },
    };
    const meta = extractMetadataFromParent(parent);
    expect(meta.title).toBe('The Headline');
    expect(meta.byline).toBe('Jane Doe');
    expect(meta.excerpt).toBe('Article description');
    expect(meta.publishedTime).toBe('2026-01-25T10:00:00Z');
  });

  it('handles flat headline field (no nested headlines object)', () => {
    const parent = { headline: 'Flat Title', body: '<p>x</p>' };
    expect(extractMetadataFromParent(parent).title).toBe('Flat Title');
  });

  it('handles title field when no headline exists', () => {
    const parent = { title: 'Title Field', body: '<p>x</p>' };
    expect(extractMetadataFromParent(parent).title).toBe('Title Field');
  });

  it('handles name field as last-resort title', () => {
    const parent = { name: 'Name Field', body: '<p>x</p>' };
    expect(extractMetadataFromParent(parent).title).toBe('Name Field');
  });

  it('prefers headlines.headline over flat headline', () => {
    const parent = {
      headlines: { headline: 'Nested Wins' },
      headline: 'Flat Loses',
      body: '<p>x</p>',
    };
    expect(extractMetadataFromParent(parent).title).toBe('Nested Wins');
  });

  it('extracts byline from participants.authors array', () => {
    const parent = {
      body: '<p>x</p>',
      participants: {
        authors: [{ name: 'Alice' }, { name: 'Bob' }],
      },
    };
    expect(extractMetadataFromParent(parent).byline).toBe('Alice, Bob');
  });

  it('extracts byline from top-level authors array', () => {
    const parent = {
      body: '<p>x</p>',
      authors: [{ name: 'Charlie' }],
    };
    expect(extractMetadataFromParent(parent).byline).toBe('Charlie');
  });

  it('extracts byline from author string field', () => {
    const parent = { body: '<p>x</p>', author: 'Direct Author' };
    expect(extractMetadataFromParent(parent).byline).toBe('Direct Author');
  });

  it('handles datePublished at top level', () => {
    const parent = { body: '<p>x</p>', datePublished: '2026-01-01T00:00:00Z' };
    expect(extractMetadataFromParent(parent).publishedTime).toBe('2026-01-01T00:00:00Z');
  });

  it('prefers dates.firstPublished over dates.published', () => {
    const parent = {
      body: '<p>x</p>',
      dates: { firstPublished: '2026-01-01T00:00:00Z', published: '2026-01-02T00:00:00Z' },
    };
    expect(extractMetadataFromParent(parent).publishedTime).toBe('2026-01-01T00:00:00Z');
  });

  it('handles description field for excerpt', () => {
    const parent = { body: '<p>x</p>', description: 'A description' };
    expect(extractMetadataFromParent(parent).excerpt).toBe('A description');
  });

  it('returns nulls for all fields when parent has no metadata', () => {
    const parent = { body: '<p>x</p>' };
    const meta = extractMetadataFromParent(parent);
    expect(meta.title).toBeNull();
    expect(meta.byline).toBeNull();
    expect(meta.excerpt).toBeNull();
    expect(meta.publishedTime).toBeNull();
  });
});

/** Build an HTML page with an embedded hydration payload containing the given loaderData. */
function buildHydrationHtml(
  loaderData: Record<string, unknown>,
  opts?: { title?: string; siteName?: string; lang?: string }
): string {
  const payload = { loaderData, actionData: null, errors: null };
  const escaped = JSON.stringify(JSON.stringify(payload));
  const title = opts?.title ?? 'Test Page';
  const siteName = opts?.siteName ?? 'Test Site';
  const lang = opts?.lang ?? 'en';

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <title>${title}</title>
  <meta property="og:title" content="${title}" />
  <meta property="og:site_name" content="${siteName}" />
  <meta property="article:published_time" content="2026-01-25T10:00:00Z" />
</head>
<body>
  <script>window.__staticRouterHydrationData = JSON.parse(${escaped});</script>
  <p>Truncated DOM content.</p>
</body></html>`;
}

const longBody =
  '<p>First paragraph of the article with enough content to pass the extraction threshold.</p>' +
  '<p>Second paragraph continues with more detail about the topic at hand and provides context.</p>' +
  '<p>Third paragraph provides additional context and information to readers of this article.</p>' +
  '<p>Fourth paragraph wraps up this section of the article with substantial content for testing.</p>' +
  '<p>Fifth paragraph ensures we exceed the five hundred character GOOD_CONTENT_LENGTH threshold.</p>' +
  '<p>Sixth paragraph adds further material to make the text content long enough for extraction.</p>';

describe('tryReactRouterHydrationExtraction', () => {
  it('extracts content from hydration data with full metadata', () => {
    const html = buildHydrationHtml({
      '1-0': {
        content: {
          asset: {
            body: longBody,
            headlines: { headline: 'Hydration Headline' },
            byline: 'Test Author',
            about: 'Test excerpt about the article',
            dates: { firstPublished: '2026-01-25T12:00:00Z' },
          },
        },
      },
    });

    const { document } = parseHTML(html);
    const result = tryReactRouterHydrationExtraction(html, 'https://example.com/article', document);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('react-router-hydration');
    expect(result!.content).toContain('<p>First paragraph');
    expect(result!.textContent).toContain('First paragraph');
    expect(result!.title).toBe('Hydration Headline');
    expect(result!.byline).toBe('Test Author');
    expect(result!.excerpt).toBe('Test excerpt about the article');
    expect(result!.publishedTime).toBe('2026-01-25T12:00:00Z');
  });

  it('returns null when no hydration data present', () => {
    const html = '<html><body><p>Normal page</p></body></html>';
    const { document } = parseHTML(html);
    expect(tryReactRouterHydrationExtraction(html, 'https://example.com', document)).toBeNull();
  });

  it('returns null when body is too short', () => {
    const html = buildHydrationHtml({
      '1': { content: { body: '<p>Short</p>' } },
    });
    const { document } = parseHTML(html);
    expect(tryReactRouterHydrationExtraction(html, 'https://example.com', document)).toBeNull();
  });

  it('falls back to DOM metadata when hydration metadata is missing', () => {
    const html = buildHydrationHtml(
      { '1-0': { data: { body: longBody } } },
      { title: 'DOM Title', siteName: 'DOM Site' }
    );

    const { document } = parseHTML(html);
    const result = tryReactRouterHydrationExtraction(html, 'https://example.com/article', document);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('DOM Title');
    expect(result!.siteName).toBe('DOM Site');
  });

  it('sets lang from the html element', () => {
    const html = buildHydrationHtml({ '1': { content: { body: longBody } } }, { lang: 'fr' });

    const { document } = parseHTML(html);
    const result = tryReactRouterHydrationExtraction(
      html,
      'https://example.com/fr/article',
      document
    );
    expect(result).not.toBeNull();
    expect(result!.lang).toBe('fr');
  });
});
