import { describe, it, expect } from 'vitest';
import { extractMedia } from '../extract/media-extractor.js';

describe('extractMedia', () => {
  it('extracts images in document order', () => {
    const html = `
      <div>
        <img src="/img1.jpg" alt="First">
        <p>Some text</p>
        <img src="/img2.jpg" alt="Second">
      </div>
    `;
    const media = extractMedia(html, 'https://example.com');
    expect(media).toEqual([
      { type: 'image', src: 'https://example.com/img1.jpg', alt: 'First' },
      { type: 'image', src: 'https://example.com/img2.jpg', alt: 'Second' },
    ]);
  });

  it('resolves relative URLs to absolute', () => {
    const html = `<img src="../images/photo.png" alt="Photo">`;
    const media = extractMedia(html, 'https://example.com/articles/test');
    expect(media[0].src).toBe('https://example.com/images/photo.png');
  });

  it('deduplicates by URL', () => {
    const html = `
      <img src="/img.jpg" alt="First">
      <a href="/page"><img src="/img.jpg" alt="Second"></a>
    `;
    const media = extractMedia(html, 'https://example.com');
    expect(media).toHaveLength(1);
    expect(media[0]).toEqual({ type: 'image', src: 'https://example.com/img.jpg', alt: 'First' });
  });

  it('returns empty array for content with no media', () => {
    const html = `<p>Just some text content</p>`;
    const media = extractMedia(html, 'https://example.com');
    expect(media).toEqual([]);
  });

  it('returns empty array on parse error', () => {
    const media = extractMedia('', 'https://example.com');
    expect(media).toEqual([]);
  });
});

describe('picture element handling', () => {
  it('extracts best source from picture with srcset using width descriptors', () => {
    const html = `
      <picture>
        <source srcset="/small.webp 400w, /large.webp 800w" type="image/webp">
        <img src="/fallback.jpg" alt="Test">
      </picture>
    `;
    const media = extractMedia(html, 'https://example.com');
    expect(media).toHaveLength(1);
    expect(media[0].src).toBe('https://example.com/large.webp');
    expect(media[0].alt).toBe('Test');
  });

  it('extracts best source from srcset using density descriptors', () => {
    const html = `
      <picture>
        <source srcset="/normal.webp 1x, /retina.webp 2x" type="image/webp">
        <img src="/fallback.jpg" alt="Test">
      </picture>
    `;
    const media = extractMedia(html, 'https://example.com');
    expect(media[0].src).toBe('https://example.com/retina.webp');
  });

  it('prefers compatible image types over avif', () => {
    const html = `
      <picture>
        <source srcset="/image.avif" type="image/avif">
        <source srcset="/image.webp" type="image/webp">
        <img src="/fallback.jpg" alt="Test">
      </picture>
    `;
    const media = extractMedia(html, 'https://example.com');
    expect(media[0].src).toBe('https://example.com/image.webp');
  });

  it('falls back to img src when no compatible source', () => {
    const html = `
      <picture>
        <source srcset="/image.avif" type="image/avif">
        <img src="/fallback.jpg" alt="Test">
      </picture>
    `;
    const media = extractMedia(html, 'https://example.com');
    expect(media[0].src).toBe('https://example.com/fallback.jpg');
  });

  it('picks largest from standalone img srcset', () => {
    const html = `<img srcset="/small.jpg 400w, /large.jpg 800w, /medium.jpg 600w" src="/fallback.jpg">`;
    const media = extractMedia(html, 'https://example.com');
    expect(media[0].src).toBe('https://example.com/large.jpg');
  });
});

describe('document link extraction', () => {
  it('extracts PDF links', () => {
    const html = `<a href="/report.pdf">Download Report</a>`;
    const media = extractMedia(html, 'https://example.com');
    expect(media).toEqual([
      {
        type: 'document',
        href: 'https://example.com/report.pdf',
        text: 'Download Report',
        extension: '.pdf',
      },
    ]);
  });

  it('extracts Office document links', () => {
    const html = `
      <a href="/data.xlsx">Spreadsheet</a>
      <a href="/presentation.pptx">Slides</a>
      <a href="/document.docx">Word Doc</a>
    `;
    const media = extractMedia(html, 'https://example.com');
    expect(media).toHaveLength(3);
    expect(media[0].extension).toBe('.xlsx');
    expect(media[1].extension).toBe('.pptx');
    expect(media[2].extension).toBe('.docx');
  });

  it('extracts data file links', () => {
    const html = `
      <a href="/data.csv">CSV Data</a>
      <a href="/config.json">JSON Config</a>
    `;
    const media = extractMedia(html, 'https://example.com');
    expect(media).toHaveLength(2);
    expect(media[0].extension).toBe('.csv');
    expect(media[1].extension).toBe('.json');
  });

  it('ignores regular HTML links', () => {
    const html = `<a href="/about.html">About Us</a>`;
    const media = extractMedia(html, 'https://example.com');
    expect(media).toEqual([]);
  });

  it('handles query strings in document URLs', () => {
    const html = `<a href="/report.pdf?v=2">Report</a>`;
    const media = extractMedia(html, 'https://example.com');
    expect(media[0].extension).toBe('.pdf');
  });

  it('preserves document order with mixed media', () => {
    const html = `
      <img src="/photo.jpg" alt="Photo">
      <a href="/report.pdf">Report</a>
      <img src="/chart.png" alt="Chart">
    `;
    const media = extractMedia(html, 'https://example.com');
    expect(media).toHaveLength(3);
    expect(media[0].type).toBe('image');
    expect(media[1].type).toBe('document');
    expect(media[2].type).toBe('image');
  });
});

describe('video extraction', () => {
  it('extracts video element src', () => {
    const html = `<video src="/video.mp4"></video>`;
    const media = extractMedia(html, 'https://example.com');
    expect(media).toEqual([{ type: 'video', src: 'https://example.com/video.mp4' }]);
  });

  it('extracts YouTube embed URL', () => {
    const html = `<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>`;
    const media = extractMedia(html, 'https://example.com');
    expect(media).toEqual([
      { type: 'video', src: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', provider: 'youtube' },
    ]);
  });

  it('extracts YouTube short URL embed', () => {
    const html = `<iframe src="https://youtu.be/dQw4w9WgXcQ"></iframe>`;
    const media = extractMedia(html, 'https://example.com');
    expect(media).toEqual([
      { type: 'video', src: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', provider: 'youtube' },
    ]);
  });

  it('extracts Vimeo embed URL', () => {
    const html = `<iframe src="https://player.vimeo.com/video/123456789"></iframe>`;
    const media = extractMedia(html, 'https://example.com');
    expect(media).toEqual([
      { type: 'video', src: 'https://vimeo.com/123456789', provider: 'vimeo' },
    ]);
  });

  it('ignores non-video iframes', () => {
    const html = `<iframe src="https://example.com/widget"></iframe>`;
    const media = extractMedia(html, 'https://example.com');
    expect(media).toEqual([]);
  });
});

describe('audio extraction', () => {
  it('extracts audio element src', () => {
    const html = `<audio src="/podcast.mp3"></audio>`;
    const media = extractMedia(html, 'https://example.com');
    expect(media).toEqual([{ type: 'audio', src: 'https://example.com/podcast.mp3' }]);
  });
});
