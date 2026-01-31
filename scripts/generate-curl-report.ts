#!/usr/bin/env npx tsx
/**
 * Generate curl (Googlebot UA) E2E report from the 10-column TSV output
 *
 * Usage: generate-curl-report.ts <tsv-file>
 *
 * Example:
 *   npx tsx scripts/test-fetch-vs-curl.ts /tmp/fetch-vs-curl.tsv
 *   npx tsx scripts/generate-curl-report.ts /tmp/fetch-vs-curl.tsv \
 *     > docs/e2e/2026-01-31-curl-report-run1.md
 */

import { existsSync, readFileSync } from 'fs';

// --- Constants ---

const EXPECTED_TSV_COLUMNS = 10;
const LOW_WORD_COUNT_THRESHOLD = 200;
const TOP_N_SITES = 10;

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

interface DistributionStats {
  min: number;
  p10: number;
  median: number;
  mean: number;
  p90: number;
  max: number;
}

interface Bucket {
  label: string;
  threshold: number;
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

function classifyIntoBuckets(values: number[], buckets: Bucket[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const bucket of buckets) {
    counts.set(bucket.label, 0);
  }

  for (const value of values) {
    for (const bucket of buckets) {
      if (value < bucket.threshold || bucket === buckets[buckets.length - 1]) {
        counts.set(bucket.label, (counts.get(bucket.label) || 0) + 1);
        break;
      }
    }
  }
  return counts;
}

function countByKey<T>(
  items: T[],
  keyFn: (item: T) => string
): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, count }));
}

function pct(count: number, total: number): string {
  if (total === 0) return '0%';
  return `${((count / total) * 100).toFixed(1)}%`;
}

function formatBucketTable(bucketCounts: Map<string, number>, total: number): string {
  return Array.from(bucketCounts.entries())
    .map(([label, count]) => `| ${label} | ${count} | ${pct(count, total)} |`)
    .join('\n');
}

function formatStatsTable(stats: DistributionStats): string {
  const rows = [
    ['Min', stats.min],
    ['P10', stats.p10],
    ['Median', stats.median],
    ['Mean', stats.mean],
    ['P90', stats.p90],
    ['Max', stats.max],
  ] as const;

  return rows.map(([label, value]) => `| ${label} | ${value} |`).join('\n');
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
  console.error('Usage: generate-curl-report.ts <tsv-file>');
  console.error(
    'Example: generate-curl-report.ts /tmp/fetch-vs-curl.tsv > docs/e2e/2026-01-31-curl-report-run1.md'
  );
  process.exit(1);
}

if (!existsSync(tsvPath)) {
  console.error(`Error: File not found: ${tsvPath}`);
  process.exit(1);
}

// --- Compute statistics ---

const results = parseTsv(tsvPath);
const total = results.length;

const curlSuccess = results.filter((r) => r.curlSuccess);
const curlFailed = results.filter((r) => !r.curlSuccess);
const curlSuccessCount = curlSuccess.length;
const curlFailedCount = curlFailed.length;

// Word count & latency for successful sites
const wordStats = computeStats(curlSuccess.map((r) => r.curlWords));
const latencyStats = computeStats(curlSuccess.map((r) => r.curlMs));

const wordCountBuckets = classifyIntoBuckets(
  curlSuccess.map((r) => r.curlWords),
  [
    { label: '<100', threshold: 100 },
    { label: '100-499', threshold: 500 },
    { label: '500-999', threshold: 1000 },
    { label: '1000-4999', threshold: 5000 },
    { label: '5000-9999', threshold: 10000 },
    { label: '10000+', threshold: Infinity },
  ]
);

const latencyBuckets = classifyIntoBuckets(
  curlSuccess.map((r) => r.curlMs),
  [
    { label: '<500ms', threshold: 500 },
    { label: '500-1999ms', threshold: 2000 },
    { label: '2000-4999ms', threshold: 5000 },
    { label: '5000-9999ms', threshold: 10000 },
    { label: '10000ms+', threshold: Infinity },
  ]
);

const sortedBySpeed = [...curlSuccess].sort((a, b) => a.curlMs - b.curlMs);
const sortedByWords = [...curlSuccess].sort((a, b) => b.curlWords - a.curlWords);
const lowWordCount = curlSuccess
  .filter((r) => r.curlWords < LOW_WORD_COUNT_THRESHOLD)
  .sort((a, b) => a.curlWords - b.curlWords);

// HTTP status breakdown
const statusBreakdown = countByKey(results, (r) => {
  if (r.curlStatus === 0) return 'timeout/error';
  return `${r.curlStatus}`;
});

// Failed sites by HTTP status
const failedByStatus = countByKey(curlFailed, (r) => {
  if (r.curlStatus === 0) return 'timeout/error';
  return `${r.curlStatus}`;
});

// httpFetch comparison
const fetchSuccessCount = results.filter((r) => r.fetchSuccess).length;
const bothOk = results.filter((r) => r.fetchSuccess && r.curlSuccess).length;
const curlOnlyOk = results.filter((r) => !r.fetchSuccess && r.curlSuccess).length;
const fetchOnlyOk = results.filter((r) => r.fetchSuccess && !r.curlSuccess).length;

const date = new Date().toLocaleDateString('en-CA');

// --- Generate report ---

const lowWordCountSection =
  lowWordCount.length > 0
    ? `### Low Word Count Sites (< ${LOW_WORD_COUNT_THRESHOLD} words)

| Site | Words | HTTP Status | URL |
| ---- | ----- | ----------- | --- |
${lowWordCount.map((r) => `| ${escapeMd(r.site)} | ${r.curlWords} | ${r.curlStatus} | ${escapeMd(r.url)} |`).join('\n')}

`
    : '';

const report = `# curl (Googlebot UA) E2E Test Report

**Date**: ${date}
**Method**: curl with Googlebot UA (\`Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)\`), 15s timeout, follow redirects
**Fixture source**: \`site-fixtures.json\` (via \`SITE_FIXTURES\` env var)

## Executive Summary

| Metric | Value |
| --- | --- |
| Total sites tested | ${total} |
| **curl success** | **${curlSuccessCount} (${pct(curlSuccessCount, total)})** |
| curl failed | ${curlFailedCount} (${pct(curlFailedCount, total)}) |
| httpFetch success (for comparison) | ${fetchSuccessCount} (${pct(fetchSuccessCount, total)}) |

### Comparison with httpFetch

| Category | Count | Rate |
| --- | --- | --- |
| Both succeed | ${bothOk} | ${pct(bothOk, total)} |
| curl only | ${curlOnlyOk} | ${pct(curlOnlyOk, total)} |
| httpFetch only | ${fetchOnlyOk} | ${pct(fetchOnlyOk, total)} |

## HTTP Status Breakdown

| Status | Count | Rate |
| --- | --- | --- |
${statusBreakdown.map(({ key, count }) => `| ${key} | ${count} | ${pct(count, total)} |`).join('\n')}

## curl Success: Content Quality

### Word Count Distribution

| Bucket | Count | % |
| --- | --- | --- |
${formatBucketTable(wordCountBuckets, curlSuccessCount)}

### Word Count Statistics

| Stat | Words |
| --- | --- |
${formatStatsTable(wordStats)}

**Note**: curl word counts reflect raw HTML converted to text (including navigation, ads, boilerplate). These are significantly higher than httpFetch's Readability-extracted counts.

${lowWordCountSection}## curl Success: Latency

### Latency Distribution

| Bucket | Count | % |
| --- | --- | --- |
${formatBucketTable(latencyBuckets, curlSuccessCount)}

### Latency Statistics

| Stat | ms |
| --- | --- |
${formatStatsTable(latencyStats)}

### Top ${TOP_N_SITES} Fastest

| Site | ms | Words |
| ---- | --- | ----- |
${sortedBySpeed
  .slice(0, TOP_N_SITES)
  .map((r) => `| ${escapeMd(r.site)} | ${r.curlMs} | ${r.curlWords} |`)
  .join('\n')}

### Top ${TOP_N_SITES} Slowest

| Site | ms | Words |
| ---- | --- | ----- |
${sortedBySpeed
  .slice(-TOP_N_SITES)
  .reverse()
  .map((r) => `| ${escapeMd(r.site)} | ${r.curlMs} | ${r.curlWords} |`)
  .join('\n')}

## curl Failures

### Failure by HTTP Status

| Status | Count | % of failures |
| --- | --- | --- |
${failedByStatus.map(({ key, count }) => `| ${key} | ${count} | ${pct(count, curlFailedCount)} |`).join('\n')}

### Failed Sites Detail

| Site | HTTP Status | URL |
| ---- | ----------- | --- |
${curlFailed
  .sort((a, b) => a.site.localeCompare(b.site))
  .map((r) => `| ${escapeMd(r.site)} | ${r.curlStatus} | ${escapeMd(r.url)} |`)
  .join('\n')}

## Top ${TOP_N_SITES} Highest Word Count

| Site | Words | ms |
| ---- | ----- | --- |
${sortedByWords
  .slice(0, TOP_N_SITES)
  .map((r) => `| ${escapeMd(r.site)} | ${r.curlWords} | ${r.curlMs} |`)
  .join('\n')}

## All Successful Sites

| # | Site | Words | ms | HTTP Status | URL |
| --- | ---- | ----- | --- | ----------- | --- |
${curlSuccess
  .sort((a, b) => a.site.localeCompare(b.site))
  .map(
    (r, i) =>
      `| ${i + 1} | ${escapeMd(r.site)} | ${r.curlWords} | ${r.curlMs} | ${r.curlStatus} | ${escapeMd(r.url)} |`
  )
  .join('\n')}
`;

console.log(report);
