#!/usr/bin/env npx tsx
/**
 * Generate comprehensive fetch E2E test report from TSV output
 *
 * Usage: generate-fetch-e2e-report.ts <tsv-file>
 *
 * Example:
 *   npx tsx scripts/test-fetch-vs-curl.ts /tmp/fetch-results.tsv
 *   npx tsx scripts/generate-fetch-e2e-report.ts /tmp/fetch-results.tsv > docs/e2e/2026-01-31-fetch-report-run1.md
 */

import { existsSync, readFileSync } from 'fs';

// --- Constants ---

const EXPECTED_TSV_COLUMNS = 15;

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
  nodeSuccess: boolean;
  nodeWords: number;
  nodeStatus: number;
  nodeMs: number;
  antibot: string[];
}

interface DistributionStats {
  min: number;
  p10: number;
  median: number;
  mean: number;
  p90: number;
  max: number;
}

// --- Helpers ---

function escapeMd(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/`/g, '\\`').replace(/\n/g, ' ');
}

function isValidNumber(value: number): boolean {
  return !isNaN(value) && isFinite(value) && value >= 0;
}

function computeStats(values: number[]): DistributionStats {
  if (values.length === 0) {
    return { min: 0, p10: 0, median: 0, mean: 0, p90: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0],
    p10: sorted[Math.floor(sorted.length * 0.1)],
    median: sorted[Math.floor(sorted.length / 2)],
    mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    p90: sorted[Math.floor(sorted.length * 0.9)],
    max: sorted[sorted.length - 1],
  };
}

function pct(count: number, total: number): string {
  if (total === 0) return '0%';
  return `${((count / total) * 100).toFixed(0)}%`;
}

// --- CLI entry ---

const tsvPath = process.argv[2];

if (!tsvPath) {
  console.error('Usage: generate-fetch-e2e-report.ts <tsv-file>');
  console.error('Example: generate-fetch-e2e-report.ts /tmp/fetch-results.tsv');
  process.exit(1);
}

if (!existsSync(tsvPath)) {
  console.error(`Error: File not found: ${tsvPath}`);
  console.error('\nMake sure to run test-fetch-vs-curl.ts first:');
  console.error('  npx tsx scripts/test-fetch-vs-curl.ts /tmp/fetch-results.tsv');
  process.exit(1);
}

// --- Parse TSV ---

function parseTsv(filePath: string): FetchResult[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');

  return lines
    .slice(1)
    .filter((line) => line.trim())
    .map((line, lineIndex) => {
      const v = line.split('\t');

      if (v.length !== EXPECTED_TSV_COLUMNS) {
        console.warn(
          `Warning: Line ${lineIndex + 2} has ${v.length} columns (expected ${EXPECTED_TSV_COLUMNS}), skipping`
        );
        return null;
      }

      const fetchWords = parseInt(v[2]);
      const fetchMs = parseInt(v[4]);
      const curlWords = parseInt(v[6]);
      const curlStatus = parseInt(v[7]);
      const curlMs = parseInt(v[8]);
      const nodeWords = parseInt(v[10]);
      const nodeStatus = parseInt(v[11]);
      const nodeMs = parseInt(v[12]);

      if (
        !isValidNumber(fetchWords) ||
        !isValidNumber(fetchMs) ||
        !isValidNumber(curlWords) ||
        !isValidNumber(curlStatus) ||
        !isValidNumber(curlMs) ||
        !isValidNumber(nodeWords) ||
        !isValidNumber(nodeStatus) ||
        !isValidNumber(nodeMs)
      ) {
        console.warn(`Warning: Skipping malformed line with invalid numbers: ${v[0]}`);
        return null;
      }

      const antibotRaw = v[14] || '';
      const antibot = antibotRaw
        ? antibotRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

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
        nodeSuccess: v[9]?.toLowerCase() === 'true',
        nodeWords,
        nodeStatus: nodeStatus || 0,
        nodeMs,
        url: v[13] || '',
        antibot,
      };
    })
    .filter((r): r is FetchResult => r !== null);
}

const results = parseTsv(tsvPath);

// --- Compute all statistics ---

const total = results.length;
const fetchSuccessResults = results.filter((r) => r.fetchSuccess);
const fetchFailedResults = results.filter((r) => !r.fetchSuccess);
const curlSuccessCount = results.filter((r) => r.curlSuccess).length;

const fetchSuccessCount = fetchSuccessResults.length;
const fetchFailedCount = fetchFailedResults.length;

const wordStats = computeStats(fetchSuccessResults.map((r) => r.fetchWords));
const latencyStats = computeStats(fetchSuccessResults.map((r) => r.fetchMs));

// --- Antibot statistics ---

const resultsWithAntibot = results.filter((r) => r.antibot.length > 0);
const antibotProviderCounts = new Map<string, number>();
for (const r of resultsWithAntibot) {
  for (const provider of r.antibot) {
    antibotProviderCounts.set(provider, (antibotProviderCounts.get(provider) || 0) + 1);
  }
}

// --- Generate report ---

const date = new Date().toLocaleDateString('en-CA');

// Sort all results alphabetically by site name for comparison table
const sortedResults = [...results].sort((a, b) => a.site.localeCompare(b.site));

// Format comparison table row
function formatComparisonRow(r: FetchResult): string {
  const fetchStatus = r.fetchSuccess ? '✓' : '✗';
  const fetchWords = r.fetchSuccess ? String(r.fetchWords) : '-';
  const fetchMs = r.fetchSuccess ? String(r.fetchMs) : '-';
  const fetchError = !r.fetchSuccess ? r.fetchError.substring(0, 20) : '';

  const curlStatus = r.curlSuccess ? '✓' : '✗';
  const curlWords = r.curlSuccess ? String(r.curlWords) : '-';
  const curlMs = r.curlSuccess ? String(r.curlMs) : '-';

  const nodeStatus = r.nodeSuccess ? '✓' : '✗';
  const nodeWords = r.nodeSuccess ? String(r.nodeWords) : '-';
  const nodeMs = r.nodeSuccess ? String(r.nodeMs) : '-';

  const antibot = r.antibot.length > 0 ? r.antibot.join(', ').substring(0, 30) : '';

  return `| ${escapeMd(r.site)} | ${fetchStatus} | ${fetchWords} | ${fetchMs} | ${curlStatus} | ${curlWords} | ${curlMs} | ${nodeStatus} | ${nodeWords} | ${nodeMs} | ${escapeMd(antibot)} | ${fetchError ? `\`${escapeMd(fetchError)}\`` : ''} |`;
}

const nodeSuccessCount = results.filter((r) => r.nodeSuccess).length;
const allThreeOk = results.filter((r) => r.fetchSuccess && r.curlSuccess && r.nodeSuccess).length;

const report = `# Three-Way E2E Comparison Report

**Date**: ${date}
**Methods**:
- **httpFetch**: lynxget with Chrome TLS fingerprint (httpcloak)
- **curl**: Standard curl with Googlebot user agent
- **node**: Node.js built-in fetch with Chrome user agent

**Fixture source**: \`site-fixtures.json\` (via \`SITE_FIXTURES\` env var)

## Executive Summary

**Total Sites Tested:** ${total}

### Success Rate Comparison

| Method | Success | Failed | Success Rate |
| ------ | ------- | ------ | ------------ |
| **httpFetch (Chrome TLS)** | **${fetchSuccessCount}** | ${fetchFailedCount} | **${pct(fetchSuccessCount, total)}** |
| curl (Googlebot UA) | ${curlSuccessCount} | ${total - curlSuccessCount} | ${pct(curlSuccessCount, total)} |
| Node.js fetch (Chrome UA) | ${nodeSuccessCount} | ${total - nodeSuccessCount} | ${pct(nodeSuccessCount, total)} |

**Key Findings:**
- httpFetch advantage over curl: **+${fetchSuccessCount - curlSuccessCount} sites (+${((fetchSuccessCount / total - curlSuccessCount / total) * 100).toFixed(0)}%)**
- httpFetch advantage over Node.js: **+${fetchSuccessCount - nodeSuccessCount} sites (+${((fetchSuccessCount / total - nodeSuccessCount / total) * 100).toFixed(0)}%)**
- All three succeeded: ${allThreeOk} sites (${pct(allThreeOk, total)})

### Overlap Analysis

| Category | Count | % of Total | Insight |
| -------- | ----- | ---------- | ------- |
| All three succeeded | ${allThreeOk} | ${pct(allThreeOk, total)} | Accessible to all methods |
| **httpFetch only** | **${results.filter((r) => r.fetchSuccess && !r.curlSuccess && !r.nodeSuccess).length}** | **${pct(results.filter((r) => r.fetchSuccess && !r.curlSuccess && !r.nodeSuccess).length, total)}** | **TLS fingerprinting wins** |
| httpFetch + curl only | ${results.filter((r) => r.fetchSuccess && r.curlSuccess && !r.nodeSuccess).length} | ${pct(results.filter((r) => r.fetchSuccess && r.curlSuccess && !r.nodeSuccess).length, total)} | UA matters |
| httpFetch + Node only | ${results.filter((r) => r.fetchSuccess && r.nodeSuccess && !r.curlSuccess).length} | ${pct(results.filter((r) => r.fetchSuccess && r.nodeSuccess && !r.curlSuccess).length, total)} | Chrome UA helps |
| None succeeded | ${results.filter((r) => !r.fetchSuccess && !r.curlSuccess && !r.nodeSuccess).length} | ${pct(results.filter((r) => !r.fetchSuccess && !r.curlSuccess && !r.nodeSuccess).length, total)} | Hard blocks |

### Performance Metrics (httpFetch)

| Metric | Value |
| ------ | ----- |
| Median latency | ${latencyStats.median}ms |
| Median word count | ${wordStats.median} words |
| Bot protection detected | ${resultsWithAntibot.length} sites (${pct(resultsWithAntibot.length, total)}) |

## Complete Three-Way Comparison

| Site | httpFetch | Words | ms | curl | Words | ms | Node | Words | ms | Antibot | Error |
| ---- | --------- | ----- | -- | ---- | ----- | -- | ---- | ----- | -- | ------- | ----- |
${sortedResults.map(formatComparisonRow).join('\n')}

## Notes

- **httpFetch**: lynxget with Chrome TLS fingerprint via httpcloak
- **curl**: Standard curl with Googlebot UA (\`Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)\`)
- **Node**: Node.js fetch with Chrome UA (\`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36\`)
- **Antibot**: Detected protection systems (truncated to 30 chars)
- **Error**: Fetch error message (truncated to 20 chars)
- Word counts and latency shown only for successful fetches
`;

console.log(report);
