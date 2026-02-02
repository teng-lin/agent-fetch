#!/usr/bin/env tsx

/**
 * E2E Database Query Tool
 * Usage: tsx scripts/e2e-db-query.ts [--stats | --overall | --runs]
 */

import { getUrlStats, getOverallStats, getTestRuns } from '../src/__tests__/db-query.js';

interface ParsedArgs {
  stats?: boolean;
  overall?: boolean;
  runs?: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};

  for (const arg of args) {
    if (arg === '--stats') parsed.stats = true;
    else if (arg === '--overall') parsed.overall = true;
    else if (arg === '--runs') parsed.runs = true;
  }

  return parsed;
}

function showUsage(): void {
  console.log(`Usage: tsx scripts/e2e-db-query.ts [options]

Options:
  --stats     Show per-URL pass/fail statistics
  --overall   Show overall statistics across all test runs
  --runs      Show test runs with environment metadata
  
Examples:
  tsx scripts/e2e-db-query.ts --stats
  tsx scripts/e2e-db-query.ts --overall
  tsx scripts/e2e-db-query.ts --runs
  tsx scripts/e2e-db-query.ts --stats --overall
`);
}

async function formatStats(): Promise<void> {
  try {
    const stats = await getUrlStats();

    if (stats.length === 0) {
      console.log('\n  No test data found.\n');
      return;
    }

    console.log(`\n📊 Per-URL Statistics (${stats.length} URLs)\n`);
    console.log(
      '  URL                                                Pass/Total  Rate   Avg(ms)  Strategy      Antibot'
    );
    console.log('  ' + '-'.repeat(110));

    for (const stat of stats) {
      const url = stat.url.padEnd(52).substring(0, 52);
      const passTotal = `${stat.passed}/${stat.total_tests}`.padEnd(11);
      const rate = `${stat.pass_rate.toFixed(1)}%`.padEnd(6);
      const avgMs = stat.avg_duration_ms
        ? `${Math.round(stat.avg_duration_ms)}`.padEnd(8)
        : '-'.padEnd(8);
      const strategy = (stat.most_common_strategy || '-').padEnd(13);
      const antibot = stat.antibot_detected > 0 ? `⚠ ${stat.antibot_detected}` : '-';

      console.log(`  ${url}${passTotal}${rate}${avgMs}${strategy}${antibot}`);
    }

    console.log('');
  } catch (error) {
    console.error('Error fetching URL stats:', error);
    process.exit(1);
  }
}

async function formatOverall(): Promise<void> {
  try {
    const stats = await getOverallStats();

    if (!stats) {
      console.log('\n  No test data found.\n');
      return;
    }

    console.log('\n📈 Overall Statistics\n');
    console.log(`  Total test runs:        ${stats.total_runs}`);
    console.log(`  Total tests executed:   ${stats.total_tests}`);
    console.log(`  Passed:                 ${stats.total_passed}`);
    console.log(`  Failed:                 ${stats.total_failed}`);
    console.log(`  Overall pass rate:      ${stats.overall_pass_rate}%`);
    console.log(`  Unique URLs tested:     ${stats.unique_urls}`);
    console.log('');
  } catch (error) {
    console.error('Error fetching overall stats:', error);
    process.exit(1);
  }
}

async function formatRuns(): Promise<void> {
  try {
    const runs = await getTestRuns(50);

    if (runs.length === 0) {
      console.log('\n  No test runs found.\n');
      return;
    }

    console.log(`\n🔄 Test Runs (${runs.length} most recent)\n`);
    console.log(
      '  Commit   Type   OS                         Network       Preset              Pass/Total  Started'
    );
    console.log('  ' + '-'.repeat(110));

    for (const run of runs) {
      const commit = (run.git_commit || '').substring(0, 7).padEnd(7);
      const type = (run.run_type || '-').padEnd(6);
      const osField = (run.os || '-').padEnd(27);
      const network = (run.network || '-').padEnd(13);
      const preset = (run.preset || '-').padEnd(20);
      const passed = run.passed_tests ?? '-';
      const total = run.total_tests ?? '-';
      const passTotal = `${passed}/${total}`.padEnd(11);
      const started = new Date(run.started_at).toLocaleString();
      console.log(`  ${commit}${type}${osField}${network}${preset}${passTotal}${started}`);
    }

    console.log('');
  } catch (error) {
    console.error('Error fetching test runs:', error);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.stats && !args.overall && !args.runs) {
    showUsage();
    process.exit(0);
  }

  if (args.stats) {
    await formatStats();
  }

  if (args.overall) {
    await formatOverall();
  }

  if (args.runs) {
    await formatRuns();
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
