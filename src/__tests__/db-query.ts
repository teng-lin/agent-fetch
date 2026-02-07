/**
 * Database query utilities for analyzing E2E test results
 */
import type initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase } from 'sql.js';
import { loadDatabase } from './db-utils.js';

/**
 * Open the database, run a callback, and ensure the connection is closed.
 * Returns the fallback value when the database file does not exist.
 */
async function withDatabase<T>(fallback: T, fn: (db: SqlJsDatabase) => T): Promise<T> {
  const db = await loadDatabase();
  if (!db) {
    return fallback;
  }
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Map sql.js query results to typed objects.
 * Returns an empty array when the result set is empty.
 */
function rowsToObjects<T>(result: initSqlJs.QueryExecResult[]): T[] {
  if (result.length === 0) {
    return [];
  }
  const [{ columns, values }] = result;
  return values.map((row) => Object.fromEntries(columns.map((col, i) => [col, row[i]])) as T);
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface UrlStats {
  url: string;
  total_tests: number;
  passed: number;
  failed: number;
  pass_rate: number;
  avg_duration_ms: number | null;
  avg_content_length: number | null;
  most_common_strategy: string | null;
  most_common_error: string | null;
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

export interface SiteStats {
  site: string;
  stable_url: string | null;
  latest_url: string | null;
  total_tests: number;
  passed: number;
  failed: number;
  pass_rate: number;
  avg_duration_ms: number | null;
  avg_content_length: number | null;
  most_common_strategy: string | null;
  most_common_error: string | null;
}

interface QualityStats {
  strategy_distribution: { strategy: string; count: number; avg_content_length: number | null }[];
  error_breakdown: { error_message: string; count: number; urls_affected: number }[];
  content_length_buckets: { bucket: string; count: number }[];
  failed_urls: {
    url: string;
    fail_count: number;
    last_error: string | null;
    last_strategy: string | null;
  }[];
}

// ---------------------------------------------------------------------------
// Exported query functions
// ---------------------------------------------------------------------------

/**
 * Get pass/fail statistics for all URLs
 */
export async function getUrlStats(): Promise<UrlStats[]> {
  return withDatabase([], (db) => {
    const result = db.exec(`
      SELECT
        url,
        COUNT(*) as total_tests,
        SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) as passed,
        SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) as failed,
        ROUND(100.0 * SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) / COUNT(*), 2) as pass_rate,
        AVG(fetch_duration_ms) as avg_duration_ms,
        AVG(content_length) as avg_content_length,
        (
          SELECT extract_strategy
          FROM test_results t2
          WHERE t2.url = t1.url AND extract_strategy IS NOT NULL
          GROUP BY extract_strategy
          ORDER BY COUNT(*) DESC
          LIMIT 1
        ) as most_common_strategy,
        (
          SELECT error_message
          FROM test_results t2
          WHERE t2.url = t1.url AND error_message IS NOT NULL
          GROUP BY error_message
          ORDER BY COUNT(*) DESC
          LIMIT 1
        ) as most_common_error
      FROM test_results t1
      GROUP BY url
      ORDER BY total_tests DESC, pass_rate DESC
    `);
    return rowsToObjects<UrlStats>(result);
  });
}

/**
 * Get pass/fail statistics grouped by site name.
 * Groups "SiteName" and "SiteName (latest)" into a single row.
 */
export async function getSiteStats(): Promise<SiteStats[]> {
  return withDatabase([], (db) => {
    const result = db.exec(`
      SELECT
        REPLACE(test_name, ' (latest)', '') as site,
        MAX(CASE WHEN test_name NOT LIKE '% (latest)' THEN url END) as stable_url,
        MAX(CASE WHEN test_name LIKE '% (latest)' THEN url END) as latest_url,
        COUNT(*) as total_tests,
        SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) as passed,
        SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) as failed,
        ROUND(100.0 * SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) / COUNT(*), 2) as pass_rate,
        AVG(fetch_duration_ms) as avg_duration_ms,
        AVG(content_length) as avg_content_length,
        (
          SELECT extract_strategy
          FROM test_results t2
          WHERE REPLACE(t2.test_name, ' (latest)', '') = REPLACE(t1.test_name, ' (latest)', '')
            AND extract_strategy IS NOT NULL
          GROUP BY extract_strategy
          ORDER BY COUNT(*) DESC
          LIMIT 1
        ) as most_common_strategy,
        (
          SELECT error_message
          FROM test_results t2
          WHERE REPLACE(t2.test_name, ' (latest)', '') = REPLACE(t1.test_name, ' (latest)', '')
            AND error_message IS NOT NULL
          GROUP BY error_message
          ORDER BY COUNT(*) DESC
          LIMIT 1
        ) as most_common_error
      FROM test_results t1
      GROUP BY REPLACE(test_name, ' (latest)', '')
      ORDER BY total_tests DESC, pass_rate DESC
    `);
    return rowsToObjects<SiteStats>(result);
  });
}

/**
 * Get overall statistics across all test runs
 */
export async function getOverallStats(): Promise<OverallStats | null> {
  return withDatabase(null, (db) => {
    const result = db.exec(`
      SELECT
        COUNT(DISTINCT run_id) as total_runs,
        COUNT(*) as total_tests,
        SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) as total_passed,
        SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) as total_failed,
        ROUND(100.0 * SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) / COUNT(*), 2) as overall_pass_rate,
        COUNT(DISTINCT url) as unique_urls
      FROM test_results
    `);
    const rows = rowsToObjects<OverallStats>(result);
    return rows[0] ?? null;
  });
}

/**
 * Get extraction quality analysis
 */
export async function getQualityStats(): Promise<QualityStats | null> {
  return withDatabase(null, (db) => {
    const strategy_distribution = rowsToObjects<QualityStats['strategy_distribution'][number]>(
      db.exec(`
        SELECT
          COALESCE(extract_strategy, 'none') as strategy,
          COUNT(*) as count,
          AVG(content_length) as avg_content_length
        FROM test_results
        GROUP BY extract_strategy
        ORDER BY count DESC
      `)
    );

    const error_breakdown = rowsToObjects<QualityStats['error_breakdown'][number]>(
      db.exec(`
        SELECT
          error_message,
          COUNT(*) as count,
          COUNT(DISTINCT url) as urls_affected
        FROM test_results
        WHERE error_message IS NOT NULL
        GROUP BY error_message
        ORDER BY count DESC
        LIMIT 20
      `)
    );

    const content_length_buckets = rowsToObjects<QualityStats['content_length_buckets'][number]>(
      db.exec(`
        SELECT
          CASE
            WHEN content_length IS NULL OR content_length = 0 THEN 'empty (0)'
            WHEN content_length < 500 THEN 'tiny (<500)'
            WHEN content_length < 2000 THEN 'short (500-2k)'
            WHEN content_length < 10000 THEN 'medium (2k-10k)'
            WHEN content_length < 50000 THEN 'long (10k-50k)'
            ELSE 'very long (50k+)'
          END as bucket,
          COUNT(*) as count
        FROM test_results
        GROUP BY bucket
        ORDER BY
          CASE bucket
            WHEN 'empty (0)' THEN 0
            WHEN 'tiny (<500)' THEN 1
            WHEN 'short (500-2k)' THEN 2
            WHEN 'medium (2k-10k)' THEN 3
            WHEN 'long (10k-50k)' THEN 4
            WHEN 'very long (50k+)' THEN 5
          END
      `)
    );

    const failed_urls = rowsToObjects<QualityStats['failed_urls'][number]>(
      db.exec(`
        SELECT
          url,
          COUNT(*) as fail_count,
          (
            SELECT error_message FROM test_results t2
            WHERE t2.url = t1.url AND t2.status = 'fail'
            ORDER BY t2.rowid DESC LIMIT 1
          ) as last_error,
          (
            SELECT extract_strategy FROM test_results t2
            WHERE t2.url = t1.url AND t2.status = 'fail'
            ORDER BY t2.rowid DESC LIMIT 1
          ) as last_strategy
        FROM test_results t1
        WHERE status = 'fail'
        GROUP BY url
        ORDER BY fail_count DESC
      `)
    );

    return {
      strategy_distribution,
      error_breakdown,
      content_length_buckets,
      failed_urls,
    };
  });
}

/**
 * Get all test runs with environment metadata
 */
export async function getTestRuns(limit: number = 50): Promise<TestRunRecord[]> {
  return withDatabase([], (db) => {
    const stmt = db.prepare(`
      SELECT run_id, git_commit, run_type, os, network, preset,
             started_at, ended_at, total_tests, passed_tests, failed_tests
      FROM test_runs
      ORDER BY started_at DESC
      LIMIT ?
    `);
    try {
      stmt.bind([limit]);

      const results: TestRunRecord[] = [];
      while (stmt.step()) {
        results.push(stmt.getAsObject() as TestRunRecord);
      }
      return results;
    } finally {
      stmt.free();
    }
  });
}
