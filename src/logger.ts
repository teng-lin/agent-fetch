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

const options = {
  level: getLogLevel(),
  formatters: {
    level: (label: string) => ({ level: label }),
  },
  base: {
    service: 'agent-fetch',
  },
};

export const logger = isDev
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
