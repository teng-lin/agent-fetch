#!/usr/bin/env tsx

/**
 * E2E Database Query Tool
 * Usage: tsx scripts/e2e-db-query.ts [--stats | --overall | --runs | --quality]
 */

import {
  getUrlStats,
  getOverallStats,
  getTestRuns,
  getQualityStats,
} from '../src/__tests__/db-query.js';

const VALID_FLAGS = ['--stats', '--overall', '--runs', '--quality'] as const;
type Flag = (typeof VALID_FLAGS)[number];

function parseArgs(args: string[]): Set<Flag> {
  const flags = new Set<Flag>();
  for (const arg of args) {
    if (VALID_FLAGS.includes(arg as Flag)) {
      flags.add(arg as Flag);
    }
  }
  return flags;
}

function showUsage(): void {
  console.log(`Usage: tsx scripts/e2e-db-query.ts [options]

Options:
  --stats     Show per-URL pass/fail statistics
  --overall   Show overall statistics across all test runs
  --runs      Show test runs with environment metadata
  --quality   Show extraction quality analysis

Examples:
  tsx scripts/e2e-db-query.ts --stats
  tsx scripts/e2e-db-query.ts --overall
  tsx scripts/e2e-db-query.ts --runs
  tsx scripts/e2e-db-query.ts --quality
  tsx scripts/e2e-db-query.ts --stats --quality
`);
}

/** Truncate a string to `maxLen` characters and pad to `width`. */
function fitColumn(value: string, width: number, maxLen: number = width): string {
  return value.substring(0, maxLen).padEnd(width);
}

function formatBytes(n: number | null): string {
  if (n == null || n === 0) return '-';
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

function formatErrorColumn(stat: {
  most_common_error: string | null;
  antibot_detected: number;
}): string {
  if (stat.most_common_error) {
    return stat.most_common_error.substring(0, 30);
  }
  if (stat.antibot_detected > 0) {
    return `antibot(${stat.antibot_detected})`;
  }
  return '-';
}

async function formatStats(): Promise<void> {
  const stats = await getUrlStats();

  if (stats.length === 0) {
    console.log('\n  No test data found.\n');
    return;
  }

  console.log(`\nPer-URL Statistics (${stats.length} URLs)\n`);
  console.log(
    '  URL                                                Pass/Total  Rate   Avg(ms)  AvgLen  Strategy      Error'
  );
  console.log('  ' + '-'.repeat(120));

  for (const stat of stats) {
    const url = fitColumn(stat.url, 52);
    const passTotal = `${stat.passed}/${stat.total_tests}`.padEnd(11);
    const rate = `${stat.pass_rate.toFixed(1)}%`.padEnd(6);
    const avgMs = stat.avg_duration_ms
      ? `${Math.round(stat.avg_duration_ms)}`.padEnd(8)
      : '-'.padEnd(8);
    const avgLen = formatBytes(stat.avg_content_length).padEnd(7);
    const strategy = (stat.most_common_strategy || '-').padEnd(13);
    const error = formatErrorColumn(stat);

    console.log(`  ${url}${passTotal}${rate}${avgMs}${avgLen}${strategy}${error}`);
  }

  console.log('');
}

async function formatOverall(): Promise<void> {
  const stats = await getOverallStats();

  if (!stats) {
    console.log('\n  No test data found.\n');
    return;
  }

  console.log('\nOverall Statistics\n');
  console.log(`  Total test runs:        ${stats.total_runs}`);
  console.log(`  Total tests executed:   ${stats.total_tests}`);
  console.log(`  Passed:                 ${stats.total_passed}`);
  console.log(`  Failed:                 ${stats.total_failed}`);
  console.log(`  Overall pass rate:      ${stats.overall_pass_rate}%`);
  console.log(`  Unique URLs tested:     ${stats.unique_urls}`);
  console.log('');
}

async function formatRuns(): Promise<void> {
  const runs = await getTestRuns(50);

  if (runs.length === 0) {
    console.log('\n  No test runs found.\n');
    return;
  }

  console.log(`\nTest Runs (${runs.length} most recent)\n`);
  console.log(
    '  Commit   Type   OS                         Network       Preset              Pass/Total  Started'
  );
  console.log('  ' + '-'.repeat(110));

  for (const run of runs) {
    const commit = fitColumn(run.git_commit || '', 7);
    const type = fitColumn(run.run_type || '-', 6);
    const osField = fitColumn(run.os || '-', 27);
    const network = fitColumn(run.network || '-', 13);
    const preset = fitColumn(run.preset || '-', 20);
    const passed = run.passed_tests ?? '-';
    const total = run.total_tests ?? '-';
    const passTotal = `${passed}/${total}`.padEnd(11);
    const started = new Date(run.started_at).toLocaleString();
    console.log(`  ${commit}${type}${osField}${network}${preset}${passTotal}${started}`);
  }

  console.log('');
}

function formatPercentBar(count: number, total: number, barWidth: number = 30): string {
  if (total === 0) return '(  0.0%)';
  const pct = ((count / total) * 100).toFixed(1);
  const bar = '\u2588'.repeat(Math.round((count / total) * barWidth));
  return `(${pct.padStart(5)}%)  ${bar}`;
}

async function formatQuality(): Promise<void> {
  const quality = await getQualityStats();

  if (!quality) {
    console.log('\n  No test data found.\n');
    return;
  }

  const totalTests = quality.strategy_distribution.reduce((s, r) => s + r.count, 0);

  // Strategy distribution
  console.log('\nExtraction Quality Analysis\n');
  console.log('  Strategy Distribution:');
  console.log('  ' + '-'.repeat(50));
  for (const row of quality.strategy_distribution) {
    const avgLen = formatBytes(row.avg_content_length);
    console.log(
      `  ${row.strategy.padEnd(18)} ${String(row.count).padStart(5)}  ${formatPercentBar(row.count, totalTests)}  avgLen=${avgLen.padStart(6)}`
    );
  }

  // Content length distribution
  console.log('\n  Content Length Distribution:');
  console.log('  ' + '-'.repeat(50));
  for (const row of quality.content_length_buckets) {
    console.log(
      `  ${row.bucket.padEnd(20)} ${String(row.count).padStart(5)}  ${formatPercentBar(row.count, totalTests)}`
    );
  }

  // Error breakdown
  if (quality.error_breakdown.length > 0) {
    console.log('\n  Error Breakdown:');
    console.log('  ' + '-'.repeat(80));
    for (const row of quality.error_breakdown) {
      const msg = fitColumn(row.error_message, 60);
      console.log(`  ${msg} x${String(row.count).padStart(3)}  (${row.urls_affected} URLs)`);
    }
  }

  // Failed URLs
  if (quality.failed_urls.length > 0) {
    console.log('\n  Consistently Failing URLs:');
    console.log('  ' + '-'.repeat(100));
    for (const row of quality.failed_urls) {
      const url = fitColumn(row.url, 52);
      const error = (row.last_error || '-').substring(0, 40);
      console.log(`  ${url} x${String(row.fail_count).padStart(2)}  ${error}`);
    }
  }

  console.log('');
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.size === 0) {
    showUsage();
    process.exit(0);
  }

  if (flags.has('--stats')) await formatStats();
  if (flags.has('--overall')) await formatOverall();
  if (flags.has('--runs')) await formatRuns();
  if (flags.has('--quality')) await formatQuality();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
