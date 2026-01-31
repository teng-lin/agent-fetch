---
name: lynxget
description: Fetch and extract content from URLs using lynxget CLI with stealth TLS fingerprinting. Use when WebFetch fails (403, 429, bot protection) or when you need reliable article extraction from protected sites.
---

# LynxGet Skill

**A better WebFetch for Claude Code.** LynxGet is a CLI/library that fetches web content with Chrome TLS fingerprinting, bypassing bot detection that blocks standard HTTP clients. No server required - runs as a local CLI tool.

## When to Use This Skill

**Automatic:** When user asks to read/fetch/summarize a URL and WebFetch returns 403, 429, or empty/garbled content due to bot protection.

**Explicit:** When user types `/lynxget <url>` or asks to use lynxget.

**Instead of WebFetch:** For sites with bot protection, CAPTCHAs, or access gates.

## Prerequisites

LynxGet must be installed. Check with:

```bash
npx lynxget --help
```

If not available, install:

```bash
npm install -g lynxget
```

## Commands

### `/lynxget <url>` - Fetch and Extract Article

**Default usage.** Fetches URL with stealth TLS fingerprinting and extracts article content.

```bash
npx lynxget "<url>" --json
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

{textContent}
```

**If fetch fails**, check `suggestedAction` in the JSON:

| suggestedAction      | What it means            | Next action                           |
| -------------------- | ------------------------ | ------------------------------------- |
| `retry_with_extract` | Needs full browser       | Inform user; lynxget CLI is HTTP-only |
| `wait_and_retry`     | Rate limited             | Wait 60s and retry                    |
| `skip`               | Cannot access this site  | Try WebFetch or inform user           |
| `update_site_config` | Site config may be stale | Inform user                           |

### `/lynxget detect <url>` - Anti-Bot Detection

Identify which protection systems a site uses.

```bash
npx lynxget "<url>" --detect --json
```

**Format output:**

```
Anti-bot detections for {url}:

  {name} ({category})
    Confidence: {confidence}%
    Action: {suggestedAction}
    Evidence: {evidence joined}
```

### `/lynxget raw <url>` - Raw HTML

Fetch raw HTML without extraction. Useful for debugging or custom parsing.

```bash
npx lynxget "<url>" --raw
```

### `/lynxget quiet <url>` - Text Only

Just the article text, no metadata.

```bash
npx lynxget "<url>" -q
```

## Error Handling

### Bot Protection Detected

When lynxget detects antibot systems, it reports them in the `antibot` array. Common detections:

- **Cloudflare Bot Management** (action: `give-up`) - Very difficult to bypass with HTTP-only
- **AWS WAF** (action: `retry-tls`) - May work on retry
- **DataDome / PerimeterX** (action: `try-archive`) - Suggest user try archive.org
- **CAPTCHA detected** (action: `solve-captcha`) - Cannot solve in CLI mode

### Fallback Strategy

If lynxget fails:

1. Check if antibot was detected in the response
2. If `suggestedAction` is `retry-tls`, retry once
3. If site has heavy protection (Cloudflare, DataDome), suggest user try:
   - archive.org/web/ for cached version
   - Google cache

## Automatic Triggering

This skill should activate when:

- User asks to read/fetch/summarize a URL
- WebFetch returns 403, 429, or timeout errors
- Previous fetch attempt returned bot protection indicators
- User mentions "blocked", "bot protection", or "can't access"

**Fallback chain:** Try WebFetch first (faster, no install needed) → If it fails with 403/429/empty → Use lynxget

## Programmatic Usage

For more complex scenarios, lynxget can be used as a library in scripts:

```typescript
import { httpFetch, detectFromResponse, detectFromHtml } from 'lynxget';

// Full fetch + extract
const result = await httpFetch(url);

// Detection only
const headerDetections = detectFromResponse(headers, cookies);
const htmlDetections = detectFromHtml(html);
```

## Comparison to WebFetch

| Feature            | LynxGet CLI   | WebFetch      |
| ------------------ | ------------- | ------------- |
| **Speed**          | 200-700ms     | 2-5s          |
| **Bot protection** | Chrome TLS FP | Basic headers |
| **JavaScript**     | No            | Yes           |
| **Install needed** | Yes (npm)     | No (built-in) |
| **Self-hosted**    | Yes           | No            |
| **Antibot detect** | 30+ systems   | None          |

**Recommendation:** Use WebFetch first. Fall back to lynxget when WebFetch fails on protected sites.
