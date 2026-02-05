/**
 * Structured logging with pino
 */
import { createRequire } from 'node:module';
import pino from 'pino';

const require = createRequire(import.meta.url);
const isDev = process.env.NODE_ENV === 'development';

/**
 * Check if pino-pretty is available in development mode.
 * Provides graceful degradation if the module is missing or corrupted.
 */
function isPinoPrettyAvailable(): boolean {
  if (!isDev) return false;
  try {
    require.resolve('pino-pretty');
    return true;
  } catch (e) {
    console.debug('pino-pretty not available, using JSON logs:', e);
    return false;
  }
}

const VALID_LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

function getLogLevel(): string {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (envLevel && VALID_LOG_LEVELS.includes(envLevel as (typeof VALID_LOG_LEVELS)[number])) {
    return envLevel;
  }
  return 'info';
}

const options = {
  level: getLogLevel(),
  formatters: {
    level: (label: string) => ({ level: label }),
  },
  base: {
    service: 'agent-fetch',
  },
};

export const logger = isPinoPrettyAvailable()
  ? pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
          destination: 2,
        },
      },
    })
  : pino(options, pino.destination(2));
