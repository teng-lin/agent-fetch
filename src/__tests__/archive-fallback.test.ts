import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchFromWayback,
  fetchFromArchiveIs,
  fetchFromArchives,
} from '../fetch/archive-fallback.js';

vi.mock('../fetch/http-client.js', () => ({
  httpRequest: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { httpRequest } from '../fetch/http-client.js';

describe('fetchFromWayback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns cleaned HTML on success', async () => {
    const html =
      '<html><body><!-- BEGIN WAYBACK TOOLBAR INSERT --><div>toolbar</div><!-- END WAYBACK TOOLBAR INSERT --><p>Article content</p></body></html>';
    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html,
      headers: {},
      cookies: [],
    });

    const result = await fetchFromWayback('https://example.com/article');

    expect(result.success).toBe(true);
    expect(result.html).not.toContain('WAYBACK TOOLBAR');
    expect(result.html).toContain('Article content');
    expect(result.archiveUrl).toBe('https://web.archive.org/web/2if_/https://example.com/article');
    expect(httpRequest).toHaveBeenCalledWith(
      'https://web.archive.org/web/2if_/https://example.com/article'
    );
  });

  it('returns failure on 404/no content', async () => {
    vi.mocked(httpRequest).mockResolvedValue({
      success: false,
      statusCode: 404,
      headers: {},
      cookies: [],
      error: 'not_found',
    });

    const result = await fetchFromWayback('https://example.com/article');

    expect(result.success).toBe(false);
    expect(result.error).toBe('not_found');
  });

  it('strips Wayback toolbar and injected scripts', async () => {
    const html = [
      '<html><head>',
      '<script src="/_static/js/bundle.js"></script>',
      '</head><body>',
      '<!-- BEGIN WAYBACK TOOLBAR INSERT -->',
      '<div id="wm-ipp-base">toolbar content</div>',
      '<!-- END WAYBACK TOOLBAR INSERT -->',
      '<p>Real content</p>',
      '</body></html>',
    ].join('');

    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html,
      headers: {},
      cookies: [],
    });

    const result = await fetchFromWayback('https://example.com/article');

    expect(result.success).toBe(true);
    expect(result.html).not.toContain('WAYBACK TOOLBAR');
    expect(result.html).not.toContain('/_static/');
    expect(result.html).toContain('Real content');
  });

  it('rejects invalid URLs (SSRF protection)', async () => {
    const result = await fetchFromWayback('javascript:alert(1)');

    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid_url');
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it('handles network errors gracefully', async () => {
    vi.mocked(httpRequest).mockRejectedValue(new Error('Connection timeout'));

    const result = await fetchFromWayback('https://example.com/article');

    expect(result.success).toBe(false);
    expect(result.error).toBe('network_error');
  });
});

describe('fetchFromArchiveIs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns HTML on success', async () => {
    const html = '<html><body><p>Archived article content that is long enough</p></body></html>';
    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html,
      headers: {},
      cookies: [],
    });

    const result = await fetchFromArchiveIs('https://example.com/article');

    expect(result.success).toBe(true);
    expect(result.html).toContain('Archived article content');
    expect(result.archiveUrl).toBe('https://archive.is/latest/https://example.com/article');
  });

  it('returns failure on 404/no content', async () => {
    vi.mocked(httpRequest).mockResolvedValue({
      success: false,
      statusCode: 404,
      headers: {},
      cookies: [],
      error: 'not_found',
    });

    const result = await fetchFromArchiveIs('https://example.com/article');

    expect(result.success).toBe(false);
    expect(result.error).toBe('not_found');
  });

  it('detects "not archived" response patterns', async () => {
    const html =
      '<html><body><p>No results. This page has not been archived yet.</p></body></html>';
    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html,
      headers: {},
      cookies: [],
    });

    const result = await fetchFromArchiveIs('https://example.com/article');

    expect(result.success).toBe(false);
    expect(result.error).toBe('not_archived');
  });

  it('rejects invalid URLs (SSRF protection)', async () => {
    const result = await fetchFromArchiveIs('ftp://evil.com/file');

    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid_url');
    expect(httpRequest).not.toHaveBeenCalled();
  });
});

describe('fetchFromArchives', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns Wayback result when it succeeds (tries Wayback first)', async () => {
    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: '<html>Wayback content</html>',
      headers: {},
      cookies: [],
    });

    const result = await fetchFromArchives('https://example.com/article');

    expect(result.success).toBe(true);
    expect(result.archiveUrl).toContain('web.archive.org');
    // Should not have tried archive.is
    expect(httpRequest).toHaveBeenCalledTimes(1);
  });

  it('falls back to Archive.is when Wayback fails', async () => {
    // Wayback fails
    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: false,
      statusCode: 404,
      headers: {},
      cookies: [],
      error: 'not_found',
    });
    // Archive.is succeeds
    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      html: '<html>Archive.is content</html>',
      headers: {},
      cookies: [],
    });

    const result = await fetchFromArchives('https://example.com/article');

    expect(result.success).toBe(true);
    expect(result.archiveUrl).toContain('archive.is');
    expect(httpRequest).toHaveBeenCalledTimes(2);
  });

  it('returns failure when both archives fail', async () => {
    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: false,
      statusCode: 404,
      headers: {},
      cookies: [],
      error: 'not_found',
    });
    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: false,
      statusCode: 404,
      headers: {},
      cookies: [],
      error: 'not_found',
    });

    const result = await fetchFromArchives('https://example.com/article');

    expect(result.success).toBe(false);
    expect(result.error).toBe('no_archive_available');
  });
});
