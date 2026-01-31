/**
 * Structured logging with pino
 */
import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

const VALID_LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

function getLogLevel(): string {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (envLevel && VALID_LOG_LEVELS.includes(envLevel as (typeof VALID_LOG_LEVELS)[number])) {
    return envLevel;
  }
  return 'info';
}

export const logger = pino({
  level: getLogLevel(),
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    service: 'agent-fetch',
  },
});
