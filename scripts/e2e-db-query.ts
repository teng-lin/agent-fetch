/**
 * CLI tool for querying E2E database analysis
 *
 * Usage examples:
 *   npm run e2e:db:query -- --stats
 *   npm run e2e:db:query -- --site example.com
 *   npm run e2e:db:query -- --commit abc123def
 *   npm run e2e:db:query -- --failed
 *   npm run e2e:db:query -- --since "2026-01-25"
 */

import {
  getSuccessRateBySite,
  getRunsByCommit,
  getRunsBySite,
  getFailedRuns,
  getRunsSince,
  getOverallStats,
} from '../src/__tests__/db-query.js';

interface ParsedArgs {
  stats?: boolean;
  site?: string;
  commit?: string;
  failed?: boolean;
  since?: string;
  help?: boolean;
}

function parseArgs(): ParsedArgs {
  const args: ParsedArgs = {};

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];

    if (arg === '--stats') {
      args.stats = true;
    } else if (arg === '--site' && i + 1 < process.argv.length) {
      args.site = process.argv[++i];
    } else if (arg === '--commit' && i + 1 < process.argv.length) {
      args.commit = process.argv[++i];
    } else if (arg === '--failed') {
      args.failed = true;
    } else if (arg === '--since' && i + 1 < process.argv.length) {
      args.since = process.argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    }
  }

  return args;
}

function showUsage(): void {
  console.log(`
E2E Database Query Tool

Usage:
  npm run e2e:db:query -- [options]

Options:
  --stats                Show overall statistics
  --site <domain>        Show all runs for a specific site
  --commit <hash>        Show all runs for a specific git commit
  --failed               Show all failed runs (success = 0)
  --since <date>         Show runs since a date (ISO format or relative like "7d")
  --help                 Show this help message

Examples:
  npm run e2e:db:query -- --stats
  npm run e2e:db:query -- --site bbc.com
  npm run e2e:db:query -- --commit abc123def456789
  npm run e2e:db:query -- --failed
  npm run e2e:db:query -- --since "2026-01-25"
  npm run e2e:db:query -- --since "7d"
`);
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) {
    return 'N/A';
  }
  const date = new Date(dateStr);
  return date.toLocaleString();
}

async function formatStats(): Promise<void> {
  try {
    const stats = await getOverallStats();

    console.log('\n📊 Overall Statistics\n');
    console.log(`  Total Runs:      ${stats.totalRuns}`);
    console.log(`  Successful:      ${stats.successfulRuns}`);
    console.log(`  Failed:          ${stats.failedRuns}`);
    console.log(`  Success Rate:    ${stats.successRate}%`);
    console.log(`  Unique Sites:    ${stats.uniqueSites}`);
    console.log(`  Unique Commits:  ${stats.uniqueCommits}`);
    console.log('\n  Date Range:');
    console.log(`    Earliest:      ${formatDate(stats.dateRange.earliest)}`);
    console.log(`    Latest:        ${formatDate(stats.dateRange.latest)}`);

    // Success rate by site
    console.log('\n📍 Success Rate by Site\n');
    const bySite = await getSuccessRateBySite();

    if (bySite.length === 0) {
      console.log('  No data available');
    } else {
      console.log('  Site                             Total  Success  Failed  Rate');
      console.log('  ' + '-'.repeat(70));
      for (const row of bySite) {
        const site = row.site.padEnd(30);
        const total = String(row.total).padStart(5);
        const success = String(row.success).padStart(7);
        const failed = String(row.failed).padStart(7);
        const rate = `${row.successRate}%`.padStart(5);
        console.log(`  ${site}${total}${success}${failed}${rate}`);
      }
    }

    console.log('');
  } catch (error) {
    console.error('Error fetching statistics:', error);
    process.exit(1);
  }
}

async function formatBySite(site: string): Promise<void> {
  try {
    const runs = await getRunsBySite(site);

    if (runs.length === 0) {
      console.log(`\n  No runs found for site: ${site}\n`);
      return;
    }

    const successCount = runs.filter((r) => r.success === 1).length;
    const failureCount = runs.length - successCount;
    const successRate = Math.round(((100 * successCount) / runs.length) * 100) / 100;

    console.log(`\n📍 Runs for Site: ${site}\n`);
    console.log(`  Total:    ${runs.length}`);
    console.log(`  Success:  ${successCount}`);
    console.log(`  Failed:   ${failureCount}`);
    console.log(`  Rate:     ${successRate}%\n`);

    console.log('  ID    Status  Latency  Code  Method         Timestamp');
    console.log('  ' + '-'.repeat(70));

    for (const run of runs.slice(0, 50)) {
      const id = String(run.id).padEnd(4);
      const status = (run.success === 1 ? '✓' : '✗').padEnd(6);
      const latency = `${run.latency_ms || '-'}ms`.padStart(7);
      const code = String(run.status_code || '-').padStart(4);
      const method = (run.extraction_method || '-').padEnd(14);
      const timestamp = new Date(run.timestamp).toLocaleString();
      console.log(`  ${id}${status}${latency}${code}  ${method}${timestamp}`);
    }

    if (runs.length > 50) {
      console.log(`  ... and ${runs.length - 50} more\n`);
    } else {
      console.log('');
    }
  } catch (error) {
    console.error('Error fetching runs:', error);
    process.exit(1);
  }
}

async function formatByCommit(commit: string): Promise<void> {
  try {
    const runs = await getRunsByCommit(commit);

    if (runs.length === 0) {
      console.log(`\n  No runs found for commit: ${commit}\n`);
      return;
    }

    const successCount = runs.filter((r) => r.success === 1).length;
    const failureCount = runs.length - successCount;
    const successRate = Math.round(((100 * successCount) / runs.length) * 100) / 100;
    const uniqueSites = new Set(runs.map((r) => r.site)).size;

    console.log(`\n🔧 Runs for Commit: ${commit}\n`);
    console.log(`  Total:        ${runs.length}`);
    console.log(`  Success:      ${successCount}`);
    console.log(`  Failed:       ${failureCount}`);
    console.log(`  Rate:         ${successRate}%`);
    console.log(`  Unique Sites: ${uniqueSites}\n`);

    console.log('  Site                        Status  Latency  Code  Timestamp');
    console.log('  ' + '-'.repeat(75));

    for (const run of runs.slice(0, 50)) {
      const site = (run.site || '-').padEnd(25);
      const status = (run.success === 1 ? '✓' : '✗').padEnd(6);
      const latency = `${run.latency_ms || '-'}ms`.padStart(7);
      const code = String(run.status_code || '-').padStart(4);
      const timestamp = new Date(run.timestamp).toLocaleString();
      console.log(`  ${site}${status}${latency}${code}  ${timestamp}`);
    }

    if (runs.length > 50) {
      console.log(`  ... and ${runs.length - 50} more\n`);
    } else {
      console.log('');
    }
  } catch (error) {
    console.error('Error fetching runs:', error);
    process.exit(1);
  }
}

async function formatFailed(): Promise<void> {
  try {
    const runs = await getFailedRuns();

    if (runs.length === 0) {
      console.log('\n  No failed runs found.\n');
      return;
    }

    console.log(`\n❌ Failed Runs (Total: ${runs.length})\n`);
    console.log('  ID    Site                    Code  Error Type           Timestamp');
    console.log('  ' + '-'.repeat(80));

    for (const run of runs.slice(0, 50)) {
      const id = String(run.id).padEnd(4);
      const site = (run.site || '-').padEnd(23);
      const code = String(run.status_code || '-').padStart(4);
      const errorType = (run.error_type || '-').padEnd(20);
      const timestamp = new Date(run.timestamp).toLocaleString();
      console.log(`  ${id}${site}${code}  ${errorType}${timestamp}`);
    }

    if (runs.length > 50) {
      console.log(`  ... and ${runs.length - 50} more\n`);
    } else {
      console.log('');
    }
  } catch (error) {
    console.error('Error fetching failed runs:', error);
    process.exit(1);
  }
}

async function formatSince(dateStr: string): Promise<void> {
  try {
    const runs = await getRunsSince(dateStr);

    if (runs.length === 0) {
      console.log(`\n  No runs found since ${dateStr}\n`);
      return;
    }

    const successCount = runs.filter((r) => r.success === 1).length;
    const successRate = Math.round(((100 * successCount) / runs.length) * 100) / 100;

    console.log(`\n📅 Runs Since: ${dateStr}\n`);
    console.log(`  Total:   ${runs.length}`);
    console.log(`  Success: ${successCount}`);
    console.log(`  Failed:  ${runs.length - successCount}`);
    console.log(`  Rate:    ${successRate}%\n`);

    console.log('  ID    Site                    Status  Latency  Timestamp');
    console.log('  ' + '-'.repeat(75));

    for (const run of runs.slice(0, 50)) {
      const id = String(run.id).padEnd(4);
      const site = (run.site || '-').padEnd(23);
      const status = (run.success === 1 ? '✓' : '✗').padEnd(6);
      const latency = `${run.latency_ms || '-'}ms`.padStart(7);
      const timestamp = new Date(run.timestamp).toLocaleString();
      console.log(`  ${id}${site}${status}${latency}  ${timestamp}`);
    }

    if (runs.length > 50) {
      console.log(`  ... and ${runs.length - 50} more\n`);
    } else {
      console.log('');
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Invalid date format')) {
      console.error('Error:', error.message);
    } else {
      console.error('Error fetching runs:', error);
    }
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();

  // Show help if requested or no arguments
  if (args.help || (!args.stats && !args.site && !args.commit && !args.failed && !args.since)) {
    showUsage();
    return;
  }

  if (args.stats) {
    await formatStats();
  } else if (args.site) {
    await formatBySite(args.site);
  } else if (args.commit) {
    await formatByCommit(args.commit);
  } else if (args.failed) {
    await formatFailed();
  } else if (args.since) {
    await formatSince(args.since);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
