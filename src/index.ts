/**
 * lynxget - Stealth fetch with Chrome TLS fingerprinting, smart content extraction,
 * and bot detection awareness.
 *
 * @module lynxget
 */
export { httpFetch } from './fetch/index.js';
export { httpRequest, getSession, closeAllSessions } from './fetch/http-client.js';
export { quickValidate } from './fetch/content-validator.js';
export {
  detectFromResponse,
  detectFromHtml,
  mergeDetections,
  detectPrimaryAntibot,
  formatDetections,
  filterAntibotOnly,
  filterCaptchaOnly,
  filterFingerprintOnly,
  filterBotDetectionOnly,
  hasCaptcha,
  hasAntibot,
  hasFingerprinting,
  hasBotDetection,
  getWindowObjectChecks,
  detectFromWindowResults,
} from './antibot/detector.js';
export { extractFromHtml } from './extract/content-extractors.js';
export { getSiteConfig, getSiteUserAgent, getSiteReferer } from './sites/site-config.js';
export type { FetchResult, ValidationResult, ValidationError } from './fetch/types.js';
export type { HttpResponse } from './fetch/http-client.js';
export type { AntibotDetection, DetectionCategory, SuggestedAction } from './antibot/detector.js';
export type { ExtractionResult } from './extract/types.js';
export type { SiteConfig } from './sites/site-config.js';
