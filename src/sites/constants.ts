/**
 * Site configuration constants
 * Shared constants used across all site config sources
 */

/** Bot User-Agents */
export const USER_AGENTS = {
  GOOGLEBOT: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  BINGBOT: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  FACEBOOKBOT: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  OUTBRAIN: 'Mozilla/5.0 (Java) outbrain',
  LAMARR:
    'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.103 Mobile Safari/537.36 Lamarr',
  GOOGLE_INSPECTION: 'Mozilla/5.0 (compatible; Google-InspectionTool/1.0)',
  // Mobile UA for sites with strong bot detection (avoids HTTP/2 protocol errors)
  MOBILE_CHROME:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36',
} as const;

/** Common referer headers */
export const REFERERS = {
  GOOGLE: 'https://www.google.com/',
  FACEBOOK: 'https://www.facebook.com/',
  TWITTER: 'https://twitter.com/',
  DRUDGE: 'https://www.drudgereport.com/',
} as const;

/** Common access control script patterns that can be reused across sites */
export const BLOCK_PATTERNS = {
  // Major access gate providers
  PIANO: /\.piano\.io\//,
  TINYPASS: /\.tinypass\.com\//,
  CXENSE: /\.cxense\.com\//,
  ZEPHR: /\/zephr\//,
  SOPHI: /\.sophi\.io\//,

  // AMP access scripts
  AMP_ACCESS: /\.ampproject\.org\/v0\/amp-access/,
  AMP_SUBSCRIPTIONS: /\.ampproject\.org\/v0\/amp-subscriptions/,
} as const;

/**
 * Convert blockPatterns from JSON (strings) to RegExp instances.
 * Used by both plugin-loader and user config loading.
 */
export function convertBlockPatterns(patterns: (string | RegExp)[]): RegExp[] {
  return patterns.map((pattern) => (typeof pattern === 'string' ? new RegExp(pattern) : pattern));
}
