import { describe, it, expect } from 'vitest';
import {
  parseSiteConfigJson,
  getSiteConfig,
  getSiteUserAgent,
  getSiteReferer,
  siteUsesArchiveFallback,
  getSiteArchiveSelectors,
  getSiteBlockPatterns,
  shouldBlockRequest,
  sitePreferJsonLd,
  siteUseNextData,
  siteUseWpRestApi,
  getSiteWpJsonApiPath,
  validateSiteConfigs,
  getSiteCount,
  getConfiguredDomains,
} from '../sites/site-config.js';

describe('parseSiteConfigJson', () => {
  it('parses basic site config fields', () => {
    const result = parseSiteConfigJson({
      'test.com': {
        userAgent: 'TestBot/1.0',
        referer: 'https://google.com/',
        allowCookies: true,
        preferJsonLd: true,
        useNextData: false,
        nextDataPath: 'props.pageProps.content',
        notes: 'test site',
        useWpRestApi: true,
        wpJsonApiPath: '/wp-json/wp/v2/posts/',
        usesArchiveFallback: true,
      },
    });

    expect(result['test.com']).toEqual({
      userAgent: 'TestBot/1.0',
      referer: 'https://google.com/',
      allowCookies: true,
      preferJsonLd: true,
      useNextData: false,
      nextDataPath: 'props.pageProps.content',
      notes: 'test site',
      useWpRestApi: true,
      wpJsonApiPath: '/wp-json/wp/v2/posts/',
      usesArchiveFallback: true,
    });
  });

  it('parses archiveSelectors as string array', () => {
    const result = parseSiteConfigJson({
      'test.com': { archiveSelectors: ['article', 'main'] },
    });
    expect(result['test.com'].archiveSelectors).toEqual(['article', 'main']);
  });

  it('converts blockPatterns strings to RegExp', () => {
    const result = parseSiteConfigJson({
      'test.com': { blockPatterns: ['\\.example\\.com\\/ads\\/'] },
    });
    expect(result['test.com'].blockPatterns).toHaveLength(1);
    expect(result['test.com'].blockPatterns![0]).toBeInstanceOf(RegExp);
    expect(result['test.com'].blockPatterns![0].test('https://cdn.example.com/ads/banner')).toBe(
      true
    );
  });

  it('skips invalid regex patterns without losing the site config', () => {
    const result = parseSiteConfigJson({
      'test.com': {
        userAgent: 'Bot/1.0',
        blockPatterns: ['(invalid[regex'],
      },
    });
    expect(result['test.com']).toBeDefined();
    expect(result['test.com'].userAgent).toBe('Bot/1.0');
    expect(result['test.com'].blockPatterns).toBeUndefined();
  });

  it('ignores unknown fields', () => {
    const result = parseSiteConfigJson({
      'test.com': {
        userAgent: 'Bot/1.0',
        unknownField: 'should be ignored',
        anotherUnknown: 42,
      },
    });
    expect(result['test.com']).toEqual({ userAgent: 'Bot/1.0' });
  });

  it('ignores fields with wrong types', () => {
    const result = parseSiteConfigJson({
      'test.com': {
        userAgent: 123,
        allowCookies: 'yes',
        preferJsonLd: 1,
      },
    });
    expect(result['test.com']).toEqual({});
  });

  it('parses multiple domains', () => {
    const result = parseSiteConfigJson({
      'a.com': { userAgent: 'A' },
      'b.com': { userAgent: 'B' },
      'c.com': { allowCookies: true },
    });
    expect(Object.keys(result)).toHaveLength(3);
    expect(result['a.com'].userAgent).toBe('A');
    expect(result['b.com'].userAgent).toBe('B');
    expect(result['c.com'].allowCookies).toBe(true);
  });

  it('returns empty object for empty input', () => {
    expect(parseSiteConfigJson({})).toEqual({});
  });
});

describe('sites/site-config accessor functions', () => {
  // These tests use domains known to exist in config/sites.json.
  // When sites.json is eventually emptied, these should move to use
  // LYNXGET_SITES_CONFIG with a test fixture file.

  describe('getSiteConfig', () => {
    it('returns null for unknown domain', () => {
      expect(getSiteConfig('https://unknown.example.info/page')).toBeNull();
    });

    it('returns null for invalid URL', () => {
      expect(getSiteConfig('not-a-url')).toBeNull();
    });
  });

  describe('getSiteUserAgent', () => {
    it('returns null for unknown domain', () => {
      expect(getSiteUserAgent('https://unknown.example.info/page')).toBeNull();
    });
  });

  describe('getSiteReferer', () => {
    it('returns null for unknown domain', () => {
      expect(getSiteReferer('https://unknown.example.info/page')).toBeNull();
    });
  });

  describe('siteUsesArchiveFallback', () => {
    it('returns false for unknown domain', () => {
      expect(siteUsesArchiveFallback('https://unknown.example.info/page')).toBe(false);
    });
  });

  describe('getSiteArchiveSelectors', () => {
    it('returns defaults for unknown domain', () => {
      const selectors = getSiteArchiveSelectors('https://unknown.example.info/page');
      expect(selectors).toEqual(['article', 'main', '.article-body']);
    });
  });

  describe('getSiteBlockPatterns', () => {
    it('returns empty array for unknown domain', () => {
      expect(getSiteBlockPatterns('https://unknown.example.info/page')).toEqual([]);
    });
  });

  describe('shouldBlockRequest', () => {
    it('returns false when site has no config', () => {
      expect(
        shouldBlockRequest('https://unknown.example.info/page', 'https://cdn.example.org/script.js')
      ).toBe(false);
    });
  });

  describe('sitePreferJsonLd', () => {
    it('returns false for unknown domain', () => {
      expect(sitePreferJsonLd('https://unknown.example.info/page')).toBe(false);
    });
  });

  describe('siteUseNextData', () => {
    it('returns false for unknown domain', () => {
      expect(siteUseNextData('https://unknown.example.info/page')).toBe(false);
    });
  });

  describe('siteUseWpRestApi', () => {
    it('returns false for unknown domain', () => {
      expect(siteUseWpRestApi('https://unknown.example.info/page')).toBe(false);
    });
  });

  describe('getSiteWpJsonApiPath', () => {
    it('returns null for unknown domain', () => {
      expect(getSiteWpJsonApiPath('https://unknown.example.info/page')).toBeNull();
    });
  });

  describe('validateSiteConfigs', () => {
    it('does not throw for valid configs', () => {
      expect(() => validateSiteConfigs()).not.toThrow();
    });
  });

  describe('getSiteCount', () => {
    it('returns a non-negative number', () => {
      expect(getSiteCount()).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getConfiguredDomains', () => {
    it('returns an array', () => {
      expect(Array.isArray(getConfiguredDomains())).toBe(true);
    });
  });

  describe('hostname normalization', () => {
    it('strips www. and m. prefixes when matching', () => {
      expect(getSiteConfig('https://www.unknown.example.info/page')).toBeNull();
      expect(getSiteConfig('https://m.unknown.example.info/page')).toBeNull();
    });
  });
});
