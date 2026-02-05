/**
 * Site-specific configurations for article extraction
 *
 * Configs are loaded from a single source:
 *   $AGENT_FETCH_SITES_JSON  ->  config/sites.json  ->  empty default
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, '..', '..');

// --- Site config interface ---

export interface SiteConfig {
  /** Custom User-Agent to use for this site */
  userAgent?: string;
  /** Custom Referer header */
  referer?: string;
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
  preferJsonLd: z.boolean().optional(),
  useNextData: z.boolean().optional(),
  nextDataPath: z.string().optional(),
  notes: z.string().optional(),
  useWpRestApi: z.boolean().optional(),
  wpJsonApiPath: z.string().optional(),
});

// --- JSON parsing ---

/**
 * Parse a raw JSON object into validated SiteConfig records.
 *
 * Each field is individually type-checked so that unknown or mistyped fields
 * are silently dropped rather than causing the whole config to fail.
 */
export function parseSiteConfigJson(raw: Record<string, unknown>): Record<string, SiteConfig> {
  const configs: Record<string, SiteConfig> = {};

  for (const [domain, rawConfig] of Object.entries(raw)) {
    const cfg = rawConfig as Record<string, unknown>;
    const config: SiteConfig = {};

    if (typeof cfg.userAgent === 'string') config.userAgent = cfg.userAgent;
    if (typeof cfg.referer === 'string') config.referer = cfg.referer;
    if (typeof cfg.preferJsonLd === 'boolean') config.preferJsonLd = cfg.preferJsonLd;
    if (typeof cfg.useNextData === 'boolean') config.useNextData = cfg.useNextData;
    if (typeof cfg.nextDataPath === 'string') config.nextDataPath = cfg.nextDataPath;
    if (typeof cfg.notes === 'string') config.notes = cfg.notes;
    if (typeof cfg.useWpRestApi === 'boolean') config.useWpRestApi = cfg.useWpRestApi;
    if (typeof cfg.wpJsonApiPath === 'string') config.wpJsonApiPath = cfg.wpJsonApiPath;

    configs[domain] = config;
  }

  return configs;
}

/**
 * Expand ~/ prefix to the user's home directory.
 */
function expandHome(p: string): string {
  return p.startsWith('~/') ? join(os.homedir(), p.slice(2)) : p;
}

/**
 * Resolve the path to sites.json.
 * Uses AGENT_FETCH_SITES_JSON (with ~/ expansion) if set, otherwise bundled config/sites.json.
 */
export function resolveSitesJson(): string | null {
  const envPath = process.env.AGENT_FETCH_SITES_JSON;
  if (envPath) {
    const resolved = expandHome(envPath);
    return existsSync(resolved) ? resolved : null;
  }
  const bundled = join(PACKAGE_ROOT, 'config', 'sites.json');
  return existsSync(bundled) ? bundled : null;
}

function loadSiteConfigs(): Record<string, SiteConfig> {
  const configPath = resolveSitesJson();
  if (!configPath) return {};
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    return parseSiteConfigJson(raw);
  } catch {
    return {};
  }
}

// --- Module-level variable ---

const SITE_CONFIGS: Record<string, SiteConfig> = loadSiteConfigs();

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
 * Get custom JSON path for Next.js __NEXT_DATA__ extraction
 * Path uses dot notation (e.g., "props.pageProps.paragraph.0.description")
 */
export function getSiteNextDataPath(url: string): string | null {
  return getSiteConfig(url)?.nextDataPath ?? null;
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
