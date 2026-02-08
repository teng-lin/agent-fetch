/**
 * agent-fetch - Full-content web fetcher and article extractor for AI agents
 */
export { httpFetch, resolvePreset } from './fetch/index.js';
export { closeAllSessions } from './fetch/http-client.js';
export {
  extractFromHtml,
  htmlToMarkdown,
  extractPdfFromBuffer,
  isPdfUrl,
  isPdfContentType,
} from './extract/index.js';
export type {
  FetchResult,
  FetchExtractionMethod,
  ValidationResult,
  ValidationError,
} from './fetch/types.js';
export type { HttpFetchOptions } from './fetch/http-fetch.js';
export type { HttpResponse } from './fetch/http-client.js';
export type {
  ExtractionResult,
  ExtractionMethod,
  MediaElement,
  SelectorOptions,
} from './extract/index.js';
export { crawl } from './crawl/index.js';
export type { CrawlOptions, CrawlResult, CrawlSummary } from './crawl/index.js';
