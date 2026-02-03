# Markdown Output for lynxget

## Goal

Add markdown as the primary output format, replacing plain text as the default. Markdown preserves article structure (headings, links, lists, emphasis) in a token-efficient format optimized for LLM consumption.

## Design

### New dependency

- `turndown` (^7.2.0) + `turndown-plugin-gfm` (^1.0.7) + `@types/turndown` (^5.0.5)
- `turndown-plugin-gfm` has no `@types` package — add a local `src/types/turndown-plugin-gfm.d.ts`
- Turndown is the standard, battle-tested choice (8.5k stars, used by Jina Reader)
- lynxget already has `linkedom` so no additional DOM dependency needed

### New module: `src/extract/markdown.ts`

```typescript
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const turndown = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined',
});

turndown.use(gfm);

export function htmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return '';
  try {
    return turndown.turndown(html);
  } catch {
    return '';
  }
}
```

Module-level singleton — Turndown instance reused across calls. On failure, returns empty string (caller falls back to textContent).

### Plain-text strategy handling

Three strategies return plain text in `content`, not HTML:

- `tryUnfluffExtraction()` (line 494): `content: result.text`
- `tryNextDataExtraction()` (line 465): `content: textContent`
- `tryNextRscExtraction()` (line 634): `content: textContent`

For these, `markdown` is set to `textContent` directly (already plain text, no conversion needed). Detection: check if `method` is `unfluff`, `next-data`, or `next-rsc`.

### Extraction pipeline (`src/extract/content-extractors.ts`)

Add a helper function that populates `markdown` on any `ExtractionResult`:

```typescript
const PLAIN_TEXT_METHODS = new Set(['unfluff', 'next-data', 'next-rsc']);

function withMarkdown(result: ExtractionResult): ExtractionResult {
  if (PLAIN_TEXT_METHODS.has(result.method)) {
    return { ...result, markdown: result.textContent };
  }
  return { ...result, markdown: result.content ? htmlToMarkdown(result.content) : null };
}
```

Apply at every non-null return site in `extractFromHtml()`:

- Line 682: `return withMarkdown(nextDataResult)` — next-data early return
- Line 694: `return withMarkdown(jsonLdResult)` — json-ld preferred early return
- Line 765: `return withMarkdown(composeMetadata(result!, allResults, jsonLdMeta))` — winner from candidate loop
- Line 778: `return withMarkdown(composeMetadata(partialResult, allResults, jsonLdMeta))` — partial result fallback

### ExtractionResult changes (`src/extract/types.ts`)

Add one field after `lang`:

```typescript
markdown: string | null; // Article content as markdown (null if conversion failed)
```

### FetchResult changes (`src/fetch/types.ts`)

Add one field after `lang`:

```typescript
markdown?: string;  // Article content as markdown
```

Note: `null` in ExtractionResult maps to `undefined` (absent) in FetchResult via the existing `?? undefined` pattern.

### httpFetch (`src/fetch/http-fetch.ts`)

In `successResult()` (line 89), add:

```typescript
markdown: extracted.markdown ?? undefined,
```

All `successResult()` call sites pass an `ExtractionResult`:

- Main success path — `extractFromHtml()` now populates `markdown` via `withMarkdown()`
- Archive fallback (`tryArchiveFallback`) — calls `extractFromHtml()`, gets `markdown` automatically
- Recovery extraction — calls `extractFromHtml()`, gets `markdown` automatically
- **WP REST API fallback** (`tryWpRestApiFallback`) — constructs its own `ExtractionResult`, needs explicit `markdown: htmlToMarkdown(contentHtml)` added where it builds the result object

### CLI changes (`src/cli.ts`)

| Mode               | Before                 | After                                                |
| ------------------ | ---------------------- | ---------------------------------------------------- |
| Default (no flags) | metadata + textContent | metadata + **markdown** (fallback to textContent)    |
| `--json`           | Full JSON              | Full JSON (now includes `markdown` field)            |
| `-q` / `--quiet`   | textContent only       | **markdown** only, fallback to textContent           |
| `--raw`            | Raw HTML               | Raw HTML (unchanged)                                 |
| `--detect`         | Antibot only           | Unchanged                                            |
| `--text`           | N/A                    | **New flag**: plain textContent only (like old `-q`) |

Fallback behavior: if `markdown` is undefined/empty, output `textContent` instead. This handles edge cases where conversion fails silently.

`--text` flag: outputs bare textContent with no metadata (identical to old `-q` behavior). Mutually exclusive with `--json`, `--raw`, `--detect`. Add to `CliOptions` interface, `parseArgs()`, and `printUsage()`.

Update `printUsage()` to document `--text` and note that default output is now markdown.

### Public API (`src/index.ts`)

Export `htmlToMarkdown` for programmatic users.

## Implementation steps

1. Install dependencies in worktree: `npm i turndown turndown-plugin-gfm && npm i -D @types/turndown`
2. Create type declaration `src/types/turndown-plugin-gfm.d.ts`
3. Create `src/extract/markdown.ts` with `htmlToMarkdown()`
4. Add `markdown` field to `ExtractionResult` in `src/extract/types.ts`
5. Add `withMarkdown()` helper and apply at all 4 return sites in `src/extract/content-extractors.ts`
6. Add `markdown` field to `FetchResult` in `src/fetch/types.ts`
7. Map `markdown` in `successResult()` in `src/fetch/http-fetch.ts`
8. Add `markdown` to WP REST API fallback `ExtractionResult` in `src/fetch/http-fetch.ts`
9. Update CLI in `src/cli.ts`: add `--text` flag, change default/quiet to use markdown with textContent fallback, update `printUsage()`
10. Export `htmlToMarkdown` from `src/index.ts`
11. Write tests `src/__tests__/markdown.test.ts`
12. Update CLI tests `src/__tests__/cli.test.ts`
13. Run full checks: `npm run lint && npm run format:check && npm run test && npm run build`

## Testing

### Unit tests (`src/__tests__/markdown.test.ts`)

```
htmlToMarkdown('<h1>Title</h1>') → '# Title'
htmlToMarkdown('<p>Text with <strong>bold</strong></p>') → 'Text with **bold**'
htmlToMarkdown('<a href="https://x.com">link</a>') → '[link](https://x.com)'
htmlToMarkdown('<ul><li>a</li><li>b</li></ul>') → '- a\n- b'
htmlToMarkdown('') → ''
htmlToMarkdown('   ') → ''
htmlToMarkdown('<script>alert(1)</script>') → ''
```

### CLI tests (`src/__tests__/cli.test.ts`)

- `parseArgs` recognizes `--text` flag
- Default mode: outputs markdown field (or textContent fallback)
- `--text` mode: outputs textContent
- `-q` mode: outputs markdown only (no metadata)
- `--json` mode: result includes `markdown` field

### Integration

- `extractFromHtml()` returns result with `markdown` populated
- Plain-text strategies (unfluff, next-data, next-rsc) set `markdown = textContent`
- `httpFetch()` includes `markdown` in `FetchResult`

## Acceptance criteria

1. `npm run lint && npm run format:check && npm run test && npm run build` all pass
2. Default CLI output shows markdown structure (headings, links, emphasis preserved)
3. `--text` flag outputs plain text (old behavior)
4. `--json` output includes `markdown` field
5. Plain-text strategies don't produce garbled markdown

## Out of scope

- Markdown-to-HTML conversion (reverse direction)
- Custom markdown formatting options
- Frontmatter/YAML header in markdown output
