import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../fetch/http-fetch.js', () => ({
  httpFetch: vi.fn(),
}));

vi.mock('../fetch/http-client.js', () => ({
  httpRequest: vi.fn(),
  closeAllSessions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../antibot/detector.js', () => ({
  detectFromResponse: vi.fn(() => []),
  detectFromHtml: vi.fn(() => []),
  mergeDetections: vi.fn(() => []),
}));

import { parseArgs, main } from '../cli.js';
import { httpFetch } from '../fetch/http-fetch.js';
import { httpRequest } from '../fetch/http-client.js';
import { mergeDetections } from '../antibot/detector.js';

describe('cli', () => {
  describe('parseArgs', () => {
    it('parses URL from positional arg', () => {
      const result = parseArgs(['https://example.com/article']);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.opts.url).toBe('https://example.com/article');
      }
    });

    it('sets --json flag', () => {
      const result = parseArgs(['https://example.com', '--json']);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') expect(result.opts.json).toBe(true);
    });

    it('sets --raw flag', () => {
      const result = parseArgs(['https://example.com', '--raw']);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') expect(result.opts.raw).toBe(true);
    });

    it('sets --detect flag', () => {
      const result = parseArgs(['https://example.com', '--detect']);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') expect(result.opts.detect).toBe(true);
    });

    it('sets -q/--quiet flag', () => {
      const r1 = parseArgs(['https://example.com', '-q']);
      const r2 = parseArgs(['https://example.com', '--quiet']);
      expect(r1.kind).toBe('ok');
      expect(r2.kind).toBe('ok');
      if (r1.kind === 'ok') expect(r1.opts.quiet).toBe(true);
      if (r2.kind === 'ok') expect(r2.opts.quiet).toBe(true);
    });

    it('returns help for --help', () => {
      expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    });

    it('returns error for no args', () => {
      const result = parseArgs([]);
      expect(result.kind).toBe('error');
    });

    it('ignores unknown flags starting with -', () => {
      const result = parseArgs(['https://example.com', '--unknown-flag']);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') expect(result.opts.url).toBe('https://example.com');
    });
  });

  describe('main', () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let processExitSpy: ReturnType<typeof vi.spyOn>;
    let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
    let originalArgv: string[];

    beforeEach(() => {
      originalArgv = process.argv;
      vi.clearAllMocks();
      consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      process.argv = originalArgv;
    });

    it('calls httpFetch and prints title + text in default mode', async () => {
      process.argv = ['node', 'cli.js', 'https://example.com/article'];
      vi.mocked(httpFetch).mockResolvedValue({
        success: true,
        url: 'https://example.com/article',
        title: 'Test Title',
        textContent: 'Article body text',
        latencyMs: 100,
      });

      await main();

      expect(httpFetch).toHaveBeenCalledWith('https://example.com/article');
      expect(consoleLogSpy).toHaveBeenCalledWith('Title: Test Title');
      expect(consoleLogSpy).toHaveBeenCalledWith('Article body text');
    });

    it('prints JSON in --json mode', async () => {
      process.argv = ['node', 'cli.js', 'https://example.com/article', '--json'];
      vi.mocked(httpFetch).mockResolvedValue({
        success: true,
        url: 'https://example.com/article',
        title: 'JSON Test',
        textContent: 'Content',
        latencyMs: 50,
      });

      await main();

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.title).toBe('JSON Test');
    });

    it('calls httpRequest and writes HTML in --raw mode', async () => {
      process.argv = ['node', 'cli.js', 'https://example.com/article', '--raw'];
      vi.mocked(httpRequest).mockResolvedValue({
        success: true,
        statusCode: 200,
        html: '<html>Raw HTML</html>',
        headers: {},
        cookies: [],
      });

      await main();

      expect(httpRequest).toHaveBeenCalledWith('https://example.com/article');
      expect(stdoutWriteSpy).toHaveBeenCalledWith('<html>Raw HTML</html>');
    });

    it('prints error and exits when --raw returns no html', async () => {
      process.argv = ['node', 'cli.js', 'https://example.com/article', '--raw'];
      vi.mocked(httpRequest).mockResolvedValue({
        success: false,
        statusCode: 403,
        headers: {},
        cookies: [],
        error: 'forbidden',
      });

      await main();

      expect(consoleErrorSpy).toHaveBeenCalledWith('Error: forbidden');
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('prints error and exits when httpFetch fails', async () => {
      process.argv = ['node', 'cli.js', 'https://example.com/article'];
      vi.mocked(httpFetch).mockResolvedValue({
        success: false,
        url: 'https://example.com/article',
        error: 'Connection refused',
        hint: 'Try again later',
        latencyMs: 50,
      });

      await main();

      expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Connection refused');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Hint: Try again later');
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('prints JSON and exits when --json httpFetch fails', async () => {
      process.argv = ['node', 'cli.js', 'https://example.com/article', '--json'];
      vi.mocked(httpFetch).mockResolvedValue({
        success: false,
        url: 'https://example.com/article',
        error: 'timeout',
        latencyMs: 10000,
      });

      await main();

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.success).toBe(false);
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('prints only text in --quiet mode', async () => {
      process.argv = ['node', 'cli.js', 'https://example.com/article', '-q'];
      vi.mocked(httpFetch).mockResolvedValue({
        success: true,
        url: 'https://example.com/article',
        title: 'Should Not Print',
        textContent: 'Just the text please',
        latencyMs: 100,
      });

      await main();

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy).toHaveBeenCalledWith('Just the text please');
    });

    it('runs --detect mode with no detections', async () => {
      process.argv = ['node', 'cli.js', 'https://example.com/article', '--detect'];
      vi.mocked(httpRequest).mockResolvedValue({
        success: true,
        statusCode: 200,
        html: '<html>Clean</html>',
        headers: { 'content-type': 'text/html' },
        cookies: [],
      });
      vi.mocked(mergeDetections).mockReturnValue([]);

      await main();

      expect(httpRequest).toHaveBeenCalledWith('https://example.com/article');
      expect(consoleLogSpy).toHaveBeenCalledWith('No antibot protection detected.');
    });

    it('runs --detect mode with detections', async () => {
      process.argv = ['node', 'cli.js', 'https://example.com/article', '--detect'];
      vi.mocked(httpRequest).mockResolvedValue({
        success: true,
        statusCode: 200,
        html: '<html>Protected</html>',
        headers: {},
        cookies: [{ name: '_px3', value: 'abc', domain: 'example.com', path: '/' }],
      });
      vi.mocked(mergeDetections).mockReturnValue([
        {
          provider: 'perimeterx',
          name: 'PerimeterX (HUMAN)',
          category: 'antibot',
          confidence: 100,
          evidence: ['cookie: _px3'],
          suggestedAction: 'try-archive',
        },
      ]);

      await main();

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Antibot detections for'));
      expect(consoleLogSpy).toHaveBeenCalledWith('  PerimeterX (HUMAN) (antibot)');
      expect(consoleLogSpy).toHaveBeenCalledWith('    Confidence: 100%');
    });

    it('runs --detect --json mode', async () => {
      process.argv = ['node', 'cli.js', 'https://example.com/article', '--detect', '--json'];
      vi.mocked(httpRequest).mockResolvedValue({
        success: true,
        statusCode: 200,
        html: '<html>Page</html>',
        headers: {},
        cookies: [],
      });
      vi.mocked(mergeDetections).mockReturnValue([]);

      await main();

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.url).toBe('https://example.com/article');
      expect(output.detections).toEqual([]);
    });
  });
});
