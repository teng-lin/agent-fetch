# agent-fetch

[![npm version](https://img.shields.io/npm/v/%40teng-lin%2Fagent-fetch.svg)](https://www.npmjs.com/package/@teng-lin/agent-fetch)
[![Node Version](https://img.shields.io/badge/node-20%20%7C%2022%20%7C%2025-blue)](https://www.npmjs.com/package/@teng-lin/agent-fetch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/teng-lin/agent-fetch/actions/workflows/ci.yml/badge.svg)](https://github.com/teng-lin/agent-fetch/actions/workflows/ci.yml)

**Full-content web fetcher for AI agents and content workflows.** Standard HTTP tools (curl, wget, or an agent's built-in web fetch) are often served truncated or different responses because servers inspect the client's network fingerprint. agent-fetch uses [browser impersonation](https://github.com/sardanioss/httpcloak) so servers respond as they would to a real browser, then runs 9 extraction strategies to pull the complete article — every paragraph, heading, and link. Runs locally with no API keys or cloud dependencies.

Also useful for:

- **NotebookLM** can't add a URL as a source — extract the content and paste it as text
- **RAG pipelines** need clean markdown from web pages, not HTML soup or truncated summaries
- **LLM conversations** where you need the full article in context, not a 3-paragraph summary

|                           | Built-in agent fetch  | Cloud extraction APIs | agent-fetch                                                                                     |
| ------------------------- | --------------------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| **Content**               | Summary or truncation | Full (usually)        | Full article text                                                                               |
| **Structure**             | Plain text blob       | Markdown (varies)     | Markdown with headings, links, lists                                                            |
| **Runs locally**          | Yes                   | No                    | Yes                                                                                             |
| **API key required**      | No                    | Yes                   | No                                                                                              |
| **Extraction strategies** | 1 (basic parse)       | 1–2                   | 9 (Readability, JSON-LD, Next.js, RSC, Nuxt, React Router, WP API, text-density, CSS selectors) |
| **Open source**           | N/A                   | Partial               | Yes                                                                                             |

## Install

```bash
npm install @teng-lin/agent-fetch
```

Or run without installing:

```bash
npx agent-fetch https://example.com/page
```

### AI Agents (Claude Code, Codex, Cursor, Copilot)

Install the [Agent Skill](https://agentskills.io) and your agent will automatically use agent-fetch when it needs to read URLs:

```bash
npx skills add teng-lin/agent-fetch
```

The skill teaches agents when and how to call agent-fetch — no configuration needed.

## Quick Start

### CLI

```bash
# Extract article as markdown
npx agent-fetch https://example.com/article

# Markdown content only (no metadata header)
npx agent-fetch https://example.com/article -q

# Full JSON output (title, content, markdown, metadata)
npx agent-fetch https://example.com/article --json

# Plain text only
npx agent-fetch https://example.com/article --text

# Raw HTML (no extraction)
npx agent-fetch https://example.com/article --raw
```

**Default output:**

```
Title: Page Title
Author: Author Name
Site: example.com
Published: 2025-01-26T12:00:00Z
Language: en
Fetched in 523ms
---
# Heading

Full content with **formatting**, [links](https://example.com), and structure preserved...
```

### Programmatic

```typescript
import { httpFetch } from '@teng-lin/agent-fetch';

const result = await httpFetch('https://example.com/article');

if (result.success) {
  console.log(result.markdown); // Full article as markdown
  console.log(result.title); // "Article Title"
  console.log(result.byline); // "By John Smith"
  console.log(result.textContent); // Plain text
  console.log(result.latencyMs); // 523
}
```

## How Extraction Works

agent-fetch runs 7 extraction strategies in parallel and picks the most complete result. No single method works for every site — modern pages use frameworks, APIs, and structured data that each require different approaches.

| Strategy                    | What it does                                                    | Best for                                    |
| --------------------------- | --------------------------------------------------------------- | ------------------------------------------- |
| **Readability**             | Mozilla's Reader View algorithm (strict + relaxed passes)       | Most pages with semantic HTML               |
| **Text density**            | Statistical text-to-tag ratio analysis (CETD)                   | Complex layouts that Readability over-trims |
| **JSON-LD**                 | Parses `schema.org` structured data                             | Sites with rich metadata                    |
| **Next.js**                 | Extracts from page props (`__NEXT_DATA__`)                      | Next.js sites (Pages Router)                |
| **React Server Components** | Parses streaming RSC payloads                                   | Next.js sites (App Router)                  |
| **WordPress REST API**      | Fetches content via `/wp-json/wp/v2/` endpoints                 | WordPress sites (40%+ of the web)           |
| **CSS selectors**           | Probes semantic containers (`<article>`, `.post-content`, etc.) | Fallback for unusual layouts                |

**Winner selection:** Strategies that extract 500+ characters are candidates. If text-density or RSC finds 2x more content than Readability, it wins. Otherwise, the longest result is chosen. Metadata (author, date, site name) is composed from the best source for each field across all strategies.

## Responsible Use

**Disclaimer:** This tool is intended for fetching publicly accessible web content. Users are solely responsible for:

- Complying with each website's Terms of Service and `robots.txt` directives
- Ensuring lawful use under applicable laws (including copyright, computer access, and data protection regulations)
- Obtaining necessary permissions before accessing or extracting content

The authors make no warranties about the legality of any specific use case. This tool does not grant permission to access any website or circumvent any access controls.

## License

MIT
