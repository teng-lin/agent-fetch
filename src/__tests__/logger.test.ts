import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture the options passed to pino
let capturedOptions: Record<string, unknown> | undefined;
let capturedTransport: Record<string, unknown> | undefined;

vi.mock('pino', () => {
  const mockPino = vi.fn((opts: Record<string, unknown>) => {
    capturedOptions = opts;
    if (opts?.transport) {
      capturedTransport = opts.transport as Record<string, unknown>;
    }
    return { level: opts?.level ?? 'info' };
  });
  mockPino.destination = vi.fn(() => 'mock-destination');
  return { default: mockPino };
});

describe('logger', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    capturedOptions = undefined;
    capturedTransport = undefined;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('getLogLevel (via pino config)', () => {
    it('defaults to info when LOG_LEVEL is not set', async () => {
      delete process.env.LOG_LEVEL;
      await import('../logger.js');
      expect(capturedOptions?.level).toBe('info');
    });

    it('returns valid level when LOG_LEVEL=debug', async () => {
      process.env.LOG_LEVEL = 'debug';
      await import('../logger.js');
      expect(capturedOptions?.level).toBe('debug');
    });

    it('ignores invalid level (LOG_LEVEL=banana falls back to info)', async () => {
      process.env.LOG_LEVEL = 'banana';
      await import('../logger.js');
      expect(capturedOptions?.level).toBe('info');
    });

    it('is case-insensitive (LOG_LEVEL=DEBUG returns debug)', async () => {
      process.env.LOG_LEVEL = 'DEBUG';
      await import('../logger.js');
      expect(capturedOptions?.level).toBe('debug');
    });

    it('accepts all valid pino log levels', async () => {
      for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
        vi.resetModules();
        capturedOptions = undefined;
        process.env.LOG_LEVEL = level;
        await import('../logger.js');
        expect(capturedOptions?.level).toBe(level);
      }
    });
  });

  describe('isPinoPrettyAvailable (via transport config)', () => {
    it('does not use pino-pretty transport when NODE_ENV is not development', async () => {
      delete process.env.NODE_ENV;
      await import('../logger.js');
      expect(capturedTransport).toBeUndefined();
    });

    it('does not use pino-pretty transport when NODE_ENV is production', async () => {
      process.env.NODE_ENV = 'production';
      await import('../logger.js');
      expect(capturedTransport).toBeUndefined();
    });
  });

  describe('logger instance', () => {
    it('exports a pino instance with service: agent-fetch in base', async () => {
      delete process.env.LOG_LEVEL;
      await import('../logger.js');
      const base = capturedOptions?.base as Record<string, string> | undefined;
      expect(base?.service).toBe('agent-fetch');
    });

    it('configures level formatter to return label', async () => {
      await import('../logger.js');
      const formatters = capturedOptions?.formatters as
        | { level: (label: string) => Record<string, string> }
        | undefined;
      expect(formatters?.level('info')).toEqual({ level: 'info' });
    });

    it('exports logger as a named export', async () => {
      const mod = await import('../logger.js');
      expect(mod.logger).toBeDefined();
    });
  });
});
