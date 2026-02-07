import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isPdfUrl, isPdfContentType, extractPdfFromBuffer } from '../extract/pdf-extractor.js';
import { fetchRemotePdfBuffer } from '../fetch/pdf-fetch.js';

vi.mock('../fetch/http-client.js', () => ({
  httpRequest: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { httpRequest } from '../fetch/http-client.js';

describe('isPdfUrl', () => {
  it('detects .pdf extension in URL', () => {
    expect(isPdfUrl('https://example.com/report.pdf')).toBe(true);
  });

  it('detects .PDF extension (case-insensitive)', () => {
    expect(isPdfUrl('https://example.com/report.PDF')).toBe(true);
  });

  it('detects .pdf in URL with query params', () => {
    expect(isPdfUrl('https://example.com/report.pdf?download=1')).toBe(true);
  });

  it('rejects non-PDF URLs', () => {
    expect(isPdfUrl('https://example.com/article')).toBe(false);
    expect(isPdfUrl('https://example.com/page.html')).toBe(false);
  });

  it('detects local file path with .pdf extension', () => {
    expect(isPdfUrl('/path/to/document.pdf')).toBe(true);
    expect(isPdfUrl('./report.pdf')).toBe(true);
  });

  it('rejects non-PDF local paths', () => {
    expect(isPdfUrl('/path/to/document.txt')).toBe(false);
  });
});

describe('isPdfContentType', () => {
  it('detects application/pdf', () => {
    expect(isPdfContentType('application/pdf')).toBe(true);
  });

  it('detects application/pdf with charset', () => {
    expect(isPdfContentType('application/pdf; charset=utf-8')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isPdfContentType('Application/PDF')).toBe(true);
  });

  it('rejects non-PDF content types', () => {
    expect(isPdfContentType('text/html')).toBe(false);
    expect(isPdfContentType('application/json')).toBe(false);
  });

  it('handles undefined', () => {
    expect(isPdfContentType(undefined)).toBe(false);
  });
});

describe('extractPdfFromBuffer', () => {
  // Minimal valid PDF (contains text "Hello World")
  function createMinimalPdf(): Buffer {
    const pdf = [
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
      '4 0 obj<</Length 44>>stream',
      'BT /F1 12 Tf 100 700 Td (Hello World) Tj ET',
      'endstream endobj',
      '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
      'xref',
      '0 6',
      '0000000000 65535 f ',
      '0000000009 00000 n ',
      '0000000058 00000 n ',
      '0000000115 00000 n ',
      '0000000266 00000 n ',
      '0000000360 00000 n ',
      'trailer<</Size 6/Root 1 0 R>>',
      'startxref',
      '431',
      '%%EOF',
    ].join('\n');
    return Buffer.from(pdf);
  }

  it('extracts text from a valid PDF buffer', async () => {
    const buffer = createMinimalPdf();
    const result = await extractPdfFromBuffer(buffer, '/test/doc.pdf');

    expect(result.success).toBe(true);
    expect(result.extractionMethod).toBe('pdf-parse');
    expect(result.textContent).toContain('Hello World');
    expect(result.markdown).toContain('Hello World');
    expect(result.url).toBe('/test/doc.pdf');
  });

  it('returns failure for invalid PDF data', async () => {
    const buffer = Buffer.from('not a pdf file');
    const result = await extractPdfFromBuffer(buffer, '/test/invalid.pdf');

    expect(result.success).toBe(false);
    expect(result.error).toBe('extraction_failed');
  });

  it('passes through statusCode', async () => {
    const buffer = createMinimalPdf();
    const result = await extractPdfFromBuffer(buffer, 'https://example.com/doc.pdf', 200);

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
  });

  it('includes extractedWordCount', async () => {
    const buffer = createMinimalPdf();
    const result = await extractPdfFromBuffer(buffer, '/test/doc.pdf');

    expect(result.success).toBe(true);
    expect(result.extractedWordCount).toBeGreaterThan(0);
  });
});

describe('fetchRemotePdfBuffer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns buffer on successful HTTP response', async () => {
    const pdfBody = '%PDF-1.4 fake content';
    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: pdfBody,
      headers: { 'content-type': 'application/pdf' },
      cookies: [],
    });

    const result = await fetchRemotePdfBuffer('https://example.com/doc.pdf');

    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(200);
    expect(result!.buffer).toBeInstanceOf(Buffer);
    expect(httpRequest).toHaveBeenCalledWith(
      'https://example.com/doc.pdf',
      { Accept: 'application/pdf,*/*' },
      undefined,
      undefined,
      undefined,
      undefined
    );
  });

  it('passes preset and timeout to httpRequest', async () => {
    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: '%PDF',
      headers: {},
      cookies: [],
    });

    await fetchRemotePdfBuffer('https://example.com/doc.pdf', 'chrome-143', 5000);

    expect(httpRequest).toHaveBeenCalledWith(
      'https://example.com/doc.pdf',
      { Accept: 'application/pdf,*/*' },
      'chrome-143',
      5000,
      undefined,
      undefined
    );
  });

  it('returns null on HTTP failure', async () => {
    vi.mocked(httpRequest).mockResolvedValue({
      success: false,
      statusCode: 404,
      html: '',
      headers: {},
      cookies: [],
    });

    const result = await fetchRemotePdfBuffer('https://example.com/missing.pdf');

    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    vi.mocked(httpRequest).mockRejectedValue(new Error('Connection refused'));

    const result = await fetchRemotePdfBuffer('https://example.com/doc.pdf');

    expect(result).toBeNull();
  });
});
