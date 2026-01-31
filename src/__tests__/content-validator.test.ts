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
});
