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
export { extractPdfFromBuffer, isPdfUrl, isPdfContentType } from './extract/pdf-extractor.js';
export { getSiteConfig, getSiteUserAgent, getSiteReferer } from './sites/site-config.js';
export type { FetchResult, ValidationResult, ValidationError } from './fetch/types.js';
export type { HttpFetchOptions } from './fetch/http-fetch.js';
export type { HttpResponse } from './fetch/http-client.js';
export type { ExtractionResult, MediaElement, SelectorOptions } from './extract/types.js';
export { crawl } from './crawl/crawler.js';
export type { CrawlOptions, CrawlResult, CrawlSummary } from './crawl/types.js';
