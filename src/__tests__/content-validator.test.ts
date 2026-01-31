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

  it('fails with challenge marker', () => {
    const html = `
      <html><body>
        <div class="cf-turnstile"></div>
        ${'Lorem ipsum '.repeat(500)}
      </body></html>
    `;
    const result = quickValidate(html, 200, 'text/html');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('challenge_detected');
    expect(result.errorDetails?.challengeType).toBe('cloudflare_turnstile');
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

  it('fails with access gate keywords when word count is low', () => {
    // Need >5KB body, >=100 words but <200 words to trigger access gate check
    // Use HTML comments for padding (stripped during text extraction)
    const padding = `<!-- ${'x'.repeat(5000)} -->`;
    const html = `
      <html><body>
        ${padding}
        ${'Lorem ipsum '.repeat(60)}
        Subscribe now to read more.
      </body></html>
    `;
    const result = quickValidate(html, 200, 'text/html');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('access_restricted');
  });

  it('passes with access gate keywords when word count is high', () => {
    const html = `
      <html><body>
        <article>${'Lorem ipsum dolor sit amet. '.repeat(250)}</article>
        <footer>Already a subscriber? Log in here.</footer>
      </body></html>
    `;
    const result = quickValidate(html, 200, 'text/html');
    expect(result.valid).toBe(true);
  });
});
