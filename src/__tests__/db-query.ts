/**
 * Database query utilities for analyzing E2E test results
 */
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import fs from 'fs';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'lynxget-e2e.db');

async function loadDatabase(): Promise<SqlJsDatabase | null> {
  if (!fs.existsSync(DB_PATH)) {
    return null;
  }

  const SQL = await initSqlJs();
  const data = fs.readFileSync(DB_PATH);
  return new SQL.Database(data);
}

interface UrlStats {
  url: string;
  total_tests: number;
  passed: number;
  failed: number;
  pass_rate: number;
  avg_duration_ms: number | null;
  most_common_strategy: string | null;
  antibot_detected: number;
}

interface TestRunRecord {
  run_id: string;
  git_commit: string;
  run_type: string;
  os: string | null;
  network: string | null;
  preset: string | null;
  started_at: string;
  ended_at: string | null;
  total_tests: number | null;
  passed_tests: number | null;
  failed_tests: number | null;
}

interface OverallStats {
  total_runs: number;
  total_tests: number;
  total_passed: number;
  total_failed: number;
  overall_pass_rate: number;
  unique_urls: number;
}

/**
 * Get pass/fail statistics for all URLs
 */
export async function getUrlStats(): Promise<UrlStats[]> {
  const db = await loadDatabase();

  if (!db) {
    return [];
  }

  try {
    const query = `
      SELECT
        url,
        COUNT(*) as total_tests,
        SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) as passed,
        SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) as failed,
        ROUND(100.0 * SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) / COUNT(*), 2) as pass_rate,
        AVG(fetch_duration_ms) as avg_duration_ms,
        (
          SELECT extract_strategy
          FROM test_results t2
          WHERE t2.url = t1.url AND extract_strategy IS NOT NULL
          GROUP BY extract_strategy
          ORDER BY COUNT(*) DESC
          LIMIT 1
        ) as most_common_strategy,
        SUM(CASE WHEN antibot_detections IS NOT NULL AND antibot_detections != '[]' THEN 1 ELSE 0 END) as antibot_detected
      FROM test_results t1
      GROUP BY url
      ORDER BY total_tests DESC, pass_rate DESC
    `;

    const result = db.exec(query);
    if (result.length === 0) {
      return [];
    }

    const [{ columns, values }] = result;
    return values.map(
      (row) => Object.fromEntries(columns.map((col, i) => [col, row[i]])) as UrlStats
    );
  } finally {
    db.close();
  }
}

/**
 * Get overall statistics across all test runs
 */
export async function getOverallStats(): Promise<OverallStats | null> {
  const db = await loadDatabase();

  if (!db) {
    return null;
  }

  try {
    const query = `
      SELECT
        COUNT(DISTINCT run_id) as total_runs,
        COUNT(*) as total_tests,
        SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) as total_passed,
        SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) as total_failed,
        ROUND(100.0 * SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) / COUNT(*), 2) as overall_pass_rate,
        COUNT(DISTINCT url) as unique_urls
      FROM test_results
    `;

    const result = db.exec(query);
    if (result.length === 0 || result[0].values.length === 0) {
      return null;
    }

    const [{ columns, values }] = result;
    const [row] = values;
    return Object.fromEntries(columns.map((col, i) => [col, row[i]])) as OverallStats;
  } finally {
    db.close();
  }
}

/**
 * Get all test runs with environment metadata
 */
export async function getTestRuns(limit: number = 50): Promise<TestRunRecord[]> {
  const db = await loadDatabase();

  if (!db) {
    return [];
  }

  try {
    const query = `
      SELECT run_id, git_commit, run_type, os, network, preset,
             started_at, ended_at, total_tests, passed_tests, failed_tests
      FROM test_runs
      ORDER BY started_at DESC
      LIMIT ?
    `;

    const stmt = db.prepare(query);
    stmt.bind([limit]);
    const results: TestRunRecord[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as TestRunRecord);
    }
    return results;
  } finally {
    db.close();
  }
}
