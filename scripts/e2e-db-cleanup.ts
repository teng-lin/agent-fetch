/**
 * Clean up old E2E database records
 *
 * Usage:
 *   npx tsx scripts/e2e-db-cleanup.ts --before "2026-01-25"
 *   npx tsx scripts/e2e-db-cleanup.ts --before "30d"
 *   npx tsx scripts/e2e-db-cleanup.ts --all
 *   npx tsx scripts/e2e-db-cleanup.ts --before "7d" --yes  # Skip confirmation
 */

import { writeFileSync, existsSync } from 'node:fs';
import * as readline from 'node:readline';
import { loadDatabase, getDatabasePath, parseDateString } from '../src/__tests__/db-utils.js';

interface ParsedArgs {
  before?: string;
  all?: boolean;
  yes?: boolean;
}

/**
 * Parse command-line arguments for the cleanup script
 * @internal - For testing purposes
 */
export function parseArgs(): ParsedArgs {
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

// Re-export parseDateString from db-utils for testability
export { parseDateString } from '../src/__tests__/db-utils.js';

async function askForConfirmation(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return await new Promise<boolean>((resolve) => {
      rl.question(message, (answer) => {
        resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
      });
    });
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const DB_PATH = getDatabasePath();

  // Validate arguments
  if (!args.before && !args.all) {
    console.error('Usage: npx tsx scripts/e2e-db-cleanup.ts --before "2026-01-25" | --all [--yes]');
    process.exit(1);
  }

  if (!existsSync(DB_PATH)) {
    console.log('Database not found. Nothing to clean up.');
    process.exit(0);
  }

  let db: any = null;
  let runCount = 0;

  try {
    // Load database from disk
    db = await loadDatabase();
    if (!db) {
      console.log('Failed to load database.');
      process.exit(1);
    }

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

    // Count records that will be deleted (with proper resource cleanup)
    const countQuery = `
      SELECT
        (SELECT COUNT(*) FROM e2e_runs ${whereClause}) as run_count
    `;

    const countStmt = db.prepare(countQuery);
    try {
      if (params.length > 0) {
        countStmt.bind(params);
      }
      countStmt.step();
      const countRow = countStmt.getAsObject() as { run_count: number };
      runCount = countRow.run_count || 0;
    } finally {
      countStmt.free();
    }

    if (runCount === 0) {
      console.log('No records to delete.');
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
        process.exit(0);
      }
    }

    // Delete e2e_runs
    const deleteRunsQuery = `DELETE FROM e2e_runs ${whereClause}`;
    db.run(deleteRunsQuery, params);

    console.log(`\n✅ Deleted ${runCount} E2E runs`);

    // Save database to disk (with error handling for write failures)
    try {
      const data = db.export();
      const dbBuffer = Buffer.from(data);
      writeFileSync(DB_PATH, dbBuffer);
    } catch (writeErr) {
      console.error('CRITICAL: Failed to persist changes to disk:', writeErr);
      console.error('Data was deleted in memory but NOT saved. This is a critical error.');
      throw writeErr;
    }
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    // Always close database connection
    if (db) {
      try {
        db.close();
      } catch (closeErr) {
        console.warn('Failed to close database:', closeErr);
      }
    }
  }
}

// Only run main if this is the main module being executed
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
