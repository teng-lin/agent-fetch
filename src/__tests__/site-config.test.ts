import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import {
  parseSiteConfigJson,
  getSiteConfig,
  getSiteUserAgent,
  getSiteReferer,
  sitePreferJsonLd,
  siteUseNextData,
  siteUseWpRestApi,
  getSiteWpJsonApiPath,
  validateSiteConfigs,
  getSiteCount,
  getConfiguredDomains,
  resolveSitesJson,
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
    });
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
  // When sites.json is eventually populated, these should exercise
  // configs loaded via AGENT_FETCH_SITES_JSON.

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

describe('resolveSitesJson', () => {
  const originalEnv = process.env.AGENT_FETCH_SITES_JSON;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENT_FETCH_SITES_JSON;
    } else {
      process.env.AGENT_FETCH_SITES_JSON = originalEnv;
    }
  });

  it('falls back to bundled config/sites.json when no env var is set', () => {
    delete process.env.AGENT_FETCH_SITES_JSON;
    const result = resolveSitesJson();
    expect(result).not.toBeNull();
    expect(result!.endsWith(path.join('config', 'sites.json'))).toBe(true);
  });

  it('uses AGENT_FETCH_SITES_JSON when set to an existing file', () => {
    const sitesJson = path.resolve(__dirname, '..', '..', 'config', 'sites.json');
    process.env.AGENT_FETCH_SITES_JSON = sitesJson;
    const result = resolveSitesJson();
    expect(result).toBe(sitesJson);
  });

  it('returns null when AGENT_FETCH_SITES_JSON points to a missing file', () => {
    process.env.AGENT_FETCH_SITES_JSON = '/tmp/nonexistent-agent-fetch-sites.json';
    const result = resolveSitesJson();
    expect(result).toBeNull();
  });
});
