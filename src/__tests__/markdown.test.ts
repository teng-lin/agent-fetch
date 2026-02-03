import { describe, it, expect } from 'vitest';
import { htmlToMarkdown } from '../extract/markdown.js';

describe('htmlToMarkdown', () => {
  it('converts headings to ATX style', () => {
    expect(htmlToMarkdown('<h1>Title</h1>')).toBe('# Title');
    expect(htmlToMarkdown('<h2>Subtitle</h2>')).toBe('## Subtitle');
  });

  it('converts bold and emphasis', () => {
    expect(htmlToMarkdown('<p>Text with <strong>bold</strong></p>')).toBe('Text with **bold**');
    expect(htmlToMarkdown('<p>Text with <em>emphasis</em></p>')).toBe('Text with *emphasis*');
  });

  it('converts links to inline style', () => {
    expect(htmlToMarkdown('<a href="https://x.com">link</a>')).toBe('[link](https://x.com)');
  });

  it('converts unordered lists', () => {
    expect(htmlToMarkdown('<ul><li>a</li><li>b</li></ul>')).toBe('-   a\n-   b');
  });

  it('converts ordered lists', () => {
    expect(htmlToMarkdown('<ol><li>first</li><li>second</li></ol>')).toBe('1.  first\n2.  second');
  });

  it('converts fenced code blocks', () => {
    const result = htmlToMarkdown('<pre><code>const x = 1;</code></pre>');
    expect(result).toContain('```');
    expect(result).toContain('const x = 1;');
  });

  it('returns empty string for empty input', () => {
    expect(htmlToMarkdown('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(htmlToMarkdown('   ')).toBe('');
  });

  it('strips script tags', () => {
    expect(htmlToMarkdown('<script>alert(1)</script>')).toBe('');
  });

  it('converts horizontal rules', () => {
    expect(htmlToMarkdown('<hr>')).toBe('---');
  });

  it('converts GFM tables', () => {
    const html =
      '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>';
    const result = htmlToMarkdown(html);
    expect(result).toContain('| A | B |');
    expect(result).toContain('| 1 | 2 |');
  });

  it('converts GFM strikethrough', () => {
    expect(htmlToMarkdown('<p><del>deleted</del></p>')).toBe('~deleted~');
  });

  it('handles malformed HTML gracefully', () => {
    expect(htmlToMarkdown('<div>Unclosed')).toBe('Unclosed');
    expect(htmlToMarkdown('<div><p>Nested unclosed')).toBe('Nested unclosed');
  });
});
