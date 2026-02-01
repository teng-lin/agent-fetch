/**
 * Database recorder module for E2E tests
 *
 * Records test results to SQLite with:
 * - Fetch results (status, latency, extraction method)
 * - Antibot detections (provider, confidence, evidence)
 * - Optional HTML compression (RECORD_HTML=true)
 * - Git commit tracking for reproducibility
 */

import Database from 'better-sqlite3';
import { gzipSync } from 'zlib';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import type { FetchResult } from '../fetch/types.js';
import type { AntibotDetection } from '../antibot/detector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../');

let dbPath: string = path.join(PROJECT_ROOT, 'lynxget-e2e.db');
let db: Database.Database | null = null;
let cachedGitCommit: string | null = null;

/**
 * Set database path (for testing)
 */
export function setDatabasePath(newPath: string): void {
  if (db) {
    closeDatabase();
  }
  dbPath = newPath;
}

/**
 * Get the current git commit hash
 * Cached after first call to avoid repeated shell commands
 */
function getGitCommit(): string {
  if (cachedGitCommit) {
    return cachedGitCommit;
  }

  try {
    cachedGitCommit = execSync('git rev-parse HEAD', {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
    }).trim();
    return cachedGitCommit;
  } catch {
    cachedGitCommit = 'unknown';
    return cachedGitCommit;
  }
}

/**
 * Initialize database connection and create tables if needed
 * Idempotent - safe to call multiple times
 */
export function initializeDatabase(): void {
  if (db) return;

  try {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    // Create e2e_runs table
    db.exec(`
      CREATE TABLE IF NOT EXISTS e2e_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        git_commit TEXT NOT NULL,
        site TEXT NOT NULL,
        run_type TEXT NOT NULL DEFAULT 'fetch',
        url TEXT NOT NULL,
        success INTEGER NOT NULL,
        latency_ms INTEGER,
        status_code INTEGER,
        extraction_method TEXT,
        title TEXT,
        author TEXT,
        body TEXT,
        publish_date TEXT,
        lang TEXT,
        error_message TEXT,
        error_type TEXT,
        raw_html_compressed BLOB,
        timestamp DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_e2e_runs_git_commit
        ON e2e_runs(git_commit);
      CREATE INDEX IF NOT EXISTS idx_e2e_runs_site
        ON e2e_runs(site);
      CREATE INDEX IF NOT EXISTS idx_e2e_runs_timestamp
        ON e2e_runs(timestamp);
    `);

    // Create antibot_detections table
    db.exec(`
      CREATE TABLE IF NOT EXISTS antibot_detections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        confidence INTEGER NOT NULL,
        evidence TEXT NOT NULL,
        suggested_action TEXT NOT NULL,
        timestamp DATETIME NOT NULL,
        FOREIGN KEY (run_id) REFERENCES e2e_runs(id)
      );

      CREATE INDEX IF NOT EXISTS idx_antibot_detections_run_id
        ON antibot_detections(run_id);
      CREATE INDEX IF NOT EXISTS idx_antibot_detections_provider
        ON antibot_detections(provider);
    `);
  } catch (err) {
    console.error('Failed to initialize database:', err);
  }
}

/**
 * Extract numeric status code from result
 */
function extractStatusCode(result: FetchResult): number | null {
  if (result.statusCode !== undefined && result.statusCode !== null) {
    return result.statusCode;
  }
  if (result.errorDetails?.statusCode) {
    return result.errorDetails.statusCode;
  }
  return null;
}

/**
 * Extract body text from result (tries multiple fields)
 */
function extractBody(result: FetchResult): string | null {
  if (result.textContent) {
    return result.textContent;
  }
  if (result.content) {
    return result.content;
  }
  return null;
}

/**
 * Extract author from result (field mapping)
 */
function extractAuthor(result: FetchResult): string | null {
  return result.byline || null;
}

/**
 * Extract publish date from result (field mapping)
 */
function extractPublishDate(result: FetchResult): string | null {
  return result.publishedTime || null;
}

/**
 * Record a test result to the database
 *
 * @param site - Site identifier (e.g., 'bbc', 'nytimes')
 * @param result - FetchResult from the test
 */
export function recordTestResult(site: string, result: FetchResult): void {
  if (!db) {
    initializeDatabase();
  }

  if (!db) {
    return; // Silent failure if db still not initialized
  }

  try {
    const shouldRecordDb =
      process.env.RECORD_E2E_DB !== 'false' &&
      process.env.RECORD_E2E_DB !== '0';
    const shouldRecordHtml = process.env.RECORD_HTML === 'true' || process.env.RECORD_HTML === '1';

    if (!shouldRecordDb) {
      return;
    }

    const gitCommit = getGitCommit();
    const timestamp = new Date().toISOString();
    const statusCode = extractStatusCode(result);
    const body = extractBody(result);
    const author = extractAuthor(result);
    const publishDate = extractPublishDate(result);
    const runType = 'fetch'; // E2E fetch tests are always 'fetch' type

    // Compress HTML if enabled
    let compressedHtml: Buffer | null = null;
    if (shouldRecordHtml && result.rawHtml) {
      try {
        compressedHtml = gzipSync(result.rawHtml);
      } catch (err) {
        console.warn('Failed to compress HTML:', err);
      }
    }

    // Insert main result
    const insertStmt = db.prepare(`
      INSERT INTO e2e_runs (
        git_commit,
        site,
        run_type,
        url,
        success,
        latency_ms,
        status_code,
        extraction_method,
        title,
        author,
        body,
        publish_date,
        lang,
        error_message,
        error_type,
        raw_html_compressed,
        timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const info = insertStmt.run(
      gitCommit,
      site,
      runType,
      result.url,
      result.success ? 1 : 0,
      result.latencyMs,
      statusCode,
      result.extractionMethod || null,
      result.title || null,
      author,
      body,
      publishDate,
      result.lang || null,
      result.error || null,
      result.errorDetails?.type || null,
      compressedHtml,
      timestamp
    );

    const runId = info.lastInsertRowid;

    // Insert antibot detections if present
    if (result.antibot && result.antibot.length > 0 && typeof runId === 'number') {
      const insertAntibotStmt = db.prepare(`
        INSERT INTO antibot_detections (
          run_id,
          provider,
          name,
          category,
          confidence,
          evidence,
          suggested_action,
          timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const detection of result.antibot) {
        insertAntibotStmt.run(
          runId,
          detection.provider,
          detection.name,
          detection.category,
          detection.confidence,
          JSON.stringify(detection.evidence),
          detection.suggestedAction,
          timestamp
        );
      }
    }
  } catch (err) {
    console.warn('Failed to record test result to database:', err);
    // Don't throw - let tests continue even if recording fails
  }
}

/**
 * Close database connection
 * Safe to call multiple times
 */
export function closeDatabase(): void {
  if (db) {
    try {
      db.close();
    } catch (err) {
      console.warn('Error closing database:', err);
    }
    db = null;
  }
}

/**
 * Get database instance (for testing)
 */
export function getDatabase(): Database.Database | null {
  return db;
}

/**
 * Get the database path
 */
export function getDatabasePath(): string {
  return dbPath;
}
