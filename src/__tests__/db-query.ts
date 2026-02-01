/**
 * Query utilities for E2E database analysis
 *
 * Helper functions for common queries to analyze test results:
 * - Success rates by site
 * - Runs by commit or site
 * - Failed runs
 * - Runs since a date
 * - Overall statistics
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../');
const DB_PATH = path.join(PROJECT_ROOT, 'lynxget-e2e.db');

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
export function getSuccessRateBySite(): SuccessRateBySite[] {
  const db = new Database(DB_PATH, { readonly: true });

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

    const results = db.prepare(query).all() as Array<{
      site: string;
      total: number;
      success: number;
      failed: number;
      successRate: number;
    }>;

    return results.map((r) => ({
      site: r.site,
      total: r.total,
      success: r.success,
      failed: r.failed,
      successRate: r.successRate,
    }));
  } finally {
    db.close();
  }
}

/**
 * Get all runs for a specific git commit
 */
export function getRunsByCommit(commitHash: string): RunRecord[] {
  const db = new Database(DB_PATH, { readonly: true });

  try {
    const query = `
      SELECT *
      FROM e2e_runs
      WHERE git_commit = ?
      ORDER BY timestamp DESC
    `;

    const results = db.prepare(query).all(commitHash) as RunRecord[];
    return results;
  } finally {
    db.close();
  }
}

/**
 * Get all runs for a specific site
 */
export function getRunsBySite(site: string): RunRecord[] {
  const db = new Database(DB_PATH, { readonly: true });

  try {
    const query = `
      SELECT *
      FROM e2e_runs
      WHERE site = ?
      ORDER BY timestamp DESC
    `;

    const results = db.prepare(query).all(site) as RunRecord[];
    return results;
  } finally {
    db.close();
  }
}

/**
 * Get all failed runs (where success = 0)
 */
export function getFailedRuns(): RunRecord[] {
  const db = new Database(DB_PATH, { readonly: true });

  try {
    const query = `
      SELECT *
      FROM e2e_runs
      WHERE success = 0
      ORDER BY timestamp DESC
    `;

    const results = db.prepare(query).all() as RunRecord[];
    return results;
  } finally {
    db.close();
  }
}

/**
 * Get all runs since a specific timestamp
 */
export function getRunsSince(dateString: string): RunRecord[] {
  const db = new Database(DB_PATH, { readonly: true });

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

    const results = db.prepare(query).all(sinceDate.toISOString()) as RunRecord[];
    return results;
  } finally {
    db.close();
  }
}

/**
 * Get overall statistics
 */
export function getOverallStats(): OverallStats {
  const db = new Database(DB_PATH, { readonly: true });

  try {
    const query = `
      SELECT
        COUNT(*) as totalRuns,
        SUM(success) as successfulRuns,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failedRuns,
        COUNT(DISTINCT site) as uniqueSites,
        COUNT(DISTINCT git_commit) as uniqueCommits,
        MIN(timestamp) as earliest,
        MAX(timestamp) as latest
      FROM e2e_runs
    `;

    const result = db.prepare(query).get() as {
      totalRuns: number;
      successfulRuns: number;
      failedRuns: number;
      uniqueSites: number;
      uniqueCommits: number;
      earliest: string | null;
      latest: string | null;
    };

    const successRate =
      result.totalRuns > 0
        ? Math.round(((100 * (result.successfulRuns || 0)) / result.totalRuns) * 100) / 100
        : 0;

    return {
      totalRuns: result.totalRuns,
      successfulRuns: result.successfulRuns || 0,
      failedRuns: result.failedRuns || 0,
      successRate,
      uniqueSites: result.uniqueSites,
      uniqueCommits: result.uniqueCommits,
      dateRange: {
        earliest: result.earliest,
        latest: result.latest,
      },
    };
  } finally {
    db.close();
  }
}
