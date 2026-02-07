import { describe, it, expect, vi } from 'vitest';
import { parseRobotsTxt, isAllowedByRobots } from '../crawl/robots-parser.js';
import { parseSitemapXml, fetchSitemapEntries } from '../crawl/sitemap-parser.js';
import { extractLinks } from '../crawl/link-extractor.js';
import { UrlFrontier, normalizeUrl } from '../crawl/url-frontier.js';
import { parseCrawlArgs } from '../cli.js';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('robots-parser', () => {
  describe('parseRobotsTxt', () => {
    it('parses Disallow rules for wildcard user-agent', () => {
      const content = `User-agent: *
Disallow: /admin
Disallow: /private/
`;
      const rules = parseRobotsTxt(content);
      expect(rules.disallowPaths).toEqual(['/admin', '/private/']);
    });

    it('ignores Disallow rules for specific user-agents', () => {
      const content = `User-agent: Googlebot
Disallow: /no-google

User-agent: *
Disallow: /blocked
`;
      const rules = parseRobotsTxt(content);
      expect(rules.disallowPaths).toEqual(['/blocked']);
    });

    it('extracts Sitemap directives', () => {
      const content = `User-agent: *
Disallow: /admin

Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/sitemap-news.xml
`;
      const rules = parseRobotsTxt(content);
      expect(rules.sitemapUrls).toEqual([
        'https://example.com/sitemap.xml',
        'https://example.com/sitemap-news.xml',
      ]);
    });

    it('handles empty content', () => {
      const rules = parseRobotsTxt('');
      expect(rules.disallowPaths).toEqual([]);
      expect(rules.sitemapUrls).toEqual([]);
    });

    it('handles comments', () => {
      const content = `# This is a comment
User-agent: *
# Another comment
Disallow: /test
`;
      const rules = parseRobotsTxt(content);
      expect(rules.disallowPaths).toEqual(['/test']);
    });
  });

  describe('isAllowedByRobots', () => {
    it('allows paths not in disallow list', () => {
      expect(isAllowedByRobots('/public', ['/admin', '/private'])).toBe(true);
    });

    it('blocks paths in disallow list', () => {
      expect(isAllowedByRobots('/admin/settings', ['/admin'])).toBe(false);
    });

    it('allows all paths with empty disallow list', () => {
      expect(isAllowedByRobots('/anything', [])).toBe(true);
    });
  });
});

describe('sitemap-parser', () => {
  describe('parseSitemapXml', () => {
    it('parses URL entries from sitemap', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/</loc>
    <lastmod>2024-01-01</lastmod>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://example.com/about</loc>
    <priority>0.8</priority>
  </url>
</urlset>`;

      const { entries, nestedSitemaps } = parseSitemapXml(xml);
      expect(entries).toHaveLength(2);
      expect(entries[0].loc).toBe('https://example.com/');
      expect(entries[0].lastmod).toBe('2024-01-01');
      expect(entries[0].priority).toBe(1.0);
      expect(entries[1].loc).toBe('https://example.com/about');
      expect(nestedSitemaps).toHaveLength(0);
    });

    it('parses sitemap index with nested sitemaps', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap-pages.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://example.com/sitemap-posts.xml</loc>
  </sitemap>
</sitemapindex>`;

      const { entries, nestedSitemaps } = parseSitemapXml(xml);
      expect(entries).toHaveLength(0);
      expect(nestedSitemaps).toEqual([
        'https://example.com/sitemap-pages.xml',
        'https://example.com/sitemap-posts.xml',
      ]);
    });

    it('handles empty sitemap', () => {
      const xml = `<?xml version="1.0"?><urlset></urlset>`;
      const { entries } = parseSitemapXml(xml);
      expect(entries).toHaveLength(0);
    });

    it('filters out non-HTTP loc URLs', () => {
      const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/valid</loc></url>
  <url><loc>ftp://example.com/invalid</loc></url>
  <url><loc>javascript:alert(1)</loc></url>
  <url><loc>file:///etc/passwd</loc></url>
  <url><loc>http://example.com/also-valid</loc></url>
</urlset>`;

      const { entries } = parseSitemapXml(xml);
      expect(entries).toHaveLength(2);
      expect(entries[0].loc).toBe('https://example.com/valid');
      expect(entries[1].loc).toBe('http://example.com/also-valid');
    });

    it('filters out non-HTTP nested sitemap loc URLs', () => {
      const xml = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
  <sitemap><loc>ftp://example.com/sitemap-2.xml</loc></sitemap>
</sitemapindex>`;

      const { nestedSitemaps } = parseSitemapXml(xml);
      expect(nestedSitemaps).toHaveLength(1);
      expect(nestedSitemaps[0]).toBe('https://example.com/sitemap-1.xml');
    });

    it('caps entries at maxEntries', () => {
      const urls = Array.from(
        { length: 10 },
        (_, i) => `  <url><loc>https://example.com/${i}</loc></url>`
      ).join('\n');
      const xml = `<?xml version="1.0"?><urlset>${urls}</urlset>`;

      const { entries } = parseSitemapXml(xml, 5);
      expect(entries).toHaveLength(5);
    });
  });

  describe('fetchSitemapEntries', () => {
    it('rejects cross-origin nested sitemaps', async () => {
      const sameOriginSitemap = `<?xml version="1.0"?>
<urlset><url><loc>https://example.com/page1</loc></url></urlset>`;

      const indexXml = `<?xml version="1.0"?>
<sitemapindex>
  <sitemap><loc>https://example.com/sitemap-ok.xml</loc></sitemap>
  <sitemap><loc>https://evil.example.com/sitemap-steal.xml</loc></sitemap>
</sitemapindex>`;

      const fetchFn = vi.fn(async (url: string) => {
        if (url.includes('sitemap-index')) return { ok: true, text: indexXml };
        if (url.includes('sitemap-ok')) return { ok: true, text: sameOriginSitemap };
        return null;
      });

      const entries = await fetchSitemapEntries(['https://example.com/sitemap-index.xml'], fetchFn);

      expect(entries).toHaveLength(1);
      expect(entries[0].loc).toBe('https://example.com/page1');
      expect(fetchFn).not.toHaveBeenCalledWith('https://evil.example.com/sitemap-steal.xml');
    });
  });
});

describe('link-extractor', () => {
  describe('extractLinks', () => {
    it('extracts absolute URLs', () => {
      const html = '<html><body><a href="https://example.com/page">Link</a></body></html>';
      const links = extractLinks(html, 'https://example.com');
      expect(links).toContain('https://example.com/page');
    });

    it('resolves relative URLs', () => {
      const html = '<html><body><a href="/about">About</a></body></html>';
      const links = extractLinks(html, 'https://example.com/page');
      expect(links).toContain('https://example.com/about');
    });

    it('strips fragments', () => {
      const html = '<html><body><a href="/page#section">Link</a></body></html>';
      const links = extractLinks(html, 'https://example.com');
      expect(links).toContain('https://example.com/page');
      expect(links.some((l) => l.includes('#'))).toBe(false);
    });

    it('deduplicates URLs', () => {
      const html = '<html><body><a href="/page">Link1</a><a href="/page">Link2</a></body></html>';
      const links = extractLinks(html, 'https://example.com');
      expect(links.filter((l) => l === 'https://example.com/page')).toHaveLength(1);
    });

    it('filters out mailto: links', () => {
      const html = '<html><body><a href="mailto:test@example.com">Email</a></body></html>';
      const links = extractLinks(html, 'https://example.com');
      expect(links).toHaveLength(0);
    });

    it('filters out javascript: links', () => {
      const html = '<html><body><a href="javascript:void(0)">JS</a></body></html>';
      const links = extractLinks(html, 'https://example.com');
      expect(links).toHaveLength(0);
    });

    it('filters out tel: links', () => {
      const html = '<html><body><a href="tel:+1234567890">Call</a></body></html>';
      const links = extractLinks(html, 'https://example.com');
      expect(links).toHaveLength(0);
    });

    it('skips anchors without href', () => {
      const html = '<html><body><a>No href</a></body></html>';
      const links = extractLinks(html, 'https://example.com');
      expect(links).toHaveLength(0);
    });
  });
});

describe('url-frontier', () => {
  describe('normalizeUrl', () => {
    it('strips fragments', () => {
      expect(normalizeUrl('https://example.com/page#section')).toBe('https://example.com/page');
    });

    it('removes trailing slashes', () => {
      expect(normalizeUrl('https://example.com/page/')).toBe('https://example.com/page');
    });

    it('preserves root path slash', () => {
      expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
    });
  });

  describe('UrlFrontier', () => {
    it('yields start URL first', () => {
      const frontier = new UrlFrontier('https://example.com/', {});
      const entry = frontier.next();
      expect(entry).not.toBeNull();
      expect(entry!.url).toBe('https://example.com/');
      expect(entry!.depth).toBe(0);
    });

    it('deduplicates URLs', () => {
      const frontier = new UrlFrontier('https://example.com/', { maxPages: 10 });
      frontier.add('https://example.com/page', 1);
      frontier.add('https://example.com/page', 1);

      frontier.next(); // start url
      const entry = frontier.next();
      expect(entry!.url).toBe('https://example.com/page');
      expect(frontier.next()).toBeNull(); // no duplicate
    });

    it('enforces same-origin', () => {
      const frontier = new UrlFrontier('https://example.com/', { sameOrigin: true });
      const added = frontier.add('https://other.example.com/page', 1);
      expect(added).toBe(false);
    });

    it('allows cross-origin when disabled', () => {
      const frontier = new UrlFrontier('https://example.com/', { sameOrigin: false });
      const added = frontier.add('https://other.example.com/page', 1);
      expect(added).toBe(true);
    });

    it('respects maxDepth', () => {
      const frontier = new UrlFrontier('https://example.com/', { maxDepth: 1 });
      expect(frontier.add('https://example.com/a', 1)).toBe(true);
      expect(frontier.add('https://example.com/b', 2)).toBe(false);
    });

    it('respects maxPages', () => {
      const frontier = new UrlFrontier('https://example.com/', { maxPages: 2 });
      frontier.add('https://example.com/a', 1);
      frontier.add('https://example.com/b', 1);

      expect(frontier.next()).not.toBeNull(); // start
      expect(frontier.next()).not.toBeNull(); // /a
      expect(frontier.next()).toBeNull(); // limit reached
    });

    it('filters by include pattern', () => {
      const frontier = new UrlFrontier('https://example.com/', {
        include: ['/blog/*'],
        maxPages: 10,
      });
      expect(frontier.add('https://example.com/blog/post1', 1)).toBe(true);
      expect(frontier.add('https://example.com/about', 1)).toBe(false);
    });

    it('filters by exclude pattern', () => {
      const frontier = new UrlFrontier('https://example.com/', {
        exclude: ['/admin/*'],
        maxPages: 10,
      });
      expect(frontier.add('https://example.com/page', 1)).toBe(true);
      expect(frontier.add('https://example.com/admin/settings', 1)).toBe(false);
    });

    it('addAll returns count of added URLs', () => {
      const frontier = new UrlFrontier('https://example.com/', { maxPages: 10 });
      const count = frontier.addAll(
        [
          'https://example.com/a',
          'https://example.com/b',
          'https://example.com/a', // duplicate
        ],
        1
      );
      expect(count).toBe(2);
    });

    it('tracks processedCount', () => {
      const frontier = new UrlFrontier('https://example.com/', {});
      expect(frontier.processedCount).toBe(0);
      frontier.next();
      expect(frontier.processedCount).toBe(1);
    });

    it('caps queue at maxQueued', () => {
      const frontier = new UrlFrontier('https://example.com/', {
        maxPages: 5,
        maxQueued: 3,
        sameOrigin: false,
      });

      // Start URL uses 1 queue slot
      expect(frontier.add('https://a.example.com/1', 0)).toBe(true); // queue=2
      expect(frontier.add('https://a.example.com/2', 0)).toBe(true); // queue=3 = maxQueued
      expect(frontier.add('https://a.example.com/3', 0)).toBe(false); // over cap
    });

    it('allows new URLs after dequeuing frees queue space', () => {
      const frontier = new UrlFrontier('https://example.com/', {
        maxPages: 10,
        maxQueued: 2,
        sameOrigin: false,
      });

      // Queue is full: start URL + 1 more
      expect(frontier.add('https://a.example.com/1', 0)).toBe(true); // queue=2
      expect(frontier.add('https://a.example.com/2', 0)).toBe(false); // queue full

      // Dequeue frees a slot
      frontier.next();
      expect(frontier.add('https://a.example.com/3', 0)).toBe(true); // queue has space now
    });

    it('defaults maxQueued to 10x maxPages', () => {
      const frontier = new UrlFrontier('https://example.com/', {
        maxPages: 2,
        sameOrigin: false,
      });
      // Default maxQueued = 2*10 = 20, so adding 19 more should work
      for (let i = 0; i < 19; i++) {
        frontier.add(`https://a.example.com/${i}`, 0);
      }
      // Queue: 1 (start) + 19 = 20 = maxQueued
      expect(frontier.add('https://a.example.com/overflow', 0)).toBe(false);
    });
  });
});

describe('CLI crawl args', () => {
  it('parses basic crawl URL', () => {
    const result = parseCrawlArgs(['https://example.com']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.url).toBe('https://example.com');
    }
  });

  it('parses --depth flag', () => {
    const result = parseCrawlArgs(['https://example.com', '--depth', '2']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.maxDepth).toBe(2);
    }
  });

  it('parses --limit flag', () => {
    const result = parseCrawlArgs(['https://example.com', '--limit', '50']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.maxPages).toBe(50);
    }
  });

  it('parses --concurrency flag', () => {
    const result = parseCrawlArgs(['https://example.com', '--concurrency', '3']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.concurrency).toBe(3);
    }
  });

  it('parses --include as comma-separated', () => {
    const result = parseCrawlArgs(['https://example.com', '--include', '/blog/*,/news/*']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.include).toEqual(['/blog/*', '/news/*']);
    }
  });

  it('parses --exclude as comma-separated', () => {
    const result = parseCrawlArgs(['https://example.com', '--exclude', '/admin/*,/tag/*']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.exclude).toEqual(['/admin/*', '/tag/*']);
    }
  });

  it('parses --delay flag', () => {
    const result = parseCrawlArgs(['https://example.com', '--delay', '200']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.delay).toBe(200);
    }
  });

  it('parses --select and --remove flags', () => {
    const result = parseCrawlArgs([
      'https://example.com',
      '--select',
      'article',
      '--remove',
      'nav',
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.targetSelector).toBe('article');
      expect(result.opts.removeSelector).toBe('nav');
    }
  });

  it('returns error when URL is missing', () => {
    const result = parseCrawlArgs([]);
    expect(result.kind).toBe('error');
  });

  it('returns help on --help', () => {
    const result = parseCrawlArgs(['--help']);
    expect(result.kind).toBe('help');
  });

  it('returns error on invalid --depth', () => {
    const result = parseCrawlArgs(['https://example.com', '--depth', 'abc']);
    expect(result.kind).toBe('error');
  });

  it('returns error when --concurrency exceeds 50', () => {
    const result = parseCrawlArgs(['https://example.com', '--concurrency', '51']);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('50');
    }
  });

  it('allows --concurrency up to 50', () => {
    const result = parseCrawlArgs(['https://example.com', '--concurrency', '50']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.concurrency).toBe(50);
    }
  });

  it('returns error when URL is not HTTP(S)', () => {
    const result = parseCrawlArgs(['/local/path']);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('http');
    }
  });

  it('returns error when URL is ftp://', () => {
    const result = parseCrawlArgs(['ftp://example.com']);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('http');
    }
  });

  it('returns error when --limit exceeds 10000', () => {
    const result = parseCrawlArgs(['https://example.com', '--limit', '10001']);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('10000');
    }
  });

  it('allows --limit up to 10000', () => {
    const result = parseCrawlArgs(['https://example.com', '--limit', '10000']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.maxPages).toBe(10000);
    }
  });
});
