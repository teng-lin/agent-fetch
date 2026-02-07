#!/usr/bin/env tsx
/**
 * Compare E2E test runs
 *
 * Usage:
 *   tsx scripts/e2e-db-compare.ts                     # Compare two most recent runs
 *   tsx scripts/e2e-db-compare.ts <run1> <run2>       # Compare two specific runs
 *   tsx scripts/e2e-db-compare.ts <run1> <run2> ...   # Compare multiple runs (timeline view)
 *   tsx scripts/e2e-db-compare.ts --last N            # Compare last N runs
 *   tsx scripts/e2e-db-compare.ts --last N --all      # Show all sites side by side
 *   tsx scripts/e2e-db-compare.ts --site <name>       # Show history for a specific site
 *   tsx scripts/e2e-db-compare.ts --flaky             # Show chronically flaky sites
 *   tsx scripts/e2e-db-compare.ts --since "2d"        # Filter runs from last 2 days
 *   tsx scripts/e2e-db-compare.ts --strategies        # Show strategy effectiveness
 *   tsx scripts/e2e-db-compare.ts --export csv        # Export comparison to CSV
 *   tsx scripts/e2e-db-compare.ts --export json       # Export comparison to JSON
 *   tsx scripts/e2e-db-compare.ts --no-group          # Show per-test instead of per-site grouping
 */
import initSqlJs, { Database } from 'sql.js';
import fs from 'fs';
import { getDatabasePath } from '../src/__tests__/db-utils.js';
import {
  groupResultsBySite,
  type SiteGroup,
  type TestResultEntry,
} from '../src/__tests__/site-grouping.js';

const DB_PATH = getDatabasePath();

// ANSI color codes
const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  reset: '\x1b[0m',
} as const;

interface RunMeta {
  id: string;
  commit: string;
  started: string;
  passed: number;
  total: number;
}

interface ParsedArgs {
  runIds: string[];
  showAll: boolean;
  site: string | null;
  flaky: boolean;
  since: string | null;
  strategies: boolean;
  exportFormat: 'csv' | 'json' | null;
  last: number | null;
  noGroup: boolean;
}

// ============================================================================
// Formatting helpers
// ============================================================================

function fitColumn(value: string, width: number): string {
  return value.substring(0, width).padEnd(width);
}

function formatStatusIcon(status: string | null, padded: boolean = false): string {
  const suffix = padded ? ' ' : '';
  if (status === 'pass') return `${colors.green}✓${suffix}${colors.reset}`;
  if (status === 'fail') return `${colors.red}✗${suffix}${colors.reset}`;
  return `${colors.gray}-${suffix}${colors.reset}`;
}

function formatTimeline(statuses: (string | null)[], padded: boolean = false): string {
  return statuses.map((s) => formatStatusIcon(s, padded)).join(padded ? '' : ' ');
}

function printSectionHeader(title: string, color: keyof typeof colors): void {
  const c = colors[color];
  console.log(
    `${c}┌───────────────────────────────────────────────────────────────────────────────┐`
  );
  console.log(`│ ${title.padEnd(77)} │`);
  console.log(
    `└───────────────────────────────────────────────────────────────────────────────┘${colors.reset}\n`
  );
}

function printMainHeader(title: string): void {
  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log(`                      ${title}`);
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');
}

function formatDelta(delta: number): { symbol: string; color: string } {
  if (delta > 0) return { symbol: '↑', color: colors.green };
  if (delta < 0) return { symbol: '↓', color: colors.red };
  return { symbol: '→', color: colors.yellow };
}

// Polyfill for findLastIndex (ES2023) - project targets ES2022
function findLastIndex<T>(arr: T[], predicate: (value: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return i;
  }
  return -1;
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    runIds: [],
    showAll: false,
    site: null,
    flaky: false,
    since: null,
    strategies: false,
    exportFormat: null,
    last: null,
    noGroup: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all') {
      result.showAll = true;
    } else if (arg === '--no-group') {
      result.noGroup = true;
    } else if (arg === '--flaky') {
      result.flaky = true;
    } else if (arg === '--strategies') {
      result.strategies = true;
    } else if (arg === '--site' && args[i + 1]) {
      result.site = args[++i];
    } else if (arg === '--since' && args[i + 1]) {
      result.since = args[++i];
    } else if (arg === '--export' && args[i + 1]) {
      const fmt = args[++i];
      if (fmt === 'csv' || fmt === 'json') {
        result.exportFormat = fmt;
      }
    } else if (arg === '--last' && args[i + 1]) {
      const parsed = parseInt(args[++i], 10);
      if (Number.isNaN(parsed) || parsed < 1) {
        console.error('Invalid --last value. Must be a positive integer.');
        process.exit(1);
      }
      result.last = parsed;
    } else if (!arg.startsWith('--')) {
      result.runIds.push(arg);
    }
  }

  return result;
}

function parseSince(since: string): number {
  const match = since.match(/^(\d+)([dhm])$/);
  if (!match) {
    console.error('Invalid --since format. Use: 1d, 2d, 12h, 30m');
    process.exit(1);
  }
  const [, num, unit] = match;
  const multipliers: Record<string, number> = { d: 86400000, h: 3600000, m: 60000 };
  return Date.now() - parseInt(num, 10) * multipliers[unit];
}

function getRunMeta(db: Database, runId: string): RunMeta {
  const stmt = db.prepare(
    `SELECT run_id, git_commit, started_at, passed_tests, total_tests
     FROM test_runs WHERE run_id = ?`
  );
  stmt.bind([runId]);
  if (!stmt.step()) {
    stmt.free();
    console.error(`Run not found: ${runId}`);
    process.exit(1);
  }
  const row = stmt.get();
  stmt.free();
  const [id, commit, started, passed, total] = row;
  return {
    id: id as string,
    commit: commit as string,
    started: started as string,
    passed: passed as number,
    total: total as number,
  };
}

function getResults(db: Database, runId: string): Map<string, TestResultEntry> {
  const stmt = db.prepare(`
    SELECT test_name, url, status, error_message, content_length, extract_strategy
    FROM test_results WHERE run_id = ?
  `);
  stmt.bind([runId]);
  const map = new Map<string, TestResultEntry>();
  while (stmt.step()) {
    const [name, url, status, error, length, strategy] = stmt.get();
    map.set(name as string, {
      url: url as string,
      status: status as string,
      error: error as string | null,
      length: length as number | null,
      strategy: strategy as string | null,
    });
  }
  stmt.free();
  return map;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function getRecentRunIds(db: Database, limit: number, sinceTimestamp: number = 0): string[] {
  const sinceClause =
    sinceTimestamp > 0 ? `AND started_at >= '${new Date(sinceTimestamp).toISOString()}'` : '';
  const result = db.exec(`
    SELECT run_id FROM test_runs
    WHERE total_tests IS NOT NULL AND typeof(total_tests) = 'integer' AND total_tests > 0
      AND started_at LIKE '____-__-__T%'
      ${sinceClause}
    ORDER BY started_at DESC
    LIMIT ${limit}
  `);
  if (!result[0]) return [];
  return result[0].values.map((r) => r[0] as string).reverse();
}

function collectAllTestNames(resultMaps: Map<string, TestResultEntry>[]): Set<string> {
  const allTests = new Set<string>();
  for (const map of resultMaps) {
    for (const name of map.keys()) {
      allTests.add(name);
    }
  }
  return allTests;
}

/**
 * Collect all base site names from grouped result maps.
 */
function collectAllSiteNames(groupMaps: Map<string, SiteGroup>[]): Set<string> {
  const all = new Set<string>();
  for (const map of groupMaps) {
    for (const name of map.keys()) {
      all.add(name);
    }
  }
  return all;
}

/**
 * Get a combined status for a SiteGroup: 'pass' if all present URLs pass,
 * 'fail' if any fail, null if absent.
 */
function siteGroupStatus(group: SiteGroup | undefined): string | null {
  if (!group) return null;
  const statuses = [group.stable?.status, group.latest?.status].filter(Boolean);
  if (statuses.length === 0) return null;
  return statuses.every((s) => s === 'pass') ? 'pass' : 'fail';
}

// ============================================================================
// Grouped two-run comparison
// ============================================================================
function compareTwoRunsGrouped(db: Database, previousRunId: string, latestRunId: string): void {
  const latest = getRunMeta(db, latestRunId);
  const previous = getRunMeta(db, previousRunId);

  printMainHeader('E2E TEST RUN COMPARISON (Grouped by Site)');

  console.log('┌─────────────────┬──────────────────────────────┬──────────────────────────────┐');
  console.log('│                 │ PREVIOUS RUN                 │ CURRENT RUN                  │');
  console.log('├─────────────────┼──────────────────────────────┼──────────────────────────────┤');
  console.log(`│ Run ID          │ ${fitColumn(previous.id, 28)} │ ${fitColumn(latest.id, 28)} │`);
  console.log(
    `│ Commit          │ ${fitColumn(previous.commit.substring(0, 7), 28)} │ ${fitColumn(latest.commit.substring(0, 7), 28)} │`
  );
  console.log(
    `│ Started         │ ${fitColumn(new Date(previous.started).toLocaleString(), 28)} │ ${fitColumn(new Date(latest.started).toLocaleString(), 28)} │`
  );
  console.log(
    `│ Passed/Total    │ ${fitColumn(`${previous.passed}/${previous.total}`, 28)} │ ${fitColumn(`${latest.passed}/${latest.total}`, 28)} │`
  );
  console.log(
    `│ Pass Rate       │ ${fitColumn(`${((previous.passed / previous.total) * 100).toFixed(1)}%`, 28)} │ ${fitColumn(`${((latest.passed / latest.total) * 100).toFixed(1)}%`, 28)} │`
  );
  console.log('└─────────────────┴──────────────────────────────┴──────────────────────────────┘');

  const delta = latest.passed - previous.passed;
  const { symbol: deltaSymbol, color: deltaColor } = formatDelta(delta);
  console.log(
    `\n${deltaColor}Net Change: ${deltaSymbol} ${Math.abs(delta)} tests (${previous.passed} → ${latest.passed})${colors.reset}\n`
  );

  const latestMap = getResults(db, latestRunId);
  const previousMap = getResults(db, previousRunId);

  // Convert to site groups
  const latestGroups = groupResultsBySite(latestMap);
  const previousGroups = groupResultsBySite(previousMap);
  const allSites = collectAllSiteNames([latestGroups, previousGroups]);

  // Categorize sites into regressions, fixes, new, removed, and still-failing
  const regressions: { site: string; latest: SiteGroup; previous: SiteGroup }[] = [];
  const fixes: { site: string; latest: SiteGroup; previous: SiteGroup }[] = [];
  const newSites: { site: string; latest: SiteGroup }[] = [];
  const removedSites: { site: string; previous: SiteGroup }[] = [];
  const stillFailing: { site: string; latest: SiteGroup }[] = [];

  for (const site of allSites) {
    const lg = latestGroups.get(site);
    const pg = previousGroups.get(site);

    if (pg && lg) {
      const prevStatus = siteGroupStatus(pg);
      const latestStatus = siteGroupStatus(lg);

      if (prevStatus === 'pass' && latestStatus === 'fail') {
        regressions.push({ site, latest: lg, previous: pg });
      } else if (prevStatus === 'fail' && latestStatus === 'pass') {
        fixes.push({ site, latest: lg, previous: pg });
      } else if (prevStatus === 'fail' && latestStatus === 'fail') {
        stillFailing.push({ site, latest: lg });
      }
    } else if (lg) {
      newSites.push({ site, latest: lg });
    } else if (pg) {
      removedSites.push({ site, previous: pg });
    }
  }

  // Print regressions
  if (regressions.length > 0) {
    printSectionHeader(`REGRESSIONS (${regressions.length} sites went from PASS → FAIL)`, 'red');
    for (const { site, latest: lg, previous: pg } of regressions) {
      console.log(`  ${colors.red}✗${colors.reset} ${site}`);
      const prevStrat = pg.stable?.strategy || pg.latest?.strategy || '-';
      const prevLen = pg.stable?.length ?? pg.latest?.length ?? '-';
      console.log(`    Previous: length=${prevLen}, strategy=${prevStrat}`);
      const currError = lg.stable?.error || lg.latest?.error || '-';
      const currLen = lg.stable?.length ?? lg.latest?.length ?? '-';
      console.log(`    Current:  length=${currLen}, error=${currError}`);
      console.log('');
    }
  }

  // Print fixes
  if (fixes.length > 0) {
    printSectionHeader(`FIXES (${fixes.length} sites went from FAIL → PASS)`, 'green');
    for (const { site, latest: lg, previous: pg } of fixes) {
      console.log(`  ${colors.green}✓${colors.reset} ${site}`);
      const prevError = pg.stable?.error || pg.latest?.error || '-';
      console.log(`    Previous: error=${prevError}`);
      const currLen = lg.stable?.length ?? lg.latest?.length ?? '-';
      const currStrat = lg.stable?.strategy || lg.latest?.strategy || '-';
      console.log(`    Current:  length=${currLen}, strategy=${currStrat}`);
      console.log('');
    }
  }

  // Print new sites
  if (newSites.length > 0) {
    printSectionHeader(`NEW SITES (${newSites.length} sites added)`, 'cyan');
    for (const { site, latest: lg } of newSites) {
      const status = siteGroupStatus(lg) || '-';
      console.log(`  ${formatStatusIcon(status)} ${site}: ${status}`);
    }
    console.log('');
  }

  // Print removed sites
  if (removedSites.length > 0) {
    printSectionHeader(`REMOVED SITES (${removedSites.length} sites no longer in suite)`, 'yellow');
    for (const { site, previous: pg } of removedSites) {
      const status = siteGroupStatus(pg) || '-';
      console.log(`  - ${site} (was ${status})`);
    }
    console.log('');
  }

  // Print still failing
  if (stillFailing.length > 0) {
    printSectionHeader(
      `STILL FAILING (${stillFailing.length} sites failed in both runs)`,
      'yellow'
    );
    for (const { site, latest: lg } of stillFailing) {
      const error = lg.stable?.error || lg.latest?.error || '-';
      console.log(`  ✗ ${site}`);
      console.log(`    Error: ${error}`);
    }
    console.log('');
  }

  // Content length comparison at site level
  printSectionHeader('CONTENT LENGTH CHANGES (successful HTTP fetches)', 'cyan');

  interface ContentChange {
    name: string;
    prevLen: number;
    currLen: number;
    changeDelta: number;
    pctChange: number;
    strategy: string | null;
  }

  const contentChanges: ContentChange[] = [];
  for (const site of allSites) {
    const lg = latestGroups.get(site);
    const pg = previousGroups.get(site);
    if (!lg || !pg) continue;

    // Compare stable URL if both have it
    for (const variant of ['stable', 'latest'] as const) {
      const curr = lg[variant];
      const prev = pg[variant];
      if (curr?.status === 'pass' && prev?.status === 'pass') {
        const prevLen = prev.length || 0;
        const currLen = curr.length || 0;
        const changeDelta = currLen - prevLen;
        const pctChange = prevLen > 0 ? (changeDelta / prevLen) * 100 : currLen > 0 ? 100 : 0;
        if (Math.abs(pctChange) > 20 || Math.abs(changeDelta) > 2000) {
          const label = variant === 'latest' ? `${site} (latest)` : site;
          contentChanges.push({
            name: label,
            prevLen,
            currLen,
            changeDelta,
            pctChange,
            strategy: curr.strategy,
          });
        }
      }
    }
  }

  contentChanges.sort((a, b) => Math.abs(b.pctChange) - Math.abs(a.pctChange));

  const significant = contentChanges.filter((c) => c.currLen < 2000 || c.pctChange < -50);
  const improved = contentChanges.filter((c) => c.pctChange > 50 && c.currLen > 2000);

  if (significant.length > 0) {
    console.log(`  ${colors.yellow}Potentially degraded (low content or big drop):${colors.reset}`);
    for (const c of significant.slice(0, 15)) {
      const { symbol, color } = formatDelta(c.changeDelta);
      console.log(
        `    ${c.name.padEnd(35)} ${String(c.prevLen).padStart(6)} → ${String(c.currLen).padStart(6)} ${color}${symbol}${Math.abs(c.pctChange).toFixed(0)}%${colors.reset}  [${c.strategy || '-'}]`
      );
    }
    console.log('');
  }

  if (improved.length > 0) {
    console.log(`  ${colors.green}Improved (big increase):${colors.reset}`);
    for (const c of improved.slice(0, 10)) {
      console.log(
        `    ${c.name.padEnd(35)} ${String(c.prevLen).padStart(6)} → ${String(c.currLen).padStart(6)} ${colors.green}↑${Math.abs(c.pctChange).toFixed(0)}%${colors.reset}  [${c.strategy || '-'}]`
      );
    }
    console.log('');
  }

  if (significant.length === 0 && improved.length === 0) {
    console.log('  No significant content length changes detected.\n');
  }

  // Summary
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('                                 SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(`  Sites:                ${allSites.size}`);
  console.log(`  Regressions:          ${regressions.length}`);
  console.log(`  Fixes:                ${fixes.length}`);
  console.log(`  New sites:            ${newSites.length}`);
  console.log(`  Removed sites:        ${removedSites.length}`);
  console.log(`  Still failing:        ${stillFailing.length}`);
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');
}

// ============================================================================
// Grouped multi-run comparison
// ============================================================================
function compareMultipleRunsGrouped(
  db: Database,
  runIds: string[],
  showAll: boolean = false
): void {
  const runs = runIds.map((id) => getRunMeta(db, id));
  const resultMaps = runIds.map((id) => getResults(db, id));
  const groupMaps = resultMaps.map((m) => groupResultsBySite(m));
  const allSites = collectAllSiteNames(groupMaps);

  printMainHeader('MULTI-RUN COMPARISON (Timeline View, Grouped by Site)');

  // Runs summary table
  const colWidth = Math.max(12, Math.floor(60 / runs.length));
  const headerRow = ['Run #', ...runs.map((_, i) => `Run ${i + 1}`)];
  const commitRow = ['Commit', ...runs.map((r) => r.commit.substring(0, 7))];
  const dateRow = ['Date', ...runs.map((r) => formatDate(r.started))];
  const passRow = ['Pass Rate', ...runs.map((r) => `${r.passed}/${r.total}`)];
  const pctRow = ['%', ...runs.map((r) => `${((r.passed / r.total) * 100).toFixed(1)}%`)];

  console.log('  ' + headerRow.map((c) => fitColumn(c, colWidth)).join(' │ '));
  console.log('  ' + '-'.repeat(headerRow.length * (colWidth + 3)));
  console.log('  ' + commitRow.map((c) => fitColumn(c, colWidth)).join(' │ '));
  console.log('  ' + dateRow.map((c) => fitColumn(c, colWidth)).join(' │ '));
  console.log('  ' + passRow.map((c) => fitColumn(c, colWidth)).join(' │ '));
  console.log('  ' + pctRow.map((c) => fitColumn(c, colWidth)).join(' │ '));
  console.log('');

  // Trend
  const firstPassCount = runs[0].passed;
  const lastPassCount = runs[runs.length - 1].passed;
  const delta = lastPassCount - firstPassCount;
  const { symbol: deltaSymbol, color: deltaColor } = formatDelta(delta);
  console.log(
    `${deltaColor}Overall Trend: ${deltaSymbol} ${Math.abs(delta)} tests (${firstPassCount} → ${lastPassCount})${colors.reset}\n`
  );

  interface SiteHistory {
    site: string;
    statuses: (string | null)[];
  }

  const siteHistories: SiteHistory[] = [];
  for (const site of [...allSites].sort()) {
    const statuses = groupMaps.map((m) => siteGroupStatus(m.get(site)));
    siteHistories.push({ site, statuses });
  }

  // Find interesting patterns
  const regressions = siteHistories.filter((t) => {
    const firstPassIdx = t.statuses.findIndex((s) => s === 'pass');
    const lastFailIdx = findLastIndex(t.statuses, (s) => s === 'fail');
    return firstPassIdx !== -1 && lastFailIdx !== -1 && firstPassIdx < lastFailIdx;
  });

  const fixes = siteHistories.filter((t) => {
    const firstFail = t.statuses.findIndex((s) => s === 'fail');
    const lastPassIdx = findLastIndex(t.statuses, (s) => s === 'pass');
    return firstFail !== -1 && lastPassIdx !== -1 && firstFail < lastPassIdx;
  });

  const alwaysPassing = siteHistories.filter((t) =>
    t.statuses.every((s) => s === 'pass' || s === null)
  );

  const alwaysFailing = siteHistories.filter(
    (t) =>
      t.statuses.some((s) => s === 'fail') && t.statuses.every((s) => s === 'fail' || s === null)
  );

  const flakySites = siteHistories.filter((t) => {
    const passCount = t.statuses.filter((s) => s === 'pass').length;
    const failCount = t.statuses.filter((s) => s === 'fail').length;
    return passCount > 0 && failCount > 0 && passCount + failCount >= 3;
  });

  // Print regressions
  if (regressions.length > 0) {
    printSectionHeader(
      `REGRESSIONS (${regressions.length} sites that went from passing to failing)`,
      'red'
    );
    for (const t of regressions) {
      console.log(`  ${t.site.padEnd(40)} ${formatTimeline(t.statuses)}`);
    }
    console.log('');
  }

  // Print fixes
  if (fixes.length > 0) {
    printSectionHeader(`FIXES (${fixes.length} sites that went from failing to passing)`, 'green');
    for (const t of fixes) {
      console.log(`  ${t.site.padEnd(40)} ${formatTimeline(t.statuses)}`);
    }
    console.log('');
  }

  // Print flaky sites
  if (flakySites.length > 0) {
    printSectionHeader(`FLAKY (${flakySites.length} sites with inconsistent results)`, 'yellow');
    for (const t of flakySites) {
      const passCount = t.statuses.filter((s) => s === 'pass').length;
      const failCount = t.statuses.filter((s) => s === 'fail').length;
      console.log(
        `  ${t.site.padEnd(40)} ${formatTimeline(t.statuses)}  (${passCount}✓ ${failCount}✗)`
      );
    }
    console.log('');
  }

  // Print always failing
  if (alwaysFailing.length > 0) {
    printSectionHeader(`ALWAYS FAILING (${alwaysFailing.length} sites that never passed)`, 'red');
    for (const t of alwaysFailing) {
      const lastGroup = groupMaps[groupMaps.length - 1].get(t.site);
      const error = lastGroup?.stable?.error || lastGroup?.latest?.error || '-';
      console.log(`  ${t.site.padEnd(40)} ${formatTimeline(t.statuses)}  [${error}]`);
    }
    console.log('');
  }

  // Print all sites side by side
  if (showAll) {
    printSectionHeader(
      `ALL SITES (${siteHistories.length} sites across ${runs.length} runs)`,
      'cyan'
    );

    const runHeaders = runs.map((_, i) => `R${i + 1}`).join(' ');
    console.log(`  ${'Site'.padEnd(40)} ${runHeaders}`);
    console.log(`  ${'-'.repeat(40)} ${runs.map(() => '--').join(' ')}`);

    for (const t of siteHistories) {
      console.log(`  ${t.site.padEnd(40)} ${formatTimeline(t.statuses, true)}`);
    }
    console.log('');
  }

  // Summary
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('                                 SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(`  Runs compared:        ${runs.length}`);
  console.log(`  Total sites seen:     ${allSites.size}`);
  console.log(`  Regressions:          ${regressions.length}`);
  console.log(`  Fixes:                ${fixes.length}`);
  console.log(`  Flaky:                ${flakySites.length}`);
  console.log(`  Always passing:       ${alwaysPassing.length}`);
  console.log(`  Always failing:       ${alwaysFailing.length}`);
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');
}

// ============================================================================
// Grouped flaky site detection
// ============================================================================
function showFlakySitesGrouped(db: Database): void {
  printMainHeader('FLAKY SITES (Inconsistent Results, Grouped)');

  const result = db.exec(`
    SELECT
      REPLACE(test_name, ' (latest)', '') as site,
      COUNT(*) as total_runs,
      SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) as passes,
      SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) as fails,
      ROUND(100.0 * SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) / COUNT(*), 1) as pass_rate
    FROM test_results
    GROUP BY REPLACE(test_name, ' (latest)', '')
    HAVING passes > 0 AND fails > 0 AND total_runs >= 5
    ORDER BY
      ABS(pass_rate - 50) ASC,
      total_runs DESC
    LIMIT 30
  `);

  if (!result[0] || result[0].values.length === 0) {
    console.log('  No flaky sites detected (with 5+ runs).\n');
    return;
  }

  console.log('  Site                                     Runs    Pass   Fail   Rate    Flakiness');
  console.log('  ' + '-'.repeat(85));

  for (const row of result[0].values) {
    const [name, total, passes, fails, passRate] = row;
    const flakiness = 100 - Math.abs((passRate as number) - 50) * 2;
    const flakinessBar = '█'.repeat(Math.round(flakiness / 5));

    console.log(
      `  ${(name as string).padEnd(40)} ${String(total).padStart(4)}   ${String(passes).padStart(4)}   ${String(fails).padStart(4)}   ${String(passRate).padStart(5)}%  ${flakinessBar}`
    );
  }

  console.log('');
}

// ============================================================================
// Grouped site history
// ============================================================================
function showSiteHistoryGrouped(db: Database, siteName: string): void {
  // Find matching base site names
  const matchStmt = db.prepare(`
    SELECT DISTINCT REPLACE(test_name, ' (latest)', '') as site
    FROM test_results
    WHERE LOWER(REPLACE(test_name, ' (latest)', '')) LIKE LOWER('%' || ? || '%')
    LIMIT 10
  `);
  matchStmt.bind([siteName]);
  const matches: string[] = [];
  while (matchStmt.step()) {
    matches.push(matchStmt.get()[0] as string);
  }
  matchStmt.free();

  if (matches.length === 0) {
    console.error(`No site found matching: ${siteName}`);
    process.exit(1);
  }

  if (matches.length > 1) {
    console.log(`\nMultiple sites match "${siteName}":`);
    matches.forEach((m) => console.log(`  - ${m}`));
    console.log('\nShowing history for first match.\n');
  }

  const baseName = matches[0];
  printMainHeader(`SITE HISTORY: ${baseName}`);

  // Pull both stable and latest results, ordered chronologically
  const historyStmt = db.prepare(`
    SELECT
      r.run_id,
      r.git_commit,
      r.started_at,
      t.test_name,
      t.status,
      t.content_length,
      t.extract_strategy,
      t.error_message,
      t.fetch_duration_ms
    FROM test_results t
    JOIN test_runs r ON t.run_id = r.run_id
    WHERE REPLACE(t.test_name, ' (latest)', '') = ?
    ORDER BY r.started_at DESC
    LIMIT 100
  `);
  historyStmt.bind([baseName]);

  interface HistoryRow {
    commit: string;
    started: string;
    testName: string;
    status: string;
    length: number | null;
    strategy: string | null;
    error: string | null;
    duration: number | null;
  }

  const rows: HistoryRow[] = [];
  while (historyStmt.step()) {
    const r = historyStmt.get();
    rows.push({
      commit: r[1] as string,
      started: r[2] as string,
      testName: r[3] as string,
      status: r[4] as string,
      length: r[5] as number | null,
      strategy: r[6] as string | null,
      error: r[7] as string | null,
      duration: r[8] as number | null,
    });
  }
  historyStmt.free();

  if (rows.length === 0) {
    console.log('  No history found.\n');
    return;
  }

  console.log(
    '  Date           Commit   Variant   Status  Length    Strategy         Duration  Error'
  );
  console.log('  ' + '-'.repeat(100));

  let passCount = 0;
  let failCount = 0;
  const lengths: number[] = [];

  for (const row of rows) {
    const dateStr = formatDate(row.started);
    const commitStr = row.commit.substring(0, 7);
    const variant = row.testName.endsWith(' (latest)') ? 'latest ' : 'stable ';
    const statusIcon =
      row.status === 'pass'
        ? `${colors.green}✓ pass${colors.reset}`
        : `${colors.red}✗ fail${colors.reset}`;
    const lengthStr = row.length ? String(row.length).padStart(8) : '       -';
    const strategyStr = (row.strategy || '-').padEnd(16);
    const durationStr = row.duration ? `${row.duration}ms`.padStart(8) : '       -';
    const errorStr = row.error ? row.error.substring(0, 25) : '';

    if (row.status === 'pass') passCount++;
    else failCount++;
    if (row.length) lengths.push(row.length);

    console.log(
      `  ${dateStr.padEnd(13)} ${commitStr}   ${variant}   ${statusIcon}  ${lengthStr}  ${strategyStr}  ${durationStr}  ${errorStr}`
    );
  }

  console.log('');
  console.log('  ' + '-'.repeat(100));
  const avgLen =
    lengths.length > 0 ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0;
  const totalRuns = passCount + failCount;
  const passRate = totalRuns > 0 ? ((passCount / totalRuns) * 100).toFixed(1) : '0.0';
  console.log(`  Pass rate: ${passRate}% (${passCount}/${totalRuns})  Avg length: ${avgLen} chars`);
  console.log('');
}

// ============================================================================
// Grouped export
// ============================================================================
function exportDataGrouped(db: Database, runIds: string[], format: 'csv' | 'json'): void {
  const runs = runIds.map((id) => getRunMeta(db, id));
  const resultMaps = runIds.map((id) => getResults(db, id));
  const groupMaps = resultMaps.map((m) => groupResultsBySite(m));
  const allSites = collectAllSiteNames(groupMaps);

  interface GroupedExportTest {
    site: string;
    stable_statuses: (string | null)[];
    latest_statuses: (string | null)[];
    passRate: number;
  }

  const tests: GroupedExportTest[] = [];
  let regressions = 0;
  let fixesCount = 0;
  let flaky = 0;

  for (const site of [...allSites].sort()) {
    const siteStatuses = groupMaps.map((m) => siteGroupStatus(m.get(site)));
    const stableStatuses = groupMaps.map((m) => m.get(site)?.stable?.status || null);
    const latestStatuses = groupMaps.map((m) => m.get(site)?.latest?.status || null);
    const passCount = siteStatuses.filter((s) => s === 'pass').length;
    const failCount = siteStatuses.filter((s) => s === 'fail').length;
    const passRate = passCount + failCount > 0 ? (passCount / (passCount + failCount)) * 100 : 0;

    tests.push({
      site,
      stable_statuses: stableStatuses,
      latest_statuses: latestStatuses,
      passRate,
    });

    const firstPass = siteStatuses.findIndex((s) => s === 'pass');
    const lastFail = findLastIndex(siteStatuses, (s) => s === 'fail');
    const firstFail = siteStatuses.findIndex((s) => s === 'fail');
    const lastPass = findLastIndex(siteStatuses, (s) => s === 'pass');

    if (firstPass !== -1 && lastFail !== -1 && firstPass < lastFail) regressions++;
    if (firstFail !== -1 && lastPass !== -1 && firstFail < lastPass) fixesCount++;
    if (passCount > 0 && failCount > 0 && passCount + failCount >= 3) flaky++;
  }

  if (format === 'json') {
    console.log(
      JSON.stringify(
        {
          runs,
          tests,
          summary: { totalSites: allSites.size, regressions, fixes: fixesCount, flaky },
        },
        null,
        2
      )
    );
  } else {
    const commitHeaders = runs.map((r) => r.commit.substring(0, 7));
    console.log(
      'site,' +
        commitHeaders.map((c) => `${c}_stable`).join(',') +
        ',' +
        commitHeaders.map((c) => `${c}_latest`).join(',') +
        ',pass_rate'
    );
    for (const test of tests) {
      const stable = test.stable_statuses
        .map((s) => (s === 'pass' ? '1' : s === 'fail' ? '0' : ''))
        .join(',');
      const latest = test.latest_statuses
        .map((s) => (s === 'pass' ? '1' : s === 'fail' ? '0' : ''))
        .join(',');
      console.log(`${test.site},${stable},${latest},${test.passRate.toFixed(1)}`);
    }
  }
}

// ============================================================================
// Site-specific history
// ============================================================================
function showSiteHistory(db: Database, siteName: string): void {
  const matchStmt = db.prepare(`
    SELECT DISTINCT test_name FROM test_results
    WHERE LOWER(test_name) LIKE LOWER('%' || ? || '%')
    LIMIT 10
  `);
  matchStmt.bind([siteName]);
  const matches: string[] = [];
  while (matchStmt.step()) {
    matches.push(matchStmt.get()[0] as string);
  }
  matchStmt.free();

  const matchResult = matches.length > 0 ? [{ values: matches.map((m) => [m]) }] : [];

  if (matchResult.length === 0 || matchResult[0].values.length === 0) {
    console.error(`No site found matching: ${siteName}`);
    process.exit(1);
  }

  if (matches.length > 1) {
    console.log(`\nMultiple sites match "${siteName}":`);
    matches.forEach((m) => console.log(`  - ${m}`));
    console.log('\nShowing history for first match.\n');
  }

  const testName = matches[0];
  printMainHeader(`SITE HISTORY: ${testName}`);

  const historyStmt = db.prepare(`
    SELECT
      r.run_id,
      r.git_commit,
      r.started_at,
      t.status,
      t.content_length,
      t.extract_strategy,
      t.error_message,
      t.fetch_duration_ms
    FROM test_results t
    JOIN test_runs r ON t.run_id = r.run_id
    WHERE t.test_name = ?
    ORDER BY r.started_at DESC
    LIMIT 50
  `);
  historyStmt.bind([testName]);
  const historyRows: unknown[][] = [];
  while (historyStmt.step()) {
    historyRows.push(historyStmt.get());
  }
  historyStmt.free();

  const historyResult = historyRows.length > 0 ? [{ values: historyRows }] : [];

  if (!historyResult[0] || historyResult[0].values.length === 0) {
    console.log('  No history found.\n');
    return;
  }

  console.log('  Date           Commit   Status  Length    Strategy         Duration  Error');
  console.log('  ' + '-'.repeat(90));

  let passCount = 0;
  let failCount = 0;
  const lengths: number[] = [];

  for (const row of historyResult[0].values) {
    const [, commit, started, status, length, strategy, error, duration] = row;
    const dateStr = formatDate(started as string);
    const commitStr = (commit as string).substring(0, 7);
    const statusIcon =
      status === 'pass'
        ? `${colors.green}✓ pass${colors.reset}`
        : `${colors.red}✗ fail${colors.reset}`;
    const lengthStr = length ? String(length).padStart(8) : '       -';
    const strategyStr = ((strategy as string) || '-').padEnd(16);
    const durationStr = duration ? `${duration}ms`.padStart(8) : '       -';
    const errorStr = error ? (error as string).substring(0, 25) : '';

    if (status === 'pass') passCount++;
    else failCount++;
    if (length) lengths.push(length as number);

    console.log(
      `  ${dateStr.padEnd(13)} ${commitStr}   ${statusIcon}  ${lengthStr}  ${strategyStr}  ${durationStr}  ${errorStr}`
    );
  }

  console.log('');
  console.log('  ' + '-'.repeat(90));
  const avgLen =
    lengths.length > 0 ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0;
  const totalRuns = passCount + failCount;
  const passRate = totalRuns > 0 ? ((passCount / totalRuns) * 100).toFixed(1) : '0.0';
  console.log(`  Pass rate: ${passRate}% (${passCount}/${totalRuns})  Avg length: ${avgLen} chars`);
  console.log('');
}

// ============================================================================
// Flaky site detection
// ============================================================================
function showFlakySites(db: Database): void {
  printMainHeader('FLAKY SITES (Inconsistent Results)');

  const result = db.exec(`
    SELECT
      test_name,
      COUNT(*) as total_runs,
      SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) as passes,
      SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) as fails,
      ROUND(100.0 * SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) / COUNT(*), 1) as pass_rate
    FROM test_results
    GROUP BY test_name
    HAVING passes > 0 AND fails > 0 AND total_runs >= 5
    ORDER BY
      ABS(pass_rate - 50) ASC,  -- Most flaky (closest to 50%) first
      total_runs DESC
    LIMIT 30
  `);

  if (!result[0] || result[0].values.length === 0) {
    console.log('  No flaky sites detected (with 5+ runs).\n');
    return;
  }

  console.log('  Site                                     Runs    Pass   Fail   Rate    Flakiness');
  console.log('  ' + '-'.repeat(85));

  for (const row of result[0].values) {
    const [name, total, passes, fails, passRate] = row;
    const flakiness = 100 - Math.abs((passRate as number) - 50) * 2; // 100% = perfectly flaky
    const flakinessBar = '█'.repeat(Math.round(flakiness / 5));

    console.log(
      `  ${(name as string).padEnd(40)} ${String(total).padStart(4)}   ${String(passes).padStart(4)}   ${String(fails).padStart(4)}   ${String(passRate).padStart(5)}%  ${flakinessBar}`
    );
  }

  console.log('');
}

// ============================================================================
// Strategy effectiveness
// ============================================================================
function showStrategyEffectiveness(db: Database): void {
  printMainHeader('EXTRACTION STRATEGY EFFECTIVENESS');

  const result = db.exec(`
    SELECT
      COALESCE(extract_strategy, 'none') as strategy,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) as passes,
      ROUND(100.0 * SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) / COUNT(*), 1) as pass_rate,
      ROUND(AVG(content_length)) as avg_length,
      ROUND(AVG(fetch_duration_ms)) as avg_duration,
      COUNT(DISTINCT test_name) as unique_sites
    FROM test_results
    GROUP BY extract_strategy
    ORDER BY total DESC
  `);

  if (!result[0] || result[0].values.length === 0) {
    console.log('  No strategy data found.\n');
    return;
  }

  console.log('  Strategy              Total    Pass%    Avg Length   Avg Time   Sites');
  console.log('  ' + '-'.repeat(75));

  for (const row of result[0].values) {
    const [strategy, total, , passRate, avgLen, avgDur, sites] = row;
    const strategyStr = (strategy as string).padEnd(20);
    const lenStr = avgLen ? `${avgLen} chars`.padStart(12) : '          -';
    const durStr = avgDur ? `${avgDur}ms`.padStart(10) : '         -';

    console.log(
      `  ${strategyStr} ${String(total).padStart(5)}    ${String(passRate).padStart(5)}%   ${lenStr}   ${durStr}   ${String(sites).padStart(5)}`
    );
  }

  // Content length trends by strategy
  console.log('\n  Content Quality by Strategy:');
  console.log('  ' + '-'.repeat(75));

  const qualityResult = db.exec(`
    SELECT
      COALESCE(extract_strategy, 'none') as strategy,
      SUM(CASE WHEN content_length < 500 THEN 1 ELSE 0 END) as tiny,
      SUM(CASE WHEN content_length >= 500 AND content_length < 2000 THEN 1 ELSE 0 END) as short,
      SUM(CASE WHEN content_length >= 2000 AND content_length < 10000 THEN 1 ELSE 0 END) as medium,
      SUM(CASE WHEN content_length >= 10000 THEN 1 ELSE 0 END) as large
    FROM test_results
    WHERE status = 'pass'
    GROUP BY extract_strategy
    ORDER BY large DESC
  `);

  if (qualityResult[0]) {
    console.log('  Strategy              <500   500-2k   2k-10k   10k+');
    console.log('  ' + '-'.repeat(60));
    for (const row of qualityResult[0].values) {
      const [strategy, tiny, short, medium, large] = row;
      console.log(
        `  ${(strategy as string).padEnd(20)} ${String(tiny).padStart(5)}   ${String(short).padStart(5)}   ${String(medium).padStart(6)}   ${String(large).padStart(5)}`
      );
    }
  }

  console.log('');
}

// ============================================================================
// Export functions
// ============================================================================
interface ExportData {
  runs: RunMeta[];
  tests: {
    name: string;
    statuses: (string | null)[];
    passRate: number;
  }[];
  summary: {
    totalTests: number;
    regressions: number;
    fixes: number;
    flaky: number;
  };
}

function exportData(db: Database, runIds: string[], format: 'csv' | 'json'): void {
  const runs = runIds.map((id) => getRunMeta(db, id));
  const resultMaps = runIds.map((id) => getResults(db, id));
  const allTests = collectAllTestNames(resultMaps);

  const tests: ExportData['tests'] = [];
  let regressions = 0;
  let fixes = 0;
  let flaky = 0;

  for (const name of [...allTests].sort()) {
    const statuses = resultMaps.map((m) => m.get(name)?.status || null);
    const passCount = statuses.filter((s) => s === 'pass').length;
    const failCount = statuses.filter((s) => s === 'fail').length;
    const passRate = passCount + failCount > 0 ? (passCount / (passCount + failCount)) * 100 : 0;

    tests.push({ name, statuses, passRate });

    // Count patterns
    const firstPass = statuses.findIndex((s) => s === 'pass');
    const lastFail = findLastIndex(statuses, (s) => s === 'fail');
    const firstFail = statuses.findIndex((s) => s === 'fail');
    const lastPass = findLastIndex(statuses, (s) => s === 'pass');

    if (firstPass !== -1 && lastFail !== -1 && firstPass < lastFail) regressions++;
    if (firstFail !== -1 && lastPass !== -1 && firstFail < lastPass) fixes++;
    if (passCount > 0 && failCount > 0 && passCount + failCount >= 3) flaky++;
  }

  const exportObj: ExportData = {
    runs,
    tests,
    summary: {
      totalTests: allTests.size,
      regressions,
      fixes,
      flaky,
    },
  };

  if (format === 'json') {
    console.log(JSON.stringify(exportObj, null, 2));
  } else {
    // CSV format
    console.log('name,' + runs.map((r) => r.commit.substring(0, 7)).join(',') + ',pass_rate');
    for (const test of tests) {
      const statuses = test.statuses
        .map((s) => (s === 'pass' ? '1' : s === 'fail' ? '0' : ''))
        .join(',');
      console.log(`${test.name},${statuses},${test.passRate.toFixed(1)}`);
    }
  }
}

// ============================================================================
// Multi-run comparison (existing)
// ============================================================================
function compareMultipleRuns(db: Database, runIds: string[], showAll: boolean = false): void {
  const runs = runIds.map((id) => getRunMeta(db, id));
  const resultMaps = runIds.map((id) => getResults(db, id));
  const allTests = collectAllTestNames(resultMaps);

  printMainHeader('MULTI-RUN COMPARISON (Timeline View)');

  // Runs summary table
  const colWidth = Math.max(12, Math.floor(60 / runs.length));
  const headerRow = ['Run #', ...runs.map((_, i) => `Run ${i + 1}`)];
  const commitRow = ['Commit', ...runs.map((r) => r.commit.substring(0, 7))];
  const dateRow = ['Date', ...runs.map((r) => formatDate(r.started))];
  const passRow = ['Pass Rate', ...runs.map((r) => `${r.passed}/${r.total}`)];
  const pctRow = ['%', ...runs.map((r) => `${((r.passed / r.total) * 100).toFixed(1)}%`)];

  console.log('  ' + headerRow.map((c) => fitColumn(c, colWidth)).join(' │ '));
  console.log('  ' + '-'.repeat(headerRow.length * (colWidth + 3)));
  console.log('  ' + commitRow.map((c) => fitColumn(c, colWidth)).join(' │ '));
  console.log('  ' + dateRow.map((c) => fitColumn(c, colWidth)).join(' │ '));
  console.log('  ' + passRow.map((c) => fitColumn(c, colWidth)).join(' │ '));
  console.log('  ' + pctRow.map((c) => fitColumn(c, colWidth)).join(' │ '));
  console.log('');

  // Trend
  const firstPass = runs[0].passed;
  const lastPass = runs[runs.length - 1].passed;
  const delta = lastPass - firstPass;
  const { symbol: deltaSymbol, color: deltaColor } = formatDelta(delta);
  console.log(
    `${deltaColor}Overall Trend: ${deltaSymbol} ${Math.abs(delta)} tests (${firstPass} → ${lastPass})${colors.reset}\n`
  );

  // Categorize tests by their status pattern
  interface TestHistory {
    name: string;
    statuses: (string | null)[];
    pattern: string;
  }

  const testHistories: TestHistory[] = [];
  for (const name of [...allTests].sort()) {
    const statuses = resultMaps.map((m) => m.get(name)?.status || null);
    const pattern = statuses.map((s) => (s === 'pass' ? '✓' : s === 'fail' ? '✗' : '-')).join('');
    testHistories.push({ name, statuses, pattern });
  }

  // Find interesting patterns
  const regressions = testHistories.filter((t) => {
    const firstPassIdx = t.statuses.findIndex((s) => s === 'pass');
    const lastFailIdx = findLastIndex(t.statuses, (s) => s === 'fail');
    return firstPassIdx !== -1 && lastFailIdx !== -1 && firstPassIdx < lastFailIdx;
  });

  const fixes = testHistories.filter((t) => {
    const firstFail = t.statuses.findIndex((s) => s === 'fail');
    const lastPassIdx = findLastIndex(t.statuses, (s) => s === 'pass');
    return firstFail !== -1 && lastPassIdx !== -1 && firstFail < lastPassIdx;
  });

  const alwaysPassing = testHistories.filter((t) =>
    t.statuses.every((s) => s === 'pass' || s === null)
  );

  const alwaysFailing = testHistories.filter(
    (t) =>
      t.statuses.some((s) => s === 'fail') && t.statuses.every((s) => s === 'fail' || s === null)
  );

  const flakyTests = testHistories.filter((t) => {
    const passCount = t.statuses.filter((s) => s === 'pass').length;
    const failCount = t.statuses.filter((s) => s === 'fail').length;
    return passCount > 0 && failCount > 0 && passCount + failCount >= 3;
  });

  // Print regressions
  if (regressions.length > 0) {
    printSectionHeader(
      `REGRESSIONS (${regressions.length} tests that went from passing to failing)`,
      'red'
    );
    for (const t of regressions) {
      console.log(`  ${t.name.padEnd(40)} ${formatTimeline(t.statuses)}`);
    }
    console.log('');
  }

  // Print fixes
  if (fixes.length > 0) {
    printSectionHeader(`FIXES (${fixes.length} tests that went from failing to passing)`, 'green');
    for (const t of fixes) {
      console.log(`  ${t.name.padEnd(40)} ${formatTimeline(t.statuses)}`);
    }
    console.log('');
  }

  // Print flaky tests
  if (flakyTests.length > 0) {
    printSectionHeader(`FLAKY (${flakyTests.length} tests with inconsistent results)`, 'yellow');
    for (const t of flakyTests) {
      const passCount = t.statuses.filter((s) => s === 'pass').length;
      const failCount = t.statuses.filter((s) => s === 'fail').length;
      console.log(
        `  ${t.name.padEnd(40)} ${formatTimeline(t.statuses)}  (${passCount}✓ ${failCount}✗)`
      );
    }
    console.log('');
  }

  // Print always failing
  if (alwaysFailing.length > 0) {
    printSectionHeader(`ALWAYS FAILING (${alwaysFailing.length} tests that never passed)`, 'red');
    for (const t of alwaysFailing) {
      const lastResult = resultMaps[resultMaps.length - 1].get(t.name);
      const error = lastResult?.error || '-';
      console.log(`  ${t.name.padEnd(40)} ${formatTimeline(t.statuses)}  [${error}]`);
    }
    console.log('');
  }

  // Print all tests side by side (when --all flag is used)
  if (showAll) {
    printSectionHeader(
      `ALL TESTS (${testHistories.length} tests across ${runs.length} runs)`,
      'cyan'
    );

    const runHeaders = runs.map((_, i) => `R${i + 1}`).join(' ');
    console.log(`  ${'Site'.padEnd(40)} ${runHeaders}`);
    console.log(`  ${'-'.repeat(40)} ${runs.map(() => '--').join(' ')}`);

    for (const t of testHistories) {
      console.log(`  ${t.name.padEnd(40)} ${formatTimeline(t.statuses, true)}`);
    }
    console.log('');
  }

  // Summary
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('                                 SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(`  Runs compared:        ${runs.length}`);
  console.log(`  Total tests seen:     ${allTests.size}`);
  console.log(`  Regressions:          ${regressions.length}`);
  console.log(`  Fixes:                ${fixes.length}`);
  console.log(`  Flaky:                ${flakyTests.length}`);
  console.log(`  Always passing:       ${alwaysPassing.length}`);
  console.log(`  Always failing:       ${alwaysFailing.length}`);
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');
}

// ============================================================================
// Two-run comparison (existing)
// ============================================================================
function compareTwoRuns(db: Database, previousRunId: string, latestRunId: string): void {
  const latest = getRunMeta(db, latestRunId);
  const previous = getRunMeta(db, previousRunId);

  printMainHeader('E2E TEST RUN COMPARISON');

  console.log('┌─────────────────┬──────────────────────────────┬──────────────────────────────┐');
  console.log('│                 │ PREVIOUS RUN                 │ CURRENT RUN                  │');
  console.log('├─────────────────┼──────────────────────────────┼──────────────────────────────┤');
  console.log(`│ Run ID          │ ${fitColumn(previous.id, 28)} │ ${fitColumn(latest.id, 28)} │`);
  console.log(
    `│ Commit          │ ${fitColumn(previous.commit.substring(0, 7), 28)} │ ${fitColumn(latest.commit.substring(0, 7), 28)} │`
  );
  console.log(
    `│ Started         │ ${fitColumn(new Date(previous.started).toLocaleString(), 28)} │ ${fitColumn(new Date(latest.started).toLocaleString(), 28)} │`
  );
  console.log(
    `│ Passed/Total    │ ${fitColumn(`${previous.passed}/${previous.total}`, 28)} │ ${fitColumn(`${latest.passed}/${latest.total}`, 28)} │`
  );
  console.log(
    `│ Pass Rate       │ ${fitColumn(`${((previous.passed / previous.total) * 100).toFixed(1)}%`, 28)} │ ${fitColumn(`${((latest.passed / latest.total) * 100).toFixed(1)}%`, 28)} │`
  );
  console.log('└─────────────────┴──────────────────────────────┴──────────────────────────────┘');

  const delta = latest.passed - previous.passed;
  const { symbol: deltaSymbol, color: deltaColor } = formatDelta(delta);
  console.log(
    `\n${deltaColor}Net Change: ${deltaSymbol} ${Math.abs(delta)} tests (${previous.passed} → ${latest.passed})${colors.reset}\n`
  );

  const latestMap = getResults(db, latestRunId);
  const previousMap = getResults(db, previousRunId);

  // Find regressions (was passing, now failing)
  const regressions: { name: string; latest: TestResultEntry; previous: TestResultEntry }[] = [];
  for (const [name, latestResult] of latestMap) {
    const previousResult = previousMap.get(name);
    if (previousResult && previousResult.status === 'pass' && latestResult.status === 'fail') {
      regressions.push({ name, latest: latestResult, previous: previousResult });
    }
  }

  // Find fixes (was failing, now passing)
  const fixes: { name: string; latest: TestResultEntry; previous: TestResultEntry }[] = [];
  for (const [name, latestResult] of latestMap) {
    const previousResult = previousMap.get(name);
    if (previousResult && previousResult.status === 'fail' && latestResult.status === 'pass') {
      fixes.push({ name, latest: latestResult, previous: previousResult });
    }
  }

  // Find new tests
  const newTests: { name: string; latest: TestResultEntry }[] = [];
  for (const [name, latestResult] of latestMap) {
    if (!previousMap.has(name)) {
      newTests.push({ name, latest: latestResult });
    }
  }

  // Find removed tests
  const removedTests: { name: string; previous: TestResultEntry }[] = [];
  for (const [name, previousResult] of previousMap) {
    if (!latestMap.has(name)) {
      removedTests.push({ name, previous: previousResult });
    }
  }

  // Still failing (failed in both)
  const stillFailing: { name: string; latest: TestResultEntry; previous: TestResultEntry }[] = [];
  for (const [name, latestResult] of latestMap) {
    const previousResult = previousMap.get(name);
    if (previousResult && previousResult.status === 'fail' && latestResult.status === 'fail') {
      stillFailing.push({ name, latest: latestResult, previous: previousResult });
    }
  }

  // Print regressions
  if (regressions.length > 0) {
    printSectionHeader(`REGRESSIONS (${regressions.length} tests went from PASS → FAIL)`, 'red');
    for (const { name, latest: l, previous: p } of regressions) {
      console.log(`  ${colors.red}✗${colors.reset} ${name}`);
      console.log(`    Previous: length=${p.length || '-'}, strategy=${p.strategy || '-'}`);
      console.log(`    Current:  length=${l.length || '-'}, error=${l.error || '-'}`);
      console.log('');
    }
  }

  // Print fixes
  if (fixes.length > 0) {
    printSectionHeader(`FIXES (${fixes.length} tests went from FAIL → PASS)`, 'green');
    for (const { name, latest: l, previous: p } of fixes) {
      console.log(`  ${colors.green}✓${colors.reset} ${name}`);
      console.log(`    Previous: error=${p.error || '-'}`);
      console.log(`    Current:  length=${l.length || '-'}, strategy=${l.strategy || '-'}`);
      console.log('');
    }
  }

  // Print new tests
  if (newTests.length > 0) {
    printSectionHeader(`NEW TESTS (${newTests.length} tests added)`, 'cyan');
    for (const { name, latest: l } of newTests) {
      console.log(`  ${formatStatusIcon(l.status)} ${name}: ${l.status}`);
    }
    console.log('');
  }

  // Print removed tests
  if (removedTests.length > 0) {
    printSectionHeader(`REMOVED TESTS (${removedTests.length} tests no longer in suite)`, 'yellow');
    for (const { name, previous: p } of removedTests) {
      console.log(`  - ${name} (was ${p.status})`);
    }
    console.log('');
  }

  // Print still failing
  if (stillFailing.length > 0) {
    printSectionHeader(
      `STILL FAILING (${stillFailing.length} tests failed in both runs)`,
      'yellow'
    );
    for (const { name, latest: l } of stillFailing) {
      console.log(`  ✗ ${name}`);
      console.log(`    Error: ${l.error || '-'}`);
    }
    console.log('');
  }

  // All current HTTP failures
  const allCurrentFailures: {
    name: string;
    latest: TestResultEntry;
    previous?: TestResultEntry;
  }[] = [];
  for (const [name, latestResult] of latestMap) {
    if (latestResult.status === 'fail') {
      const previousResult = previousMap.get(name);
      allCurrentFailures.push({ name, latest: latestResult, previous: previousResult });
    }
  }

  if (allCurrentFailures.length > 0) {
    printSectionHeader(
      `HTTP FAILURES (${allCurrentFailures.length} tests with HTTP/extraction errors)`,
      'red'
    );
    for (const { name, latest: l, previous: p } of allCurrentFailures) {
      const prevStatus = p ? p.status : 'N/A';
      let indicator: string;
      if (prevStatus === 'pass') {
        indicator = `${colors.red}↓ REGRESSED${colors.reset}`;
      } else if (prevStatus === 'fail') {
        indicator = `${colors.yellow}→ PERSISTENT${colors.reset}`;
      } else {
        indicator = `${colors.cyan}+ NEW${colors.reset}`;
      }
      console.log(`  ✗ ${name} [${indicator}]`);
      console.log(`    Error: ${l.error || '-'}`);
    }
    console.log('');
  }

  // Content length comparison
  printSectionHeader('CONTENT LENGTH CHANGES (successful HTTP fetches)', 'cyan');

  interface ContentChange {
    name: string;
    prevLen: number;
    currLen: number;
    changeDelta: number;
    pctChange: number;
    strategy: string | null;
  }

  const contentChanges: ContentChange[] = [];
  for (const [name, latestResult] of latestMap) {
    const previousResult = previousMap.get(name);
    if (latestResult.status === 'pass' && previousResult && previousResult.status === 'pass') {
      const prevLen = previousResult.length || 0;
      const currLen = latestResult.length || 0;
      const changeDelta = currLen - prevLen;
      const pctChange = prevLen > 0 ? (changeDelta / prevLen) * 100 : currLen > 0 ? 100 : 0;
      if (Math.abs(pctChange) > 20 || Math.abs(changeDelta) > 2000) {
        contentChanges.push({
          name,
          prevLen,
          currLen,
          changeDelta,
          pctChange,
          strategy: latestResult.strategy,
        });
      }
    }
  }

  contentChanges.sort((a, b) => Math.abs(b.pctChange) - Math.abs(a.pctChange));

  const significant = contentChanges.filter((c) => c.currLen < 2000 || c.pctChange < -50);
  const improved = contentChanges.filter((c) => c.pctChange > 50 && c.currLen > 2000);

  if (significant.length > 0) {
    console.log(`  ${colors.yellow}Potentially degraded (low content or big drop):${colors.reset}`);
    for (const c of significant.slice(0, 15)) {
      const { symbol, color } = formatDelta(c.changeDelta);
      console.log(
        `    ${c.name.padEnd(35)} ${String(c.prevLen).padStart(6)} → ${String(c.currLen).padStart(6)} ${color}${symbol}${Math.abs(c.pctChange).toFixed(0)}%${colors.reset}  [${c.strategy || '-'}]`
      );
    }
    console.log('');
  }

  if (improved.length > 0) {
    console.log(`  ${colors.green}Improved (big increase):${colors.reset}`);
    for (const c of improved.slice(0, 10)) {
      console.log(
        `    ${c.name.padEnd(35)} ${String(c.prevLen).padStart(6)} → ${String(c.currLen).padStart(6)} ${colors.green}↑${Math.abs(c.pctChange).toFixed(0)}%${colors.reset}  [${c.strategy || '-'}]`
      );
    }
    console.log('');
  }

  if (significant.length === 0 && improved.length === 0) {
    console.log('  No significant content length changes detected.\n');
  }

  // Low content tests
  const MIN_WORDS = 200;
  const lowContentTests: {
    name: string;
    currLen: number;
    prevLen: number | null;
    strategy: string | null;
  }[] = [];
  for (const [name, latestResult] of latestMap) {
    if (
      latestResult.status === 'pass' &&
      latestResult.length &&
      latestResult.length < MIN_WORDS * 6
    ) {
      const previousResult = previousMap.get(name);
      lowContentTests.push({
        name,
        currLen: latestResult.length,
        prevLen: previousResult?.length || null,
        strategy: latestResult.strategy,
      });
    }
  }

  if (lowContentTests.length > 0) {
    lowContentTests.sort((a, b) => a.currLen - b.currLen);
    printSectionHeader(
      `LOW CONTENT WARNING (${lowContentTests.length} tests likely below word count threshold)`,
      'yellow'
    );
    console.log('  These HTTP-succeeded but have low content (may fail word count validation):');
    for (const t of lowContentTests) {
      const prevStr = t.prevLen ? `(was ${t.prevLen})` : '(new)';
      const estWords = Math.round(t.currLen / 6);
      console.log(
        `    ${t.name.padEnd(35)} ${String(t.currLen).padStart(5)} chars (~${estWords} words) ${prevStr.padStart(12)}  [${t.strategy || '-'}]`
      );
    }
    console.log('');
  }

  // Summary
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('                                 SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(`  Regressions:          ${regressions.length}`);
  console.log(`  Fixes:                ${fixes.length}`);
  console.log(`  New tests:            ${newTests.length}`);
  console.log(`  Removed tests:        ${removedTests.length}`);
  console.log(`  Still failing:        ${stillFailing.length}`);
  console.log(`  HTTP failures:        ${allCurrentFailures.length}`);
  console.log(`  Low content warnings: ${lowContentTests.length}`);
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');
}

// ============================================================================
// Main
// ============================================================================
async function main(): Promise<void> {
  if (!fs.existsSync(DB_PATH)) {
    console.error('Database not found:', DB_PATH);
    process.exit(1);
  }

  const SQL = await initSqlJs();
  const data = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(data);

  const args = parseArgs(process.argv.slice(2));

  const grouped = !args.noGroup;

  // Handle special modes first
  if (args.site) {
    if (grouped) {
      showSiteHistoryGrouped(db, args.site);
    } else {
      showSiteHistory(db, args.site);
    }
    db.close();
    return;
  }

  if (args.flaky) {
    if (grouped) {
      showFlakySitesGrouped(db);
    } else {
      showFlakySites(db);
    }
    db.close();
    return;
  }

  if (args.strategies) {
    showStrategyEffectiveness(db);
    db.close();
    return;
  }

  // Build run IDs list
  let runIds: string[] = args.runIds;
  const sinceTimestamp = args.since ? parseSince(args.since) : 0;

  if (args.last) {
    runIds = getRecentRunIds(db, args.last, sinceTimestamp);
    if (runIds.length < 2) {
      console.error(`Need at least 2 completed test runs, found ${runIds.length}`);
      process.exit(1);
    }
  } else if (runIds.length === 0) {
    runIds = getRecentRunIds(db, 2, sinceTimestamp);
    if (runIds.length < 2) {
      console.error('Need at least 2 completed test runs to compare');
      process.exit(1);
    }
  }

  // Handle export
  if (args.exportFormat) {
    if (grouped) {
      exportDataGrouped(db, runIds, args.exportFormat);
    } else {
      exportData(db, runIds, args.exportFormat);
    }
    db.close();
    return;
  }

  // Route to appropriate comparison function
  if (runIds.length === 2 && !args.showAll) {
    if (grouped) {
      compareTwoRunsGrouped(db, runIds[0], runIds[1]);
    } else {
      compareTwoRuns(db, runIds[0], runIds[1]);
    }
  } else {
    if (grouped) {
      compareMultipleRunsGrouped(db, runIds, args.showAll);
    } else {
      compareMultipleRuns(db, runIds, args.showAll);
    }
  }

  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
