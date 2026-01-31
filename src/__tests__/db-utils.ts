/**
 * Shared utilities for E2E database operations
 *
 * Provides common functions for database access and date/time parsing
 * to avoid duplication across db-query.ts and e2e-db-cleanup.ts
 */

import initSqlJs from 'sql.js';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../');
const DB_PATH = path.join(PROJECT_ROOT, 'e2e.db');

let sqlJsInstance: Awaited<ReturnType<typeof initSqlJs>> | null = null;

/**
 * Get the database file path
 * @internal
 */
export function getDatabasePath(): string {
  return DB_PATH;
}

/**
 * Load the E2E database from disk using sql.js
 * Returns null if the database file does not exist
 *
 * @internal
 */
export async function loadDatabase() {
  if (!sqlJsInstance) {
    sqlJsInstance = await initSqlJs();
  }

  if (!existsSync(DB_PATH)) {
    return null;
  }

  const buffer = readFileSync(DB_PATH);
  return new sqlJsInstance.Database(buffer);
}

/**
 * Parse a date string in ISO format (YYYY-MM-DD) or relative format (Nd, Nh, Nm)
 *
 * Supported formats:
 * - ISO: YYYY-MM-DD (e.g., "2026-01-25") - parsed as UTC midnight
 * - Relative: <number><unit> where unit is:
 *   - d: days (e.g., "30d" = 30 days ago)
 *   - h: hours (e.g., "24h" = 24 hours ago)
 *   - m: minutes (e.g., "5m" = 5 minutes ago)
 *
 * @param dateStr - The date string to parse
 * @returns A Date object representing the parsed date
 * @throws {Error} If the date format is invalid
 * @internal
 */
export function parseDateString(dateStr: string): Date {
  // Try ISO format: YYYY-MM-DD
  const isoMatch = dateStr.match(/^\d{4}-\d{2}-\d{2}$/);
  if (isoMatch) {
    // Parse as UTC midnight - all database timestamps are in UTC
    return new Date(dateStr + 'T00:00:00Z');
  }

  // Try relative format: 30d, 24h, 5m
  const relativeMatch = dateStr.match(/^(\d+)([dhm])$/);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2];
    const now = new Date();

    if (unit === 'd') {
      now.setDate(now.getDate() - amount);
    } else if (unit === 'h') {
      now.setHours(now.getHours() - amount);
    } else if (unit === 'm') {
      now.setMinutes(now.getMinutes() - amount);
    }

    return now;
  }

  throw new Error(
    `Invalid date format: ${dateStr}. Use ISO format (2026-01-25) or relative (30d, 24h, 5m)`
  );
}
