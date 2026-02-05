# Contributing to agent-fetch

## API Reference

### `httpFetch(url, options?)`

Main entry point. Fetches a URL with Chrome TLS fingerprinting and extracts article content.

```typescript
import { httpFetch } from '@teng-lin/agent-fetch';

const result = await httpFetch('https://example.com/article');
```

**Returns** `FetchResult`:

| Field             | Type      | Description                                    |
| ----------------- | --------- | ---------------------------------------------- |
| `success`         | `boolean` | Whether extraction succeeded                   |
| `url`             | `string`  | Fetched URL                                    |
| `latencyMs`       | `number`  | Total time in milliseconds                     |
| `title`           | `string?` | Article title                                  |
| `byline`          | `string?` | Author attribution                             |
| `content`         | `string?` | Extracted HTML content                         |
| `textContent`     | `string?` | Plain text content                             |
| `markdown`        | `string?` | Markdown with headings, links, lists preserved |
| `excerpt`         | `string?` | Opening paragraph                              |
| `siteName`        | `string?` | Publication name                               |
| `publishedTime`   | `string?` | ISO 8601 publish date                          |
| `lang`            | `string?` | Language code                                  |
| `error`           | `string?` | Error message on failure                       |
| `hint`            | `string?` | Human-readable suggestion                      |
| `suggestedAction` | `string?` | `retry_with_extract`, `wait_and_retry`, `skip` |

### `httpRequest(url, headers?, preset?)`

Low-level HTTP client with TLS fingerprinting. Returns raw response data without extraction.

```typescript
import { httpRequest } from '@teng-lin/agent-fetch';

const response = await httpRequest('https://example.com');

console.log(response.statusCode); // 200
console.log(response.html); // Raw HTML
console.log(response.headers); // Response headers
console.log(response.cookies); // Set-Cookie values
```

### `extractFromHtml(html, url)`

Run the multi-strategy extraction pipeline on existing HTML.

```typescript
import { extractFromHtml } from '@teng-lin/agent-fetch';

const result = extractFromHtml(html, 'https://example.com/article');
if (result) {
  console.log(result.title);
  console.log(result.textContent);
}
```

### `htmlToMarkdown(html)`

Convert HTML to clean markdown.

```typescript
import { htmlToMarkdown } from '@teng-lin/agent-fetch';

const md = htmlToMarkdown('<h1>Title</h1><p>Content with <a href="...">links</a></p>');
```

## CLI Reference

```
Usage: agent-fetch <url> [options]

Options:
  --json              Full JSON output (title, content, markdown, metadata)
  --raw               Raw HTML (no extraction)
  -q, --quiet         Markdown content only (no metadata)
  --text              Plain text only
  --preset <value>    TLS preset (chrome-143, android-chrome-143, ios-safari-18)
  -h, --help          Show help
```

## Extraction Pipeline

When `httpFetch(url)` is called, the request flows through multiple stages. Structured
API paths are tried first (faster, more reliable), falling back to DOM-based extraction
with 9 parallel strategies and intelligent winner selection.

```
httpFetch(url)
│
├─ STAGE 1: WordPress Fast Path
│  Is site configured for WP REST API?
│  ├─ Yes → GET /wp-json/wp/v2/posts?slug=…&_embed
│  │        └─ Success? → return  ────────────────────────────────┐
│  └─ No/Fail ↓                                                   │
│                                                                 │
├─ STAGE 2: HTTP Fetch                                            │
│  httpRequest(url) with Chrome TLS fingerprinting (httpcloak)    │
│  ├─ SSRF protection (reject private IPs)                        │
│  ├─ 10s timeout, 10MB size limit                                │
│  └─ Retry up to 2× with exponential backoff                     │
│     └─ Response ↓                                               │
│                                                                 │
├─ STAGE 3: Content Validation                                    │
│  quickValidate(html)                                            │
│  ├─ HTTP 200-299?                                               │
│  ├─ Content-Type: text/html?                                    │
│  ├─ Body ≥ 5KB?                                                 │
│  └─ Word count ≥ 100?                                           │
│     ├─ Fail → STAGE 4 (fallbacks)                               │
│     └─ Pass ↓                                                   │
│                                                                 │
├─ STAGE 4: API Fallbacks (if validation failed)                  │
│  Try in order, return first success:                            │
│  ├─ 1. __NEXT_DATA__ extraction                                 │
│  ├─ 2. WP REST API (auto-detect from <link rel="alternate">)    │
│  ├─ 3. Arc XP Prism content API                                 │
│  └─ 4. WP AJAX (admin-ajax.php POST)                            │
│     └─ Success? → return  ────────────────────────────────┐     │
│                                                           │     │
├─ STAGE 5: WP REST API Priority Path                       │     │
│  (structured data preferred over DOM parsing)             │     │
│  ├─ Detect API URL from HTML or site config               │     │
│  ├─ Fetch & extract from API                              │     │
│  └─ Compare API vs DOM content length                     │     │
│     ├─ DOM > 2× API and DOM ≥ 500 chars → use DOM,        │     │
│     │  but enrich with API metadata                       │     │
│     └─ Otherwise → use API  ──────────────────────────┐   │     │
│                                                       │   │     │
├─ STAGE 6: DOM Extraction                              │   │     │
│  extractFromHtml() — run 9 strategies in parallel:    │   │     │
│                                                       │   │     │
│  ┌──────────────────────────────────────────────────┐ │   │     │
│  │  Strategy          │ Approach                    │ │   │     │
│  ├──────────────────────────────────────────────────┤ │   │     │
│  │  Readability       │ Mozilla Reader View algo    │ │   │     │
│  │  Text Density      │ Text-to-tag ratio (CETD)    │ │   │     │
│  │  JSON-LD           │ schema.org structured data  │ │   │     │
│  │  Next.js           │ __NEXT_DATA__ page props    │ │   │     │
│  │  RSC               │ React Server Components     │ │   │     │
│  │  Nuxt              │ Nuxt payload extraction     │ │   │     │
│  │  React Router      │ Hydration data extraction   │ │   │     │
│  │  CSS Selectors     │ <article>, .post-content    │ │   │     │
│  │  Unfluff           │ Goose-port heuristics       │ │   │     │
│  └──────────────────────────────────────────────────┘ │   │     │
│     │                                                 │   │     │
│     ▼                                                 │   │     │
│  Winner Selection:                                    │   │     │
│  1. Config-driven: siteUseNextData / sitePreferJsonLd │   │     │
│     → if ≥ 500 chars, return immediately              │   │     │
│  2. Comparators:                                      │   │     │
│     TextDensity > 2× Readability → prefer TextDensity │   │     │
│     RSC > 2× Readability → prefer RSC                 │   │     │
│  3. All strategies ≥ 500 chars → pick longest         │   │     │
│  4. Fallback: any ≥ 200 chars in priority order       │   │     │
│  5. Last resort: best partial available               │   │     │
│     │                                                 │   │     │
│     ▼                                                 │   │     │
│  Metadata Composition:                                │   │     │
│  Winner's content + best metadata from ALL strategies │   │     │
│  (byline, publishedTime, siteName, lang)              │   │     │
│     └─ extraction result ↓                            │   │     │
│                                                       │   │     │
├─ STAGE 7: Next.js Data Route Probe                    │   │     │
│  If DOM result < 2000 chars:                          │   │     │
│  ├─ Fetch /_next/data/{buildId}/{path}.json           │   │     │
│  └─ Use only if data route has MORE content           │   │     │
│     ↓                                                 │   │     │
│                                                       │   │     │
├─ STAGE 8: Markdown Conversion                         │   │     │
│  ├─ HTML strategies → Turndown to markdown            │   │     │
│  └─ Text strategies → use textContent as-is           │   │     │
│     ↓                                                 │   │     │
│     ◄─────────────────────────────────────────────────┘───┘     │
│     ◄───────────────────────────────────────────────────────────┘
│
└─ FetchResult
   { success, url, title, byline, markdown, textContent,
     excerpt, siteName, publishedTime, lang, latencyMs,
     extractionMethod, isAccessibleForFree }
```

Key design decisions:

- **Structured APIs first**: WordPress REST API and other content APIs are checked
  before DOM parsing — structured data is more reliable than heuristic extraction.
- **9 complementary strategies**: No single method works for every site. Readability
  handles most articles, but Next.js/RSC/WP API handle framework-rendered pages that
  DOM parsers miss.
- **2× comparator rule**: Text-density and RSC can override Readability when they
  find significantly more content (2× threshold prevents false positives).
- **Metadata composition**: The winner provides content, but metadata (author, date,
  site name) is sourced from whichever strategy found the best value for each field.

## Development

```bash
npm install
npm test              # Unit tests
npm run test:e2e:fetch # E2E tests (hits real sites)
npm run build
npm run lint
npm run format
```
