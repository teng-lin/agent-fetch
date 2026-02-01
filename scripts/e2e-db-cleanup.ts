/**
 * Clean up old E2E database records
 *
 * Usage:
 *   npx tsx scripts/e2e-db-cleanup.ts --before "2025-01-15"
 *   npx tsx scripts/e2e-db-cleanup.ts --before "30d"
 *   npx tsx scripts/e2e-db-cleanup.ts --all
 *   npx tsx scripts/e2e-db-cleanup.ts --before "7d" --yes  # Skip confirmation
 */

import Database from 'better-sqlite3';
import { createInterface } from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';

const DB_PATH = path.resolve(process.cwd(), 'lynxget-e2e.db');

interface ParsedArgs {
  before?: string;
  all?: boolean;
  yes?: boolean;
}

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

export function parseDateString(dateStr: string): Date {
  // Try ISO format
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

  throw new Error(`Invalid date format: ${dateStr}`);
}

export async function askForConfirmation(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

export async function main() {
  const args = parseArgs();

  // Validate arguments
  if (!args.before && !args.all) {
    console.error('Usage: e2e-db-cleanup --before "2025-01-15" | --all [--yes]');
    process.exit(1);
  }

  if (!fs.existsSync(DB_PATH)) {
    console.log('Database not found. Nothing to clean up.');
    process.exit(0);
  }

  const db = new Database(DB_PATH);

  try {
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

    // Dry run: count records that will be deleted
    const countQuery = `
      SELECT
        (SELECT COUNT(*) FROM e2e_runs ${whereClause}) as run_count,
        (SELECT COUNT(*) FROM antibot_detections WHERE run_id IN (
          SELECT id FROM e2e_runs ${whereClause}
        )) as detection_count
    `;

    const countResult = db.prepare(countQuery).get(...params) as {
      run_count: number;
      detection_count: number;
    };

    if (countResult.run_count === 0) {
      console.log('No records to delete.');
      db.close();
      process.exit(0);
    }

    console.log(`\n📊 Dry run: Would delete:`);
    console.log(`  - ${countResult.run_count} E2E runs`);
    console.log(`  - ${countResult.detection_count} antibot detections`);
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
    db.prepare(deleteQuery).run(...params);

    console.log(
      `\n✅ Deleted ${countResult.run_count} runs and ${countResult.detection_count} detections`
    );
    db.close();
  } catch (error) {
    console.error('Error:', error);
    db.close();
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
