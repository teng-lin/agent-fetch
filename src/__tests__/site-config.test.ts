import { describe, it, expect } from 'vitest';
import {
  getSiteConfig,
  getSiteUserAgent,
  getSiteReferer,
  siteUsesArchiveFallback,
  getSiteArchiveSelectors,
  getSiteBlockPatterns,
  shouldBlockRequest,
  sitePreferJsonLd,
  siteUseNextData,
  validateSiteConfigs,
  getSiteConfigStats,
  getSiteCount,
  getConfiguredDomains,
} from '../sites/site-config.js';

describe('sites/site-config', () => {
  describe('getSiteConfig', () => {
    it('returns config for direct domain match', () => {
      const config = getSiteConfig('https://github.com/example/repo');
      expect(config).not.toBeNull();
    });

    it('strips www. prefix', () => {
      const config = getSiteConfig('https://www.github.com/page');
      expect(config).not.toBeNull();
    });

    it('strips m. prefix', () => {
      const config = getSiteConfig('https://m.wikipedia.org/wiki/Test');
      expect(config).not.toBeNull();
    });

    it('matches subdomain to parent config', () => {
      const config = getSiteConfig('https://en.wikipedia.org/wiki/Test');
      expect(config).not.toBeNull();
      expect(config!.userAgent).toContain('Googlebot');
    });

    it('returns null for unknown domain', () => {
      expect(getSiteConfig('https://unknown.example.info/page')).toBeNull();
    });

    it('returns null for invalid URL', () => {
      expect(getSiteConfig('not-a-url')).toBeNull();
    });
  });

  describe('getSiteUserAgent', () => {
    it('returns custom UA for wikipedia.org', () => {
      const ua = getSiteUserAgent('https://wikipedia.org/wiki/Test');
      expect(ua).not.toBeNull();
      expect(ua).toContain('Googlebot');
    });

    it('returns null for github.com (no custom UA)', () => {
      expect(getSiteUserAgent('https://github.com/page')).toBeNull();
    });

    it('returns null for unknown domain', () => {
      expect(getSiteUserAgent('https://unknown.example.info/page')).toBeNull();
    });
  });

  describe('getSiteReferer', () => {
    it('returns null when unconfigured', () => {
      expect(getSiteReferer('https://github.com/page')).toBeNull();
    });
  });

  describe('siteUsesArchiveFallback', () => {
    it('returns true for example.com', () => {
      expect(siteUsesArchiveFallback('https://example.com/article')).toBe(true);
    });

    it('returns false for github.com', () => {
      expect(siteUsesArchiveFallback('https://github.com/page')).toBe(false);
    });

    it('returns false for unknown domain', () => {
      expect(siteUsesArchiveFallback('https://unknown.example.info/page')).toBe(false);
    });
  });

  describe('getSiteArchiveSelectors', () => {
    it('returns defaults when unconfigured', () => {
      const selectors = getSiteArchiveSelectors('https://github.com/page');
      expect(selectors).toEqual(['article', 'main', '.article-body']);
    });
  });

  describe('getSiteBlockPatterns', () => {
    it('returns patterns for test.example.org', () => {
      const patterns = getSiteBlockPatterns('https://test.example.org/page');
      expect(patterns).toHaveLength(2);
    });

    it('returns empty array for github.com', () => {
      expect(getSiteBlockPatterns('https://github.com/page')).toEqual([]);
    });
  });

  describe('shouldBlockRequest', () => {
    it('blocks matching analytics.js URL', () => {
      expect(
        shouldBlockRequest('https://test.example.org/page', 'https://cdn.example.org/analytics.js')
      ).toBe(true);
    });

    it('blocks matching /ads/ path', () => {
      expect(
        shouldBlockRequest('https://test.example.org/page', 'https://cdn.example.org/ads/banner')
      ).toBe(true);
    });

    it('allows non-matching URL', () => {
      expect(
        shouldBlockRequest('https://test.example.org/page', 'https://cdn.example.org/styles.css')
      ).toBe(false);
    });
  });

  describe('sitePreferJsonLd', () => {
    it('returns true for demo.example.net', () => {
      expect(sitePreferJsonLd('https://demo.example.net/article')).toBe(true);
    });

    it('returns false for github.com', () => {
      expect(sitePreferJsonLd('https://github.com/page')).toBe(false);
    });
  });

  describe('siteUseNextData', () => {
    it('returns false for all minimal defaults', () => {
      expect(siteUseNextData('https://github.com/page')).toBe(false);
      expect(siteUseNextData('https://example.com/article')).toBe(false);
      expect(siteUseNextData('https://wikipedia.org/wiki/Test')).toBe(false);
    });
  });

  describe('validateSiteConfigs', () => {
    it('does not throw for valid configs', () => {
      expect(() => validateSiteConfigs()).not.toThrow();
    });
  });

  describe('getSiteConfigStats', () => {
    it('returns correct stats', () => {
      const stats = getSiteConfigStats();
      expect(stats.total).toBeGreaterThanOrEqual(5);
      expect(stats.minimalDefaults).toBe(5);
    });
  });

  describe('getSiteCount', () => {
    it('returns at least 5 configured sites', () => {
      expect(getSiteCount()).toBeGreaterThanOrEqual(5);
    });
  });

  describe('getConfiguredDomains', () => {
    it('includes all minimal default domains', () => {
      const domains = getConfiguredDomains();
      expect(domains).toContain('github.com');
      expect(domains).toContain('wikipedia.org');
      expect(domains).toContain('example.com');
      expect(domains).toContain('test.example.org');
      expect(domains).toContain('demo.example.net');
    });
  });
});
