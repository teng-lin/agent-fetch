/**
 * agent-fetch - Full-content web fetcher and article extractor for AI agents
 */
export { httpFetch, resolvePreset } from './fetch/index.js';
export { httpRequest, httpPost, getSession, closeAllSessions } from './fetch/http-client.js';
export { quickValidate } from './fetch/content-validator.js';
export {
  extractFromHtml,
  detectWpRestApi,
  extractNextBuildId,
} from './extract/content-extractors.js';
export { htmlToMarkdown } from './extract/markdown.js';
export { getSiteConfig, getSiteUserAgent, getSiteReferer } from './sites/site-config.js';
export type { FetchResult, ValidationResult, ValidationError } from './fetch/types.js';
export type { HttpFetchOptions } from './fetch/http-fetch.js';
export type { HttpResponse } from './fetch/http-client.js';
export type { ExtractionResult, MediaElement } from './extract/types.js';
