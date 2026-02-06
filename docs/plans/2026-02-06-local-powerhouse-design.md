# Local Powerhouse: Expanding agent-fetch Capabilities

**Date:** 2026-02-06
**Status:** Draft
**Direction:** Local-first, zero cloud dependency

## Strategic Context

agent-fetch currently excels at single-URL content extraction with 13+ strategies and TLS client presets via httpcloak. This design expands its capabilities to cover multi-page crawling, PDF extraction, and surgical content targeting.

**Our differentiator:** Fast, local, zero-dependency. No API keys, no cloud, no browser overhead. Runs entirely on the user's machine.

**What we're NOT doing (for now):**

- JS rendering (Playwright/Puppeteer) — violates local-lightweight principle
- LLM-powered structured extraction — requires external API
- Web search integration — requires search API
- Hosted service / SaaS mode

## Feature Wave 1: Three Features

### Feature 1: CSS Selectors + Content Control

**Goal:** Surgical content extraction via CSS selectors.

#### CLI Interface

```bash
agent-fetch <url> --select "article.post-body"       # extract only this element
agent-fetch <url> --remove "nav, .sidebar, .comments" # remove before extraction
agent-fetch <url> --select ".product" --remove ".ads"  # combine both
```

#### Programmatic API

```typescript
httpFetch(url, {
  targetSelector: 'article.post-body', // string | string[]
  removeSelector: ['nav', '.sidebar'], // string | string[]
});
```

#### Implementation

- Applied to the DOM **before** extraction strategies run
- `removeSelector`: uses linkedom (already a dependency) to `.remove()` matching elements
- `targetSelector`: replaces the document body with only matched element(s). When multiple elements match, they are concatenated in document order.
- Both work on the parsed HTML, so they interact correctly with all 13+ existing extraction strategies
- JSON output includes a `selectors` field showing what was applied
- If `targetSelector` matches nothing, fall back to normal extraction (with a warning in logs)

#### Files to Change

```
src/extract/content-extractors.ts   # Add selector pre-processing before strategy execution
src/extract/types.ts                # Add targetSelector, removeSelector to ExtractionOptions
src/cli.ts                          # Add --select and --remove flags
src/fetch/http-fetch.ts             # Pass selector options through to extraction
src/fetch/types.ts                  # Add to HttpFetchOptions
```

#### Effort: Small (~100-150 lines)

---

### Feature 2: PDF Extraction

**Goal:** Extract text content from PDF files (local or remote) and convert to markdown.

#### CLI Interface

```bash
agent-fetch document.pdf                              # local file
agent-fetch https://example.com/report.pdf            # remote PDF
agent-fetch https://example.com/report.pdf --json     # full metadata
agent-fetch https://example.com/report.pdf --text     # plain text only
```

#### Programmatic API

```typescript
import { httpFetch } from 'agent-fetch';

// Remote PDF — auto-detected from .pdf extension
const result = await httpFetch('https://example.com/report.pdf');

// Local file support via new function
import { extractPdfFromBuffer } from 'agent-fetch';
const result = await extractPdfFromBuffer(buffer, '/path/to/document.pdf');
```

#### Implementation

1. **Detection:** Check URL/path extension (`.pdf`)
2. **Fetching:** Remote PDFs fetched via existing httpcloak client, local files read from disk via `fs.readFile`
3. **Extraction:** Use `pdf-parse` (lightweight, 0 native deps, ~200KB) to extract text
4. **Markdown conversion:** Structure extracted text into markdown with title as H1 and paragraph preservation
5. **Metadata:** Extract PDF metadata (title, author, creation date) into standard `FetchResult` fields
6. **Output:** Same `FetchResult` shape: `title`, `content`, `textContent`, `markdown`, `extractionMethod: 'pdf-parse'`

#### What We Skip (v1)

- OCR for scanned PDFs (too heavy)
- DOCX/XLSX/other document formats (can add later)

#### New Dependency

- `pdf-parse` (~200KB, pure JS)

#### Files to Create/Change

```
src/extract/pdf-extractor.ts    # New: PDF parsing and markdown conversion
src/fetch/http-fetch.ts         # Detect PDF URL, route to pdf-extractor
src/cli.ts                      # Detect local file paths, handle PDF input
src/index.ts                    # Export extractPdfFromBuffer
```

#### Effort: Medium (~200-300 lines)

---

### Feature 3: Site Crawling

**Goal:** Recursive site crawling with auto-detection (sitemap-first, link-following fallback) and JSONL streaming output.

#### CLI Interface

```bash
# Basic crawl — JSONL to stdout
agent-fetch crawl https://example.com

# With limits
agent-fetch crawl https://example.com --depth 2 --limit 50

# Filter URLs by pattern
agent-fetch crawl https://example.com --include "/blog/*" --exclude "*/tag/*"

# Combine with extraction options
agent-fetch crawl https://example.com --depth 1 --select "article" --remove "nav"

# Quiet mode — just discovered URLs
agent-fetch crawl https://example.com --limit 100 -q

# With politeness delay
agent-fetch crawl https://example.com --delay 200
```

#### Parameters

| Flag            | Default | Description                                    |
| --------------- | ------- | ---------------------------------------------- |
| `--depth`       | 3       | Max link-following depth from start URL        |
| `--limit`       | 100     | Max pages to fetch                             |
| `--concurrency` | 5       | Parallel requests                              |
| `--include`     | —       | URL glob patterns to include (comma-separated) |
| `--exclude`     | —       | URL glob patterns to exclude (comma-separated) |
| `--same-origin` | true    | Stay on same origin (protocol+host+port)       |
| `--delay`       | 0       | Delay between batches of requests (ms)         |

All existing single-URL options also apply to each page in the crawl (`--select`, `--remove`, `--json`, `--text`, `--raw`, `--preset`, `--timeout`).

#### Programmatic API

```typescript
import { crawl } from 'agent-fetch';

const stream = crawl('https://example.com', {
  maxDepth: 2,
  maxPages: 50,
  concurrency: 5,
  include: ['/blog/*'],
  exclude: ['*/tag/*'],
  sameOrigin: true,
  delay: 200,
  // All httpFetch options available too
  targetSelector: 'article',
  removeSelector: ['nav', '.sidebar'],
});

// AsyncGenerator — yields FetchResult objects as pages complete
for await (const result of stream) {
  console.log(result.url, result.title);
}
```

#### Crawl Strategy (Auto-Detection)

```
1. Fetch robots.txt for the target origin
   → Parse Disallow rules (respect them by default)
   → Extract Sitemap: directives
2. Try sitemap.xml (and any sitemaps found in robots.txt)
   → If found: use sitemap URLs as the crawl queue
     - Filter by include/exclude patterns
     - Respect --limit
     - Ignore --depth (sitemap provides flat URL list)
   → If not found or empty: fall back to link discovery
3. Link discovery mode:
   → Parse <a href> from each fetched page
   → Normalize URLs (resolve relative, strip fragments, deduplicate)
   → Filter: same-origin check, include/exclude patterns
   → BFS traversal respecting --depth limit
4. Concurrency: process up to --concurrency pages in parallel
5. Deduplication: normalize URLs, maintain visited Set
6. Politeness: respect --delay between batches
```

#### Output Format (JSONL)

Each completed page emits one line:

```jsonl
{"url":"https://example.com/","title":"Home","markdown":"# Welcome...","extractionMethod":"readability","latencyMs":523,"depth":0,"success":true}
{"url":"https://example.com/about","title":"About","markdown":"# About Us...","extractionMethod":"json-ld","latencyMs":412,"depth":1,"success":true}
{"url":"https://example.com/broken","error":"http_error","statusCode":404,"latencyMs":200,"depth":1,"success":false}
```

A summary line at the end:

```jsonl
{
  "type": "summary",
  "pagesTotal": 47,
  "pagesSuccess": 45,
  "pagesFailed": 2,
  "pagesBlocked": 3,
  "durationMs": 12340,
  "source": "sitemap",
  "startUrl": "https://example.com/"
}
```

#### Architecture

New module structure:

```
src/
  crawl/
    crawler.ts          # Main crawl orchestrator (AsyncGenerator)
                        #   - Coordinates frontier, fetching, and output
                        #   - Manages concurrency with batch processing
    url-frontier.ts     # BFS queue with:
                        #   - URL normalization and deduplication (visited Set)
                        #   - Depth tracking per URL
                        #   - Pattern filtering (include/exclude globs)
                        #   - Same-origin enforcement
    sitemap-parser.ts   # Parse sitemap.xml and sitemap index files
                        #   - Extract <loc>, <lastmod>, <priority>
                        #   - Recursive sitemap index resolution
    robots-parser.ts    # Parse robots.txt
                        #   - Extract Disallow rules
                        #   - Extract Sitemap: directives
                        #   - Check URL against rules
    link-extractor.ts   # Extract <a href> from HTML
                        #   - Resolve relative URLs against base
                        #   - Strip fragments, normalize trailing slashes
                        #   - Filter out non-HTTP schemes (mailto:, tel:, javascript:)
    types.ts            # CrawlOptions, CrawlResult, CrawlSummary types
```

CLI changes:

```
src/cli.ts              # Add 'crawl' subcommand detection
                        #   When first arg is 'crawl', second arg is URL
                        #   Parse crawl-specific flags
                        #   Stream JSONL to stdout
```

Exports:

```
src/index.ts            # Export { crawl } and crawl types
```

#### New Dependencies

- `picomatch` for glob pattern matching (~10KB, zero deps)

#### Effort: Large (~600-800 lines across 6 new files)

---

## Feature Wave 2 (Future)

Features to consider after Wave 1 ships:

| Feature                   | Description                         |
| ------------------------- | ----------------------------------- |
| **MCP server**            | Expose agent-fetch as an MCP tool   |
| **Streaming output**      | SSE for programmatic API consumers  |
| **robots.txt standalone** | Check robots.txt for any single URL |
| **Batch mode**            | `agent-fetch batch urls.txt`        |
| **DOCX/XLSX**             | Document format extraction          |
| **Change detection**      | Diff pages between fetches          |
| **HTTP caching**          | ETag/Last-Modified respect          |
