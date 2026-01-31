#!/usr/bin/env npx tsx
/**
 * Generate httpFetch vs curl comparison report from TSV output
 *
 * Usage: generate-fetch-vs-curl-report.ts <tsv-file>
 *
 * Example:
 *   npx tsx scripts/test-fetch-vs-curl.ts /tmp/fetch-vs-curl.tsv
 *   npx tsx scripts/generate-fetch-vs-curl-report.ts /tmp/fetch-vs-curl.tsv \
 *     > docs/e2e/2026-01-31-fetch-vs-curl-comparison-run1.md
 */

import { existsSync, readFileSync } from 'fs';

// --- Constants ---

const EXPECTED_TSV_COLUMNS = 10;

// --- Types ---

interface FetchResult {
  site: string;
  url: string;
  fetchSuccess: boolean;
  fetchWords: number;
  fetchError: string;
  fetchMs: number;
  curlSuccess: boolean;
  curlWords: number;
  curlStatus: number;
  curlMs: number;
}

// --- Helpers ---

function escapeMd(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/`/g, '\\`').replace(/\n/g, ' ');
}

function isValidNumber(value: number): boolean {
  return !isNaN(value) && isFinite(value) && value >= 0;
}

function pct(count: number, total: number): string {
  if (total === 0) return '0%';
  return `${((count / total) * 100).toFixed(1)}%`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

// --- Parse ---

function parseTsv(filePath: string): FetchResult[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');

  return lines
    .slice(1)
    .filter((line) => line.trim())
    .map((line, lineIndex) => {
      const v = line.split('\t');
      if (v.length !== EXPECTED_TSV_COLUMNS) {
        console.warn(`Warning: Line ${lineIndex + 2} has ${v.length} columns, skipping`);
        return null;
      }

      const fetchWords = parseInt(v[2]);
      const fetchMs = parseInt(v[4]);
      const curlWords = parseInt(v[6]);
      const curlStatus = parseInt(v[7]);
      const curlMs = parseInt(v[8]);

      if (
        !isValidNumber(fetchWords) ||
        !isValidNumber(fetchMs) ||
        !isValidNumber(curlWords) ||
        !isValidNumber(curlStatus) ||
        !isValidNumber(curlMs)
      ) {
        console.warn(`Warning: Skipping malformed line: ${v[0]}`);
        return null;
      }

      return {
        site: v[0] || 'unknown',
        fetchSuccess: v[1]?.toLowerCase() === 'true',
        fetchWords,
        fetchError: v[3] || '',
        fetchMs,
        curlSuccess: v[5]?.toLowerCase() === 'true',
        curlWords,
        curlStatus: curlStatus || 0,
        curlMs,
        url: v[9] || '',
      };
    })
    .filter((r): r is FetchResult => r !== null);
}

// --- CLI ---

const tsvPath = process.argv[2];

if (!tsvPath) {
  console.error('Usage: generate-fetch-vs-curl-report.ts <tsv-file>');
  console.error(
    'Example: generate-fetch-vs-curl-report.ts /tmp/fetch-vs-curl.tsv > docs/e2e/2026-01-31-fetch-vs-curl-comparison-run1.md'
  );
  process.exit(1);
}

if (!existsSync(tsvPath)) {
  console.error(`Error: File not found: ${tsvPath}`);
  process.exit(1);
}

// --- Classify results ---

const results = parseTsv(tsvPath);
const total = results.length;

const bothOk = results.filter((r) => r.fetchSuccess && r.curlSuccess);
const fetchOnly = results.filter((r) => r.fetchSuccess && !r.curlSuccess);
const curlOnly = results.filter((r) => !r.fetchSuccess && r.curlSuccess);
const neither = results.filter((r) => !r.fetchSuccess && !r.curlSuccess);

const fetchOkCount = results.filter((r) => r.fetchSuccess).length;
const curlOkCount = results.filter((r) => r.curlSuccess).length;

// Sub-classify fetchOnly by curl status
const fetchOnlyBy403 = fetchOnly.filter((r) => r.curlStatus === 403 || r.curlStatus === 401);
const fetchOnlyOther = fetchOnly.filter((r) => r.curlStatus !== 403 && r.curlStatus !== 401);

// Sub-classify curlOnly by fetch error
const curlOnlyByChallenge = curlOnly.filter((r) => r.fetchError === 'challenge_detected');
const curlOnlyByContent = curlOnly.filter(
  (r) => r.fetchError === 'insufficient_content' || r.fetchError === 'body_too_small'
);
const curlOnlyOther = curlOnly.filter(
  (r) =>
    r.fetchError !== 'challenge_detected' &&
    r.fetchError !== 'insufficient_content' &&
    r.fetchError !== 'body_too_small'
);

// Word count / latency stats for both-OK sites
const bothFetchWords = bothOk.map((r) => r.fetchWords);
const bothCurlWords = bothOk.map((r) => r.curlWords);
const bothFetchMs = bothOk.map((r) => r.fetchMs);
const bothCurlMs = bothOk.map((r) => r.curlMs);

const date = new Date().toLocaleDateString('en-CA');

// --- Generate report ---

const report = `# httpFetch vs curl Comparison Report

**Date**: ${date}
**httpFetch**: lynxget httpcloak (Chrome TLS fingerprint)
**curl**: Googlebot UA (\`Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)\`), 15s timeout, follow redirects
**Fixture source**: \`site-fixtures.json\` (via \`SITE_FIXTURES\` env var)

## Executive Summary

| Metric | Count | Rate |
| --- | --- | --- |
| Total sites tested | ${total} | |
| httpFetch success | ${fetchOkCount} | ${pct(fetchOkCount, total)} |
| curl success | ${curlOkCount} | ${pct(curlOkCount, total)} |
| **Both succeed** | **${bothOk.length}** | **${pct(bothOk.length, total)}** |
| **httpFetch only** | **${fetchOnly.length}** | **${pct(fetchOnly.length, total)}** |
| **curl only** | **${curlOnly.length}** | **${pct(curlOnly.length, total)}** |
| **Neither** | **${neither.length}** | **${pct(neither.length, total)}** |

httpcloak TLS fingerprinting provides a **net gain of +${fetchOnly.length - curlOnly.length} sites** (${fetchOnly.length} won − ${curlOnly.length} lost) over plain curl with Googlebot UA.

A combined strategy (httpFetch + Googlebot curl fallback) would reach **${fetchOkCount + curlOnly.length}/${total} (${pct(fetchOkCount + curlOnly.length, total)})** — only the ${neither.length} "neither" sites would remain, requiring browser automation.

## Sites Where httpFetch Wins (${fetchOnly.length} sites)

These sites block curl (Googlebot UA) but httpFetch succeeds via Chrome TLS fingerprinting.

### Bot-blocked sites (curl 401/403) — ${fetchOnlyBy403.length} sites

| Site | Fetch Words | Fetch ms | curl Status |
| --- | --- | --- | --- |
${fetchOnlyBy403
  .sort((a, b) => a.site.localeCompare(b.site))
  .map((r) => `| ${escapeMd(r.site)} | ${r.fetchWords} | ${r.fetchMs} | ${r.curlStatus} |`)
  .join('\n')}
${
  fetchOnlyOther.length > 0
    ? `
### Other curl failures — ${fetchOnlyOther.length} sites

| Site | Fetch Words | Fetch ms | curl Status | Notes |
| --- | --- | --- | --- | --- |
${fetchOnlyOther
  .sort((a, b) => a.site.localeCompare(b.site))
  .map((r) => {
    let notes = '';
    if (r.curlStatus === 429) notes = 'Rate limited';
    else if (r.curlStatus === 500) notes = 'Server error on Googlebot';
    else if (r.curlStatus === 0) notes = 'curl timeout/connection failure';
    else notes = `HTTP ${r.curlStatus}`;
    return `| ${escapeMd(r.site)} | ${r.fetchWords} | ${r.fetchMs} | ${r.curlStatus} | ${notes} |`;
  })
  .join('\n')}
`
    : ''
}
### Summary

- **${fetchOnlyBy403.length}/${fetchOnly.length} (${pct(fetchOnlyBy403.length, fetchOnly.length)})** are sites returning HTTP 401/403 to Googlebot — they have explicit bot blocking that httpcloak's Chrome TLS fingerprint bypasses.
- Median word count: ${median(fetchOnly.map((r) => r.fetchWords))} words.

## Sites Where curl Wins (${curlOnly.length} sites)

These sites allow Googlebot but block or challenge httpcloak's Chrome TLS fingerprint.

| Site | curl Words | curl Status | Fetch Error | Notes |
| --- | --- | --- | --- | --- |
${curlOnly
  .sort((a, b) => a.site.localeCompare(b.site))
  .map((r) => {
    let notes = '';
    if (r.fetchError === 'challenge_detected') notes = 'Cloudflare challenge';
    else if (r.fetchError === 'insufficient_content') notes = 'Content extraction issue';
    else if (r.fetchError === 'body_too_small') notes = 'Accepted but empty';
    else if (r.fetchError === 'http_error') notes = 'HTTP error';
    else notes = r.fetchError;
    return `| ${escapeMd(r.site)} | ${r.curlWords} | ${r.curlStatus} | \`${escapeMd(r.fetchError)}\` | ${notes} |`;
  })
  .join('\n')}

### Analysis

- **${curlOnlyByChallenge.length}/${curlOnly.length} (${pct(curlOnlyByChallenge.length, curlOnly.length)})** are Cloudflare \`challenge_detected\`: These sites use Cloudflare bot protection that specifically challenges Chrome-like TLS fingerprints but whitelists Googlebot.
- **${curlOnlyByContent.length}/${curlOnly.length}** are content extraction issues (\`insufficient_content\`/\`body_too_small\`): These are potentially fixable with better site configs.
${curlOnlyOther.length > 0 ? `- **${curlOnlyOther.length}/${curlOnly.length}** are other errors (HTTP errors, timeouts).\n` : ''}
## Sites Where Neither Succeeds (${neither.length} sites)

These sites need **browser automation** (Playwright extraction) to succeed.

| Site | Fetch Error | curl Status | Notes |
| --- | --- | --- | --- |
${neither
  .sort((a, b) => a.site.localeCompare(b.site))
  .map((r) => {
    let notes = '';
    if (r.fetchError.includes('challenge') && r.curlStatus === 403) notes = 'Heavy bot protection';
    else if (r.fetchError.includes('http_error') && r.curlStatus === 401) notes = 'Hard paywall';
    else if (r.fetchError.includes('http_error') && r.curlStatus === 403)
      notes = 'Paywall + bot block';
    else if (r.fetchError.includes('insufficient') && r.curlStatus === 403)
      notes = 'JS rendering required';
    else if (r.fetchError.includes('timeout')) notes = 'Slow + blocked';
    else notes = `${r.fetchError}`;
    return `| ${escapeMd(r.site)} | \`${escapeMd(r.fetchError)}\` | ${r.curlStatus} | ${notes} |`;
  })
  .join('\n')}

## Word Count Comparison (${bothOk.length} both-OK sites)

For sites where both httpFetch and curl succeed:

| Metric | httpFetch | curl |
| --- | --- | --- |
| Median words | ${median(bothFetchWords)} | ${median(bothCurlWords)} |
| Mean words | ${mean(bothFetchWords)} | ${mean(bothCurlWords)} |

curl returns significantly more words because it receives raw HTML (Googlebot often gets full unpaywalled content), while httpFetch extracts via Readability which strips boilerplate, navigation, and ads. The httpFetch word counts represent clean article text.

## Latency Comparison (${bothOk.length} both-OK sites)

| Metric | httpFetch | curl |
| --- | --- | --- |
| Median ms | ${median(bothFetchMs)} | ${median(bothCurlMs)} |
| Mean ms | ${mean(bothFetchMs)} | ${mean(bothCurlMs)} |

## Key Takeaways

1. **httpcloak adds ${fetchOnly.length} sites (+${pct(fetchOnly.length, total)})** that plain curl cannot reach — these are sites with bot UA blocking that Chrome TLS fingerprinting bypasses.

2. **curl retains access to ${curlOnly.length} sites (${pct(curlOnly.length, total)})** that httpcloak cannot reach — mostly Cloudflare-protected sites that whitelist Googlebot but challenge Chrome-like fingerprints.

3. **A combined strategy would reach ${fetchOkCount + curlOnly.length}/${total} (${pct(fetchOkCount + curlOnly.length, total)})** — only the ${neither.length} "neither" sites would remain, all requiring browser automation.

4. **${curlOnlyByContent.length} of the ${curlOnly.length} curl-only wins are likely fixable** — they're content extraction bugs, not access failures.
`;

console.log(report);
