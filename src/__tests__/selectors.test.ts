import { describe, it, expect, vi } from 'vitest';
import { applySelectors, extractFromHtml } from '../extract/content-extractors.js';
import { parseArgs } from '../cli.js';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../sites/site-config.js', () => ({
  sitePreferJsonLd: vi.fn(() => false),
  siteUseNextData: vi.fn(() => false),
  getSiteNextDataPath: vi.fn(() => null),
}));

import { logger } from '../logger.js';

/** Generate filler text of at least n characters */
function loremText(n: number): string {
  const base =
    'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ';
  let text = '';
  while (text.length < n) text += base;
  return text;
}

describe('applySelectors', () => {
  it('returns html unchanged when no selectors provided', () => {
    const html = '<html><body><p>Hello</p></body></html>';
    expect(applySelectors(html, {})).toBe(html);
  });

  it('removes elements matching removeSelector', () => {
    const html = '<html><body><nav>Menu</nav><article>Content</article></body></html>';
    const result = applySelectors(html, { removeSelector: 'nav' });
    expect(result).not.toContain('Menu');
    expect(result).toContain('Content');
  });

  it('removes multiple elements with comma-separated removeSelector', () => {
    const html =
      '<html><body><nav>Nav</nav><aside>Sidebar</aside><article>Content</article></body></html>';
    const result = applySelectors(html, { removeSelector: 'nav, aside' });
    expect(result).not.toContain('Nav');
    expect(result).not.toContain('Sidebar');
    expect(result).toContain('Content');
  });

  it('accepts removeSelector as array', () => {
    const html =
      '<html><body><nav>Nav</nav><aside>Sidebar</aside><article>Content</article></body></html>';
    const result = applySelectors(html, { removeSelector: ['nav', 'aside'] });
    expect(result).not.toContain('Nav');
    expect(result).not.toContain('Sidebar');
    expect(result).toContain('Content');
  });

  it('keeps only targeted elements with targetSelector', () => {
    const html =
      '<html><body><header>Header</header><article class="post">Article</article><footer>Footer</footer></body></html>';
    const result = applySelectors(html, { targetSelector: 'article.post' });
    expect(result).toContain('Article');
    expect(result).not.toContain('Header');
    expect(result).not.toContain('Footer');
  });

  it('concatenates multiple matched elements for targetSelector', () => {
    const html =
      '<html><body><div class="item">First</div><div class="other">Skip</div><div class="item">Second</div></body></html>';
    const result = applySelectors(html, { targetSelector: '.item' });
    expect(result).toContain('First');
    expect(result).toContain('Second');
    expect(result).not.toContain('Skip');
  });

  it('falls back to full document when targetSelector matches nothing', () => {
    const html = '<html><body><p>Content</p></body></html>';
    const result = applySelectors(html, { targetSelector: '.nonexistent' });
    expect(result).toContain('Content');
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ targetSelector: '.nonexistent' }),
      expect.stringContaining('matched no elements')
    );
  });

  it('applies removeSelector before targetSelector', () => {
    const html =
      '<html><body><article><nav>Nav inside article</nav><p>Article text</p></article></body></html>';
    const result = applySelectors(html, {
      removeSelector: 'nav',
      targetSelector: 'article',
    });
    expect(result).toContain('Article text');
    expect(result).not.toContain('Nav inside article');
  });

  it('accepts targetSelector as array', () => {
    const html =
      '<html><body><h1>Title</h1><article>Content</article><aside>Side</aside></body></html>';
    const result = applySelectors(html, { targetSelector: ['h1', 'article'] });
    expect(result).toContain('Title');
    expect(result).toContain('Content');
    expect(result).not.toContain('Side');
  });
});

describe('extractFromHtml with selectors', () => {
  const articleText = loremText(600);

  it('extracts content from targeted element', () => {
    const html = `<html><body>
      <nav>Navigation</nav>
      <article class="post">${articleText}</article>
      <footer>Footer</footer>
    </body></html>`;

    const result = extractFromHtml(html, 'https://example.com', {
      targetSelector: 'article.post',
    });
    expect(result).not.toBeNull();
    expect(result!.textContent).toContain('Lorem ipsum');
  });

  it('removes elements before extraction', () => {
    const html = `<html><body>
      <article>
        <div class="ads">Buy stuff!</div>
        <p>${articleText}</p>
        <div class="comments">Comments here</div>
      </article>
    </body></html>`;

    const result = extractFromHtml(html, 'https://example.com', {
      removeSelector: '.ads, .comments',
    });
    expect(result).not.toBeNull();
    // The ads and comments should be removed
    expect(result!.textContent).not.toContain('Buy stuff!');
    expect(result!.textContent).not.toContain('Comments here');
  });

  it('works without selectors (backwards compatible)', () => {
    const html = `<html><body><article><p>${articleText}</p></article></body></html>`;

    const withSelectors = extractFromHtml(html, 'https://example.com', undefined);
    const without = extractFromHtml(html, 'https://example.com');
    expect(withSelectors).not.toBeNull();
    expect(without).not.toBeNull();
    expect(withSelectors!.textContent).toBe(without!.textContent);
  });
});

describe('CLI --select and --remove', () => {
  it('parses --select flag', () => {
    const result = parseArgs(['https://example.com', '--select', 'article.post']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.select).toBe('article.post');
    }
  });

  it('parses --remove flag', () => {
    const result = parseArgs(['https://example.com', '--remove', 'nav, .sidebar']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.remove).toBe('nav, .sidebar');
    }
  });

  it('parses both --select and --remove together', () => {
    const result = parseArgs(['https://example.com', '--select', '.content', '--remove', '.ads']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.select).toBe('.content');
      expect(result.opts.remove).toBe('.ads');
    }
  });

  it('select defaults to undefined', () => {
    const result = parseArgs(['https://example.com']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.select).toBeUndefined();
    }
  });

  it('remove defaults to undefined', () => {
    const result = parseArgs(['https://example.com']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.remove).toBeUndefined();
    }
  });

  it('returns error when --select is missing value', () => {
    const result = parseArgs(['https://example.com', '--select']);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('--select requires a value');
    }
  });

  it('returns error when --remove is missing value', () => {
    const result = parseArgs(['https://example.com', '--remove']);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('--remove requires a value');
    }
  });
});
