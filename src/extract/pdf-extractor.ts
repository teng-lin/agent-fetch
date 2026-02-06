/**
 * PDF text extraction and markdown conversion using pdf-parse
 */
import { PDFParse, VerbosityLevel } from 'pdf-parse';
import { httpRequest } from '../fetch/http-client.js';
import type { FetchResult } from '../fetch/types.js';
import { logger } from '../logger.js';

/**
 * Check if a URL or path looks like a PDF based on extension.
 */
export function isPdfUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname;
    return pathname.toLowerCase().endsWith('.pdf');
  } catch {
    // Not a valid URL, check as a plain path
    return url.toLowerCase().endsWith('.pdf');
  }
}

/**
 * Check if a Content-Type header indicates a PDF.
 */
export function isPdfContentType(contentType: string | undefined): boolean {
  return contentType?.toLowerCase().includes('application/pdf') ?? false;
}

/**
 * Fetch a remote PDF via httpRequest (inherits SSRF protection and size limits).
 * The response body is returned as a string by httpcloak; we convert to Buffer
 * using latin1 encoding which preserves all byte values (0-255) losslessly.
 */
export async function fetchRemotePdfBuffer(
  url: string,
  preset?: string,
  timeout?: number
): Promise<{ buffer: Buffer; statusCode: number } | null> {
  try {
    const response = await httpRequest(url, { Accept: 'application/pdf,*/*' }, preset, timeout);

    if (!response.success || !response.html) {
      logger.debug({ url, statusCode: response.statusCode }, 'Remote PDF fetch failed');
      return null;
    }

    // Convert string body to Buffer using latin1 (preserves byte values 0-255)
    const buffer = Buffer.from(response.html, 'latin1');
    return { buffer, statusCode: response.statusCode };
  } catch (e) {
    logger.debug({ url, error: String(e) }, 'Remote PDF fetch error');
    return null;
  }
}

const PDF_EXTRACTION_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

/**
 * Extract text and metadata from a PDF buffer.
 * Returns a FetchResult with extractionMethod: 'pdf-parse'.
 */
export async function extractPdfFromBuffer(
  buffer: Buffer | Uint8Array,
  source: string,
  statusCode?: number
): Promise<FetchResult> {
  const startTime = Date.now();

  let pdf: PDFParse | undefined;
  try {
    pdf = new PDFParse({ data: new Uint8Array(buffer), verbosity: VerbosityLevel.ERRORS });

    // Must be sequential — concurrent calls cause worker thread DataCloneError
    const textResult = await withTimeout(pdf.getText(), PDF_EXTRACTION_TIMEOUT_MS, 'PDF getText');
    const infoResult = await withTimeout(pdf.getInfo(), PDF_EXTRACTION_TIMEOUT_MS, 'PDF getInfo');

    const text = textResult.text.trim();

    if (!text) {
      return {
        success: false,
        url: source,
        latencyMs: Date.now() - startTime,
        error: 'extraction_failed',
        errorDetails: { type: 'empty_pdf' },
        statusCode: statusCode ?? null,
        rawHtml: null,
        extractionMethod: null,
      };
    }

    // Extract metadata from info
    const info = infoResult.info ?? {};
    const title = typeof info.Title === 'string' ? info.Title : null;
    const byline = typeof info.Author === 'string' ? info.Author : null;

    // Get creation date
    const dateNode = infoResult.getDateNode();
    const creationDate = dateNode.CreationDate ?? dateNode.XmpCreateDate;
    const publishedTime = creationDate instanceof Date ? creationDate.toISOString() : null;

    // Convert to simple markdown
    const markdown = textToMarkdown(text, title);

    return {
      success: true,
      url: source,
      latencyMs: Date.now() - startTime,
      title: title ?? undefined,
      byline: byline ?? undefined,
      content: text,
      textContent: text,
      excerpt: text.length > 200 ? text.slice(0, 200) + '...' : text,
      publishedTime: publishedTime ?? undefined,
      markdown,
      extractedWordCount: text.split(/\s+/).filter(Boolean).length,
      statusCode: statusCode ?? null,
      rawHtml: null,
      extractionMethod: 'pdf-parse',
    };
  } catch (e) {
    logger.error({ source, error: String(e) }, 'PDF extraction failed');
    return {
      success: false,
      url: source,
      latencyMs: Date.now() - startTime,
      error: 'extraction_failed',
      errorDetails: { type: String(e) },
      statusCode: statusCode ?? null,
      rawHtml: null,
      extractionMethod: null,
    };
  } finally {
    if (pdf) {
      await pdf.destroy().catch(() => {});
    }
  }
}

/**
 * Convert plain text from PDF to basic markdown.
 * Adds the title as an H1 heading and preserves paragraph structure.
 */
function textToMarkdown(text: string, title: string | null): string {
  const lines: string[] = [];

  if (title) {
    lines.push(`# ${title}`, '');
  }

  // Normalize line endings and preserve paragraph breaks
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Split into paragraphs on double newlines
  const paragraphs = normalized.split(/\n{2,}/);

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (trimmed) {
      lines.push(trimmed, '');
    }
  }

  return lines.join('\n').trim();
}
