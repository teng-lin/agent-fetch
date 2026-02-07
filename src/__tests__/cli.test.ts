import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseArgs, parseCrawlArgs, parseCookies, main } from '../cli.js';

vi.mock('../fetch/http-fetch.js');
vi.mock('../fetch/http-client.js');

/** Assert parseArgs returned kind 'ok' and return the narrowed result. */
function expectOk(result: ReturnType<typeof parseArgs>) {
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') throw new Error('unreachable');
  return result;
}

/** Assert parseArgs returned kind 'error' and return the narrowed result. */
function expectError(result: ReturnType<typeof parseArgs>) {
  expect(result.kind).toBe('error');
  if (result.kind !== 'error') throw new Error('unreachable');
  return result;
}

describe('CLI parseArgs', () => {
  it('parses URL as positional argument', () => {
    const { opts } = expectOk(parseArgs(['https://example.com']));
    expect(opts.url).toBe('https://example.com');
    expect(opts.json).toBe(false);
    expect(opts.raw).toBe(false);
    expect(opts.quiet).toBe(false);
  });

  it('sets --json flag', () => {
    const { opts } = expectOk(parseArgs(['https://example.com', '--json']));
    expect(opts.json).toBe(true);
  });

  it('sets --raw flag', () => {
    const { opts } = expectOk(parseArgs(['https://example.com', '--raw']));
    expect(opts.raw).toBe(true);
  });

  it('sets -q flag', () => {
    const { opts } = expectOk(parseArgs(['https://example.com', '-q']));
    expect(opts.quiet).toBe(true);
  });

  it('sets --quiet flag', () => {
    const { opts } = expectOk(parseArgs(['https://example.com', '--quiet']));
    expect(opts.quiet).toBe(true);
  });

  it('returns help on --help', () => {
    expect(parseArgs(['--help']).kind).toBe('help');
  });

  it('returns help on -h', () => {
    expect(parseArgs(['-h']).kind).toBe('help');
  });

  it('returns version on --version', () => {
    expect(parseArgs(['--version']).kind).toBe('version');
  });

  it('returns version on -v', () => {
    expect(parseArgs(['-v']).kind).toBe('version');
  });

  it('returns error when URL is missing', () => {
    const { message } = expectError(parseArgs([]));
    expect(message).toContain('Missing required <url>');
  });

  it('sets --text flag', () => {
    const { opts } = expectOk(parseArgs(['https://example.com', '--text']));
    expect(opts.text).toBe(true);
  });

  it('text defaults to false', () => {
    const { opts } = expectOk(parseArgs(['https://example.com']));
    expect(opts.text).toBe(false);
  });

  it('collects warnings for unknown flags', () => {
    const { opts, warnings } = expectOk(parseArgs(['https://example.com', '--unknown', '--foo']));
    expect(opts.url).toBe('https://example.com');
    expect(warnings).toContain('Unknown option: --unknown');
    expect(warnings).toContain('Unknown option: --foo');
  });

  it('returns empty warnings array when no unknown flags', () => {
    const { warnings } = expectOk(parseArgs(['https://example.com', '--json']));
    expect(warnings).toEqual([]);
  });

  it('parses --preset flag correctly', () => {
    const { opts } = expectOk(parseArgs(['https://example.com', '--preset', 'android-chrome-143']));
    expect(opts.preset).toBe('android-chrome-143');
  });

  it('preset defaults to undefined when not provided', () => {
    const { opts } = expectOk(parseArgs(['https://example.com']));
    expect(opts.preset).toBeUndefined();
  });

  it('parses --timeout flag correctly', () => {
    const { opts } = expectOk(parseArgs(['https://example.com', '--timeout', '5000']));
    expect(opts.timeout).toBe(5000);
  });

  it('timeout defaults to undefined when not provided', () => {
    const { opts } = expectOk(parseArgs(['https://example.com']));
    expect(opts.timeout).toBeUndefined();
  });

  it('returns error when --timeout is missing value', () => {
    const { message } = expectError(parseArgs(['https://example.com', '--timeout']));
    expect(message).toContain('--timeout requires a value');
  });

  it('returns error when --timeout value is not a positive integer', () => {
    const { message } = expectError(parseArgs(['https://example.com', '--timeout', '-100']));
    expect(message).toContain('--timeout must be a positive integer');
  });

  it('returns error when --timeout value is not a number', () => {
    const { message } = expectError(parseArgs(['https://example.com', '--timeout', 'abc']));
    expect(message).toContain('--timeout must be a positive integer');
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

  it('outputs JSON in --json mode', async () => {
    const { httpFetch } = await import('../fetch/http-fetch.js');
    const { closeAllSessions } = await import('../fetch/http-client.js');

    const mockResult = {
      success: true,
      url: 'https://example.com/article',
      title: 'JSON Test',
      markdown: '# JSON Test',
      latencyMs: 100,
    };
    vi.mocked(httpFetch).mockResolvedValue(mockResult);

    process.argv = ['node', 'cli.js', 'https://example.com/article', '--json'];
    await main();

    expect(consoleLogSpy).toHaveBeenCalledWith(JSON.stringify(mockResult, null, 2));
    expect(closeAllSessions).toHaveBeenCalled();
  });

  it('outputs only text content in --text mode', async () => {
    const { httpFetch } = await import('../fetch/http-fetch.js');
    const { closeAllSessions } = await import('../fetch/http-client.js');

    vi.mocked(httpFetch).mockResolvedValue({
      success: true,
      url: 'https://example.com/article',
      textContent: 'Plain text content here',
      latencyMs: 100,
    });

    process.argv = ['node', 'cli.js', 'https://example.com/article', '--text'];
    await main();

    expect(consoleLogSpy).toHaveBeenCalledWith('Plain text content here');
    expect(closeAllSessions).toHaveBeenCalled();
  });

  it('outputs only markdown in -q quiet mode', async () => {
    const { httpFetch } = await import('../fetch/http-fetch.js');
    const { closeAllSessions } = await import('../fetch/http-client.js');

    vi.mocked(httpFetch).mockResolvedValue({
      success: true,
      url: 'https://example.com/article',
      title: 'Title',
      markdown: '# Title\n\nBody text',
      latencyMs: 100,
    });

    process.argv = ['node', 'cli.js', 'https://example.com/article', '-q'];
    await main();

    expect(consoleLogSpy).toHaveBeenCalledWith('# Title\n\nBody text');
    expect(closeAllSessions).toHaveBeenCalled();
  });
});

/** Assert parseCrawlArgs returned kind 'ok' and return the narrowed result. */
function expectCrawlOk(result: ReturnType<typeof parseCrawlArgs>) {
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') throw new Error('unreachable');
  return result;
}

/** Assert parseCrawlArgs returned kind 'error' and return the narrowed result. */
function expectCrawlError(result: ReturnType<typeof parseCrawlArgs>) {
  expect(result.kind).toBe('error');
  if (result.kind !== 'error') throw new Error('unreachable');
  return result;
}

describe('parseCrawlArgs', () => {
  it('parses --depth flag', () => {
    const { opts } = expectCrawlOk(parseCrawlArgs(['https://example.com', '--depth', '5']));
    expect(opts.maxDepth).toBe(5);
  });

  it('parses --limit flag', () => {
    const { opts } = expectCrawlOk(parseCrawlArgs(['https://example.com', '--limit', '50']));
    expect(opts.maxPages).toBe(50);
  });

  it('parses --concurrency flag', () => {
    const { opts } = expectCrawlOk(parseCrawlArgs(['https://example.com', '--concurrency', '3']));
    expect(opts.concurrency).toBe(3);
  });

  it('parses --include and --exclude flags', () => {
    const { opts } = expectCrawlOk(
      parseCrawlArgs(['https://example.com', '--include', '*.html,/blog/*', '--exclude', '*.pdf'])
    );
    expect(opts.include).toEqual(['*.html', '/blog/*']);
    expect(opts.exclude).toEqual(['*.pdf']);
  });

  it('parses --same-origin flag', () => {
    const { opts } = expectCrawlOk(parseCrawlArgs(['https://example.com', '--same-origin']));
    expect(opts.sameOrigin).toBe(true);
  });

  it('parses --no-same-origin flag', () => {
    const { opts } = expectCrawlOk(parseCrawlArgs(['https://example.com', '--no-same-origin']));
    expect(opts.sameOrigin).toBe(false);
  });

  it('parses --delay flag', () => {
    const { opts } = expectCrawlOk(parseCrawlArgs(['https://example.com', '--delay', '200']));
    expect(opts.delay).toBe(200);
  });

  it('returns error for missing URL', () => {
    const { message } = expectCrawlError(parseCrawlArgs([]));
    expect(message).toContain('Missing required <url>');
  });

  it('returns error for non-HTTP URL', () => {
    const { message } = expectCrawlError(parseCrawlArgs(['ftp://example.com']));
    expect(message).toContain('must start with http:// or https://');
  });

  it('returns error for --limit exceeding 10000', () => {
    const { message } = expectCrawlError(
      parseCrawlArgs(['https://example.com', '--limit', '10001'])
    );
    expect(message).toContain('must not exceed 10000');
  });

  it('returns error for --concurrency exceeding 50', () => {
    const { message } = expectCrawlError(
      parseCrawlArgs(['https://example.com', '--concurrency', '51'])
    );
    expect(message).toContain('must not exceed 50');
  });

  it('returns error for negative --depth', () => {
    const { message } = expectCrawlError(parseCrawlArgs(['https://example.com', '--depth', '-1']));
    expect(message).toContain('non-negative');
  });

  it('returns help on -h', () => {
    expect(parseCrawlArgs(['-h']).kind).toBe('help');
  });
});

describe('parseCookies', () => {
  it('parses semicolon-separated name=value pairs', () => {
    const result = parseCookies(['name=value; name2=value2']);
    expect(result).toEqual({ name: 'value', name2: 'value2' });
  });

  it('splits on first = only to handle values containing =', () => {
    const result = parseCookies(['name=val=ue']);
    expect(result).toEqual({ name: 'val=ue' });
  });

  it('returns undefined for undefined input', () => {
    expect(parseCookies(undefined)).toBeUndefined();
  });

  it('returns undefined for empty array', () => {
    expect(parseCookies([])).toBeUndefined();
  });

  it('handles multiple --cookie strings', () => {
    const result = parseCookies(['session=abc', 'token=xyz']);
    expect(result).toEqual({ session: 'abc', token: 'xyz' });
  });

  it('strips control characters from values', () => {
    const result = parseCookies(['name=val\r\nue', 'user=test\0user']);
    expect(result).toEqual({ name: 'value', user: 'testuser' });
  });
});
