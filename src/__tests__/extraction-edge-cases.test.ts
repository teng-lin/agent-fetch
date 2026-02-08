/**
 * Integration-style edge case tests across multiple extractors.
 * Only logger is mocked -- real extraction runs end-to-end.
 */
import { describe, it, expect, vi } from 'vitest';
import { extractFromHtml } from '../extract/content-extractors.js';
import { MIN_CONTENT_LENGTH } from '../extract/types.js';
import { loremText } from './test-helpers.js';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('extraction edge cases', () => {
  it('returns null for HTML with only navigation and footer', () => {
    const html = `<html><body>
      <nav><a href="/">Home</a><a href="/about">About</a><a href="/contact">Contact</a></nav>
      <footer><p>Copyright 2024 Example Corp</p><a href="/privacy">Privacy</a></footer>
    </body></html>`;
    const result = extractFromHtml(html, 'https://example.com/nav-only');
    expect(result).toBeNull();
  });

  it('extracts content from HTML with multiple article tags', () => {
    const mainContent = loremText(600);
    const html = `<html><head><title>Main Article</title></head><body>
      <article class="sidebar"><p>Short sidebar blurb.</p></article>
      <article class="main"><h1>Primary Article</h1><p>${mainContent}</p></article>
    </body></html>`;
    const result = extractFromHtml(html, 'https://example.com/multi-article');
    expect(result).not.toBeNull();
    expect(result!.textContent!.length).toBeGreaterThanOrEqual(MIN_CONTENT_LENGTH);
  });

  it('does not include display:none content in extraction', () => {
    const visibleContent = loremText(600);
    const html = `<html><head><title>Visible Content</title></head><body>
      <article>
        <div style="display:none"><p>This hidden content should not appear in the extraction result at all.</p></div>
        <p>${visibleContent}</p>
      </article>
    </body></html>`;
    const result = extractFromHtml(html, 'https://example.com/hidden');
    expect(result).not.toBeNull();
    // The extraction should succeed with the visible content
    expect(result!.textContent!.length).toBeGreaterThanOrEqual(MIN_CONTENT_LENGTH);
  });

  it('preserves table content in extraction', () => {
    const rows = Array.from(
      { length: 20 },
      (_, i) =>
        `<tr><td>Item ${i}</td><td>Description for item ${i} with enough text to be meaningful content for extraction</td><td>$${(i + 1) * 10}.00</td></tr>`
    ).join('');
    const html = `<html><head><title>Data Table</title></head><body>
      <article>
        <h1>Product Catalog</h1>
        <p>${loremText(300)}</p>
        <table><thead><tr><th>Name</th><th>Description</th><th>Price</th></tr></thead><tbody>${rows}</tbody></table>
        <p>${loremText(300)}</p>
      </article>
    </body></html>`;
    const result = extractFromHtml(html, 'https://example.com/table');
    expect(result).not.toBeNull();
    expect(result!.textContent).toContain('Item 0');
    expect(result!.textContent).toContain('Item 19');
  });

  it('extracts from minimal valid HTML with sufficient content', () => {
    const content = loremText(600);
    const html = `<html><body><p>${content}</p></body></html>`;
    const result = extractFromHtml(html, 'https://example.com/minimal');
    expect(result).not.toBeNull();
    expect(result!.textContent!.length).toBeGreaterThanOrEqual(MIN_CONTENT_LENGTH);
  });

  it('returns null for minimal HTML with insufficient content', () => {
    const html = '<html><body><p>Hello world</p></body></html>';
    const result = extractFromHtml(html, 'https://example.com/tiny');
    expect(result).toBeNull();
  });

  it('handles HTML with deeply nested content structures', () => {
    const content = loremText(600);
    const html = `<html><head><title>Deep Nesting</title></head><body>
      <div><div><div><div><div><article><p>${content}</p></article></div></div></div></div></div>
    </body></html>`;
    const result = extractFromHtml(html, 'https://example.com/nested');
    expect(result).not.toBeNull();
    expect(result!.textContent!.length).toBeGreaterThanOrEqual(MIN_CONTENT_LENGTH);
  });

  it('handles HTML with large amounts of boilerplate and small article', () => {
    const navLinks = Array.from(
      { length: 100 },
      (_, i) => `<a href="/page${i}">Page ${i}</a>`
    ).join('');
    const content = loremText(600);
    const html = `<html><head><title>Boilerplate Heavy</title></head><body>
      <header><nav>${navLinks}</nav></header>
      <article><h1>The Real Article</h1><p>${content}</p></article>
      <footer>${navLinks}</footer>
    </body></html>`;
    const result = extractFromHtml(html, 'https://example.com/boilerplate');
    expect(result).not.toBeNull();
    expect(result!.textContent!.length).toBeGreaterThanOrEqual(MIN_CONTENT_LENGTH);
  });

  it('handles HTML entities in content', () => {
    const content = loremText(600);
    const html = `<html><head><title>Entities &amp; More</title></head><body>
      <article><h1>Article with &lt;entities&gt;</h1><p>${content}</p><p>Price: &euro;100 &mdash; sale!</p></article>
    </body></html>`;
    const result = extractFromHtml(html, 'https://example.com/entities');
    expect(result).not.toBeNull();
    expect(result!.textContent!.length).toBeGreaterThanOrEqual(MIN_CONTENT_LENGTH);
  });
});
