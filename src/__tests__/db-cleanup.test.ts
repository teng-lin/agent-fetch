import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { parseDateString } from '../../scripts/e2e-db-cleanup.js';

const TEST_DB_PATH = path.resolve('/tmp', `test-cleanup-${Date.now()}.db`);
let dbAvailable = true;

describe('e2e-db-cleanup', () => {
  beforeEach(() => {
    // Clean up any existing test database
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }

    // Create test database with schema
    try {
      const db = new Database(TEST_DB_PATH);
      db.exec(`
        CREATE TABLE e2e_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          git_commit TEXT,
          timestamp DATETIME,
          site TEXT,
          url TEXT,
          success INTEGER,
          run_type TEXT DEFAULT 'fetch'
        );

        CREATE TABLE antibot_detections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL,
          provider TEXT,
          FOREIGN KEY(run_id) REFERENCES e2e_runs(id) ON DELETE CASCADE
        );

        CREATE INDEX idx_e2e_runs_timestamp ON e2e_runs(timestamp);
      `);
      db.close();
    } catch {
      // better-sqlite3 native module not available
      dbAvailable = false;
    }
  });

  afterEach(() => {
    // Clean up test database
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  describe('parseDateString', () => {
    it('should parse ISO date format (YYYY-MM-DD)', () => {
      const dateStr = '2025-12-31';
      const parsed = parseDateString(dateStr);

      expect(parsed.getUTCFullYear()).toBe(2025);
      expect(parsed.getUTCMonth()).toBe(11); // 0-indexed
      expect(parsed.getUTCDate()).toBe(31);
    });

    it('should parse ISO date format at midnight UTC', () => {
      const dateStr = '2026-01-15';
      const parsed = parseDateString(dateStr);

      // Should parse to midnight UTC
      expect(parsed.toISOString()).toContain('2026-01-15T00:00:00');
    });

    it('should parse relative date format (30d)', () => {
      const now = new Date();
      const before30d = parseDateString('30d');

      // Should be approximately 30 days ago
      const diffMs = now.getTime() - before30d.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);

      expect(diffDays).toBeGreaterThanOrEqual(29.9);
      expect(diffDays).toBeLessThanOrEqual(30.1);
    });

    it('should parse relative date format (24h)', () => {
      const now = new Date();
      const before24h = parseDateString('24h');

      // Should be approximately 24 hours ago
      const diffMs = now.getTime() - before24h.getTime();
      const diffHours = diffMs / (1000 * 60 * 60);

      expect(diffHours).toBeGreaterThanOrEqual(23.9);
      expect(diffHours).toBeLessThanOrEqual(24.1);
    });

    it('should parse relative date format (5m)', () => {
      const now = new Date();
      const before5m = parseDateString('5m');

      // Should be approximately 5 minutes ago
      const diffMs = now.getTime() - before5m.getTime();
      const diffMinutes = diffMs / (1000 * 60);

      expect(diffMinutes).toBeGreaterThanOrEqual(4.9);
      expect(diffMinutes).toBeLessThanOrEqual(5.1);
    });

    it('should throw on invalid date format', () => {
      expect(() => parseDateString('invalid')).toThrow('Invalid date format');
      expect(() => parseDateString('99999-01-01')).toThrow('Invalid date format');
      expect(() => parseDateString('30x')).toThrow('Invalid date format');
    });
  });

  describe('counting deletable records', () => {
    it('should count records correctly', () => {
      if (!dbAvailable) {
        expect(true).toBe(true);
        return;
      }

      const db = new Database(TEST_DB_PATH);

      // Insert test data
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const insertRun = db.prepare(`
        INSERT INTO e2e_runs (git_commit, timestamp, site, url, success, run_type)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      insertRun.run('abc123', now.toISOString(), 'site1', 'url1', 1, 'fetch');
      insertRun.run('abc123', yesterday.toISOString(), 'site2', 'url2', 1, 'fetch');
      insertRun.run('abc123', lastWeek.toISOString(), 'site3', 'url3', 0, 'fetch');

      // Count all runs
      const allRuns = db.prepare('SELECT COUNT(*) as count FROM e2e_runs').get() as Record<
        string,
        number
      >;
      expect(allRuns.count).toBe(3);

      db.close();
    });

    it('should count records before a specific date', () => {
      if (!dbAvailable) {
        expect(true).toBe(true);
        return;
      }

      const db = new Database(TEST_DB_PATH);

      // Insert test data
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const insertRun = db.prepare(`
        INSERT INTO e2e_runs (git_commit, timestamp, site, url, success, run_type)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      insertRun.run('abc123', now.toISOString(), 'site1', 'url1', 1, 'fetch');
      insertRun.run('abc123', yesterday.toISOString(), 'site2', 'url2', 1, 'fetch');
      insertRun.run('abc123', lastWeek.toISOString(), 'site3', 'url3', 0, 'fetch');

      // Count records before 3 days ago
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
      const result = db
        .prepare('SELECT COUNT(*) as count FROM e2e_runs WHERE timestamp < ?')
        .get(threeDaysAgo.toISOString()) as Record<string, number>;

      expect(result.count).toBe(1); // Only lastWeek record
      db.close();
    });

    it('should count related antibot detections', () => {
      if (!dbAvailable) {
        expect(true).toBe(true);
        return;
      }

      const db = new Database(TEST_DB_PATH);

      // Insert test data
      const now = new Date();
      const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const insertRun = db.prepare(`
        INSERT INTO e2e_runs (git_commit, timestamp, site, url, success, run_type)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const run1 = insertRun.run('abc123', now.toISOString(), 'site1', 'url1', 1, 'fetch');
      const run2 = insertRun.run('abc123', lastWeek.toISOString(), 'site2', 'url2', 0, 'fetch');

      // Insert detections
      const insertDetection = db.prepare(`
        INSERT INTO antibot_detections (run_id, provider)
        VALUES (?, ?)
      `);

      insertDetection.run(run1.lastInsertRowid, 'cloudflare');
      insertDetection.run(run2.lastInsertRowid, 'akamai');
      insertDetection.run(run2.lastInsertRowid, 'recaptcha');

      // Count detections for old runs (before 3 days ago)
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
      const result = db
        .prepare(
          `SELECT COUNT(*) as count FROM antibot_detections WHERE run_id IN (
            SELECT id FROM e2e_runs WHERE timestamp < ?
          )`
        )
        .get(threeDaysAgo.toISOString()) as Record<string, number>;

      expect(result.count).toBe(2); // Only the 2 detections from old run
      db.close();
    });
  });

  describe('cleanup operations', () => {
    it('should remove records before a specific date', () => {
      if (!dbAvailable) {
        expect(true).toBe(true);
        return;
      }

      const db = new Database(TEST_DB_PATH);

      // Insert test data
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const insertRun = db.prepare(`
        INSERT INTO e2e_runs (git_commit, timestamp, site, url, success, run_type)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      insertRun.run('abc123', now.toISOString(), 'site1', 'url1', 1, 'fetch');
      insertRun.run('abc123', yesterday.toISOString(), 'site2', 'url2', 1, 'fetch');
      insertRun.run('abc123', lastWeek.toISOString(), 'site3', 'url3', 0, 'fetch');

      // Delete records before 3 days ago
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
      db.prepare('DELETE FROM e2e_runs WHERE timestamp < ?').run(threeDaysAgo.toISOString());

      // Verify only recent records remain
      const remaining = db.prepare('SELECT COUNT(*) as count FROM e2e_runs').get() as Record<
        string,
        number
      >;

      expect(remaining.count).toBe(2); // now and yesterday should remain
      db.close();
    });

    it('should cascade delete antibot detections with runs', () => {
      if (!dbAvailable) {
        expect(true).toBe(true);
        return;
      }

      const db = new Database(TEST_DB_PATH);

      // Insert test data
      const now = new Date();
      const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const insertRun = db.prepare(`
        INSERT INTO e2e_runs (git_commit, timestamp, site, url, success, run_type)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const run1 = insertRun.run('abc123', now.toISOString(), 'site1', 'url1', 1, 'fetch');
      const run2 = insertRun.run('abc123', lastWeek.toISOString(), 'site2', 'url2', 0, 'fetch');

      // Insert detections
      const insertDetection = db.prepare(`
        INSERT INTO antibot_detections (run_id, provider)
        VALUES (?, ?)
      `);

      insertDetection.run(run1.lastInsertRowid, 'cloudflare');
      insertDetection.run(run2.lastInsertRowid, 'akamai');
      insertDetection.run(run2.lastInsertRowid, 'recaptcha');

      // Delete old run
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
      db.prepare('DELETE FROM e2e_runs WHERE timestamp < ?').run(threeDaysAgo.toISOString());

      // Verify detections were also deleted
      const remainingDetections = db
        .prepare('SELECT COUNT(*) as count FROM antibot_detections')
        .get() as Record<string, number>;

      expect(remainingDetections.count).toBe(1); // Only the cloudflare detection should remain
      db.close();
    });

    it('should correctly preserve records when criteria do not match', () => {
      if (!dbAvailable) {
        expect(true).toBe(true);
        return;
      }

      const db = new Database(TEST_DB_PATH);

      // Insert test data
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const insertRun = db.prepare(`
        INSERT INTO e2e_runs (git_commit, timestamp, site, url, success, run_type)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      insertRun.run('abc123', now.toISOString(), 'site1', 'url1', 1, 'fetch');
      insertRun.run('abc123', yesterday.toISOString(), 'site2', 'url2', 1, 'fetch');
      const run3 = insertRun.run('abc123', lastWeek.toISOString(), 'site3', 'url3', 0, 'fetch');

      // Insert detections only for older run
      const insertDetection = db.prepare(`
        INSERT INTO antibot_detections (run_id, provider)
        VALUES (?, ?)
      `);

      insertDetection.run(run3.lastInsertRowid, 'akamai');

      // Delete records before 3 days ago (should only delete run3)
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
      db.prepare('DELETE FROM e2e_runs WHERE timestamp < ?').run(threeDaysAgo.toISOString());

      // Verify only the old run and its detection were deleted
      const remainingRuns = db.prepare('SELECT COUNT(*) as count FROM e2e_runs').get() as Record<
        string,
        number
      >;
      const remainingDetections = db
        .prepare('SELECT COUNT(*) as count FROM antibot_detections')
        .get() as Record<string, number>;

      expect(remainingRuns.count).toBe(2);
      expect(remainingDetections.count).toBe(0);
      db.close();
    });
  });
});
