import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseArgs, main } from '../cli.js';

vi.mock('../fetch/http-fetch.js');
vi.mock('../fetch/http-client.js');

describe('CLI parseArgs', () => {
  it('parses URL as positional argument', () => {
    const result = parseArgs(['https://example.com']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.url).toBe('https://example.com');
      expect(result.opts.json).toBe(false);
      expect(result.opts.raw).toBe(false);
      expect(result.opts.detect).toBe(false);
      expect(result.opts.quiet).toBe(false);
    }
  });

  it('sets --json flag', () => {
    const result = parseArgs(['https://example.com', '--json']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.json).toBe(true);
    }
  });

  it('sets --raw flag', () => {
    const result = parseArgs(['https://example.com', '--raw']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.raw).toBe(true);
    }
  });

  it('sets --detect flag', () => {
    const result = parseArgs(['https://example.com', '--detect']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.detect).toBe(true);
    }
  });

  it('sets -q flag', () => {
    const result = parseArgs(['https://example.com', '-q']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.quiet).toBe(true);
    }
  });

  it('sets --quiet flag', () => {
    const result = parseArgs(['https://example.com', '--quiet']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.quiet).toBe(true);
    }
  });

  it('returns help on --help', () => {
    const result = parseArgs(['--help']);
    expect(result.kind).toBe('help');
  });

  it('returns help on -h', () => {
    const result = parseArgs(['-h']);
    expect(result.kind).toBe('help');
  });

  it('returns error when URL is missing', () => {
    const result = parseArgs([]);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('Missing required <url>');
    }
  });

  it('ignores unknown flags', () => {
    const result = parseArgs(['https://example.com', '--unknown']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.url).toBe('https://example.com');
    }
  });

  it('parses --preset flag correctly', () => {
    const result = parseArgs(['https://example.com', '--preset', 'android-chrome-143']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.preset).toBe('android-chrome-143');
    }
  });

  it('preset defaults to undefined when not provided', () => {
    const result = parseArgs(['https://example.com']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.preset).toBeUndefined();
    }
  });

  it('reads LYNXGET_PRESET env var as fallback', () => {
    const originalPreset = process.env.LYNXGET_PRESET;
    process.env.LYNXGET_PRESET = 'ios-safari-18';

    const result = parseArgs(['https://example.com']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.preset).toBe('ios-safari-18');
    }

    if (originalPreset) {
      process.env.LYNXGET_PRESET = originalPreset;
    } else {
      delete process.env.LYNXGET_PRESET;
    }
  });

  it('--preset flag overrides LYNXGET_PRESET env var', () => {
    const originalPreset = process.env.LYNXGET_PRESET;
    process.env.LYNXGET_PRESET = 'ios-safari-18';

    const result = parseArgs(['https://example.com', '--preset', 'android-chrome-143']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.preset).toBe('android-chrome-143');
    }

    if (originalPreset) {
      process.env.LYNXGET_PRESET = originalPreset;
    } else {
      delete process.env.LYNXGET_PRESET;
    }
  });
});

describe('CLI main', () => {
  let originalArgv: string[];
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalArgv = process.argv;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
    vi.resetAllMocks();
  });

  it('calls httpFetch with correct arguments', async () => {
    const { httpFetch } = await import('../fetch/http-fetch.js');
    const { closeAllSessions } = await import('../fetch/http-client.js');

    vi.mocked(httpFetch).mockResolvedValue({
      success: true,
      url: 'https://example.com/article',
      statusCode: 200,
      strategy: 'readability',
      durationMs: 1234,
      extracted: {
        title: 'Test Article',
        content: 'Test content',
        author: null,
        publishDate: null,
      },
      antibotDetections: [],
    });

    process.argv = ['node', 'cli.js', 'https://example.com/article'];
    await main();

    expect(httpFetch).toHaveBeenCalledWith('https://example.com/article', { preset: undefined });
    expect(closeAllSessions).toHaveBeenCalled();
  });

  it('handles raw mode correctly', async () => {
    const { httpRequest } = await import('../fetch/http-client.js');
    const { closeAllSessions } = await import('../fetch/http-client.js');

    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: '<html>Raw HTML</html>',
      headers: {},
      cookies: [],
    });

    process.argv = ['node', 'cli.js', 'https://example.com/article', '--raw'];
    await main();

    expect(httpRequest).toHaveBeenCalledWith('https://example.com/article', {}, undefined);
    expect(consoleLogSpy).toHaveBeenCalledWith('<html>Raw HTML</html>');
    expect(closeAllSessions).toHaveBeenCalled();
  });

  it('handles detect mode correctly', async () => {
    const { httpRequest } = await import('../fetch/http-client.js');
    const { closeAllSessions } = await import('../fetch/http-client.js');

    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: '<html>Test</html>',
      headers: {},
      cookies: [],
    });

    process.argv = ['node', 'cli.js', 'https://example.com/article', '--detect'];
    await main();

    expect(httpRequest).toHaveBeenCalledWith('https://example.com/article', {}, undefined);
    expect(closeAllSessions).toHaveBeenCalled();
  });

  it('handles errors and calls closeAllSessions', async () => {
    const { httpFetch } = await import('../fetch/http-fetch.js');
    const { closeAllSessions } = await import('../fetch/http-client.js');

    vi.mocked(httpFetch).mockResolvedValue({
      success: false,
      url: 'https://example.com/article',
      statusCode: 403,
      error: 'Access forbidden',
      action: null,
      durationMs: 1234,
      antibotDetections: [],
    });

    process.argv = ['node', 'cli.js', 'https://example.com/article'];

    await expect(main()).rejects.toThrow('process.exit(1)');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Access forbidden');
    expect(closeAllSessions).toHaveBeenCalled();
  });
});
