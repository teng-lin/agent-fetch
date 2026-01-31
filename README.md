# LynxGet

<p align="left">
<img src="./assets/lynxget.svg" alt="LynxGet Logo" width="600">
</p>

**wget for the AI agent age** - Stealth fetch with Chrome TLS fingerprinting, multi-strategy content extraction, and anti-bot detection. Fetch articles from the real web without getting blocked.

## Features

- **Chrome TLS fingerprinting** - Uses [httpcloak](https://github.com/nichochar/httpcloak) to spoof Chrome 143+ TLS/HTTP2 fingerprints at the network level
- **Multi-strategy extraction** - Readability, JSON-LD, CSS selectors, unfluff - automatically picks the best strategy per page
- **Anti-bot detection** - Identifies 30+ protection systems (Cloudflare, DataDome, PerimeterX, AWS WAF, Akamai, etc.) with confidence scores and suggested actions
- **CAPTCHA detection** - Detects reCAPTCHA, hCaptcha, Turnstile, FunCaptcha, GeeTest, and more
- **Fingerprint technique detection** - Identifies 21 browser fingerprinting techniques (canvas, WebGL, audio, fonts, etc.)
- **SSRF protection** - Blocks private IPs, validates DNS resolution, enforces response size limits
- **Fast** - 200-700ms median latency, no browser overhead

## Install

```bash
npm install lynxget
```

## Quick Start

### CLI

```bash
# Extract article text
npx lynxget https://example.com/article

# Full JSON output
npx lynxget https://example.com/article --json

# Raw HTML (no extraction)
npx lynxget https://example.com/article --raw

# Anti-bot detection only
npx lynxget https://example.com/article --detect

# Text content only (quiet mode)
npx lynxget https://example.com/article -q
```

### Programmatic

```typescript
import { httpFetch } from 'lynxget';

const result = await httpFetch('https://example.com/article');

if (result.success) {
  console.log(result.title); // "Article Title"
  console.log(result.byline); // "By John Smith"
  console.log(result.textContent); // Clean extracted text
  console.log(result.latencyMs); // 523
}

if (result.antibot?.length) {
  console.log(result.antibot[0].name); // "Cloudflare Bot Management"
  console.log(result.antibot[0].confidence); // 95
}
```

## API Reference

### `httpFetch(url)`

Main entry point. Fetches a URL with stealth TLS fingerprinting, extracts article content, and detects anti-bot protections.

```typescript
import { httpFetch } from 'lynxget';

const result = await httpFetch('https://example.com/article');
```

**Returns** `FetchResult`:

| Field             | Type                  | Description                                                          |
| ----------------- | --------------------- | -------------------------------------------------------------------- |
| `success`         | `boolean`             | Whether extraction succeeded                                         |
| `url`             | `string`              | Fetched URL                                                          |
| `latencyMs`       | `number`              | Total time in milliseconds                                           |
| `title`           | `string?`             | Article title                                                        |
| `byline`          | `string?`             | Author attribution                                                   |
| `content`         | `string?`             | Extracted HTML content                                               |
| `textContent`     | `string?`             | Plain text content                                                   |
| `excerpt`         | `string?`             | Opening paragraph                                                    |
| `siteName`        | `string?`             | Publication name                                                     |
| `publishedTime`   | `string?`             | ISO 8601 publish date                                                |
| `lang`            | `string?`             | Language code                                                        |
| `error`           | `string?`             | Error message on failure                                             |
| `hint`            | `string?`             | Human-readable suggestion                                            |
| `suggestedAction` | `string?`             | `retry_with_extract`, `wait_and_retry`, `skip`, `update_site_config` |
| `antibot`         | `AntibotDetection[]?` | Detected protections                                                 |

### `httpRequest(url, headers?, browserType?)`

Low-level HTTP client with TLS fingerprinting. Returns raw response data without extraction.

```typescript
import { httpRequest } from 'lynxget';

const response = await httpRequest('https://example.com', {
  'Accept-Language': 'en-US,en;q=0.9',
});

console.log(response.statusCode); // 200
console.log(response.html); // Raw HTML
console.log(response.headers); // Response headers
console.log(response.cookies); // Set-Cookie values
```

**Parameters:**

- `url` - Target URL
- `headers` - Optional custom headers (merged with defaults)
- `browserType` - `'chromium'` (default) or `'firefox'`

### `extractFromHtml(html, url)`

Run the multi-strategy content extraction pipeline on HTML.

```typescript
import { extractFromHtml } from 'lynxget';

const result = extractFromHtml(html, 'https://example.com/article');
if (result) {
  console.log(result.title);
  console.log(result.textContent);
}
```

### Anti-Bot Detection

Detect which protection systems are present from HTTP response data or HTML content.

```typescript
import {
  detectFromResponse,
  detectFromHtml,
  mergeDetections,
  hasCaptcha,
  hasAntibot,
  hasFingerprinting,
  filterAntibotOnly,
  filterCaptchaOnly,
  filterFingerprintOnly,
  formatDetections,
} from 'lynxget';

// Detect from response headers and cookies
const headerDetections = detectFromResponse({ 'cf-ray': 'abc123', server: 'cloudflare' }, [
  '__cf_bm=xyz; Path=/',
]);

// Detect from HTML content
const htmlDetections = detectFromHtml(html);

// Combine results (deduplicates by provider, keeps highest confidence)
const all = mergeDetections(headerDetections, htmlDetections);

// Boolean checks
hasCaptcha(all); // true if any CAPTCHA detected
hasAntibot(all); // true if any anti-bot system detected
hasFingerprinting(all); // true if any fingerprinting technique detected

// Filter by category
filterAntibotOnly(all); // Cloudflare, DataDome, PerimeterX, etc.
filterCaptchaOnly(all); // reCAPTCHA, hCaptcha, Turnstile, etc.
filterFingerprintOnly(all); // Canvas, WebGL, audio fingerprinting, etc.

// Human-readable format
console.log(formatDetections(all));
// "Cloudflare Bot Management (95% confidence, action: give-up) [cookie: __cf_bm, header: cf-ray]"
```

**`AntibotDetection` shape:**

```typescript
{
  provider: string;        // e.g. 'cloudflare', 'perimeterx'
  name: string;            // e.g. 'Cloudflare Bot Management'
  category: 'antibot' | 'captcha' | 'fingerprint';
  confidence: number;      // 0-100
  evidence: string[];      // What triggered detection
  suggestedAction: 'retry-tls' | 'try-archive' | 'retry-headers'
                 | 'solve-captcha' | 'give-up' | 'unknown';
}
```

### Detected Systems

**Anti-bot (8):** AWS WAF, Cloudflare Bot Management, PerimeterX (HUMAN), DataDome, Akamai Bot Manager, Incapsula (Imperva), Shape Security (F5), Kasada

**CAPTCHAs (7):** reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile, FunCaptcha (Arkose Labs), GeeTest, Friendly Captcha

**Fingerprinting (3 libraries):** FingerprintJS, BotD, CreepJS

**Fingerprinting techniques (21):** Audio, Battery, Canvas, Clipboard, Crypto, CSS, Font, Gamepad, Geolocation, Hardware, IndexedDB, Media Devices, Navigator, Orientation, Performance, Screen, Storage, Timezone, USB, WebGL, WebRTC

### Session Management

```typescript
import { getSession, closeAllSessions } from 'lynxget';

// Get a reusable TLS session
const session = await getSession('chromium');

// Clean up when done (closes all httpcloak sessions)
await closeAllSessions();
```

### Site Configuration

```typescript
import { getSiteConfig, getSiteUserAgent, getSiteReferer } from 'lynxget';

const config = getSiteConfig('example.com');
const ua = getSiteUserAgent('example.com');
const referer = getSiteReferer('example.com');
```

### Content Validation

```typescript
import { quickValidate } from 'lynxget';

// Quickly check if a response looks like real content vs a challenge page
const validation = quickValidate(statusCode, contentType, html);
if (!validation.valid) {
  console.log(validation.error); // 'challenge_detected'
  console.log(validation.errorDetails); // { challengeType: 'cloudflare' }
}
```

## CLI Reference

```
Usage: lynxget <url> [options]

Options:
  --json      Full JSON output (title, content, antibot detections, etc)
  --raw       Raw HTML output (no extraction)
  --detect    Show antibot detection only
  -q, --quiet Text content only (no metadata)
  -h, --help  Show this help message
```

**Default output:**

```
Title: Article Title
Author: John Smith
Site: Example News
Published: 2025-01-26T12:00:00Z
Language: en
Fetched in 523ms
---
[Extracted article text...]
```

**Detection output** (`--detect`):

```
Antibot detections for https://example.com:

  Cloudflare Bot Management (antibot)
    Confidence: 95%
    Action: give-up
    Evidence: cookie: __cf_bm, header: cf-ray
```

## How It Works

### TLS Fingerprinting

Standard HTTP clients (fetch, axios, got) have distinctive TLS fingerprints that bot detection systems identify instantly. LynxGet uses [httpcloak](https://github.com/nichochar/httpcloak) to present Chrome 143+ TLS/HTTP2 fingerprints, making requests indistinguishable from a real browser at the network level.

### Content Extraction Pipeline

LynxGet tries multiple extraction strategies and picks the best result:

1. **Next.js `__NEXT_DATA__`** - Structured data from Next.js pages (when site config specifies)
2. **JSON-LD** - Schema.org structured data embedded in pages
3. **Mozilla Readability** - The algorithm behind Firefox Reader View
4. **CSS selectors** - Site-specific selectors for known layouts
5. **unfluff** - Python-goose port for general article extraction

### Security

- **SSRF protection** - Blocks requests to private IPs (10.x, 172.16.x, 192.168.x, localhost)
- **DNS rebinding protection** - Re-validates resolved IPs after connection
- **Response size limits** - 10MB max response body
- **Request timeout** - 10 second default

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev -- https://example.com/article

# Run tests
npm test

# Run E2E tests (hits real websites)
npm run test:e2e:fetch

# Build
npm run build

# Lint & format
npm run lint
npm run format
```

## E2E Testing & Report Generation

LynxGet includes E2E tests that validate fetching and extraction against real websites. These tests are configurable via environment variables and can generate detailed reports.

### Site Fixtures

E2E tests require a `site-fixtures.json` file containing test URLs and validation criteria. You can specify its location via the `SITE_FIXTURES` environment variable.

**Example site-fixtures.json:**

```json
[
  {
    "site": "Tech Blog",
    "stable": {
      "url": "https://example-tech-blog.com/article/future-of-ai",
      "minWords": 800
    },
    "latest": {
      "url": "https://example-tech-blog.com/article/latest-post",
      "minWords": 500
    },
    "priority": "critical",
    "tags": ["tech", "ai"],
    "expectedToFail": false
  },
  {
    "site": "News Site",
    "stable": {
      "url": "https://example-news.com/breaking-news",
      "minWords": 400
    },
    "priority": "important",
    "tags": ["news", "paywall"],
    "expectedToFail": true
  }
]
```

**Field reference:**

- `site` - Display name for the test
- `stable.url` - Primary test URL (always tested)
- `stable.minWords` - Minimum word count for success
- `latest.url` - Optional secondary URL for latest content
- `latest.minWords` - Min words for latest URL
- `priority` - `"critical"` or `"important"` (for filtering)
- `tags` - Array of tags for categorization
- `expectedToFail` - If true, failures are reported but don't fail the test

### Running E2E Tests

```bash
# Basic E2E test (vitest-based, stable URLs only)
npm run test:e2e

# Run with custom fixture file
SITE_FIXTURES=/path/to/fixtures.json npm run test:e2e

# Filter by priority
TEST_PRIORITY=critical npm run test:e2e

# Filter by tags
TEST_TAGS=paywall,cookies npm run test:e2e

# Filter by site names
TEST_SITES="Tech Blog,News Site" npm run test:e2e

# Adjust concurrency (default: 5)
TEST_CONCURRENCY=10 npm run test:e2e

# Test both stable and latest URLs
TEST_SET=all npm run test:e2e
```

### Generating Comparison Reports

The report generator compares lynxget's httpFetch against standard HTTP clients to measure the impact of Chrome TLS fingerprinting.

#### Comparison Options

You can test against one, two, or all three methods:

```bash
# THREE-WAY COMPARISON (default) - httpFetch vs curl vs Node.js
npm run test:e2e:all

# httpFetch ONLY - baseline performance
COMPARE_CURL=false COMPARE_NODE=false npm run test:e2e:all

# httpFetch vs curl - measures TLS + UA advantage
COMPARE_NODE=false npm run test:e2e:all

# httpFetch vs Node.js - isolates TLS fingerprinting impact
COMPARE_CURL=false npm run test:e2e:all
```

#### What Each Comparison Measures

| Comparison     | httpFetch              | vs             | Measures                           |
| -------------- | ---------------------- | -------------- | ---------------------------------- |
| **vs curl**    | Chrome TLS + Chrome UA | Googlebot UA   | Combined TLS + UA advantage        |
| **vs Node.js** | Chrome TLS + Chrome UA | Chrome UA only | Pure TLS fingerprinting impact     |
| **Three-way**  | All three methods      | -              | Full picture of evasion techniques |

#### Generate Report

```bash
# Run comparison and generate markdown report
npm run test:e2e:all
npm run report:fetch

# Or combine in one command
npm run test:e2e:all && \
  npm run report:fetch > /tmp/e2e-report-$(date +%Y-%m-%d).md
```

#### Report Contents

The report includes:

- **Success rates** - Side-by-side comparison of all tested methods
- **Overlap analysis** - Sites accessible to which combinations
- **Performance metrics** - Latency and word count distributions
- **Complete comparison table** - Every site with all methods
- **Bot protection breakdown** - Which protections were detected

**Example three-way comparison results:**

```
Total: 235 sites
- httpFetch: 214 (91%) - Chrome TLS fingerprinting
- Node.js:   203 (86%) - Chrome UA only
- curl:      166 (71%) - Googlebot UA

Key findings:
- TLS fingerprinting worth: 5% (httpFetch 91% vs Node.js 86%)
- User agent matters: 15% (Node.js 86% vs curl 71%)
- Combined advantage: 20% (httpFetch 91% vs curl 71%)
- httpFetch exclusive wins: 23 sites
```

## License

MIT
