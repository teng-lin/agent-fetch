#!/usr/bin/env npx tsx
/**
 * Multi-method comparison: httpFetch() vs curl vs Node.js fetch
 * Writes TSV report to a file (default: <tmpdir>/fetch-comparison.tsv).
 *
 * Usage:
 *   npx tsx scripts/test-fetch-vs-curl.ts [output.tsv]
 *
 * Environment Variables:
 *   TEST_CONCURRENCY=N     - Parallel requests (default: 5)
 *   COMPARE_CURL=false     - Skip curl comparison
 *   COMPARE_NODE=false     - Skip Node.js fetch comparison
 *
 * Examples:
 *   # All three methods (default)
 *   npx tsx scripts/test-fetch-vs-curl.ts
 *
 *   # httpFetch only
 *   COMPARE_CURL=false COMPARE_NODE=false npx tsx scripts/test-fetch-vs-curl.ts
 *
 *   # httpFetch vs curl only
 *   COMPARE_NODE=false npx tsx scripts/test-fetch-vs-curl.ts
 *
 *   # httpFetch vs Node.js only
 *   COMPARE_CURL=false npx tsx scripts/test-fetch-vs-curl.ts
 */
import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { httpFetch } from '../src/fetch/http-fetch.js';
import { loadSiteConfigs } from '../src/__tests__/fixtures/sites.js';
import type { SiteTestConfig } from '../src/__tests__/fixtures/types.js';

const execFileAsync = promisify(execFile);

const CONCURRENCY = parseInt(process.env.TEST_CONCURRENCY || '5', 10);
const COMPARE_CURL = process.env.COMPARE_CURL !== 'false';
const COMPARE_NODE = process.env.COMPARE_NODE !== 'false';

// Determine output filename based on what's being compared
let defaultOutputName = 'fetch';
if (COMPARE_CURL) defaultOutputName += '-vs-curl';
if (COMPARE_NODE) defaultOutputName += '-vs-node';
defaultOutputName += '.tsv';

const OUTPUT_PATH = process.argv[2] || join(tmpdir(), defaultOutputName);

const sites: SiteTestConfig[] = loadSiteConfigs();

if (sites.length === 0) {
  console.error(
    'No site fixtures found. Set SITE_FIXTURES env var or place site-fixtures.json in repo root.'
  );
  process.exit(1);
}

interface Result {
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
  antibot: string;
}

function wordCount(text: string | null | undefined): number {
  if (!text) return 0;
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

async function curlFetch(url: string): Promise<{ status: number; words: number; ms: number }> {
  const start = Date.now();
  try {
    const { stdout } = await execFileAsync(
      'curl',
      [
        '-sS',
        '-L',
        '-o',
        '-',
        '-w',
        '\n__STATUS__%{http_code}',
        '-m',
        '15',
        '-A',
        'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        url,
      ],
      { maxBuffer: 10 * 1024 * 1024, timeout: 20000 }
    );
    const ms = Date.now() - start;
    const statusMatch = stdout.match(/__STATUS__(\d+)$/);
    const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
    const body = stdout.replace(/__STATUS__\d+$/, '');
    // Rough word count from HTML body (strip tags)
    const text = body.replace(/<[^>]+>/g, ' ');
    return { status, words: wordCount(text), ms };
  } catch {
    return { status: 0, words: 0, ms: Date.now() - start };
  }
}

async function nodeFetch(url: string): Promise<{ status: number; words: number; ms: number }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    clearTimeout(timeout);
    const ms = Date.now() - start;
    const body = await response.text();
    const text = body.replace(/<[^>]+>/g, ' ');
    return { status: response.status, words: wordCount(text), ms };
  } catch {
    return { status: 0, words: 0, ms: Date.now() - start };
  }
}

async function testSite(config: SiteTestConfig): Promise<Result> {
  const url = config.stable.url;

  // Build list of methods to run
  const methods: Promise<any>[] = [
    httpFetch(url).catch((err) => ({
      success: false,
      textContent: undefined as string | undefined,
      error: String(err),
      latencyMs: 0,
      url,
      antibot: [] as { name: string }[],
    })),
  ];

  if (COMPARE_CURL) methods.push(curlFetch(url));
  if (COMPARE_NODE) methods.push(nodeFetch(url));

  // Run selected methods in parallel
  const results = await Promise.all(methods);
  const fetchResult = results[0];
  const curlResult = COMPARE_CURL ? results[COMPARE_NODE ? 1 : 1] : { status: 0, words: 0, ms: 0 };
  const nodeResult = COMPARE_NODE ? results[COMPARE_CURL ? 2 : 1] : { status: 0, words: 0, ms: 0 };

  const antibot = (fetchResult.antibot || []).map((d) => d.name).join(', ');

  return {
    site: config.site,
    url,
    fetchSuccess: fetchResult.success,
    fetchWords: wordCount(fetchResult.textContent),
    fetchError: fetchResult.success ? '' : fetchResult.error || 'unknown',
    fetchMs: fetchResult.latencyMs,
    curlSuccess: curlResult.status >= 200 && curlResult.status < 400,
    curlWords: curlResult.words,
    curlStatus: curlResult.status,
    curlMs: curlResult.ms,
    nodeSuccess: nodeResult.status >= 200 && nodeResult.status < 400,
    nodeWords: nodeResult.words,
    nodeStatus: nodeResult.status,
    nodeMs: nodeResult.ms,
    antibot,
  };
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

function tsvRow(values: (string | number | boolean)[]): string {
  return values.join('\t') + '\n';
}

async function main() {
  const methods = ['httpFetch'];
  if (COMPARE_CURL) methods.push('curl');
  if (COMPARE_NODE) methods.push('Node.js');

  console.log(`Testing ${sites.length} sites (concurrency: ${CONCURRENCY})...`);
  console.log(`Methods: ${methods.join(', ')}`);
  console.log(`Output: ${OUTPUT_PATH}`);

  // Build header columns dynamically
  const headerCols = ['site', 'fetch_ok', 'fetch_words', 'fetch_error', 'fetch_ms'];
  if (COMPARE_CURL) {
    headerCols.push('curl_ok', 'curl_words', 'curl_status', 'curl_ms');
  }
  if (COMPARE_NODE) {
    headerCols.push('node_ok', 'node_words', 'node_status', 'node_ms');
  }
  headerCols.push('url', 'antibot');

  writeFileSync(OUTPUT_PATH, tsvRow(headerCols));

  const results = await runWithConcurrency(sites, CONCURRENCY, async (config) => {
    const result = await testSite(config);
    const fetchStatus = result.fetchSuccess ? 'OK' : 'FAIL';

    // Build console output dynamically
    let output = `  ${config.site}: fetch=${fetchStatus}(${result.fetchWords}w)`;
    if (COMPARE_CURL) {
      const curlStatus = result.curlSuccess ? 'OK' : 'FAIL';
      output += ` curl=${curlStatus}(${result.curlWords}w)`;
    }
    if (COMPARE_NODE) {
      const nodeStatus = result.nodeSuccess ? 'OK' : 'FAIL';
      output += ` node=${nodeStatus}(${result.nodeWords}w)`;
    }
    console.log(output);

    // Build row columns dynamically
    const rowCols: (string | number | boolean)[] = [
      result.site,
      result.fetchSuccess,
      result.fetchWords,
      result.fetchError,
      result.fetchMs,
    ];
    if (COMPARE_CURL) {
      rowCols.push(result.curlSuccess, result.curlWords, result.curlStatus, result.curlMs);
    }
    if (COMPARE_NODE) {
      rowCols.push(result.nodeSuccess, result.nodeWords, result.nodeStatus, result.nodeMs);
    }
    rowCols.push(result.url, result.antibot);

    // Append row immediately so partial results survive crashes
    appendFileSync(OUTPUT_PATH, tsvRow(rowCols));

    return result;
  });

  // Summary
  const fetchOk = results.filter((r) => r.fetchSuccess).length;

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total: ${results.length}`);
  console.log(`httpFetch OK: ${fetchOk} (${((fetchOk / results.length) * 100).toFixed(0)}%)`);

  if (COMPARE_CURL || COMPARE_NODE) {
    if (COMPARE_CURL) {
      const curlOk = results.filter((r) => r.curlSuccess).length;
      console.log(`curl OK: ${curlOk} (${((curlOk / results.length) * 100).toFixed(0)}%)`);
    }
    if (COMPARE_NODE) {
      const nodeOk = results.filter((r) => r.nodeSuccess).length;
      console.log(`Node.js fetch OK: ${nodeOk} (${((nodeOk / results.length) * 100).toFixed(0)}%)`);
    }

    // Show overlap statistics
    if (COMPARE_CURL && COMPARE_NODE) {
      const allThreeOk = results.filter(
        (r) => r.fetchSuccess && r.curlSuccess && r.nodeSuccess
      ).length;
      const fetchOnly = results.filter(
        (r) => r.fetchSuccess && !r.curlSuccess && !r.nodeSuccess
      ).length;
      console.log(`All three OK: ${allThreeOk}`);
      console.log(`httpFetch only: ${fetchOnly}`);
    } else if (COMPARE_CURL) {
      const bothOk = results.filter((r) => r.fetchSuccess && r.curlSuccess).length;
      const fetchOnly = results.filter((r) => r.fetchSuccess && !r.curlSuccess).length;
      console.log(`Both OK: ${bothOk}`);
      console.log(`httpFetch only: ${fetchOnly}`);
    } else if (COMPARE_NODE) {
      const bothOk = results.filter((r) => r.fetchSuccess && r.nodeSuccess).length;
      const fetchOnly = results.filter((r) => r.fetchSuccess && !r.nodeSuccess).length;
      console.log(`Both OK: ${bothOk}`);
      console.log(`httpFetch only: ${fetchOnly}`);
    }
  }

  console.log(`\nResults written to: ${OUTPUT_PATH}`);
}

main().catch(console.error);
