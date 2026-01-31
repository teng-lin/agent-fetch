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

## Development

```bash
npm install
npm test              # Unit tests
npm run test:e2e:fetch # E2E tests (hits real sites)
npm run build
npm run lint
npm run format
```
