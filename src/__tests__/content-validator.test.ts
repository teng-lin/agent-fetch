import { describe, it, expect } from 'vitest';
import { quickValidate } from '../fetch/content-validator.js';

describe('quickValidate', () => {
  it('passes with valid article HTML', () => {
    const html = `
      <html>
        <body>
          <article>
            ${'Lorem ipsum dolor sit amet. '.repeat(200)}
          </article>
        </body>
      </html>
    `;
    const result = quickValidate(html, 200, 'text/html');
    expect(result.valid).toBe(true);
  });

  it('fails with HTTP error status', () => {
    const result = quickValidate('<html></html>', 404, 'text/html');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('http_status_error');
  });

  it('fails with wrong content type', () => {
    const result = quickValidate('{"error": "not found"}', 200, 'application/json');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('wrong_content_type');
  });

  it('accepts application/xhtml+xml content type', () => {
    const xhtmlBody = `
      <html xmlns="http://www.w3.org/1999/xhtml">
        <body>
          ${'Lorem ipsum dolor sit amet. '.repeat(200)}
        </body>
      </html>
    `;
    expect(quickValidate(xhtmlBody, 200, 'application/xhtml+xml').valid).toBe(true);
    expect(quickValidate(xhtmlBody, 200, 'application/xhtml+xml; charset=utf-8').valid).toBe(true);
  });

  it('fails with body too small', () => {
    const html = '<html><body>Short</body></html>';
    const result = quickValidate(html, 200, 'text/html');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('body_too_small');
    expect(result.errorDetails?.bodySize).toBeLessThan(5 * 1024);
  });

  it('fails with low word count', () => {
    // Generate enough bytes (>5KB) but low word count (<100 words)
    // Use long non-word strings to pad the size
    const padding = 'x'.repeat(5200); // Ensure >5KB
    const html = '<html><body>' + padding + ' Short article.</body></html>';
    const result = quickValidate(html, 200, 'text/html');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('insufficient_content');
  });

  it('handles malformed nested script tags without hanging', () => {
    // Pathological input that causes catastrophic backtracking with
    // the old regex: /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi
    const nested = '<script>' + '<script>'.repeat(50) + '</script>';
    const content = 'Lorem ipsum dolor sit amet. '.repeat(200);
    const html = `<html><body>${nested}${content}</body></html>`;
    const start = performance.now();
    const result = quickValidate(html, 200, 'text/html');
    const elapsed = performance.now() - start;
    expect(result.valid).toBe(true);
    expect(elapsed).toBeLessThan(100);
  });

  it('accepts CJK text with 100+ characters (CJK-aware word counting)', () => {
    // Each CJK character counts as one word. 270 CJK chars > MIN_WORD_COUNT (100).
    const cjkChars = '这是一个关于人工智能的文章内容。'.repeat(30); // 270 CJK chars
    const padding = '<div>' + 'x'.repeat(5200) + '</div>'; // Ensure >5KB
    const html = `<html><body>${padding}<article>${cjkChars}</article></body></html>`;
    const result = quickValidate(html, 200, 'text/html');
    expect(result.valid).toBe(true);
  });

  it('accepts content-type as array', () => {
    const html = `<html><body>${'Lorem ipsum dolor sit amet. '.repeat(200)}</body></html>`;
    const result = quickValidate(html, 200, ['text/html', 'charset=utf-8']);
    expect(result.valid).toBe(true);
  });

  it('passes when content-type is undefined', () => {
    const html = `<html><body>${'Lorem ipsum dolor sit amet. '.repeat(200)}</body></html>`;
    const result = quickValidate(html, 200, undefined);
    expect(result.valid).toBe(true);
  });

  it('passes when content-type array has empty first element', () => {
    const html = `<html><body>${'Lorem ipsum dolor sit amet. '.repeat(200)}</body></html>`;
    // Empty string in array — ctValue is falsy, so content-type check is skipped
    const result = quickValidate(html, 200, ['', 'text/html']);
    expect(result.valid).toBe(true);
  });

  it('strips numeric HTML entities from word count', () => {
    // Numeric entities (&#123;, &#x7b;) should not inflate the word count.
    // Build a page where all "words" are just numeric entities — should fail word count.
    const entities = '&#60; &#x3C; &#123; &#x7b; '.repeat(100);
    const padding = 'x'.repeat(5200);
    const html = `<html><body>${padding}${entities}</body></html>`;
    const result = quickValidate(html, 200, 'text/html');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('insufficient_content');
  });

  describe('CJK content validation', () => {
    // Helper: wrap body content in HTML with enough byte-size to pass the 5KB check
    function wrapHtml(body: string): string {
      const padding = '<div>' + 'x'.repeat(5200) + '</div>';
      return '<html><head><title>Test</title></head><body>' + padding + body + '</body></html>';
    }

    it('accepts Chinese article with 100+ characters', () => {
      const chineseText = '这是一篇关于人工智能技术发展的文章内容'.repeat(8);
      const html = wrapHtml(`<article><p>${chineseText}</p></article>`);
      const result = quickValidate(html, 200);
      expect(result.valid).toBe(true);
    });

    it('rejects Chinese article with fewer than 100 characters', () => {
      const chineseText = '这是一篇关于人工智能技术发展的文章内容很短';
      const html = wrapHtml(`<article><p>${chineseText}</p></article>`);
      const result = quickValidate(html, 200);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('insufficient_content');
    });

    it('accepts Japanese article with 100+ characters', () => {
      const japaneseText = 'これは人工知能技術の発展に関する記事の内容です'.repeat(8);
      const html = wrapHtml(`<article><p>${japaneseText}</p></article>`);
      const result = quickValidate(html, 200);
      expect(result.valid).toBe(true);
    });

    it('accepts Korean article with 100+ characters', () => {
      const koreanText = '인공지능기술의발전에관한기사의내용입니다여기'.repeat(8);
      const html = wrapHtml(`<article><p>${koreanText}</p></article>`);
      const result = quickValidate(html, 200);
      expect(result.valid).toBe(true);
    });

    it('accepts mixed CJK and English content', () => {
      const mixed = ('Hello world ' + '你好世界测试内容 ').repeat(15);
      const html = wrapHtml(`<article><p>${mixed}</p></article>`);
      const result = quickValidate(html, 200);
      expect(result.valid).toBe(true);
    });
  });
});
