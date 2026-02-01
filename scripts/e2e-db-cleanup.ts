/**
 * Clean up old E2E database records
 *
 * Usage:
 *   npx tsx scripts/e2e-db-cleanup.ts --before "2026-01-25"
 *   npx tsx scripts/e2e-db-cleanup.ts --before "30d"
 *   npx tsx scripts/e2e-db-cleanup.ts --all
 *   npx tsx scripts/e2e-db-cleanup.ts --before "7d" --yes  # Skip confirmation
 */

import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../');
const DB_PATH = path.join(PROJECT_ROOT, 'lynxget-e2e.db');

interface ParsedArgs {
  before?: string;
  all?: boolean;
  yes?: boolean;
}

function parseArgs(): ParsedArgs {
  const args: ParsedArgs = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--before' && i + 1 < process.argv.length) {
      args.before = process.argv[++i];
    } else if (process.argv[i] === '--all') {
      args.all = true;
    } else if (process.argv[i] === '--yes') {
      args.yes = true;
    }
  }
  return args;
}

function parseDateString(dateStr: string): Date {
  // Try ISO format: YYYY-MM-DD
  const isoMatch = dateStr.match(/^\d{4}-\d{2}-\d{2}$/);
  if (isoMatch) {
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

async function askForConfirmation(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

async function main() {
  const args = parseArgs();

  // Validate arguments
  if (!args.before && !args.all) {
    console.error('Usage: npx tsx scripts/e2e-db-cleanup.ts --before "2026-01-25" | --all [--yes]');
    process.exit(1);
  }

  if (!existsSync(DB_PATH)) {
    console.log('Database not found. Nothing to clean up.');
    process.exit(0);
  }

  try {
    // Initialize sql.js
    const sqlJs = await initSqlJs();
    const buffer = readFileSync(DB_PATH);
    const db = new sqlJs.Database(buffer);

    // Build WHERE clause
    let whereClause = '';
    let params: unknown[] = [];

    if (args.all) {
      whereClause = '';
    } else if (args.before) {
      const beforeDate = parseDateString(args.before);
      whereClause = 'WHERE timestamp < ?';
      params = [beforeDate.toISOString()];
    }

    // Count records that will be deleted
    const countQuery = `
      SELECT
        (SELECT COUNT(*) FROM e2e_runs ${whereClause}) as run_count
    `;

    const countStmt = db.prepare(countQuery);
    if (params.length > 0) {
      countStmt.bind(params);
    }
    countStmt.step();
    const countRow = countStmt.getAsObject() as { run_count: number };
    countStmt.free();

    const runCount = countRow.run_count || 0;

    if (runCount === 0) {
      console.log('No records to delete.');
      db.close();
      process.exit(0);
    }

    console.log(`\n📊 Dry run: Would delete:`);
    console.log(`  - ${runCount} E2E runs`);
    console.log('');

    // Ask for confirmation
    if (!args.yes) {
      const confirmed = await askForConfirmation('Proceed with deletion? (y/n): ');
      if (!confirmed) {
        console.log('Cancelled.');
        db.close();
        process.exit(0);
      }
    }

    // Delete records
    const deleteQuery = `DELETE FROM e2e_runs ${whereClause}`;
    db.run(deleteQuery, params);

    console.log(`\n✅ Deleted ${runCount} E2E runs`);

    // Save database to disk
    const data = db.export();
    const dbBuffer = Buffer.from(data);
    writeFileSync(DB_PATH, dbBuffer);

    db.close();
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Only run main if this is the main module being executed
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
