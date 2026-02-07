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

  it('returns version on --version', () => {
    const result = parseArgs(['--version']);
    expect(result.kind).toBe('version');
  });

  it('returns version on -v', () => {
    const result = parseArgs(['-v']);
    expect(result.kind).toBe('version');
  });

  it('returns error when URL is missing', () => {
    const result = parseArgs([]);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('Missing required <url>');
    }
  });

  it('sets --text flag', () => {
    const result = parseArgs(['https://example.com', '--text']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.text).toBe(true);
    }
  });

  it('text defaults to false', () => {
    const result = parseArgs(['https://example.com']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.text).toBe(false);
    }
  });

  it('collects warnings for unknown flags', () => {
    const result = parseArgs(['https://example.com', '--unknown', '--foo']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.url).toBe('https://example.com');
      expect(result.warnings).toContain('Unknown option: --unknown');
      expect(result.warnings).toContain('Unknown option: --foo');
    }
  });

  it('returns empty warnings array when no unknown flags', () => {
    const result = parseArgs(['https://example.com', '--json']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.warnings).toEqual([]);
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

  it('parses --timeout flag correctly', () => {
    const result = parseArgs(['https://example.com', '--timeout', '5000']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.timeout).toBe(5000);
    }
  });

  it('timeout defaults to undefined when not provided', () => {
    const result = parseArgs(['https://example.com']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.timeout).toBeUndefined();
    }
  });

  it('returns error when --timeout is missing value', () => {
    const result = parseArgs(['https://example.com', '--timeout']);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('--timeout requires a value');
    }
  });

  it('returns error when --timeout value is not a positive integer', () => {
    const result = parseArgs(['https://example.com', '--timeout', '-100']);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('--timeout must be a positive integer');
    }
  });

  it('returns error when --timeout value is not a number', () => {
    const result = parseArgs(['https://example.com', '--timeout', 'abc']);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('--timeout must be a positive integer');
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
    });

    process.argv = ['node', 'cli.js', 'https://example.com/article'];
    await main();

    expect(httpFetch).toHaveBeenCalledWith('https://example.com/article', {
      preset: undefined,
      timeout: undefined,
      proxy: undefined,
      cookies: undefined,
    });
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

    expect(httpRequest).toHaveBeenCalledWith(
      'https://example.com/article',
      {},
      undefined,
      undefined,
      undefined,
      undefined
    );
    expect(consoleLogSpy).toHaveBeenCalledWith('<html>Raw HTML</html>');
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
    });

    process.argv = ['node', 'cli.js', 'https://example.com/article'];

    await expect(main()).rejects.toThrow('process.exit(1)');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Access forbidden');
    expect(closeAllSessions).toHaveBeenCalled();
  });

  it('passes timeout option to httpFetch', async () => {
    const { httpFetch } = await import('../fetch/http-fetch.js');
    const { closeAllSessions } = await import('../fetch/http-client.js');

    vi.mocked(httpFetch).mockResolvedValue({
      success: true,
      url: 'https://example.com/article',
      latencyMs: 500,
      title: 'Test Article',
      markdown: 'Test content',
    });

    process.argv = ['node', 'cli.js', 'https://example.com/article', '--timeout', '5000'];
    await main();

    expect(httpFetch).toHaveBeenCalledWith('https://example.com/article', {
      preset: undefined,
      timeout: 5000,
      proxy: undefined,
      cookies: undefined,
    });
    expect(closeAllSessions).toHaveBeenCalled();
  });

  it('passes timeout option to httpRequest in raw mode', async () => {
    const { httpRequest } = await import('../fetch/http-client.js');
    const { closeAllSessions } = await import('../fetch/http-client.js');

    vi.mocked(httpRequest).mockResolvedValue({
      success: true,
      statusCode: 200,
      html: '<html>Raw HTML</html>',
      headers: {},
      cookies: [],
    });

    process.argv = ['node', 'cli.js', 'https://example.com/article', '--raw', '--timeout', '3000'];
    await main();

    expect(httpRequest).toHaveBeenCalledWith(
      'https://example.com/article',
      {},
      undefined,
      3000,
      undefined,
      undefined
    );
    expect(closeAllSessions).toHaveBeenCalled();
  });
});
