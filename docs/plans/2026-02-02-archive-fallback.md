# Archive Fallback Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When direct fetch fails (paywall, challenge, insufficient content), try fetching the article from Wayback Machine and Archive.is, then run the archived HTML through the existing extraction pipeline.

**Architecture:** New `src/fetch/archive-fallback.ts` module with two archive sources (Wayback Machine, Archive.is). Integrated into `http-fetch.ts` at the validation-failure and extraction-failure paths. Uses `httpRequest()` from `http-client.ts` for all HTTP calls (archive services do bot detection too). Feeds archived HTML through existing `extractFromHtml()` — no custom CSS selectors needed.

**Tech Stack:** httpcloak (via existing `httpRequest`), existing `extractFromHtml`, Wayback Machine CDX API, Archive.is latest redirect.

---

## Design Decisions

### Why simpler than unwaller's 952-line implementation

The unwaller uses custom CSS selectors to extract from archive HTML. We instead feed the full archived HTML through lynxget's existing multi-strategy extraction pipeline (`extractFromHtml`), which already handles Readability, text-density, JSON-LD, etc. This eliminates ~400 lines of selector logic.

### Wayback Machine: `web/2/{url}` shortcut vs timemap

The unwaller parses the timemap API to find the latest snapshot, then fetches it. The `web/2/{url}` shortcut does this in one step — Wayback auto-redirects to the latest snapshot. Adding `if_/` returns raw content without the Wayback toolbar iframe injection.

**URL pattern:** `https://web.archive.org/web/2if_/{url}`

### Archive.is: `latest/{url}` vs 6-TLD rotation

The unwaller rotates through 6 TLDs (archive.fo, .is, .li, .md, .ph, .vn) to avoid rate limiting. For our use case (single retry, not bulk), `archive.is/latest/{url}` is sufficient and simpler.

**URL pattern:** `https://archive.is/latest/{url}`

### Stripping Wayback toolbar

Wayback Machine injects `<!-- BEGIN WAYBACK TOOLBAR INSERT -->...<!-- END WAYBACK TOOLBAR INSERT -->` into archived pages, plus a `<script src="/_static/...">` block. These must be stripped before feeding HTML to extractors, otherwise they pollute content extraction.

### When to trigger

Archive fallback runs when `httpFetch()` would otherwise return a failure with `suggestedAction: 'retry_with_extract'`. Specifically:

- `challenge_detected` — bot challenge detected, recovery extraction failed
- `access_restricted` — paywall/gate detected, recovery extraction failed
- `insufficient_content` — content too short (< 100 chars)
- `extraction_failed` — all extraction strategies returned null

### Not triggered for

- `http_status_error` — server errors (404, 500) are unlikely to be in archives either
- `wrong_content_type` — non-HTML responses (PDF, images)
- `body_too_small` — page didn't load at all (< 5KB)

---

## Task 1: Create archive-fallback module with Wayback Machine support

**Files:**

- Create: `src/fetch/archive-fallback.ts`
- Test: `src/__tests__/archive-fallback.test.ts`

**Step 1: Write the failing test for Wayback Machine fetch**

```typescript
// src/__tests__/archive-fallback.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../fetch/http-client.js', () => ({
  httpRequest: vi.fn(),
}));

import { fetchFromWayback } from '../fetch/archive-fallback.js';
import { httpRequest } from '../fetch/http-client.js';

describe('fetchFromWayback', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('fetches latest snapshot using web/2if_ shortcut', async () => {
    const archivedHtml =
      '<html><body><article>Full archived article content here</article></body></html>';

    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: archivedHtml,
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    const result = await fetchFromWayback('https://example.com/article');

    expect(result.success).toBe(true);
    expect(result.html).toBe(archivedHtml);
    expect(result.archiveUrl).toMatch(/web\.archive\.org/);
    expect(httpRequest).toHaveBeenCalledWith(
      'https://web.archive.org/web/2if_/https://example.com/article',
      expect.any(Object)
    );
  });

  it('returns failure when Wayback returns non-200', async () => {
    vi.mocked(httpRequest).mockResolvedValue({
      success: false,
      statusCode: 404,
      html: 'Not Found',
      headers: {},
      cookies: [],
    });

    const result = await fetchFromWayback('https://example.com/missing');

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('strips Wayback toolbar from HTML', async () => {
    const toolbarHtml = [
      '<html><head></head><body>',
      '<!-- BEGIN WAYBACK TOOLBAR INSERT -->',
      '<div id="wm-ipp-base">toolbar stuff</div>',
      '<!-- END WAYBACK TOOLBAR INSERT -->',
      '<article>Real content</article>',
      '</body></html>',
    ].join('\n');

    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: toolbarHtml,
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    const result = await fetchFromWayback('https://example.com/article');

    expect(result.success).toBe(true);
    expect(result.html).not.toContain('WAYBACK TOOLBAR');
    expect(result.html).toContain('Real content');
  });

  it('rejects non-HTTP URLs', async () => {
    const result = await fetchFromWayback('javascript:alert(1)');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid URL');
  });

  it('returns failure on network error', async () => {
    vi.mocked(httpRequest).mockResolvedValue({
      success: false,
      statusCode: 0,
      headers: {},
      cookies: [],
      error: 'Connection refused',
    });

    const result = await fetchFromWayback('https://example.com/article');
    expect(result.success).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run src/__tests__/archive-fallback.test.ts`
Expected: FAIL — `archive-fallback.ts` doesn't exist

**Step 3: Implement fetchFromWayback**

```typescript
// src/fetch/archive-fallback.ts
import { httpRequest } from './http-client.js';
import { logger } from '../logger.js';

const WAYBACK_PREFIX = 'https://web.archive.org/web/2if_/';

export interface ArchiveFetchResult {
  success: boolean;
  html?: string;
  archiveUrl?: string;
  error?: string;
}

/** Validate URL protocol (SSRF prevention) */
function isValidInputUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Strip Wayback Machine toolbar injection from archived HTML */
function stripWaybackToolbar(html: string): string {
  // Remove toolbar insert block
  let cleaned = html.replace(
    /<!-- BEGIN WAYBACK TOOLBAR INSERT -->[\s\S]*?<!-- END WAYBACK TOOLBAR INSERT -->/g,
    ''
  );
  // Remove Wayback analytics/helper scripts
  cleaned = cleaned.replace(/<script\s+src="\/\/_static\/[^"]*"[^>]*><\/script>/g, '');
  return cleaned;
}

/**
 * Fetch article from Wayback Machine using the web/2if_ shortcut.
 * `web/2` = latest snapshot, `if_` = raw content (no toolbar iframe).
 */
export async function fetchFromWayback(url: string): Promise<ArchiveFetchResult> {
  if (!isValidInputUrl(url)) {
    return { success: false, error: 'Invalid URL: must be HTTP or HTTPS' };
  }

  const archiveUrl = `${WAYBACK_PREFIX}${url}`;
  logger.debug({ url, archiveUrl }, 'Trying Wayback Machine');

  const response = await httpRequest(archiveUrl, {
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.5',
  });

  if (!response.success || response.statusCode !== 200 || !response.html) {
    logger.debug({ url, statusCode: response.statusCode }, 'Wayback Machine: not found');
    return { success: false, error: `Wayback Machine: not found (${response.statusCode})` };
  }

  const html = stripWaybackToolbar(response.html);
  logger.info({ url, htmlLength: html.length }, 'Wayback Machine: fetched');

  return { success: true, html, archiveUrl };
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- --run src/__tests__/archive-fallback.test.ts`
Expected: All 5 tests PASS

**Step 5: Commit**

```bash
git add src/fetch/archive-fallback.ts src/__tests__/archive-fallback.test.ts
git commit -m "feat: add Wayback Machine archive fallback"
```

---

## Task 2: Add Archive.is support to archive-fallback module

**Files:**

- Modify: `src/fetch/archive-fallback.ts`
- Modify: `src/__tests__/archive-fallback.test.ts`

**Step 1: Write failing tests for Archive.is**

Add to `src/__tests__/archive-fallback.test.ts`:

```typescript
import { fetchFromArchiveIs } from '../fetch/archive-fallback.js';

describe('fetchFromArchiveIs', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('fetches latest snapshot from archive.is', async () => {
    const archivedHtml = '<html><body><article>Archived article</article></body></html>';

    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: archivedHtml,
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    const result = await fetchFromArchiveIs('https://example.com/article');

    expect(result.success).toBe(true);
    expect(result.html).toBe(archivedHtml);
    expect(result.archiveUrl).toMatch(/archive\.is/);
    expect(httpRequest).toHaveBeenCalledWith(
      'https://archive.is/latest/https://example.com/article',
      expect.any(Object)
    );
  });

  it('returns failure when archive.is returns non-200', async () => {
    vi.mocked(httpRequest).mockResolvedValue({
      success: false,
      statusCode: 404,
      html: '',
      headers: {},
      cookies: [],
    });

    const result = await fetchFromArchiveIs('https://example.com/missing');
    expect(result.success).toBe(false);
  });

  it('detects "not archived" page', async () => {
    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: '<html><body>No results found</body></html>',
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    const result = await fetchFromArchiveIs('https://example.com/never-archived');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not archived');
  });

  it('rejects non-HTTP URLs', async () => {
    const result = await fetchFromArchiveIs('file:///etc/passwd');
    expect(result.success).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run src/__tests__/archive-fallback.test.ts`
Expected: FAIL — `fetchFromArchiveIs` not exported

**Step 3: Implement fetchFromArchiveIs**

Add to `src/fetch/archive-fallback.ts`:

```typescript
const ARCHIVE_IS_PREFIX = 'https://archive.is/latest/';

/** Patterns indicating the article is not in the archive */
const NOT_ARCHIVED_PATTERNS = [
  'No results found',
  'not in the archive',
  'Webpage not found',
  'no archived version',
];

/**
 * Fetch article from Archive.is using the /latest/ shortcut.
 * Redirects to the most recent archived snapshot.
 */
export async function fetchFromArchiveIs(url: string): Promise<ArchiveFetchResult> {
  if (!isValidInputUrl(url)) {
    return { success: false, error: 'Invalid URL: must be HTTP or HTTPS' };
  }

  const archiveUrl = `${ARCHIVE_IS_PREFIX}${url}`;
  logger.debug({ url, archiveUrl }, 'Trying Archive.is');

  const response = await httpRequest(archiveUrl, {
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.5',
  });

  if (!response.success || response.statusCode !== 200 || !response.html) {
    logger.debug({ url, statusCode: response.statusCode }, 'Archive.is: not found');
    return { success: false, error: `Archive.is: not found (${response.statusCode})` };
  }

  // Check for "not archived" patterns
  if (NOT_ARCHIVED_PATTERNS.some((p) => response.html!.includes(p))) {
    logger.debug({ url }, 'Archive.is: not archived');
    return { success: false, error: 'Archive.is: not archived' };
  }

  logger.info({ url, htmlLength: response.html.length }, 'Archive.is: fetched');

  return { success: true, html: response.html, archiveUrl };
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- --run src/__tests__/archive-fallback.test.ts`
Expected: All 9 tests PASS (5 Wayback + 4 Archive.is)

**Step 5: Commit**

```bash
git add src/fetch/archive-fallback.ts src/__tests__/archive-fallback.test.ts
git commit -m "feat: add Archive.is fallback source"
```

---

## Task 3: Add combined `fetchFromArchives` orchestrator

**Files:**

- Modify: `src/fetch/archive-fallback.ts`
- Modify: `src/__tests__/archive-fallback.test.ts`

**Step 1: Write failing tests for the orchestrator**

Add to `src/__tests__/archive-fallback.test.ts`:

```typescript
import { fetchFromArchives } from '../fetch/archive-fallback.js';

describe('fetchFromArchives', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns Wayback result when it succeeds first', async () => {
    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: '<html><body><article>Wayback content</article></body></html>',
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    const result = await fetchFromArchives('https://example.com/article');

    expect(result.success).toBe(true);
    expect(result.archiveUrl).toMatch(/web\.archive\.org/);
  });

  it('falls back to Archive.is when Wayback fails', async () => {
    vi.mocked(httpRequest)
      .mockResolvedValueOnce({
        // Wayback fails
        success: false,
        statusCode: 404,
        html: '',
        headers: {},
        cookies: [],
      })
      .mockResolvedValueOnce({
        // Archive.is succeeds
        success: true,
        statusCode: 200,
        html: '<html><body><article>Archive.is content</article></body></html>',
        headers: { 'content-type': 'text/html' },
        cookies: [],
      });

    const result = await fetchFromArchives('https://example.com/article');

    expect(result.success).toBe(true);
    expect(result.archiveUrl).toMatch(/archive\.is/);
  });

  it('returns failure when both sources fail', async () => {
    vi.mocked(httpRequest).mockResolvedValue({
      success: false,
      statusCode: 404,
      html: '',
      headers: {},
      cookies: [],
    });

    const result = await fetchFromArchives('https://example.com/nowhere');

    expect(result.success).toBe(false);
    expect(result.error).toContain('No archive sources');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run src/__tests__/archive-fallback.test.ts`
Expected: FAIL — `fetchFromArchives` not exported

**Step 3: Implement fetchFromArchives**

Add to `src/fetch/archive-fallback.ts`:

```typescript
/**
 * Try all archive sources in priority order.
 * Wayback first (more reliable, less bot detection), then Archive.is.
 */
export async function fetchFromArchives(url: string): Promise<ArchiveFetchResult> {
  // Try Wayback Machine first — generally more reliable, less aggressive bot detection
  const wayback = await fetchFromWayback(url);
  if (wayback.success) return wayback;

  // Fall back to Archive.is
  const archiveIs = await fetchFromArchiveIs(url);
  if (archiveIs.success) return archiveIs;

  return {
    success: false,
    error: `No archive sources had content. Wayback: ${wayback.error}; Archive.is: ${archiveIs.error}`,
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- --run src/__tests__/archive-fallback.test.ts`
Expected: All 12 tests PASS

**Step 5: Commit**

```bash
git add src/fetch/archive-fallback.ts src/__tests__/archive-fallback.test.ts
git commit -m "feat: add combined archive orchestrator"
```

---

## Task 4: Integrate archive fallback into http-fetch.ts

**Files:**

- Modify: `src/fetch/http-fetch.ts` (integration at validation-failure and extraction-failure paths)
- Modify: `src/__tests__/http-fetch.test.ts` (new tests)

This is the key integration task. Archive fallback triggers when:

1. Validation fails with `challenge_detected` or `access_restricted` AND recovery extraction also fails
2. Extraction fails entirely (all strategies return null)
3. Extracted content is below `MIN_CONTENT_LENGTH`

**Step 1: Write failing tests**

Add to `src/__tests__/http-fetch.test.ts`:

```typescript
// Add import at top of file, alongside existing mocks.
// IMPORTANT: Default to returning a failed result so existing tests don't crash
// when archive fallback is triggered (vi.fn() returns undefined, which causes
// TypeError when tryArchiveFallback accesses .success on the result).
vi.mock('../fetch/archive-fallback.js', () => ({
  fetchFromArchives: vi.fn().mockResolvedValue({ success: false, error: 'mock: not configured' }),
}));

import { fetchFromArchives } from '../fetch/archive-fallback.js';
```

Also update the existing logger mock (line 23-28 of `http-fetch.test.ts`) to include `debug` and `warn`:

```typescript
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));
```

Add test cases:

```typescript
describe('archive fallback integration', () => {
  it('tries archive when challenge detected and extraction fails', async () => {
    const url = 'https://example.com/paywalled';

    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: '<html><div class="cf-turnstile"></div></html>',
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({
      valid: false,
      error: 'challenge_detected',
      errorDetails: { challengeType: 'cloudflare_turnstile' },
    });

    // Recovery extraction fails
    vi.mocked(extractFromHtml).mockReturnValue(null);

    // Archive succeeds
    vi.mocked(fetchFromArchives).mockResolvedValue({
      success: true,
      html: '<html><article>Full article from archive</article></html>',
      archiveUrl: 'https://web.archive.org/web/2if_/https://example.com/paywalled',
    });

    // Archive extraction succeeds
    // extractFromHtml is called twice: once for recovery, once for archive
    vi.mocked(extractFromHtml)
      .mockReturnValueOnce(null) // recovery fails
      .mockReturnValueOnce({
        title: 'Archived Article',
        byline: 'Author',
        content: '<article>Full article from archive</article>',
        textContent: 'Full archived article content. '.repeat(20),
        excerpt: 'Full archived article content.',
        siteName: 'Example',
        publishedTime: '2024-01-01',
        lang: 'en',
        method: 'readability',
      });

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(result.title).toBe('Archived Article');
    expect(fetchFromArchives).toHaveBeenCalledWith(url);
  });

  it('does NOT try archive for http_status_error', async () => {
    const url = 'https://example.com/404';

    vi.mocked(httpRequest).mockResolvedValue({
      success: false,
      statusCode: 404,
      html: 'Not Found',
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({
      valid: false,
      error: 'http_status_error',
      errorDetails: { statusCode: 404 },
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(false);
    expect(fetchFromArchives).not.toHaveBeenCalled();
  });

  it('returns original error when archive also fails', async () => {
    const url = 'https://example.com/paywalled';

    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: '<html><div class="cf-turnstile"></div></html>',
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({
      valid: false,
      error: 'challenge_detected',
      errorDetails: { challengeType: 'cloudflare_turnstile' },
    });

    vi.mocked(extractFromHtml).mockReturnValue(null);

    vi.mocked(fetchFromArchives).mockResolvedValue({
      success: false,
      error: 'No archive sources had content',
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(false);
    expect(result.error).toBe('challenge_detected');
    expect(result.suggestedAction).toBe('retry_with_extract');
  });

  it('tries archive when extraction returns null', async () => {
    const url = 'https://example.com/broken-extraction';

    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: '<html><body>Some content that validates</body></html>',
      headers: { 'content-type': 'text/html' },
      cookies: [],
    });

    vi.mocked(quickValidate).mockReturnValue({ valid: true });

    // Direct extraction fails
    vi.mocked(extractFromHtml).mockReturnValueOnce(null);

    // Archive succeeds
    vi.mocked(fetchFromArchives).mockResolvedValue({
      success: true,
      html: '<html><article>Archived version</article></html>',
      archiveUrl: 'https://web.archive.org/web/2if_/https://example.com/broken-extraction',
    });

    vi.mocked(extractFromHtml).mockReturnValueOnce({
      title: 'Archived Version',
      byline: null,
      content: '<article>Archived version</article>',
      textContent: 'Full archived article content. '.repeat(20),
      excerpt: null,
      siteName: null,
      publishedTime: null,
      lang: null,
      method: 'readability',
    });

    const result = await httpFetch(url);

    expect(result.success).toBe(true);
    expect(result.title).toBe('Archived Version');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run src/__tests__/http-fetch.test.ts`
Expected: FAIL — `fetchFromArchives` not called in `httpFetch`

**Step 3: Integrate archive fallback into http-fetch.ts**

Modify `src/fetch/http-fetch.ts`:

Add import at top:

```typescript
import { fetchFromArchives } from './archive-fallback.js';
```

Add a set of errors that trigger archive fallback (near `RECOVERABLE_VALIDATION_ERRORS`):

```typescript
// Validation errors that should try archive fallback before giving up
const ARCHIVE_FALLBACK_ERRORS = new Set<ValidationError>([
  'challenge_detected',
  'access_restricted',
  'insufficient_content',
]);
```

Add archive fallback helper function at line 71 (after `successResult`, before `buildSiteHeaders`):

```typescript
/**
 * Try archive fallback: fetch from Wayback/Archive.is and extract.
 * Returns a successful FetchResult if archive has extractable content, null otherwise.
 *
 * Note on the two error-set constants:
 * - RECOVERABLE_VALIDATION_ERRORS: Triggers immediate recovery extraction from the original HTML
 * - ARCHIVE_FALLBACK_ERRORS: Triggers archive fallback (superset — includes insufficient_content)
 *
 * For challenge_detected/access_restricted: Try recovery extraction first, then archive if recovery fails
 * For insufficient_content: Skip recovery (validator already checked), go straight to archive
 */
async function tryArchiveFallback(
  url: string,
  startTime: number,
  antibot?: AntibotDetection[]
): Promise<FetchResult | null> {
  try {
    const archive = await fetchFromArchives(url);
    if (!archive.success || !archive.html) return null;

    let extracted: ExtractionResult | null;
    try {
      extracted = extractFromHtml(archive.html, url);
    } catch (e) {
      logger.debug({ url, error: String(e) }, 'Archive extraction threw exception');
      return null;
    }

    if (!extracted?.textContent || extracted.textContent.trim().length < MIN_CONTENT_LENGTH) {
      return null;
    }

    // Tag the result with the archive URL
    extracted.archiveUrl = archive.archiveUrl;

    logger.info(
      { url, archiveUrl: archive.archiveUrl, method: extracted.method },
      'Archive fallback succeeded'
    );

    // Include extractionMethod and statusCode for consistency with the direct success path
    // (see lines 243-259 of http-fetch.ts). rawHtml is null since the archived HTML
    // is not the original page's HTML.
    return {
      ...successResult(url, startTime, extracted, antibot),
      extractionMethod: extracted.method ?? null,
      statusCode: null,
      rawHtml: null,
    };
  } catch (e) {
    logger.debug({ url, error: String(e) }, 'Archive fallback failed');
    return null;
  }
}
```

**Integration point 1** — Insert at line 188 of `http-fetch.ts` (between the `RECOVERABLE_VALIDATION_ERRORS` try-catch block ending at line 186 and the `return failResult(...)` at line 189):

```typescript
// Try archive fallback for recoverable errors
if (ARCHIVE_FALLBACK_ERRORS.has(validation.error!)) {
  const archiveResult = await tryArchiveFallback(url, startTime, antibotField);
  if (archiveResult) return archiveResult;
}
```

**Integration point 2** — Replace lines 208-220 of `http-fetch.ts` (the `if (!extracted)` block):

```typescript
if (!extracted) {
  // Try archive before giving up
  const archiveResult = await tryArchiveFallback(url, startTime, antibotField);
  if (archiveResult) return archiveResult;

  return failResult(
    url,
    startTime,
    {
      error: 'extraction_failed',
      errorDetails: { type: 'null_result' },
      suggestedAction: 'retry_with_extract',
      hint: 'Failed to parse HTML',
      antibot: antibotField,
    },
    response.statusCode
  );
}
```

**Integration point 3** — Replace lines 224-238 of `http-fetch.ts` (the insufficient content block):

```typescript
if (!extracted.textContent || extracted.textContent.trim().length < MIN_CONTENT_LENGTH) {
  // Try archive — direct content might be truncated/paywalled
  const archiveResult = await tryArchiveFallback(url, startTime, antibotField);
  if (archiveResult) return archiveResult;

  const wordCount = extracted.textContent ? extracted.textContent.split(/\s+/).length : 0;
  return failResult(
    url,
    startTime,
    {
      error: 'insufficient_content',
      errorDetails: { wordCount },
      suggestedAction: 'retry_with_extract',
      hint: 'Extracted content too short',
      antibot: antibotField,
    },
    response.statusCode
  );
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- --run src/__tests__/http-fetch.test.ts`
Expected: All tests PASS (existing + new archive integration tests)

**Step 5: Run the full test suite**

Run: `npm run lint && npm run format:check && npm test && npm run build`
Expected: All pass

**Step 6: Commit**

```bash
git add src/fetch/http-fetch.ts src/__tests__/http-fetch.test.ts src/fetch/archive-fallback.ts
git commit -m "feat: integrate archive fallback into fetch pipeline"
```

---

## Task 5: Export archive module from public API

**Files:**

- Modify: `src/fetch/index.ts` (barrel export — line 8, add after `HttpResponse` export)
- Modify: `src/index.ts` (public API — line 33, add after `SiteConfig` export)

**Step 1: Add barrel export**

Add to `src/fetch/index.ts` after line 8:

```typescript
export { fetchFromArchives } from './archive-fallback.js';
export type { ArchiveFetchResult } from './archive-fallback.js';
```

**Step 2: Add public API export**

Add to `src/index.ts` after line 33:

```typescript
export { fetchFromArchives } from './fetch/archive-fallback.js';
export type { ArchiveFetchResult } from './fetch/archive-fallback.js';
```

**Step 3: Build to verify**

Run: `npm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add src/index.ts src/fetch/index.ts
git commit -m "feat: export archive fallback from public API"
```

---

## Task 6: Run full pre-commit checks and E2E validation

**Step 1: Run full check suite**

Run: `npm run lint && npm run format:check && npm test && npm run build`
Expected: All pass, no lint errors, no format issues

**Step 2: Run E2E tests against real sites**

Run: `npm run test:e2e` (or the fetch-specific variant)

Check the database for sites that were previously `challenge_detected` or `access_restricted` — some should now succeed via archive fallback.

**Step 3: Fix any issues found**

Address lint, format, or test failures.

**Step 4: Final commit if needed**

```bash
git add -A
git commit -m "fix: address lint/format issues from archive fallback"
```

---

## Summary

| Task | What                           | Files                        |
| ---- | ------------------------------ | ---------------------------- |
| 1    | Wayback Machine fetch          | `archive-fallback.ts`, tests |
| 2    | Archive.is fetch               | same files                   |
| 3    | Combined orchestrator          | same files                   |
| 4    | Integration into http-fetch.ts | `http-fetch.ts`, tests       |
| 5    | Public API export              | `index.ts`                   |
| 6    | Full validation + E2E          | all                          |

**Expected outcome:** Sites that currently fail with `challenge_detected`, `access_restricted`, or `insufficient_content` will transparently try Wayback Machine and Archive.is before reporting failure. The `archiveUrl` field in `ExtractionResult` (already defined) will be populated when content comes from an archive source.
