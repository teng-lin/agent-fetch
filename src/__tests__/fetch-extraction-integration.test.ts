/**
 * Fetch-extraction integration tests.
 *
 * Only HTTP transport (httpRequest/httpPost) and logger are mocked.
 * Real extraction (extractFromHtml, quickValidate, etc.) runs end-to-end,
 * catching argument-passing bugs and type mismatches that unit tests with
 * mocked extractors would miss.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock only HTTP transport and logger ---

vi.mock('../fetch/http-client.js', () => ({
  httpRequest: vi.fn(),
  httpPost: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../extract/pdf-extractor.js', () => ({
  isPdfUrl: vi.fn().mockReturnValue(false),
  isPdfContentType: vi.fn().mockReturnValue(false),
  fetchRemotePdfBuffer: vi.fn(),
  extractPdfFromBuffer: vi.fn(),
}));

// Do NOT mock: content-extractors, content-validator, site-config, markdown, etc.

import { httpFetch } from '../fetch/http-fetch.js';
import { httpRequest } from '../fetch/http-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(html: string, statusCode = 200) {
  return {
    success: true,
    statusCode,
    html,
    headers: { 'content-type': 'text/html' },
    cookies: [],
  };
}

/**
 * Build a realistic article HTML page that passes quickValidate:
 * - Body >5 KB (Buffer.byteLength >= 5120)
 * - Word count >100 (stripped text)
 * - Content-Type text/html
 * - Status 200
 */
function buildArticleHtml(options: {
  title?: string;
  paragraphs?: string[];
  jsonLd?: Record<string, unknown>;
  lang?: string;
}): string {
  const { title = 'Test Article Title', paragraphs, jsonLd, lang = 'en' } = options;

  const defaultParagraphs = [
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
    'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
    'Curabitur pretium tincidunt lacus. Nulla gravida orci a odio. Nullam varius, turpis et commodo pharetra, est eros bibendum elit, nec luctus magna felis sollicitudin mauris. Integer in mauris eu nibh euismod gravida.',
    'Praesent congue erat at massa. Sed cursus turpis vitae tortor. Donec posuere vulputate arcu. Phasellus accumsan cursus velit. Vestibulum ante ipsum primis in faucibus orci luctus et ultrices posuere cubilia Curae.',
    'Pellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestas. Vestibulum tortor quam, feugiat vitae, ultricies eget, tempor sit amet, ante. Donec eu libero sit amet quam egestas semper.',
    'Aenean ultricies mi vitae est. Mauris placerat eleifend leo. Quisque sit amet est et sapien ullamcorper pharetra. Vestibulum erat wisi, condimentum sed, commodo vitae, ornare sit amet, wisi.',
    'Fusce fermentum odio nec arcu. Vivamus euismod mauris. In ut quam vitae odio lacinia tincidunt. Praesent ut ligula non mi varius sagittis. Cras sagittis.',
  ];

  const paras = paragraphs ?? defaultParagraphs;
  const paragraphHtml = paras.map((p) => `      <p>${p}</p>`).join('\n');

  const jsonLdScript = jsonLd
    ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta property="og:title" content="${title}">
  <meta property="og:site_name" content="Example News">
  <title>${title} - Example News</title>
  ${jsonLdScript}
</head>
<body>
  <header><nav>Navigation</nav></header>
  <article>
    <h1>${title}</h1>
${paragraphHtml}
  </article>
  <footer>Footer content</footer>
</body>
</html>`;

  // Ensure >5 KB body size
  const byteLength = Buffer.byteLength(html, 'utf8');
  if (byteLength < 5120) {
    const padding = ' '.repeat(5120 - byteLength);
    return html.replace('</body>', `<!-- ${padding} --></body>`);
  }

  return html;
}

describe('fetch-extraction integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Readability extraction from realistic HTML
  // -------------------------------------------------------------------------
  it('extracts article content from realistic HTML via Readability', async () => {
    const html = buildArticleHtml({
      title: 'Breaking News Story About Important Events',
    });

    vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(html));

    const result = await httpFetch('https://example.com/article/breaking-news');

    expect(result.success).toBe(true);
    expect(result.title).toBeDefined();
    expect(result.title).toContain('Breaking News');
    expect(result.textContent).toBeDefined();
    expect(result.textContent!.length).toBeGreaterThan(200);
    expect(result.extractionMethod).toBeDefined();
    expect(result.markdown).toBeDefined();
    expect(result.markdown!.length).toBeGreaterThan(0);
    expect(result.extractedWordCount).toBeDefined();
    expect(result.extractedWordCount!).toBeGreaterThan(50);
    expect(result.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // 2. JSON-LD metadata extraction
  // -------------------------------------------------------------------------
  it('extracts JSON-LD metadata alongside DOM content', async () => {
    const html = buildArticleHtml({
      title: 'Article With Structured Data',
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'NewsArticle',
        headline: 'Article With Structured Data',
        wordCount: 250,
        isAccessibleForFree: false,
        author: { '@type': 'Person', name: 'Jane Reporter' },
      },
    });

    vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(html));

    const result = await httpFetch('https://example.com/news/structured-data');

    expect(result.success).toBe(true);
    expect(result.isAccessibleForFree).toBe(false);
    expect(result.declaredWordCount).toBe(250);
  });

  // -------------------------------------------------------------------------
  // 3. Error handling: failed HTTP request
  // -------------------------------------------------------------------------
  it('returns failure when httpRequest fails', async () => {
    // Use a non-zero statusCode so the response is not retryable
    // (retries only trigger when statusCode === 0 and no SSRF error).
    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: false,
      statusCode: 502,
      headers: {},
      cookies: [],
      error: 'Connection refused',
    });

    const result = await httpFetch('https://example.com/down');

    expect(result.success).toBe(false);
    expect(result.error).toBe('http_status_error');
    expect(result.errorDetails?.type).toBe('Connection refused');
  });

  // -------------------------------------------------------------------------
  // 4. Error handling: validation failure (non-200)
  // -------------------------------------------------------------------------
  it('returns failure for non-200 status codes', async () => {
    const html = buildArticleHtml({ title: 'Forbidden Page' });

    vi.mocked(httpRequest).mockResolvedValueOnce({
      success: true,
      statusCode: 403,
      html,
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    const result = await httpFetch('https://example.com/forbidden');

    expect(result.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 5. CJK article content (integration test for CJK fix)
  // -------------------------------------------------------------------------
  it('handles CJK article content correctly', async () => {
    // Build a Chinese article with >5 KB body size.
    // CJK chars are 3 bytes each in UTF-8, so we need ~1700+ characters for 5 KB.
    const paragraph = [
      '中国科学家在量子计算领域取得了重大突破，这项研究成果将对全球科技发展产生深远的影响。',
      '据报道，该研究团队经过多年的不懈努力，成功研发出新一代量子处理器，其计算能力远超传统计算机。',
      '这一突破性进展引起了国际科学界的广泛关注，多位诺贝尔奖得主对此表示高度赞赏。',
      '专家指出，量子计算技术的快速发展将在密码学、药物研发、气候模拟等领域发挥重要作用。',
      '该研究成果已在国际顶级学术期刊上发表，标志着中国在量子科技领域迈入了世界领先行列。',
      '未来，研究团队将继续深入探索量子纠缠和量子纠错等核心问题，为构建实用化量子计算机奠定基础。',
    ].join('');

    // 8 identical paragraphs to ensure >5 KB body size and >100 CJK "words"
    const paragraphHtml = Array(8).fill(`      <p>${paragraph}</p>`).join('\n');

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta property="og:title" content="量子计算重大突破">
  <meta property="og:site_name" content="科技新闻网">
  <title>量子计算重大突破 - 科技新闻网</title>
</head>
<body>
  <header><nav>导航栏</nav></header>
  <article>
    <h1>量子计算重大突破</h1>
${paragraphHtml}
  </article>
  <footer>页脚内容</footer>
</body>
</html>`;

    // Verify our fixture is large enough
    const byteLength = Buffer.byteLength(html, 'utf8');
    expect(byteLength).toBeGreaterThanOrEqual(5120);

    vi.mocked(httpRequest).mockResolvedValueOnce(makeResponse(html));

    const result = await httpFetch('https://example.com/zh/quantum-breakthrough');

    expect(result.success).toBe(true);
    expect(result.title).toBeDefined();
    expect(result.textContent).toBeDefined();
    expect(result.textContent!.length).toBeGreaterThan(200);
    expect(result.extractedWordCount).toBeDefined();
    // CJK characters each count as 1 word, so this should be well over 100
    expect(result.extractedWordCount!).toBeGreaterThan(100);
    expect(result.markdown).toBeDefined();
  });
});
