/**
 * Vitest setup file - runs before all tests
 */

// Suppress known undici parser timeout errors (Node.js internal issue)
const originalEmit = process.emit.bind(process);

// @ts-expect-error - Override process.emit to filter undici errors
process.emit = function (event: string, error: Error, ...args: unknown[]) {
  if (
    event === 'uncaughtException' &&
    error?.stack?.includes('onParserTimeout') &&
    error?.message?.includes('deref')
  ) {
    console.warn('[vitest] Suppressed known undici parser timeout error (Node.js internal issue)');
    return true;
  }

  // @ts-expect-error - Pass through other events normally
  return originalEmit(event, error, ...args);
};

import { initializeDatabase, closeDatabase } from './src/__tests__/db-recorder.js';

// Initialize E2E database for recording test results (async)
(async () => {
  try {
    await initializeDatabase();
    process.on('exit', closeDatabase);
  } catch (error) {
    console.warn('Failed to initialize E2E database:', error);
  }
})();
