import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseCookies, parseArgs, parseCrawlArgs } from '../cli.js';
import { resolveProxy } from '../fetch/http-fetch.js';
import { validateProxyUrl, redactProxyUrl } from '../fetch/http-client.js';

describe('parseCookies', () => {
  it('parses semicolon-separated cookies', () => {
    expect(parseCookies(['a=1; b=2'])).toEqual({ a: '1', b: '2' });
  });

  it('handles values containing =', () => {
    expect(parseCookies(['token=abc=def=ghi'])).toEqual({ token: 'abc=def=ghi' });
  });

  it('handles empty values', () => {
    expect(parseCookies(['name='])).toEqual({ name: '' });
  });

  it('trims whitespace around names and values', () => {
    expect(parseCookies(['  a = 1 ;  b = 2  '])).toEqual({ a: '1', b: '2' });
  });

  it('merges multiple --cookie arguments', () => {
    expect(parseCookies(['a=1', 'b=2'])).toEqual({ a: '1', b: '2' });
  });

  it('returns undefined for empty input', () => {
    expect(parseCookies(undefined)).toBeUndefined();
    expect(parseCookies([])).toBeUndefined();
  });

  it('skips pairs without =', () => {
    expect(parseCookies(['a=1; invalid; b=2'])).toEqual({ a: '1', b: '2' });
  });

  it('skips empty segments', () => {
    expect(parseCookies(['a=1;;; b=2'])).toEqual({ a: '1', b: '2' });
  });

  it('skips pairs with empty name', () => {
    expect(parseCookies(['=value'])).toBeUndefined();
  });

  it('strips newlines and null bytes from cookie values', () => {
    expect(parseCookies(['session=abc\r\ndef'])).toEqual({ session: 'abcdef' });
    expect(parseCookies(['token=val\nue'])).toEqual({ token: 'value' });
    expect(parseCookies(['id=a\0b'])).toEqual({ id: 'ab' });
  });
});

describe('resolveProxy', () => {
  const envKeys = ['AGENT_FETCH_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY'];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('returns explicit proxy when provided', () => {
    process.env.AGENT_FETCH_PROXY = 'http://env-proxy:8080';
    expect(resolveProxy('http://explicit:9090')).toBe('http://explicit:9090');
  });

  it('falls back to AGENT_FETCH_PROXY', () => {
    process.env.AGENT_FETCH_PROXY = 'http://agent-proxy:8080';
    process.env.HTTPS_PROXY = 'http://https-proxy:8080';
    expect(resolveProxy()).toBe('http://agent-proxy:8080');
  });

  it('falls back to HTTPS_PROXY', () => {
    process.env.HTTPS_PROXY = 'http://https-proxy:8080';
    process.env.HTTP_PROXY = 'http://http-proxy:8080';
    expect(resolveProxy()).toBe('http://https-proxy:8080');
  });

  it('falls back to HTTP_PROXY', () => {
    process.env.HTTP_PROXY = 'http://http-proxy:8080';
    expect(resolveProxy()).toBe('http://http-proxy:8080');
  });

  it('returns undefined when no proxy is configured', () => {
    expect(resolveProxy()).toBeUndefined();
  });
});

describe('validateProxyUrl', () => {
  it('accepts http:// proxy', async () => {
    await expect(validateProxyUrl('http://proxy.example.com:8080')).resolves.toBeUndefined();
  });

  it('accepts https:// proxy', async () => {
    await expect(validateProxyUrl('https://proxy.example.com:8080')).resolves.toBeUndefined();
  });

  it('accepts socks5:// proxy', async () => {
    await expect(validateProxyUrl('socks5://proxy.example.com:1080')).resolves.toBeUndefined();
  });

  it('accepts socks5h:// proxy', async () => {
    await expect(validateProxyUrl('socks5h://proxy.example.com:1080')).resolves.toBeUndefined();
  });

  it('rejects ftp:// proxy', async () => {
    await expect(validateProxyUrl('ftp://proxy.example.com:21')).rejects.toThrow(
      'Invalid proxy scheme'
    );
  });

  it('rejects invalid URL', async () => {
    await expect(validateProxyUrl('not-a-url')).rejects.toThrow('Invalid proxy URL');
  });

  it('rejects proxy pointing to private IP', async () => {
    await expect(validateProxyUrl('http://127.0.0.1:8080')).rejects.toThrow('SSRF protection');
  });

  it('rejects proxy pointing to link-local IP', async () => {
    await expect(validateProxyUrl('http://169.254.169.254:80')).rejects.toThrow('SSRF protection');
  });
});

describe('redactProxyUrl', () => {
  it('redacts username and password', () => {
    expect(redactProxyUrl('http://user:secret@proxy.example.com:8080')).toBe(
      'http://***:***@proxy.example.com:8080/'
    );
  });

  it('redacts password only', () => {
    const result = redactProxyUrl('http://user:secret@proxy.example.com:8080');
    expect(result).not.toContain('secret');
    expect(result).toContain('***');
  });

  it('leaves URL without credentials unchanged', () => {
    expect(redactProxyUrl('http://proxy.example.com:8080')).toBe('http://proxy.example.com:8080/');
  });

  it('handles invalid URL', () => {
    expect(redactProxyUrl('not-a-url')).toBe('<invalid-proxy-url>');
  });
});

describe('CLI --proxy and --cookie', () => {
  it('parseArgs handles --proxy', () => {
    const result = parseArgs(['https://example.com', '--proxy', 'http://proxy:8080']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.proxy).toBe('http://proxy:8080');
    }
  });

  it('parseArgs handles --cookie', () => {
    const result = parseArgs(['https://example.com', '--cookie', 'a=1; b=2']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.cookie).toEqual(['a=1; b=2']);
    }
  });

  it('parseArgs handles multiple --cookie flags', () => {
    const result = parseArgs(['https://example.com', '--cookie', 'a=1', '--cookie', 'b=2']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.cookie).toEqual(['a=1', 'b=2']);
    }
  });

  it('parseArgs returns error for --proxy without value', () => {
    const result = parseArgs(['https://example.com', '--proxy']);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('--proxy requires a value');
    }
  });

  it('parseArgs returns error for --cookie without value', () => {
    const result = parseArgs(['https://example.com', '--cookie']);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('--cookie requires a value');
    }
  });
});

describe('parseCrawlArgs --proxy and --cookie', () => {
  it('handles --proxy', () => {
    const result = parseCrawlArgs(['https://example.com', '--proxy', 'socks5://proxy:1080']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.proxy).toBe('socks5://proxy:1080');
    }
  });

  it('handles --cookie and parses into cookies map', () => {
    const result = parseCrawlArgs(['https://example.com', '--cookie', 'session=abc123']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.opts.cookies).toEqual({ session: 'abc123' });
    }
  });
});
