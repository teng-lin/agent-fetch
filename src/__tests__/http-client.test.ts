import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockClose = vi.fn();
let mockSessionConstructor: (() => void) | undefined;
const mockSessionOptions: Record<string, unknown>[] = [];

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('dns', () => ({
  promises: {
    resolve4: vi.fn(),
    resolve6: vi.fn(),
  },
}));

vi.mock('httpcloak', () => ({
  default: {
    Session: class MockSession {
      get = mockGet;
      post = mockPost;
      close = mockClose;
      constructor(opts?: Record<string, unknown>) {
        mockSessionOptions.push(opts ?? {});
        if (mockSessionConstructor) mockSessionConstructor();
      }
    },
    Preset: {
      CHROME_143: 'chrome_143',
      FIREFOX_133: 'firefox_133',
    },
  },
}));

import {
  validateSSRF,
  getSession,
  closeAllSessions,
  httpRequest,
  httpPost,
} from '../fetch/http-client.js';
import { promises as dns } from 'dns';

afterEach(() => {
  mockSessionConstructor = undefined;
});

function mockDnsIPv4Only(ipv4: string): void {
  vi.mocked(dns.resolve4).mockResolvedValue([ipv4]);
  vi.mocked(dns.resolve6).mockRejectedValue(new Error('no AAAA'));
}

function mockDnsIPv6Only(ipv6: string): void {
  vi.mocked(dns.resolve4).mockRejectedValue(new Error('no A'));
  vi.mocked(dns.resolve6).mockResolvedValue([ipv6]);
}

function mockDnsFailure(): void {
  vi.mocked(dns.resolve4).mockRejectedValue(new Error('NXDOMAIN'));
  vi.mocked(dns.resolve6).mockRejectedValue(new Error('NXDOMAIN'));
}

describe('fetch/http-client', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockSessionOptions.length = 0;
    await closeAllSessions();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('validateSSRF', () => {
    it('allows public IP addresses', async () => {
      mockDnsIPv4Only('93.184.216.34');
      const result = await validateSSRF('https://example.com/page');
      expect(result).toEqual(['93.184.216.34']);
    });

    it('throws for 127.x localhost', async () => {
      mockDnsIPv4Only('127.0.0.1');
      await expect(validateSSRF('https://example.com')).rejects.toThrow('SSRF protection');
    });

    it('throws for 10.x private IP', async () => {
      mockDnsIPv4Only('10.0.0.1');
      await expect(validateSSRF('https://example.com')).rejects.toThrow('SSRF protection');
    });

    it('throws for 192.168.x private IP', async () => {
      mockDnsIPv4Only('192.168.1.1');
      await expect(validateSSRF('https://example.com')).rejects.toThrow('SSRF protection');
    });

    it('throws for 172.16.x private IP', async () => {
      mockDnsIPv4Only('172.16.0.1');
      await expect(validateSSRF('https://example.com')).rejects.toThrow('SSRF protection');
    });

    it('throws for 169.254.x link-local IP', async () => {
      mockDnsIPv4Only('169.254.1.1');
      await expect(validateSSRF('https://example.com')).rejects.toThrow('SSRF protection');
    });

    it('throws for ::1 IPv6 localhost', async () => {
      mockDnsIPv6Only('::1');
      await expect(validateSSRF('https://example.com')).rejects.toThrow('SSRF protection');
    });

    it('throws for fe80:: IPv6 link-local', async () => {
      mockDnsIPv6Only('fe80::1');
      await expect(validateSSRF('https://example.com')).rejects.toThrow('SSRF protection');
    });

    it('throws for ::ffff:127.0.0.1 mapped IPv4', async () => {
      mockDnsIPv6Only('::ffff:127.0.0.1');
      await expect(validateSSRF('https://example.com')).rejects.toThrow('SSRF protection');
    });

    it('returns empty array when DNS fails', async () => {
      mockDnsFailure();
      const result = await validateSSRF('https://example.com');
      expect(result).toEqual([]);
    });

    it('throws for 0.x.x.x "this network" range', async () => {
      mockDnsIPv4Only('0.0.0.1');
      await expect(validateSSRF('https://example.com')).rejects.toThrow('SSRF protection');
    });

    it('throws for fc00:: IPv6 private range', async () => {
      mockDnsIPv6Only('fc00::1');
      await expect(validateSSRF('https://example.com')).rejects.toThrow('SSRF protection');
    });

    it('throws for fd00:: IPv6 private range', async () => {
      mockDnsIPv6Only('fd00::1');
      await expect(validateSSRF('https://example.com')).rejects.toThrow('SSRF protection');
    });

    it('combines IPv4 and IPv6 results', async () => {
      vi.mocked(dns.resolve4).mockResolvedValue(['93.184.216.34']);
      vi.mocked(dns.resolve6).mockResolvedValue(['2606:2800:220:1:248:1893:25c8:1946']);

      const result = await validateSSRF('https://example.com');
      expect(result).toHaveLength(2);
      expect(result).toContain('93.184.216.34');
      expect(result).toContain('2606:2800:220:1:248:1893:25c8:1946');
    });
  });

  describe('getSession', () => {
    it('creates a new session', async () => {
      const session = await getSession();
      expect(session).toBeDefined();
      expect(session.get).toBeDefined();
    });

    it('returns cached session on second call', async () => {
      const session1 = await getSession();
      const session2 = await getSession();
      expect(session1).toBe(session2);
    });
  });

  describe('closeAllSessions', () => {
    it('clears cache so next call creates new session', async () => {
      const session1 = await getSession();
      await closeAllSessions();
      const session2 = await getSession();
      expect(session1).not.toBe(session2);
    });
  });

  describe('session creation failure recovery', () => {
    it('recovers after session creation fails', async () => {
      // First call: session constructor throws
      mockSessionConstructor = () => {
        throw new Error('Binary not found');
      };
      await expect(getSession()).rejects.toThrow('Binary not found');

      // Second call: constructor works again — should NOT hang
      mockSessionConstructor = undefined;
      const session = await getSession();
      expect(session).toBeDefined();
      expect(session.get).toBeDefined();
    });

    it('concurrent callers do not hang when session creation fails', async () => {
      mockSessionConstructor = () => {
        throw new Error('Session init failed');
      };

      // First caller triggers failure
      const call1 = getSession().catch((e) => e);

      // Second caller arrives while first is failing
      const call2 = getSession().catch((e) => e);

      const [result1, result2] = await Promise.all([call1, call2]);

      // Both should get errors, neither should hang
      expect(result1).toBeInstanceOf(Error);
      expect(result2).toBeInstanceOf(Error);

      // Now fix the constructor — next call should succeed
      mockSessionConstructor = undefined;
      const session = await getSession();
      expect(session).toBeDefined();
    });
  });

  describe('httpRequest', () => {
    beforeEach(() => {
      mockDnsIPv4Only('93.184.216.34');
    });

    it('returns successful response with cookies', async () => {
      mockGet.mockResolvedValue({
        ok: true,
        statusCode: 200,
        text: '<html>Hello</html>',
        headers: { 'content-type': 'text/html' },
        cookies: [{ name: 'sid', value: '123', domain: 'example.com', path: '/' }],
      });

      const result = await httpRequest('https://example.com/page');
      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.html).toBe('<html>Hello</html>');
      expect(result.cookies).toHaveLength(1);
      expect(result.cookies[0].name).toBe('sid');
    });

    it('handles text-as-function quirk', async () => {
      mockGet.mockResolvedValue({
        ok: true,
        statusCode: 200,
        text: () => '<html>Function text</html>',
        headers: {},
        cookies: [],
      });

      const result = await httpRequest('https://example.com/page');
      expect(result.html).toBe('<html>Function text</html>');
    });

    it('rejects SSRF attempts', async () => {
      mockDnsIPv4Only('127.0.0.1');
      const result = await httpRequest('https://example.com/page');
      expect(result.success).toBe(false);
      expect(result.error).toContain('SSRF protection');
    });

    it('rejects oversized Content-Length', async () => {
      mockGet.mockResolvedValue({
        ok: true,
        statusCode: 200,
        text: 'small body',
        headers: { 'content-length': '999999999' },
        cookies: [],
      });

      const result = await httpRequest('https://example.com/page');
      expect(result.success).toBe(false);
      expect(result.error).toBe('response_too_large');
    });

    it('handles session.get errors gracefully', async () => {
      mockGet.mockRejectedValue(new Error('Connection refused'));

      const result = await httpRequest('https://example.com/page');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection refused');
    });

    it('allows IP changes between public IPs (CDN rotation)', async () => {
      // Pre-connection resolves to one public IP, post-connection resolves to a different public IP
      // This is normal behavior for CDNs like CloudFront that use rotating anycast DNS
      vi.mocked(dns.resolve4)
        .mockResolvedValueOnce(['93.184.216.34'])
        .mockResolvedValueOnce(['198.51.100.1']);
      vi.mocked(dns.resolve6).mockRejectedValue(new Error('no AAAA'));

      mockGet.mockResolvedValue({
        ok: true,
        statusCode: 200,
        text: '<html>CDN rotated</html>',
        headers: {},
        cookies: [],
      });

      const result = await httpRequest('https://example.com/page');
      expect(result.success).toBe(true);
      expect(result.html).toBe('<html>CDN rotated</html>');
    });

    it('detects DNS rebinding to private IP after connection', async () => {
      // Pre-connection resolves to public IP, post-connection resolves to private IP
      // This is a DNS rebinding attack that should be blocked
      vi.mocked(dns.resolve4)
        .mockResolvedValueOnce(['93.184.216.34'])
        .mockResolvedValueOnce(['192.168.1.1']); // Private IP!
      vi.mocked(dns.resolve6).mockRejectedValue(new Error('no AAAA'));

      mockGet.mockResolvedValue({
        ok: true,
        statusCode: 200,
        text: '<html>Rebound</html>',
        headers: {},
        cookies: [],
      });

      const result = await httpRequest('https://example.com/page');
      expect(result.success).toBe(false);
      expect(result.error).toContain('SSRF protection');
    });

    it('rejects response body exceeding size limit without Content-Length', async () => {
      const hugeBody = 'x'.repeat(10 * 1024 * 1024 + 1); // > MAX_RESPONSE_SIZE
      mockGet.mockResolvedValue({
        ok: true,
        statusCode: 200,
        text: hugeBody,
        headers: {},
        cookies: [],
      });

      const result = await httpRequest('https://example.com/page');
      expect(result.success).toBe(false);
      expect(result.error).toBe('response_too_large');
    });

    it('passes custom headers to session.get', async () => {
      mockGet.mockResolvedValue({
        ok: true,
        statusCode: 200,
        text: '<html>OK</html>',
        headers: {},
        cookies: [],
      });

      await httpRequest('https://example.com/page', { 'X-Custom': 'value' });
      expect(mockGet).toHaveBeenCalledWith('https://example.com/page', {
        headers: { 'Cache-Control': 'no-cache', 'X-Custom': 'value' },
      });
    });

    it('retries with fresh session on 304 Not Modified', async () => {
      mockGet
        .mockResolvedValueOnce({
          ok: true,
          statusCode: 304,
          text: '',
          headers: {},
          cookies: [],
        })
        .mockResolvedValueOnce({
          ok: true,
          statusCode: 200,
          text: '<html>Full content</html>',
          headers: {},
          cookies: [],
        });

      const result = await httpRequest('https://example.com/page');
      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.html).toBe('<html>Full content</html>');
      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(mockClose).toHaveBeenCalled(); // fresh session closed
    });

    it('returns 304 result when retry also gets 304', async () => {
      mockGet.mockResolvedValue({
        ok: true,
        statusCode: 304,
        text: '',
        headers: {},
        cookies: [],
      });

      const result = await httpRequest('https://example.com/page');
      expect(result.success).toBe(true); // ok is true for 304 (< 400)
      expect(result.statusCode).toBe(304);
      expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it('accepts firefox browser type', async () => {
      mockGet.mockResolvedValue({
        ok: true,
        statusCode: 200,
        text: '<html>Firefox</html>',
        headers: {},
        cookies: [],
      });

      const result = await httpRequest('https://example.com/page', {}, 'firefox');
      expect(result.success).toBe(true);
      expect(result.html).toBe('<html>Firefox</html>');
    });

    it('handles request timeout', async () => {
      vi.useFakeTimers();
      // Mock session.get to never resolve (simulates hang)
      mockGet.mockImplementation(() => new Promise(() => {}));

      const resultPromise = httpRequest('https://example.com/page');
      await vi.advanceTimersByTimeAsync(21000); // Default timeout is 20s
      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Request timeout');
    });

    it('respects custom timeout value', async () => {
      vi.useFakeTimers();
      // Mock session.get to never resolve (simulates hang)
      mockGet.mockImplementation(() => new Promise(() => {}));

      const resultPromise = httpRequest('https://example.com/page', {}, undefined, 5000);
      await vi.advanceTimersByTimeAsync(6000); // Custom timeout is 5s
      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Request timeout after 5000ms');
    });

    it('handles DNS resolution timeout', async () => {
      vi.useFakeTimers();
      // Mock DNS to never resolve
      vi.mocked(dns.resolve4).mockImplementation(() => new Promise(() => {}));
      vi.mocked(dns.resolve6).mockImplementation(() => new Promise(() => {}));

      const resultPromise = httpRequest('https://example.com/page');
      await vi.advanceTimersByTimeAsync(6000);
      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('DNS resolution timed out');
    });
  });

  describe('getSession with proxy', () => {
    it('returns different sessions for different proxies', async () => {
      const session1 = await getSession(undefined, 'http://proxy1.example.com:8080');
      const session2 = await getSession(undefined, 'http://proxy2.example.com:8080');
      expect(session1).not.toBe(session2);
    });

    it('returns cached session for same proxy', async () => {
      const session1 = await getSession(undefined, 'http://proxy.example.com:8080');
      const session2 = await getSession(undefined, 'http://proxy.example.com:8080');
      expect(session1).toBe(session2);
    });

    it('returns different sessions for proxy vs no-proxy', async () => {
      const sessionDirect = await getSession();
      const sessionProxy = await getSession(undefined, 'http://proxy.example.com:8080');
      expect(sessionDirect).not.toBe(sessionProxy);
    });

    it('passes proxy to Session constructor', async () => {
      await getSession(undefined, 'http://proxy.example.com:8080');
      expect(mockSessionOptions).toContainEqual(
        expect.objectContaining({ proxy: 'http://proxy.example.com:8080' })
      );
    });

    it('does not pass proxy when none provided', async () => {
      await getSession();
      expect(mockSessionOptions).toHaveLength(1);
      expect(mockSessionOptions[0]).not.toHaveProperty('proxy');
    });
  });

  describe('httpRequest with cookies', () => {
    beforeEach(() => {
      mockDnsIPv4Only('93.184.216.34');
    });

    it('passes cookies via RequestOptions', async () => {
      mockGet.mockResolvedValue({
        ok: true,
        statusCode: 200,
        text: '<html>OK</html>',
        headers: {},
        cookies: [],
      });

      await httpRequest('https://example.com/page', {}, undefined, undefined, undefined, {
        session: 'abc123',
      });

      expect(mockGet).toHaveBeenCalledWith('https://example.com/page', {
        headers: { 'Cache-Control': 'no-cache' },
        cookies: { session: 'abc123' },
      });
    });

    it('does not include cookies field when no cookies provided', async () => {
      mockGet.mockResolvedValue({
        ok: true,
        statusCode: 200,
        text: '<html>OK</html>',
        headers: {},
        cookies: [],
      });

      await httpRequest('https://example.com/page');

      expect(mockGet).toHaveBeenCalledWith('https://example.com/page', {
        headers: { 'Cache-Control': 'no-cache' },
      });
    });

    it('does not include cookies field when cookies is empty object', async () => {
      mockGet.mockResolvedValue({
        ok: true,
        statusCode: 200,
        text: '<html>OK</html>',
        headers: {},
        cookies: [],
      });

      await httpRequest('https://example.com/page', {}, undefined, undefined, undefined, {});

      expect(mockGet).toHaveBeenCalledWith('https://example.com/page', {
        headers: { 'Cache-Control': 'no-cache' },
      });
    });
  });

  describe('304 retry with proxy and cookies', () => {
    beforeEach(() => {
      mockDnsIPv4Only('93.184.216.34');
    });

    it('creates fresh session with proxy on 304 retry', async () => {
      mockGet
        .mockResolvedValueOnce({
          ok: true,
          statusCode: 304,
          text: '',
          headers: {},
          cookies: [],
        })
        .mockResolvedValueOnce({
          ok: true,
          statusCode: 200,
          text: '<html>OK</html>',
          headers: {},
          cookies: [],
        });

      mockSessionOptions.length = 0;
      await httpRequest(
        'https://example.com/page',
        {},
        undefined,
        undefined,
        'http://proxy.example.com:8080'
      );

      // Cached session + fresh 304-retry session: both must have proxy
      const proxyOptions = mockSessionOptions.filter(
        (opts) => opts.proxy === 'http://proxy.example.com:8080'
      );
      expect(proxyOptions.length).toBeGreaterThanOrEqual(2);
    });

    it('passes cookies on 304 retry request', async () => {
      mockGet
        .mockResolvedValueOnce({
          ok: true,
          statusCode: 304,
          text: '',
          headers: {},
          cookies: [],
        })
        .mockResolvedValueOnce({
          ok: true,
          statusCode: 200,
          text: '<html>OK</html>',
          headers: {},
          cookies: [],
        });

      await httpRequest('https://example.com/page', {}, undefined, undefined, undefined, {
        session: 'abc',
      });

      // Both original and retry requests should include cookies
      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(mockGet.mock.calls[0][1]).toHaveProperty('cookies', { session: 'abc' });
      expect(mockGet.mock.calls[1][1]).toHaveProperty('cookies', { session: 'abc' });
    });
  });

  describe('httpPost with cookies', () => {
    beforeEach(() => {
      mockDnsIPv4Only('93.184.216.34');
    });

    it('passes cookies via RequestOptions on POST', async () => {
      mockPost.mockResolvedValue({
        ok: true,
        statusCode: 200,
        text: 'OK',
        headers: {},
        cookies: [],
      });

      await httpPost(
        'https://example.com/api',
        { action: 'test' },
        undefined,
        undefined,
        undefined,
        undefined,
        { auth: 'token123' }
      );

      expect(mockPost).toHaveBeenCalledWith('https://example.com/api', {
        headers: {
          'Cache-Control': 'no-cache',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: { action: 'test' },
        cookies: { auth: 'token123' },
      });
    });
  });

  describe('httpPost', () => {
    beforeEach(() => {
      mockDnsIPv4Only('93.184.216.34');
    });

    it('returns successful POST response', async () => {
      mockPost.mockResolvedValue({
        ok: true,
        statusCode: 200,
        text: '{"success":true,"data":"<p>Article content</p>"}',
        headers: { 'content-type': 'application/json' },
        cookies: [],
      });

      const result = await httpPost('https://example.com/wp-admin/admin-ajax.php', {
        action: 'fetch_article_content',
        'data[id]': 'abc-123',
      });
      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.html).toBe('{"success":true,"data":"<p>Article content</p>"}');
    });

    it('passes form data and Content-Type header to session.post', async () => {
      mockPost.mockResolvedValue({
        ok: true,
        statusCode: 200,
        text: 'OK',
        headers: {},
        cookies: [],
      });

      await httpPost('https://example.com/wp-admin/admin-ajax.php', {
        action: 'fetch_content',
        'data[id]': 'uuid-here',
      });

      expect(mockPost).toHaveBeenCalledWith('https://example.com/wp-admin/admin-ajax.php', {
        headers: {
          'Cache-Control': 'no-cache',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: { action: 'fetch_content', 'data[id]': 'uuid-here' },
      });
    });

    it('merges custom headers with Content-Type', async () => {
      mockPost.mockResolvedValue({
        ok: true,
        statusCode: 200,
        text: 'OK',
        headers: {},
        cookies: [],
      });

      await httpPost(
        'https://example.com/wp-admin/admin-ajax.php',
        { action: 'test' },
        { 'X-Custom': 'value' }
      );

      expect(mockPost).toHaveBeenCalledWith('https://example.com/wp-admin/admin-ajax.php', {
        headers: {
          'Cache-Control': 'no-cache',
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Custom': 'value',
        },
        body: { action: 'test' },
      });
    });

    it('rejects SSRF attempts on POST', async () => {
      mockDnsIPv4Only('127.0.0.1');
      const result = await httpPost('https://example.com/wp-admin/admin-ajax.php', {
        action: 'test',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('SSRF protection');
    });

    it('handles POST errors gracefully', async () => {
      mockPost.mockRejectedValue(new Error('Connection refused'));

      const result = await httpPost('https://example.com/wp-admin/admin-ajax.php', {
        action: 'test',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection refused');
    });
  });
});
