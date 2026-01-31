/**
 * Minimal default site configurations
 *
 * These are basic examples to demonstrate the config format.
 * For production use, load site-specific configs via the plugin system.
 *
 * See docs/PLUGIN-SYSTEM.md for how to add your own site configurations.
 */
import type { SiteConfig } from './site-config.js';

/**
 * Minimal default configurations - just enough to show the format
 *
 * IMPORTANT: This core does NOT include site-specific bypass configurations.
 * Users must provide their own configs via:
 * - Plugin system (config/plugins.json)
 * - User config file (USER_SITE_CONFIG env var)
 */
export const MINIMAL_DEFAULTS: Record<string, SiteConfig> = {
  // Example: Public domain site with no restrictions
  'github.com': {
    // No special config needed - works with default browser
  },

  // Example: Site that works better with bot UA
  'wikipedia.org': {
    userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  },

  // Example: Site requiring archive fallback
  'example.com': {
    usesArchiveFallback: true,
  },

  // Example: Site with blocked resources
  'test.example.org': {
    blockPatterns: [/\.example\.org\/analytics\.js/, /\.example\.org\/ads\//],
  },

  // Example: Site preferring JSON-LD extraction
  'demo.example.net': {
    preferJsonLd: true,
  },
};
