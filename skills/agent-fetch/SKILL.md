---
name: agent-fetch
description: Fetch and extract full article content from URLs. Returns complete text with structure (headings, links, lists) instead of summaries. Multiple extraction strategies, browser impersonation, cookies, crawling, custom selectors, 200-700ms.
---

# agent-fetch Skill

**A better web fetch for text content.** Your built-in web fetch summarizes or truncates pages. agent-fetch extracts the complete article — every paragraph, heading, and link — using 7 extraction strategies and browser impersonation. No server required, runs as a local CLI tool.

## When to Use This Skill

**Use agent-fetch whenever you need to read a URL.** It returns full article text with structure preserved — better than your built-in web fetch for any task involving page content.

- User asks to read, fetch, or analyze a URL
- User types `/agent-fetch <url>`
- You need the full text, not a summary or truncation
- Your built-in web fetch returned incomplete or garbled content

## Prerequisites

agent-fetch runs via npx (no install needed):

```bash
npx agent-fetch --help
```

## Commands

### `/agent-fetch <url>` - Fetch and Extract Article

**Default usage.** Fetches URL with browser impersonation and extracts complete article content as markdown.

```bash
npx agent-fetch "<url>" --json
```

**Parse the JSON output** and present to the user:

```markdown
---
title: {title}
author: {byline || "Unknown"}
source: {siteName}
url: {url}
date: {publishedTime || "Unknown"}
fetched_in: {latencyMs}ms
---

## {markdown || textContent}

{markdown || textContent}
```

**If fetch fails**, check `suggestedAction` in the JSON:

| suggestedAction      | What it means           | Next action                           |
| -------------------- | ----------------------- | ------------------------------------- |
| `retry_with_extract` | Needs full browser      | Inform user; agent-fetch is HTTP-only |
| `wait_and_retry`     | Rate limited            | Wait 60s and retry                    |
| `skip`               | Cannot access this site | Inform user                           |

### `/agent-fetch raw <url>` - Raw HTML

Fetch raw HTML without extraction.

```bash
npx agent-fetch "<url>" --raw
```

### `/agent-fetch quiet <url>` - Markdown Only

Just the article markdown, no metadata.

```bash
npx agent-fetch "<url>" -q
```

### `/agent-fetch text <url>` - Plain Text Only

Plain text content without formatting or metadata.

```bash
npx agent-fetch "<url>" --text
```

### `/agent-fetch cookies` - Use Persistent Cookies

Load cookies from a Netscape format file or pass inline:

```bash
# From Netscape cookie file (export from browser)
npx agent-fetch "<url>" --cookie-file ~/.cookies.txt

# Inline cookies (repeatable)
npx agent-fetch "<url>" --cookie "sessionId=abc123; theme=dark"
```

### `/agent-fetch selectors <url>` - Custom CSS Selectors

Extract specific elements or remove unwanted ones:

```bash
# Extract only the article, remove navigation and ads
npx agent-fetch "<url>" --select "article" --remove "nav, .sidebar, [class*='ad']"

# Extract all divs with class "post-content"
npx agent-fetch "<url>" --select ".post-content"
```

### `/agent-fetch crawl <url>` - Crawl Multiple Pages

Follow links and extract content from multiple pages:

```bash
# Crawl with defaults (depth: 3, max 100 pages)
npx agent-fetch crawl "<url>"

# Deeper crawl with concurrency control
npx agent-fetch crawl "<url>" --depth 5 --limit 50 --concurrency 3

# Include/exclude specific URL patterns
npx agent-fetch crawl "<url>" --include "*/blog/*" --exclude "**/archive/**"

# Add rate limiting delay between requests
npx agent-fetch crawl "<url>" --delay 1000

# Allow cross-origin (stay on same origin by default)
npx agent-fetch crawl "<url>" --no-same-origin

# Output as JSONL for processing
npx agent-fetch crawl "<url>" --json
```

### `/agent-fetch pdf <file>` - Extract from PDF

Extract text content from local PDF files:

```bash
# Extract PDF as markdown with metadata
npx agent-fetch document.pdf

# JSON output for programmatic access
npx agent-fetch document.pdf --json

# Just the text content
npx agent-fetch document.pdf --text
```

### `/agent-fetch preset` - Custom TLS Fingerprint

Impersonate different browsers to bypass fingerprinting checks:

```bash
# Chrome 143 (default)
npx agent-fetch "<url>" --preset "chrome-143"

# iOS Safari 18
npx agent-fetch "<url>" --preset "ios-safari-18"

# Android Chrome 143
npx agent-fetch "<url>" --preset "android-chrome-143"
```