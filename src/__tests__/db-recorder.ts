/**
 * Database recorder module for E2E tests
 *
 * Records test results to SQLite with:
 * - Test run tracking (one per execution)
 * - URL target configuration (min word count per URL)
 * - Individual fetch results linked to test runs
 * - Antibot detections (provider, confidence, evidence)
 * - Optional HTML compression (RECORD_HTML=true)
 *
 * Uses sql.js (pure JavaScript SQLite) for cross-platform compatibility
 */

import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { gzipSync } from 'zlib';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { FetchResult } from '../fetch/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../');

let dbPath: string = path.join(PROJECT_ROOT, 'lynxget-e2e.db');
let db: SqlJsDatabase | null = null;
let sqlJs: any = null;
let cachedGitCommit: string | null = null;
let currentRunId: string | null = null;

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
 * Generate a unique run ID (UUID-like string)
 */
function generateRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Initialize database connection and create tables if needed
 * Idempotent - safe to call multiple times
 */
export async function initializeDatabase(): Promise<void> {
  if (db) return;

  try {
    // Initialize sql.js
    if (!sqlJs) {
      sqlJs = await initSqlJs();
    }

    // Load existing database or create new one
    if (existsSync(dbPath)) {
      const buffer = readFileSync(dbPath);
      db = new sqlJs.Database(buffer);
    } else {
      db = new sqlJs.Database();
    }

    // Create url_targets table (static configuration)
    db.run(`
      CREATE TABLE IF NOT EXISTS url_targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        min_word_count INTEGER NOT NULL DEFAULT 200,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_url_targets_site
        ON url_targets(site);
      CREATE INDEX IF NOT EXISTS idx_url_targets_url
        ON url_targets(url);
    `);

    // Create test_runs table (one per test execution)
    db.run(`
      CREATE TABLE IF NOT EXISTS test_runs (
        run_id TEXT PRIMARY KEY,
        git_commit TEXT NOT NULL,
        run_type TEXT NOT NULL DEFAULT 'fetch',
        started_at DATETIME NOT NULL,
        ended_at DATETIME,
        total_tests INTEGER,
        passed_tests INTEGER,
        failed_tests INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_test_runs_git_commit
        ON test_runs(git_commit);
      CREATE INDEX IF NOT EXISTS idx_test_runs_started_at
        ON test_runs(started_at);
    `);

    // Create e2e_runs table (individual test results)
    db.run(`
      CREATE TABLE IF NOT EXISTS e2e_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        url_target_id INTEGER,
        site TEXT NOT NULL,
        url TEXT NOT NULL,
        success INTEGER NOT NULL,
        word_count INTEGER,
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (run_id) REFERENCES test_runs(run_id),
        FOREIGN KEY (url_target_id) REFERENCES url_targets(id)
      );

      CREATE INDEX IF NOT EXISTS idx_e2e_runs_run_id
        ON e2e_runs(run_id);
      CREATE INDEX IF NOT EXISTS idx_e2e_runs_url_target_id
        ON e2e_runs(url_target_id);
      CREATE INDEX IF NOT EXISTS idx_e2e_runs_site
        ON e2e_runs(site);
      CREATE INDEX IF NOT EXISTS idx_e2e_runs_timestamp
        ON e2e_runs(timestamp);
    `);

    // Create antibot_detections table
    db.run(`
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

    // Save database to disk
    saveDatabaseToDisk();
  } catch (err) {
    console.error('Failed to initialize database:', err);
  }
}

/**
 * Start a new test run and return the run ID
 */
export function startTestRun(runType: string = 'fetch'): string {
  if (!db) {
    throw new Error('Database not initialized');
  }

  const runId = generateRunId();
  const gitCommit = getGitCommit();
  const startedAt = new Date().toISOString();

  db.run(`
    INSERT INTO test_runs (run_id, git_commit, run_type, started_at)
    VALUES (?, ?, ?, ?)
  `, [runId, gitCommit, runType, startedAt]);

  currentRunId = runId;
  saveDatabaseToDisk();
  return runId;
}

/**
 * End the current test run with final statistics
 */
export function endTestRun(totalTests: number, passedTests: number, failedTests: number): void {
  if (!db || !currentRunId) {
    return;
  }

  const endedAt = new Date().toISOString();

  db.run(`
    UPDATE test_runs
    SET ended_at = ?, total_tests = ?, passed_tests = ?, failed_tests = ?
    WHERE run_id = ?
  `, [endedAt, totalTests, passedTests, failedTests, currentRunId]);

  saveDatabaseToDisk();
  currentRunId = null;
}

/**
 * Get or create URL target
 */
function getOrCreateUrlTarget(site: string, url: string, minWordCount: number): number {
  if (!db) {
    throw new Error('Database not initialized');
  }

  // Try to get existing
  const result = db.exec(
    'SELECT id FROM url_targets WHERE url = ?',
    [url]
  );

  if (result.length > 0 && result[0].values.length > 0) {
    return result[0].values[0][0] as number;
  }

  // Create new
  db.run(`
    INSERT OR IGNORE INTO url_targets (site, url, min_word_count)
    VALUES (?, ?, ?)
  `, [site, url, minWordCount]);

  // Get the ID
  const selectResult = db.exec(
    'SELECT id FROM url_targets WHERE url = ?',
    [url]
  );

  if (selectResult.length > 0 && selectResult[0].values.length > 0) {
    return selectResult[0].values[0][0] as number;
  }

  throw new Error(`Failed to get or create url_target for ${url}`);
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
 * Extract word count from result
 */
function extractWordCount(result: FetchResult): number | null {
  if (result.textContent) {
    return result.textContent.split(/\s+/).filter(w => w.length > 0).length;
  }
  if (result.content) {
    return result.content.split(/\s+/).filter(w => w.length > 0).length;
  }
  return null;
}

/**
 * Record a test result to the database
 *
 * @param site - Site identifier (e.g., 'bbc', 'nytimes')
 * @param result - FetchResult from the test
 * @param minWordCount - Minimum expected word count for this URL
 */
export function recordTestResult(
  site: string,
  result: FetchResult,
  minWordCount: number = 200
): void {
  if (!db) {
    reloadOrInitializeDatabase();
  }

  if (!db || !currentRunId) {
    return; // Silent failure if db still not initialized or no active run
  }

  try {
    const shouldRecordDb =
      process.env.RECORD_E2E_DB !== 'false' && process.env.RECORD_E2E_DB !== '0';
    const shouldRecordHtml = process.env.RECORD_HTML === 'true' || process.env.RECORD_HTML === '1';

    if (!shouldRecordDb) {
      return;
    }

    const timestamp = new Date().toISOString();
    const statusCode = extractStatusCode(result);
    const body = extractBody(result);
    const author = extractAuthor(result);
    const publishDate = extractPublishDate(result);
    const wordCount = extractWordCount(result);

    // Get or create URL target
    const urlTargetId = getOrCreateUrlTarget(site, result.url, minWordCount);

    // Compress HTML if enabled
    let compressedHtml: Uint8Array | null = null;
    if (shouldRecordHtml && result.rawHtml) {
      try {
        const compressed = gzipSync(result.rawHtml);
        compressedHtml = new Uint8Array(compressed);
      } catch (err) {
        console.warn('Failed to compress HTML:', err);
      }
    }

    // Insert main result
    db.run(`
      INSERT INTO e2e_runs (
        run_id,
        url_target_id,
        site,
        url,
        success,
        word_count,
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      currentRunId,
      urlTargetId,
      site,
      result.url,
      result.success ? 1 : 0,
      wordCount,
      result.latencyMs ?? null,
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
    ]);

    // Get the last inserted row ID
    const lastIdResult = db.exec('SELECT last_insert_rowid() as id');
    const runResultId = lastIdResult[0]?.values[0]?.[0];

    // Insert antibot detections if present
    if (result.antibot && result.antibot.length > 0 && typeof runResultId === 'number') {
      for (const detection of result.antibot) {
        db.run(`
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
        `, [
          runResultId,
          detection.provider,
          detection.name,
          detection.category,
          detection.confidence,
          JSON.stringify(detection.evidence),
          detection.suggestedAction,
          timestamp
        ]);
      }
    }

    // Save database to disk after each insert
    saveDatabaseToDisk();
  } catch (err) {
    console.warn('Failed to record test result to database:', err);
    // Don't throw - let tests continue even if recording fails
  }
}

/**
 * Save the current database to disk
 */
function saveDatabaseToDisk(): void {
  if (!db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    writeFileSync(dbPath, buffer);
  } catch (err) {
    console.warn('Failed to save database to disk:', err);
  }
}

/**
 * Reload database from disk or initialize if needed
 */
function reloadOrInitializeDatabase(): void {
  try {
    if (!sqlJs) {
      // This is synchronous loading - sql.js initialization is already done
      return;
    }

    if (existsSync(dbPath)) {
      const buffer = readFileSync(dbPath);
      db = new sqlJs.Database(buffer);
    } else {
      db = new sqlJs.Database();
    }
  } catch (err) {
    console.warn('Failed to reload database:', err);
  }
}

/**
 * Close database connection and save to disk
 * Safe to call multiple times
 */
export function closeDatabase(): void {
  if (db) {
    try {
      saveDatabaseToDisk();
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
export function getDatabase(): SqlJsDatabase | null {
  return db;
}

/**
 * Get the database path
 */
export function getDatabasePath(): string {
  return dbPath;
}

/**
 * Get current run ID
 */
export function getCurrentRunId(): string | null {
  return currentRunId;
}
