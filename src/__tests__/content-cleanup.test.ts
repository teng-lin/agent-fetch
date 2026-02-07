import { describe, it, expect } from 'vitest';
import { cleanExtractedHtml } from '../extract/content-cleanup.js';

describe('cleanExtractedHtml', () => {
  it('removes figcaption elements but preserves figure and img', () => {
    const input =
      '<figure><img src="x.jpg" alt="Photo"><figcaption>Credit: Photo by Jane</figcaption></figure><p>Article text here.</p>';
    const result = cleanExtractedHtml(input);
    expect(result.html).not.toContain('figcaption');
    expect(result.html).not.toContain('Photo by Jane');
    expect(result.html).toContain('<figure>');
    expect(result.html).toContain('<img src="x.jpg"');
    expect(result.html).toContain('Article text here.');
  });

  it('removes itemprop=caption elements', () => {
    const input = '<div itemprop="caption">Photo credit: J. Smith</div><p>Story content.</p>';
    const result = cleanExtractedHtml(input);
    expect(result.html).not.toContain('Photo credit');
    expect(result.html).toContain('Story content.');
  });

  it('removes non-article UI text', () => {
    const input =
      '<p>Thank you for your patience while we verify access.</p><p>The real article content goes here.</p>';
    const result = cleanExtractedHtml(input);
    expect(result.html).not.toContain('Thank you for your patience');
    expect(result.html).toContain('The real article content goes here.');
  });

  it('preserves article text over 200 chars mentioning subscribe', () => {
    const longText = 'Subscribe for all ' + 'x'.repeat(200);
    const input = `<p>${longText}</p>`;
    const result = cleanExtractedHtml(input);
    expect(result.html).toContain(longText);
  });

  it('removes standalone "Advertisement" text', () => {
    const input = '<p>Advertisement</p><p>Article paragraph.</p>';
    const result = cleanExtractedHtml(input);
    expect(result.html).not.toContain('Advertisement');
    expect(result.html).toContain('Article paragraph.');
  });

  it('deduplicates long paragraphs keeping the later occurrence', () => {
    const longPara =
      'This is a sufficiently long paragraph that should be deduplicated when it appears more than once in the document content.';
    const input = `<div><p>${longPara}</p></div><article><p>${longPara}</p></article>`;
    const result = cleanExtractedHtml(input);
    // The first (preview) occurrence should be removed; the second (body) kept
    expect(result.html).toContain(longPara);
    const count = result.html.split(longPara).length - 1;
    expect(count).toBe(1);
  });

  it('does not deduplicate short paragraphs', () => {
    const input = '<p>Read more</p><p>Read more</p>';
    const result = cleanExtractedHtml(input);
    const count = result.html.split('Read more').length - 1;
    expect(count).toBe(2);
  });

  it('handles empty input', () => {
    const result = cleanExtractedHtml('');
    expect(result.html).toBe('');
    expect(result.textContent).toBe('');
  });

  it('cleans HTML with all noise types combined', () => {
    const longPara =
      'Scientists discovered a new species of deep-sea fish in the Pacific Ocean, marking the first such finding in over a decade of marine exploration.';
    const input = [
      // Preview duplicate
      `<p>${longPara}</p>`,
      // Figcaption noise
      '<figure><img src="fish.jpg" alt="Fish"><figcaption>Credit: Photo Agency</figcaption></figure>',
      // Boilerplate
      '<p>Already a subscriber? Log in.</p>',
      '<p>Skip Advertisement</p>',
      // Article body with the real paragraph
      `<article><p>${longPara}</p><p>The species was found at a depth of 8,000 meters.</p></article>`,
    ].join('');

    const result = cleanExtractedHtml(input);

    // Captions removed
    expect(result.html).not.toContain('figcaption');
    expect(result.html).not.toContain('Credit: Photo Agency');
    // Figure preserved
    expect(result.html).toContain('<figure>');

    // Boilerplate removed
    expect(result.html).not.toContain('Already a subscriber');
    expect(result.html).not.toContain('Skip Advertisement');

    // Duplicate paragraph deduplicated to one
    const paraCount = result.html.split(longPara).length - 1;
    expect(paraCount).toBe(1);

    // Real content preserved
    expect(result.html).toContain('depth of 8,000 meters');
    expect(result.textContent).toContain('depth of 8,000 meters');
  });
});
