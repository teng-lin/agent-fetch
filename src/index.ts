/**
 * lynxget - Stealth web fetcher and article extractor for AI agents
 */
export { httpFetch, resolvePreset } from './fetch/index.js';
export { httpRequest, getSession, closeAllSessions } from './fetch/http-client.js';
export { quickValidate } from './fetch/content-validator.js';
export {
  fetchFromWayback,
  fetchFromArchiveIs,
  fetchFromArchives,
} from './fetch/archive-fallback.js';
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
export type { HttpFetchOptions } from './fetch/http-fetch.js';
export type { HttpResponse } from './fetch/http-client.js';
export type { ArchiveFetchResult } from './fetch/archive-fallback.js';
export type { AntibotDetection, DetectionCategory, SuggestedAction } from './antibot/detector.js';
export type { ExtractionResult } from './extract/types.js';
