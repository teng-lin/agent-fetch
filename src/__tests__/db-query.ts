/**
 * Query utilities for E2E database analysis
 *
 * Helper functions for common queries to analyze test results:
 * - Success rates by site
 * - Runs by commit or site
 * - Failed runs
 * - Runs since a date
 * - Overall statistics
 *
 * Uses sql.js (pure JavaScript SQLite) for cross-platform compatibility
 */

import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../');
const DB_PATH = path.join(PROJECT_ROOT, 'lynxget-e2e.db');

let sqlJsInstance: any = null;

/**
 * Load database from disk using sql.js
 */
async function loadDatabase(): Promise<SqlJsDatabase | null> {
  try {
    if (!sqlJsInstance) {
      sqlJsInstance = await initSqlJs();
    }

    if (!existsSync(DB_PATH)) {
      return null;
    }

    const buffer = readFileSync(DB_PATH);
    return new sqlJsInstance.Database(buffer);
  } catch (err) {
    console.error('Failed to load database:', err);
    return null;
  }
}

interface SuccessRateBySite {
  site: string;
  total: number;
  success: number;
  failed: number;
  successRate: number;
}

interface RunRecord {
  id: number;
  git_commit: string;
  site: string;
  run_type: string;
  url: string;
  success: number;
  latency_ms: number | null;
  status_code: number | null;
  extraction_method: string | null;
  title: string | null;
  author: string | null;
  body: string | null;
  publish_date: string | null;
  lang: string | null;
  error_message: string | null;
  error_type: string | null;
  timestamp: string;
  created_at: string;
}

interface OverallStats {
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  successRate: number;
  uniqueSites: number;
  uniqueCommits: number;
  dateRange: {
    earliest: string | null;
    latest: string | null;
  };
}

/**
 * Get success rate by site with counts
 * Returns percentage success per site and total run count
 */
export async function getSuccessRateBySite(): Promise<SuccessRateBySite[]> {
  const db = await loadDatabase();

  if (!db) {
    return [];
  }

  try {
    const query = `
      SELECT
        site,
        COUNT(*) as total,
        SUM(success) as success,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed,
        ROUND(100.0 * SUM(success) / COUNT(*), 2) as successRate
      FROM e2e_runs
      GROUP BY site
      ORDER BY successRate DESC, total DESC
    `;

    const results = db.exec(query);
    if (!results.length) {
      return [];
    }

    const columns = results[0].columns;
    return results[0].values.map((row) => ({
      site: row[columns.indexOf('site')] as string,
      total: row[columns.indexOf('total')] as number,
      success: row[columns.indexOf('success')] as number,
      failed: row[columns.indexOf('failed')] as number,
      successRate: row[columns.indexOf('successRate')] as number,
    }));
  } finally {
    db.close();
  }
}

/**
 * Get all runs for a specific git commit
 */
export async function getRunsByCommit(commitHash: string): Promise<RunRecord[]> {
  const db = await loadDatabase();

  if (!db) {
    return [];
  }

  try {
    const query = `
      SELECT *
      FROM e2e_runs
      WHERE git_commit = ?
      ORDER BY timestamp DESC
    `;

    const stmt = db.prepare(query);
    stmt.bind([commitHash]);
    const results: RunRecord[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as RunRecord);
    }
    return results;
  } finally {
    db.close();
  }
}

/**
 * Get all runs for a specific site
 */
export async function getRunsBySite(site: string): Promise<RunRecord[]> {
  const db = await loadDatabase();

  if (!db) {
    return [];
  }

  try {
    const query = `
      SELECT *
      FROM e2e_runs
      WHERE site = ?
      ORDER BY timestamp DESC
    `;

    const stmt = db.prepare(query);
    stmt.bind([site]);
    const results: RunRecord[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as RunRecord);
    }
    return results;
  } finally {
    db.close();
  }
}

/**
 * Get all failed runs (where success = 0)
 */
export async function getFailedRuns(): Promise<RunRecord[]> {
  const db = await loadDatabase();

  if (!db) {
    return [];
  }

  try {
    const query = `
      SELECT *
      FROM e2e_runs
      WHERE success = 0
      ORDER BY timestamp DESC
    `;

    const stmt = db.prepare(query);
    const results: RunRecord[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as RunRecord);
    }
    return results;
  } finally {
    db.close();
  }
}

/**
 * Get all runs since a specific timestamp
 */
export async function getRunsSince(dateString: string): Promise<RunRecord[]> {
  const db = await loadDatabase();

  if (!db) {
    return [];
  }

  try {
    // Parse the date string (ISO format or relative like "7d")
    let sinceDate: Date;

    if (dateString.match(/^\d{4}-\d{2}-\d{2}/)) {
      // ISO format
      sinceDate = new Date(dateString);
    } else {
      // Relative format: 7d, 24h, 30m
      const match = dateString.match(/^(\d+)([dhm])$/);
      if (!match) {
        throw new Error('Invalid date format. Use ISO (2026-01-25) or relative (7d, 24h, 30m)');
      }

      const amount = parseInt(match[1], 10);
      const unit = match[2];
      sinceDate = new Date();

      if (unit === 'd') {
        sinceDate.setDate(sinceDate.getDate() - amount);
      } else if (unit === 'h') {
        sinceDate.setHours(sinceDate.getHours() - amount);
      } else if (unit === 'm') {
        sinceDate.setMinutes(sinceDate.getMinutes() - amount);
      }
    }

    const query = `
      SELECT *
      FROM e2e_runs
      WHERE timestamp >= ?
      ORDER BY timestamp DESC
    `;

    const stmt = db.prepare(query);
    stmt.bind([sinceDate.toISOString()]);
    const results: RunRecord[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as RunRecord);
    }
    return results;
  } finally {
    db.close();
  }
}

/**
 * Get overall statistics
 */
export async function getOverallStats(): Promise<OverallStats> {
  const db = await loadDatabase();

  if (!db) {
    return {
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      successRate: 0,
      uniqueSites: 0,
      uniqueCommits: 0,
      dateRange: {
        earliest: null,
        latest: null,
      },
    };
  }

  try {
    const query = `
      SELECT
        COUNT(*) as totalResults,
        SUM(success) as successfulRuns,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failedRuns,
        COUNT(DISTINCT site) as uniqueSites,
        (SELECT COUNT(DISTINCT git_commit) FROM test_runs) as uniqueCommits,
        MIN(r.timestamp) as earliest,
        MAX(r.timestamp) as latest
      FROM e2e_runs r
    `;

    const results = db.exec(query);
    if (!results.length || !results[0].values.length) {
      return {
        totalRuns: 0,
        successfulRuns: 0,
        failedRuns: 0,
        successRate: 0,
        uniqueSites: 0,
        uniqueCommits: 0,
        dateRange: {
          earliest: null,
          latest: null,
        },
      };
    }

    const columns = results[0].columns;
    const row = results[0].values[0];

    const totalRuns = (row[columns.indexOf('totalResults')] as number) || 0;
    const successfulRuns = (row[columns.indexOf('successfulRuns')] as number) || 0;
    const failedRuns = (row[columns.indexOf('failedRuns')] as number) || 0;
    const uniqueSites = (row[columns.indexOf('uniqueSites')] as number) || 0;
    const uniqueCommits = (row[columns.indexOf('uniqueCommits')] as number) || 0;
    const earliest = (row[columns.indexOf('earliest')] as string | null) || null;
    const latest = (row[columns.indexOf('latest')] as string | null) || null;

    const successRate =
      totalRuns > 0 ? Math.round(((100 * successfulRuns) / totalRuns) * 100) / 100 : 0;

    return {
      totalRuns,
      successfulRuns,
      failedRuns,
      successRate,
      uniqueSites,
      uniqueCommits,
      dateRange: {
        earliest,
        latest,
      },
    };
  } finally {
    db.close();
  }
}
