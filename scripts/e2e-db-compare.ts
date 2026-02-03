#!/usr/bin/env tsx
/**
 * Compare two E2E test runs
 *
 * Usage:
 *   tsx scripts/e2e-db-compare.ts           # Compare two most recent runs
 *   tsx scripts/e2e-db-compare.ts <run1> <run2>  # Compare specific runs by ID
 */
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import fs from 'fs';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'lynxget-e2e.db');

interface TestResult {
  url: string;
  status: string;
  error: string | null;
  length: number | null;
  strategy: string | null;
}

function fitColumn(value: string, width: number): string {
  return value.substring(0, width).padEnd(width);
}

async function main(): Promise<void> {
  if (!fs.existsSync(DB_PATH)) {
    console.error('Database not found:', DB_PATH);
    process.exit(1);
  }

  const SQL = await initSqlJs();
  const data = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(data);

  // Get run IDs from args or use two most recent
  const args = process.argv.slice(2);
  let latestRunId: string;
  let previousRunId: string;

  if (args.length >= 2) {
    [previousRunId, latestRunId] = args;
  } else {
    const runsResult = db.exec(`
      SELECT run_id, git_commit, started_at, passed_tests, total_tests, failed_tests
      FROM test_runs
      WHERE total_tests IS NOT NULL
      ORDER BY started_at DESC
      LIMIT 2
    `);

    if (!runsResult[0] || runsResult[0].values.length < 2) {
      console.error('Need at least 2 completed test runs to compare');
      process.exit(1);
    }

    latestRunId = runsResult[0].values[0][0] as string;
    previousRunId = runsResult[0].values[1][0] as string;
  }

  // Get run metadata
  const getRunMeta = (runId: string) => {
    const result = db.exec(
      `SELECT run_id, git_commit, started_at, passed_tests, total_tests
       FROM test_runs WHERE run_id = '${runId}'`
    );
    if (!result[0] || result[0].values.length === 0) {
      console.error(`Run not found: ${runId}`);
      process.exit(1);
    }
    const [id, commit, started, passed, total] = result[0].values[0];
    return {
      id: id as string,
      commit: commit as string,
      started: started as string,
      passed: passed as number,
      total: total as number,
    };
  };

  const latest = getRunMeta(latestRunId);
  const previous = getRunMeta(previousRunId);

  // Header
  console.log(
    '\n═══════════════════════════════════════════════════════════════════════════════'
  );
  console.log(
    '                         E2E TEST RUN COMPARISON'
  );
  console.log(
    '═══════════════════════════════════════════════════════════════════════════════\n'
  );

  console.log(
    '┌─────────────────┬──────────────────────────────┬──────────────────────────────┐'
  );
  console.log(
    '│                 │ PREVIOUS RUN                 │ CURRENT RUN                  │'
  );
  console.log(
    '├─────────────────┼──────────────────────────────┼──────────────────────────────┤'
  );
  console.log(
    `│ Run ID          │ ${fitColumn(previous.id, 28)} │ ${fitColumn(latest.id, 28)} │`
  );
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
  console.log(
    '└─────────────────┴──────────────────────────────┴──────────────────────────────┘'
  );

  const delta = latest.passed - previous.passed;
  const deltaSymbol = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
  const deltaColor = delta > 0 ? '\x1b[32m' : delta < 0 ? '\x1b[31m' : '\x1b[33m';
  console.log(
    `\n${deltaColor}Net Change: ${deltaSymbol} ${Math.abs(delta)} tests (${previous.passed} → ${latest.passed})\x1b[0m\n`
  );

  // Get detailed results for both runs
  const getResults = (runId: string): Map<string, TestResult> => {
    const result = db.exec(`
      SELECT test_name, url, status, error_message, content_length, extract_strategy
      FROM test_results WHERE run_id = '${runId}'
    `);
    const map = new Map<string, TestResult>();
    if (result[0]) {
      for (const row of result[0].values) {
        const [name, url, status, error, length, strategy] = row;
        map.set(name as string, {
          url: url as string,
          status: status as string,
          error: error as string | null,
          length: length as number | null,
          strategy: strategy as string | null,
        });
      }
    }
    return map;
  };

  const latestMap = getResults(latestRunId);
  const previousMap = getResults(previousRunId);

  // Find regressions (was passing, now failing)
  const regressions: { name: string; latest: TestResult; previous: TestResult }[] = [];
  for (const [name, latestResult] of latestMap) {
    const previousResult = previousMap.get(name);
    if (previousResult && previousResult.status === 'pass' && latestResult.status === 'fail') {
      regressions.push({ name, latest: latestResult, previous: previousResult });
    }
  }

  // Find fixes (was failing, now passing)
  const fixes: { name: string; latest: TestResult; previous: TestResult }[] = [];
  for (const [name, latestResult] of latestMap) {
    const previousResult = previousMap.get(name);
    if (previousResult && previousResult.status === 'fail' && latestResult.status === 'pass') {
      fixes.push({ name, latest: latestResult, previous: previousResult });
    }
  }

  // Find new tests
  const newTests: { name: string; latest: TestResult }[] = [];
  for (const [name, latestResult] of latestMap) {
    if (!previousMap.has(name)) {
      newTests.push({ name, latest: latestResult });
    }
  }

  // Find removed tests
  const removedTests: { name: string; previous: TestResult }[] = [];
  for (const [name, previousResult] of previousMap) {
    if (!latestMap.has(name)) {
      removedTests.push({ name, previous: previousResult });
    }
  }

  // Still failing (failed in both)
  const stillFailing: { name: string; latest: TestResult; previous: TestResult }[] = [];
  for (const [name, latestResult] of latestMap) {
    const previousResult = previousMap.get(name);
    if (previousResult && previousResult.status === 'fail' && latestResult.status === 'fail') {
      stillFailing.push({ name, latest: latestResult, previous: previousResult });
    }
  }

  // Print regressions
  if (regressions.length > 0) {
    console.log(
      '\x1b[31m┌───────────────────────────────────────────────────────────────────────────────┐'
    );
    console.log(
      `│ REGRESSIONS (${regressions.length} tests went from PASS → FAIL)${' '.repeat(Math.max(0, 47 - String(regressions.length).length))}│`
    );
    console.log(
      '└───────────────────────────────────────────────────────────────────────────────┘\x1b[0m\n'
    );
    for (const { name, latest: l, previous: p } of regressions) {
      console.log(`  \x1b[31m✗\x1b[0m ${name}`);
      console.log(`    Previous: length=${p.length || '-'}, strategy=${p.strategy || '-'}`);
      console.log(`    Current:  length=${l.length || '-'}, error=${l.error || '-'}`);
      console.log('');
    }
  }

  // Print fixes
  if (fixes.length > 0) {
    console.log(
      '\x1b[32m┌───────────────────────────────────────────────────────────────────────────────┐'
    );
    console.log(
      `│ FIXES (${fixes.length} tests went from FAIL → PASS)${' '.repeat(Math.max(0, 53 - String(fixes.length).length))}│`
    );
    console.log(
      '└───────────────────────────────────────────────────────────────────────────────┘\x1b[0m\n'
    );
    for (const { name, latest: l, previous: p } of fixes) {
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
      console.log(`    Previous: error=${p.error || '-'}`);
      console.log(`    Current:  length=${l.length || '-'}, strategy=${l.strategy || '-'}`);
      console.log('');
    }
  }

  // Print new tests
  if (newTests.length > 0) {
    console.log(
      '\x1b[36m┌───────────────────────────────────────────────────────────────────────────────┐'
    );
    console.log(
      `│ NEW TESTS (${newTests.length} tests added)${' '.repeat(Math.max(0, 55 - String(newTests.length).length))}│`
    );
    console.log(
      '└───────────────────────────────────────────────────────────────────────────────┘\x1b[0m\n'
    );
    for (const { name, latest: l } of newTests) {
      const statusIcon = l.status === 'pass' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      console.log(`  ${statusIcon} ${name}: ${l.status}`);
    }
    console.log('');
  }

  // Print removed tests
  if (removedTests.length > 0) {
    console.log(
      '\x1b[33m┌───────────────────────────────────────────────────────────────────────────────┐'
    );
    console.log(
      `│ REMOVED TESTS (${removedTests.length} tests no longer in suite)${' '.repeat(Math.max(0, 47 - String(removedTests.length).length))}│`
    );
    console.log(
      '└───────────────────────────────────────────────────────────────────────────────┘\x1b[0m\n'
    );
    for (const { name, previous: p } of removedTests) {
      console.log(`  - ${name} (was ${p.status})`);
    }
    console.log('');
  }

  // Print still failing
  if (stillFailing.length > 0) {
    console.log(
      '\x1b[33m┌───────────────────────────────────────────────────────────────────────────────┐'
    );
    console.log(
      `│ STILL FAILING (${stillFailing.length} tests failed in both runs)${' '.repeat(Math.max(0, 47 - String(stillFailing.length).length))}│`
    );
    console.log(
      '└───────────────────────────────────────────────────────────────────────────────┘\x1b[0m\n'
    );
    for (const { name, latest: l } of stillFailing) {
      console.log(`  ✗ ${name}`);
      console.log(`    Error: ${l.error || '-'}`);
    }
    console.log('');
  }

  // All current HTTP failures
  const allCurrentFailures: { name: string; latest: TestResult; previous?: TestResult }[] = [];
  for (const [name, latestResult] of latestMap) {
    if (latestResult.status === 'fail') {
      const previousResult = previousMap.get(name);
      allCurrentFailures.push({ name, latest: latestResult, previous: previousResult });
    }
  }

  if (allCurrentFailures.length > 0) {
    console.log(
      '\x1b[31m┌───────────────────────────────────────────────────────────────────────────────┐'
    );
    console.log(
      `│ HTTP FAILURES (${allCurrentFailures.length} tests with HTTP/extraction errors)${' '.repeat(Math.max(0, 44 - String(allCurrentFailures.length).length))}│`
    );
    console.log(
      '└───────────────────────────────────────────────────────────────────────────────┘\x1b[0m\n'
    );
    for (const { name, latest: l, previous: p } of allCurrentFailures) {
      const prevStatus = p ? p.status : 'N/A';
      const indicator =
        prevStatus === 'pass'
          ? '\x1b[31m↓ REGRESSED\x1b[0m'
          : prevStatus === 'fail'
            ? '\x1b[33m→ PERSISTENT\x1b[0m'
            : '\x1b[36m+ NEW\x1b[0m';
      console.log(`  ✗ ${name} [${indicator}]`);
      console.log(`    Error: ${l.error || '-'}`);
    }
    console.log('');
  }

  // Content length comparison
  console.log(
    '\x1b[36m┌───────────────────────────────────────────────────────────────────────────────┐'
  );
  console.log(
    '│ CONTENT LENGTH CHANGES (successful HTTP fetches)                             │'
  );
  console.log(
    '└───────────────────────────────────────────────────────────────────────────────┘\x1b[0m\n'
  );

  interface ContentChange {
    name: string;
    prevLen: number;
    currLen: number;
    delta: number;
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
          delta: changeDelta,
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
    console.log('  \x1b[33mPotentially degraded (low content or big drop):\x1b[0m');
    for (const c of significant.slice(0, 15)) {
      const arrow = c.delta > 0 ? '↑' : '↓';
      const color = c.delta > 0 ? '\x1b[32m' : '\x1b[31m';
      console.log(
        `    ${c.name.padEnd(35)} ${String(c.prevLen).padStart(6)} → ${String(c.currLen).padStart(6)} ${color}${arrow}${Math.abs(c.pctChange).toFixed(0)}%\x1b[0m  [${c.strategy || '-'}]`
      );
    }
    console.log('');
  }

  if (improved.length > 0) {
    console.log('  \x1b[32mImproved (big increase):\x1b[0m');
    for (const c of improved.slice(0, 10)) {
      console.log(
        `    ${c.name.padEnd(35)} ${String(c.prevLen).padStart(6)} → ${String(c.currLen).padStart(6)} \x1b[32m↑${Math.abs(c.pctChange).toFixed(0)}%\x1b[0m  [${c.strategy || '-'}]`
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
    if (latestResult.status === 'pass' && latestResult.length && latestResult.length < MIN_WORDS * 6) {
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
    console.log(
      '\x1b[33m┌───────────────────────────────────────────────────────────────────────────────┐'
    );
    console.log(
      `│ LOW CONTENT WARNING (${lowContentTests.length} tests likely below word count threshold)${' '.repeat(Math.max(0, 40 - String(lowContentTests.length).length))}│`
    );
    console.log(
      '└───────────────────────────────────────────────────────────────────────────────┘\x1b[0m\n'
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
  console.log(
    '═══════════════════════════════════════════════════════════════════════════════'
  );
  console.log(
    '                                 SUMMARY'
  );
  console.log(
    '═══════════════════════════════════════════════════════════════════════════════'
  );
  console.log(`  Regressions:          ${regressions.length}`);
  console.log(`  Fixes:                ${fixes.length}`);
  console.log(`  New tests:            ${newTests.length}`);
  console.log(`  Removed tests:        ${removedTests.length}`);
  console.log(`  Still failing:        ${stillFailing.length}`);
  console.log(`  HTTP failures:        ${allCurrentFailures.length}`);
  console.log(`  Low content warnings: ${lowContentTests.length}`);
  console.log(
    '═══════════════════════════════════════════════════════════════════════════════\n'
  );

  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
