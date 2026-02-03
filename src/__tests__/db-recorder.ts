/**
 * SQLite-backed test recorder for E2E tests
 */
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { execSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'lynxget-e2e.db');

let db: SqlJsDatabase | null = null;
let currentRunId: string | null = null;

/**
 * Get the current git commit hash
 */
function getGitCommit(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Generate a unique run ID
 */
function generateRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Load existing database from disk
 */
function loadDatabaseFromDisk(): Uint8Array | null {
  try {
    if (fs.existsSync(DB_PATH)) {
      return fs.readFileSync(DB_PATH);
    }
  } catch (error) {
    console.warn('Failed to load existing database:', error);
  }
  return null;
}

/**
 * Save database to disk
 */
function saveDatabaseToDisk(): void {
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, data);
  } catch (error) {
    console.error('Failed to save database:', error);
  }
}

/**
 * Initialize the SQLite database (in-memory with disk persistence)
 */
export async function initializeDatabase(): Promise<void> {
  if (db) return;

  const SQL = await initSqlJs();

  // Load existing database or create new one
  const existingData = loadDatabaseFromDisk();
  db = existingData ? new SQL.Database(existingData) : new SQL.Database();

  if (!existingData) {
    // Create schema for new database
    db.run(`
      CREATE TABLE IF NOT EXISTS test_runs (
        run_id TEXT PRIMARY KEY,
        git_commit TEXT NOT NULL,
        run_type TEXT NOT NULL DEFAULT 'fetch',
        os TEXT,
        network TEXT,
        preset TEXT,
        started_at DATETIME NOT NULL,
        ended_at DATETIME,
        total_tests INTEGER,
        passed_tests INTEGER,
        failed_tests INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS test_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        test_name TEXT NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL,
        http_status INTEGER,
        fetch_duration_ms INTEGER,
        extract_strategy TEXT,
        content_length INTEGER,
        error_message TEXT,
        antibot_detections TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (run_id) REFERENCES test_runs(run_id)
      );
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_test_results_run_id ON test_results(run_id);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_test_results_url ON test_results(url);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_test_results_status ON test_results(status);`);

    saveDatabaseToDisk();
  } else {
    // Migrate existing database: ensure new tables and columns exist
    db.run(`
      CREATE TABLE IF NOT EXISTS test_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        test_name TEXT NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL,
        http_status INTEGER,
        fetch_duration_ms INTEGER,
        extract_strategy TEXT,
        content_length INTEGER,
        error_message TEXT,
        antibot_detections TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (run_id) REFERENCES test_runs(run_id)
      );
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_test_results_run_id ON test_results(run_id);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_test_results_url ON test_results(url);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_test_results_status ON test_results(status);`);

    // Migrate existing test_runs: add columns if they don't exist
    const columnsResult = db.exec('PRAGMA table_info(test_runs)');
    const existingColumns = new Set(columnsResult[0]?.values.map((row) => row[1] as string) ?? []);
    for (const col of ['os', 'network', 'preset']) {
      if (!existingColumns.has(col)) {
        db.run(`ALTER TABLE test_runs ADD COLUMN ${col} TEXT`);
      }
    }
    saveDatabaseToDisk();
  }
}

export interface TestRunOptions {
  runType?: string;
  preset?: string;
}

/**
 * Start a new test run and return the run ID
 *
 * Environment metadata is auto-detected:
 * - OS: from os.platform() + os.release()
 * - Network: from LYNXGET_NETWORK env var (e.g. 'home-wifi', 'vpn-us-east')
 * - Preset: TLS fingerprint preset, passed explicitly or from LYNXGET_PRESET env var
 */
export function startTestRun(runTypeOrOptions: string | TestRunOptions = 'fetch'): string {
  if (!db) {
    throw new Error('Database not initialized');
  }

  const opts =
    typeof runTypeOrOptions === 'string' ? { runType: runTypeOrOptions } : runTypeOrOptions;

  const runType = opts.runType ?? 'fetch';
  const detectedOs = `${os.platform()}/${os.release()}`;
  const network = process.env.LYNXGET_NETWORK || null;
  const preset = opts.preset ?? process.env.LYNXGET_PRESET ?? null;

  const runId = generateRunId();
  const gitCommit = getGitCommit();
  const startedAt = new Date().toISOString();

  db.run(
    `
    INSERT INTO test_runs (run_id, git_commit, run_type, os, network, preset, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    [runId, gitCommit, runType, detectedOs, network, preset, startedAt]
  );

  currentRunId = runId;
  saveDatabaseToDisk();
  return runId;
}

/**
 * End the current test run with summary stats
 */
export function endTestRun(passed: number, failed: number): void {
  if (!db || !currentRunId) {
    throw new Error('No active test run');
  }

  const endedAt = new Date().toISOString();
  const total = passed + failed;

  db.run(
    `UPDATE test_runs SET ended_at = ?, total_tests = ?, passed_tests = ?, failed_tests = ? WHERE run_id = ?`,
    [endedAt, total, passed, failed, currentRunId]
  );

  saveDatabaseToDisk();
  currentRunId = null;
}

/**
 * Record a single test result
 */
export interface TestResult {
  testName: string;
  url: string;
  status: 'pass' | 'fail';
  httpStatus?: number;
  fetchDurationMs?: number;
  extractStrategy?: string;
  contentLength?: number;
  errorMessage?: string;
  antibotDetections?: string[];
}

export function recordTestResult(result: TestResult): void {
  if (!db || !currentRunId) {
    throw new Error('No active test run');
  }

  db.run(
    `
    INSERT INTO test_results (
      run_id, test_name, url, status, http_status, fetch_duration_ms,
      extract_strategy, content_length, error_message, antibot_detections
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    [
      currentRunId,
      result.testName,
      result.url,
      result.status,
      result.httpStatus ?? null,
      result.fetchDurationMs ?? null,
      result.extractStrategy ?? null,
      result.contentLength ?? null,
      result.errorMessage ?? null,
      result.antibotDetections ? JSON.stringify(result.antibotDetections) : null,
    ]
  );

  saveDatabaseToDisk();
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    saveDatabaseToDisk();
    db.close();
    db = null;
  }
}
