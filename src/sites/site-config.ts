/**
 * Site-specific configurations for article extraction
 *
 * Minimal defaults are included as examples.
 * For production use, load site-specific configs via the plugin system.
 * See docs/PLUGIN-SYSTEM.md for how to add your own site configurations.
 */
import { z } from 'zod';
import { MINIMAL_DEFAULTS } from './minimal-defaults.js';
import { USER_AGENTS, REFERERS, BLOCK_PATTERNS, convertBlockPatterns } from './constants.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Re-export constants for backward compatibility
export { USER_AGENTS, REFERERS, BLOCK_PATTERNS };

function loadJsonSiteConfigs(): Record<string, SiteConfig> {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const configPath = join(__dirname, '..', '..', 'config', 'sites.json');
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    const configs: Record<string, SiteConfig> = {};

    for (const [domain, rawConfig] of Object.entries(raw)) {
      const cfg = rawConfig as Record<string, unknown>;
      const config: SiteConfig = {};

      if (typeof cfg.userAgent === 'string') config.userAgent = cfg.userAgent;
      if (typeof cfg.referer === 'string') config.referer = cfg.referer;
      if (typeof cfg.allowCookies === 'boolean') config.allowCookies = cfg.allowCookies;
      if (typeof cfg.usesArchiveFallback === 'boolean')
        config.usesArchiveFallback = cfg.usesArchiveFallback;
      if (typeof cfg.preferJsonLd === 'boolean') config.preferJsonLd = cfg.preferJsonLd;
      if (typeof cfg.useNextData === 'boolean') config.useNextData = cfg.useNextData;
      if (typeof cfg.nextDataPath === 'string') config.nextDataPath = cfg.nextDataPath;
      if (typeof cfg.notes === 'string') config.notes = cfg.notes;
      if (typeof cfg.useWpRestApi === 'boolean') config.useWpRestApi = cfg.useWpRestApi;
      if (typeof cfg.wpJsonApiPath === 'string') config.wpJsonApiPath = cfg.wpJsonApiPath;
      if (Array.isArray(cfg.archiveSelectors)) {
        config.archiveSelectors = cfg.archiveSelectors.map(String);
      }
      if (Array.isArray(cfg.blockPatterns)) {
        try {
          config.blockPatterns = convertBlockPatterns(cfg.blockPatterns);
        } catch {
          // Skip invalid regex patterns for this site rather than losing all configs
        }
      }

      configs[domain] = config;
    }

    return configs;
  } catch {
    // Config file missing or invalid -- continue with minimal defaults
    return {};
  }
}

// --- Site config interface ---

export interface SiteConfig {
  /** Custom User-Agent to use for this site */
  userAgent?: string;
  /** Custom Referer header */
  referer?: string;
  /** Whether to allow cookies (default: false - cookies are cleared) */
  allowCookies?: boolean;
  /** Content selectors for archive extraction */
  archiveSelectors?: string[];
  /** Whether this site uses archive.is fallback */
  usesArchiveFallback?: boolean;
  /** URL patterns to block (access control scripts, etc.) */
  blockPatterns?: RegExp[];
  /** Prefer JSON-LD extraction (full content in structured data) */
  preferJsonLd?: boolean;
  /** Use Next.js __NEXT_DATA__ extraction for sites using Next.js framework */
  useNextData?: boolean;
  /** JSON path to extract content from __NEXT_DATA__ */
  nextDataPath?: string;
  /** Optional notes about site configuration */
  notes?: string;
  /** Use WordPress REST API for content extraction */
  useWpRestApi?: boolean;
  /** Custom WP JSON API path for sites with non-standard endpoints */
  wpJsonApiPath?: string;
}

// --- Zod validation schema ---

export const SiteConfigSchema = z.object({
  userAgent: z.string().optional(),
  referer: z.string().url().optional(),
  allowCookies: z.boolean().optional(),
  archiveSelectors: z.array(z.string()).optional(),
  usesArchiveFallback: z.boolean().optional(),
  blockPatterns: z.array(z.instanceof(RegExp)).optional(),
  preferJsonLd: z.boolean().optional(),
  useNextData: z.boolean().optional(),
  nextDataPath: z.string().optional(),
  notes: z.string().optional(),
  useWpRestApi: z.boolean().optional(),
  wpJsonApiPath: z.string().optional(),
});

// --- Module-level variable ---

// JSON configs loaded first, then minimal defaults override (development examples take priority)
const SITE_CONFIGS: Record<string, SiteConfig> = {
  ...loadJsonSiteConfigs(),
  ...MINIMAL_DEFAULTS,
};

// --- Validation ---

/**
 * Validate all site configs at startup. Throws if any config is invalid.
 */
export function validateSiteConfigs(): void {
  const errors: string[] = [];

  for (const [domain, config] of Object.entries(SITE_CONFIGS)) {
    const result = SiteConfigSchema.safeParse(config);
    if (!result.success) {
      errors.push(`${domain}: ${result.error.message}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid site configs:\n${errors.join('\n')}`);
  }
}

/**
 * Get site config statistics
 */
export function getSiteConfigStats(): {
  total: number;
  minimalDefaults: number;
} {
  return {
    total: Object.keys(SITE_CONFIGS).length,
    minimalDefaults: Object.keys(MINIMAL_DEFAULTS).length,
  };
}

// --- Accessor functions ---

/**
 * Get site configuration for a URL
 */
export function getSiteConfig(url: string): SiteConfig | null {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '').replace(/^m\./, '');

    // Direct match
    if (SITE_CONFIGS[hostname]) {
      return SITE_CONFIGS[hostname];
    }

    // Try subdomain match
    const parts = hostname.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      const candidate = parts.slice(i).join('.');
      if (SITE_CONFIGS[candidate]) {
        return SITE_CONFIGS[candidate];
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Get custom User-Agent for a site
 */
export function getSiteUserAgent(url: string): string | null {
  return getSiteConfig(url)?.userAgent ?? null;
}

/**
 * Get custom Referer for a site
 */
export function getSiteReferer(url: string): string | null {
  return getSiteConfig(url)?.referer ?? null;
}

/**
 * Check if a site uses archive fallback
 */
export function siteUsesArchiveFallback(url: string): boolean {
  return getSiteConfig(url)?.usesArchiveFallback ?? false;
}

/**
 * Get archive content selectors for a site
 */
export function getSiteArchiveSelectors(url: string): string[] {
  return getSiteConfig(url)?.archiveSelectors ?? ['article', 'main', '.article-body'];
}

/**
 * Get URL patterns to block for a site
 */
export function getSiteBlockPatterns(url: string): RegExp[] {
  return getSiteConfig(url)?.blockPatterns ?? [];
}

/**
 * Check if a request URL should be blocked for a site
 */
export function shouldBlockRequest(siteUrl: string, requestUrl: string): boolean {
  const patterns = getSiteBlockPatterns(siteUrl);
  return patterns.some((pattern) => pattern.test(requestUrl));
}

/**
 * Check if a site prefers JSON-LD extraction
 */
export function sitePreferJsonLd(url: string): boolean {
  return getSiteConfig(url)?.preferJsonLd ?? false;
}

/**
 * Check if a site uses Next.js __NEXT_DATA__ extraction
 */
export function siteUseNextData(url: string): boolean {
  return getSiteConfig(url)?.useNextData ?? false;
}

/**
 * Check if a site uses WordPress REST API extraction
 */
export function siteUseWpRestApi(url: string): boolean {
  return getSiteConfig(url)?.useWpRestApi ?? false;
}

/**
 * Get the custom WP JSON API path for a site, or null if not configured
 */
export function getSiteWpJsonApiPath(url: string): string | null {
  return getSiteConfig(url)?.wpJsonApiPath ?? null;
}

/**
 * Get count of configured sites
 */
export function getSiteCount(): number {
  return Object.keys(SITE_CONFIGS).length;
}

/**
 * Get all configured domains
 */
export function getConfiguredDomains(): string[] {
  return Object.keys(SITE_CONFIGS);
}
