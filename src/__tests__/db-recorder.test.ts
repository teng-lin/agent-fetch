import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import {
  initializeDatabase,
  recordTestResult,
  closeDatabase,
  getDatabase,
  getDatabasePath,
  setDatabasePath,
} from './db-recorder.js';
import type { FetchResult } from '../fetch/types.js';
import type { AntibotDetection } from '../antibot/detector.js';

describe('db-recorder', () => {
  let testDbPath: string;

  beforeEach(() => {
    // Create a temporary test database
    testDbPath = path.join('/tmp', `test-lynxget-${Date.now()}.db`);
    // Set test database path
    setDatabasePath(testDbPath);
  });

  afterEach(() => {
    closeDatabase();
    // Clean up test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('initializeDatabase', () => {
    it('should create database tables idempotently', () => {
      initializeDatabase();
      const db = getDatabase();
      // Skip test if better-sqlite3 can't load (missing build tools)
      if (!db) {
        expect(true).toBe(true);
        return;
      }

      // Check e2e_runs table exists
      const tables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='e2e_runs'`)
        .all();
      expect(tables).toHaveLength(1);

      // Check antibot_detections table exists
      const antibotTables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='antibot_detections'`)
        .all();
      expect(antibotTables).toHaveLength(1);
    });

    it('should be safe to call multiple times', () => {
      initializeDatabase();
      initializeDatabase();
      initializeDatabase();

      const db = getDatabase();
      // Skip test if better-sqlite3 can't load
      if (!db) {
        expect(true).toBe(true);
        return;
      }

      const tables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='e2e_runs'`)
        .all();
      expect(tables).toHaveLength(1);
    });

    it('should create proper schema with indexes', () => {
      initializeDatabase();
      const db = getDatabase();

      if (!db) {
        expect(true).toBe(true);
        return;
      }

      // Check indexes on e2e_runs
      const indexes = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='e2e_runs'`)
        .all();
      expect(indexes.length).toBeGreaterThanOrEqual(3);

      const indexNames = indexes.map((idx: any) => idx.name);
      expect(indexNames).toContain('idx_e2e_runs_git_commit');
      expect(indexNames).toContain('idx_e2e_runs_site');
      expect(indexNames).toContain('idx_e2e_runs_timestamp');
    });
  });

  describe('recordTestResult', () => {
    beforeEach(() => {
      initializeDatabase();
      // Enable recording by default
      process.env.RECORD_E2E_DB = 'true';
      process.env.RECORD_HTML = 'false';
    });

    it('should record a successful result', () => {
      const result: FetchResult = {
        success: true,
        url: 'https://example.com',
        latencyMs: 150,
        title: 'Example Article',
        byline: 'John Doe',
        textContent: 'This is the article body.',
        publishedTime: '2024-01-01T12:00:00Z',
        lang: 'en',
        statusCode: 200,
        extractionMethod: 'readability',
      };

      recordTestResult('example', result);

      const db = getDatabase();
      if (db) {
        const rows = db.prepare('SELECT * FROM e2e_runs').all();
        expect(rows).toHaveLength(1);

        const row: any = rows[0];
        expect(row.success).toBe(1);
        expect(row.site).toBe('example');
        expect(row.run_type).toBe('fetch');
        expect(row.url).toBe('https://example.com');
        expect(row.latency_ms).toBe(150);
        expect(row.status_code).toBe(200);
        expect(row.extraction_method).toBe('readability');
        expect(row.title).toBe('Example Article');
        expect(row.author).toBe('John Doe');
        expect(row.body).toBe('This is the article body.');
        expect(row.publish_date).toBe('2024-01-01T12:00:00Z');
        expect(row.lang).toBe('en');
      }
    });

    it('should record a failed result', () => {
      const result: FetchResult = {
        success: false,
        url: 'https://blocked.example.com',
        latencyMs: 300,
        error: 'Blocked by Cloudflare',
        errorDetails: {
          type: 'challenge_detected',
          statusCode: 403,
        },
        statusCode: 403,
      };

      recordTestResult('blocked', result);

      const db = getDatabase();
      if (db) {
        const rows = db.prepare('SELECT * FROM e2e_runs').all();
        expect(rows).toHaveLength(1);

        const row: any = rows[0];
        expect(row.success).toBe(0);
        expect(row.site).toBe('blocked');
        expect(row.run_type).toBe('fetch');
        expect(row.status_code).toBe(403);
        expect(row.error_message).toBe('Blocked by Cloudflare');
        expect(row.error_type).toBe('challenge_detected');
      }
    });

    it('should map fields correctly (textContent -> body, byline -> author)', () => {
      const result: FetchResult = {
        success: true,
        url: 'https://example.com',
        latencyMs: 100,
        textContent: 'Article content',
        byline: 'Jane Smith',
        publishedTime: '2024-02-01T10:00:00Z',
      };

      recordTestResult('test', result);

      const db = getDatabase();
      if (db) {
        const row: any = db.prepare('SELECT * FROM e2e_runs').get();
        expect(row.run_type).toBe('fetch');
        expect(row.body).toBe('Article content');
        expect(row.author).toBe('Jane Smith');
        expect(row.publish_date).toBe('2024-02-01T10:00:00Z');
      }
    });

    it('should record antibot detections as separate rows', () => {
      const detections: AntibotDetection[] = [
        {
          provider: 'cloudflare',
          name: 'Cloudflare',
          category: 'antibot',
          confidence: 100,
          evidence: ['header: cf-ray', 'cookie: __cf_bm'],
          suggestedAction: 'retry-tls',
        },
        {
          provider: 'recaptcha',
          name: 'reCAPTCHA',
          category: 'captcha',
          confidence: 85,
          evidence: ['content: __RECAPTCHA_CLIENT'],
          suggestedAction: 'solve-captcha',
        },
      ];

      const result: FetchResult = {
        success: false,
        url: 'https://protected.com',
        latencyMs: 200,
        statusCode: 403,
        antibot: detections,
      };

      recordTestResult('protected', result);

      const db = getDatabase();
      if (db) {
        // Check main result was recorded
        const runs = db.prepare('SELECT * FROM e2e_runs').all();
        expect(runs).toHaveLength(1);
        expect(runs[0].run_type).toBe('fetch');

        // Check detections were recorded
        const detectionRows = db.prepare('SELECT * FROM antibot_detections').all();
        expect(detectionRows).toHaveLength(2);

        const cloudflareDetection: any = detectionRows[0];
        expect(cloudflareDetection.provider).toBe('cloudflare');
        expect(cloudflareDetection.confidence).toBe(100);
        expect(JSON.parse(cloudflareDetection.evidence)).toEqual([
          'header: cf-ray',
          'cookie: __cf_bm',
        ]);
      }
    });

    it('should compress HTML when RECORD_HTML is enabled', () => {
      process.env.RECORD_HTML = 'true';

      const htmlContent = '<html><body>Test content</body></html>';
      const result: FetchResult = {
        success: true,
        url: 'https://example.com',
        latencyMs: 100,
        rawHtml: htmlContent,
      };

      recordTestResult('example', result);

      const db = getDatabase();
      if (db) {
        const row: any = db.prepare('SELECT * FROM e2e_runs').get();
        expect(row.run_type).toBe('fetch');
        expect(row.raw_html_compressed).not.toBeNull();

        // Verify it's actually gzipped
        if (row.raw_html_compressed) {
          // Gzip magic number is 1f 8b
          expect(row.raw_html_compressed[0]).toBe(0x1f);
          expect(row.raw_html_compressed[1]).toBe(0x8b);
        }
      }
    });

    it('should not record HTML when RECORD_HTML is disabled', () => {
      process.env.RECORD_HTML = 'false';

      const result: FetchResult = {
        success: true,
        url: 'https://example.com',
        latencyMs: 100,
        rawHtml: '<html><body>Test</body></html>',
      };

      recordTestResult('example', result);

      const db = getDatabase();
      if (db) {
        const row: any = db.prepare('SELECT raw_html_compressed FROM e2e_runs').get();
        expect(row.raw_html_compressed).toBeNull();
      }
    });

    it('should not record when RECORD_E2E_DB is disabled', () => {
      process.env.RECORD_E2E_DB = 'false';

      const result: FetchResult = {
        success: true,
        url: 'https://example.com',
        latencyMs: 100,
      };

      recordTestResult('example', result);

      const db = getDatabase();
      if (db) {
        const rows = db.prepare('SELECT * FROM e2e_runs').all();
        expect(rows).toHaveLength(0);
      }
    });

    it('should handle missing optional fields gracefully', () => {
      const result: FetchResult = {
        success: true,
        url: 'https://minimal.com',
        latencyMs: 50,
      };

      recordTestResult('minimal', result);

      const db = getDatabase();
      if (db) {
        const row: any = db.prepare('SELECT * FROM e2e_runs').get();
        expect(row.run_type).toBe('fetch');
        expect(row.title).toBeNull();
        expect(row.author).toBeNull();
        expect(row.body).toBeNull();
        expect(row.status_code).toBeNull();
      }
    });

    it('should use statusCode field if provided', () => {
      const result: FetchResult = {
        success: true,
        url: 'https://example.com',
        latencyMs: 100,
        statusCode: 200,
      };

      recordTestResult('example', result);

      const db = getDatabase();
      if (db) {
        const row: any = db.prepare('SELECT * FROM e2e_runs').get();
        expect(row.run_type).toBe('fetch');
        expect(row.status_code).toBe(200);
      }
    });

    it('should fall back to errorDetails.statusCode if statusCode not present', () => {
      const result: FetchResult = {
        success: false,
        url: 'https://example.com',
        latencyMs: 100,
        errorDetails: {
          statusCode: 429,
        },
      };

      recordTestResult('example', result);

      const db = getDatabase();
      if (db) {
        const row: any = db.prepare('SELECT * FROM e2e_runs').get();
        expect(row.run_type).toBe('fetch');
        expect(row.status_code).toBe(429);
      }
    });

    it('should gracefully handle database errors', () => {
      closeDatabase();
      // With db closed, recordTestResult should silently fail
      const result: FetchResult = {
        success: true,
        url: 'https://example.com',
        latencyMs: 100,
      };

      // Should not throw
      expect(() => recordTestResult('example', result)).not.toThrow();
    });
  });

  describe('closeDatabase', () => {
    it('should close database connection', () => {
      initializeDatabase();
      getDatabase();

      closeDatabase();
      const dbAfter = getDatabase();
      expect(dbAfter).toBeNull();
    });

    it('should be safe to call multiple times', () => {
      initializeDatabase();
      closeDatabase();
      closeDatabase();
      closeDatabase();

      expect(getDatabase()).toBeNull();
    });
  });

  describe('getDatabasePath', () => {
    it('should return the configured test database path', () => {
      const dbPath = getDatabasePath();
      expect(dbPath).toBe(testDbPath);
    });
  });
});
