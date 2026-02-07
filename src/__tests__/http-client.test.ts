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

    it('throws when DNS resolution fails (fail closed)', async () => {
      mockDnsFailure();
      await expect(validateSSRF('https://example.com')).rejects.toThrow(
        'SSRF protection: DNS resolution returned no addresses'
      );
    });

    it('throws when DNS returns no addresses (fail closed)', async () => {
      vi.mocked(dns.resolve4).mockResolvedValue([]);
      vi.mocked(dns.resolve6).mockResolvedValue([]);
      await expect(validateSSRF('https://example.com')).rejects.toThrow(
        'SSRF protection: DNS resolution returned no addresses'
      );
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

    it('throws for 2001:db8:: IPv6 documentation range (RFC 3849)', async () => {
      mockDnsIPv6Only('2001:db8::1');
      await expect(validateSSRF('https://example.com')).rejects.toThrow('SSRF protection');
    });

    it('throws for 100:: IPv6 discard range (RFC 6666)', async () => {
      mockDnsIPv6Only('100::1');
      await expect(validateSSRF('https://example.com')).rejects.toThrow('SSRF protection');
    });

    it('throws for bracketed IPv6 localhost literal', async () => {
      await expect(validateSSRF('http://[::1]/')).rejects.toThrow('SSRF protection');
    });

    it('throws for bracketed IPv6 private literal', async () => {
      await expect(validateSSRF('http://[fc00::1]/')).rejects.toThrow('SSRF protection');
    });

    it('allows bracketed IPv6 public literal', async () => {
      const result = await validateSSRF('http://[2606:4700::1]/');
      expect(result).toEqual(['2606:4700::1']);
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

  describe('session recycling', () => {
    it('recycles session after max age', async () => {
      vi.useFakeTimers();
      mockDnsIPv4Only('93.184.216.34');
      mockGet.mockResolvedValue({
        ok: true,
        statusCode: 200,
        text: '<html>OK</html>',
        headers: {},
        cookies: [],
      });

      const result1 = await httpRequest('https://example.com/page');
      expect(result1.success).toBe(true);
      const constructorCallsBefore = mockSessionOptions.length;

      // Advance past SESSION_MAX_AGE_MS (1 hour)
      vi.advanceTimersByTime(61 * 60 * 1000);

      const result2 = await httpRequest('https://example.com/page');
      expect(result2.success).toBe(true);
      expect(mockSessionOptions.length).toBeGreaterThan(constructorCallsBefore);
      expect(mockClose).toHaveBeenCalled();
    });

    it('defers recycling when session has in-flight requests', async () => {
      vi.useFakeTimers();
      mockDnsIPv4Only('93.184.216.34');

      mockGet.mockResolvedValueOnce({
        ok: true,
        statusCode: 200,
        text: '<html>OK</html>',
        headers: {},
        cookies: [],
      });
      await httpRequest('https://example.com/page');
      const constructorCallsBefore = mockSessionOptions.length;

      // Use timeout > SESSION_MAX_AGE_MS to prevent the request timeout from
      // firing before we advance past the session max age window.
      let resolveInflight!: (v: unknown) => void;
      mockGet.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveInflight = resolve;
        })
      );
      const twoHoursMs = 2 * 60 * 60 * 1000;
      const inflightPromise = httpRequest(
        'https://example.com/inflight',
        {},
        undefined,
        twoHoursMs
      );

      // Advance past max age but NOT past the 2-hour request timeout
      await vi.advanceTimersByTimeAsync(61 * 60 * 1000);

      // Session should NOT be recycled while inFlightRequests > 0
      await getSession();
      expect(mockSessionOptions.length).toBe(constructorCallsBefore);

      resolveInflight({
        ok: true,
        statusCode: 200,
        text: '<html>Inflight done</html>',
        headers: {},
        cookies: [],
      });
      // Advance past remaining timeout to avoid dangling timers
      await vi.advanceTimersByTimeAsync(twoHoursMs);
      await inflightPromise;
    });
  });

  describe('LRU eviction', () => {
    it('evicts least-recently-used session when cache exceeds MAX_SESSIONS', async () => {
      for (let i = 0; i < 50; i++) {
        await getSession(`preset-${i}`);
      }
      await getSession('preset-overflow');
      expect(mockClose).toHaveBeenCalled();
    });

    it('evicts oldest session by lastAccessed time', async () => {
      vi.useFakeTimers();
      for (let i = 0; i < 50; i++) {
        await getSession(`preset-${i}`);
        vi.advanceTimersByTime(10);
      }
      // Re-access preset-0 so it becomes recently used
      await getSession('preset-0');

      // Overflow should evict preset-1 (oldest lastAccessed), NOT preset-0
      await getSession('preset-overflow');
      expect(mockClose).toHaveBeenCalled();
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
      expect(mockClose).toHaveBeenCalled();
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
      expect(result.success).toBe(true);
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
      mockGet.mockImplementation(() => new Promise(() => {}));

      const resultPromise = httpRequest('https://example.com/page');
      await vi.advanceTimersByTimeAsync(21000); // Default timeout is 20s
      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Request timeout');
    });

    it('respects custom timeout value', async () => {
      vi.useFakeTimers();
      mockGet.mockImplementation(() => new Promise(() => {}));

      const resultPromise = httpRequest('https://example.com/page', {}, undefined, 5000);
      await vi.advanceTimersByTimeAsync(6000);
      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Request timeout after 5000ms');
    });

    it('handles DNS resolution timeout', async () => {
      vi.useFakeTimers();
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

  describe('session recycling', () => {
    beforeEach(() => {
      mockDnsIPv4Only('93.184.216.34');
    });

    it('creates new session after previous one ages out', async () => {
      vi.useFakeTimers();

      mockGet.mockResolvedValue({
        ok: true,
        statusCode: 200,
        text: '<html>OK</html>',
        headers: {},
        cookies: [],
      });

      // First request creates session and completes (decrements inFlight)
      await httpRequest('https://example.com/page1');
      const sessionsCreatedBefore = mockSessionOptions.length;

      // Advance past SESSION_MAX_AGE_MS (1 hour)
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1);

      // Next request should trigger session recycling
      await httpRequest('https://example.com/page2');
      const sessionsCreatedAfter = mockSessionOptions.length;

      // A new session should have been created (recycled)
      expect(sessionsCreatedAfter).toBeGreaterThan(sessionsCreatedBefore);
      // Old session should have been closed
      expect(mockClose).toHaveBeenCalled();
    });

    it('defers recycling when session has in-flight requests', async () => {
      vi.useFakeTimers();

      // First mock never resolves (simulates long-running request)
      // Use a very long timeout (2 hours) to prevent the request timeout from
      // firing before SESSION_MAX_AGE_MS when we advance time
      let resolveSlowRequest!: (value: unknown) => void;
      mockGet.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSlowRequest = resolve;
          })
      );

      // Start request but don't await — keeps inFlightRequests > 0
      // Use timeoutMs of 2 hours so it won't time out when we advance by 1 hour
      const slowPromise = httpRequest(
        'https://example.com/slow',
        {},
        undefined,
        2 * 60 * 60 * 1000
      );

      // Advance past max age
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1);

      // Snapshot close count before the fast request — closeAllSessions() in
      // beforeEach may have already called mockClose during cleanup of the
      // previous test's cached sessions.
      const closedBeforeFast = mockClose.mock.calls.length;

      // Fast request should reuse the same session (recycling deferred)
      mockGet.mockResolvedValueOnce({
        ok: true,
        statusCode: 200,
        text: '<html>Fast</html>',
        headers: {},
        cookies: [],
      });
      await httpRequest('https://example.com/fast', {}, undefined, 2 * 60 * 60 * 1000);

      // Session should NOT have been closed during fast request (in-flight deferral)
      expect(mockClose.mock.calls.length).toBe(closedBeforeFast);

      // Now complete the slow request
      resolveSlowRequest({
        ok: true,
        statusCode: 200,
        text: '<html>Slow done</html>',
        headers: {},
        cookies: [],
      });
      await slowPromise;

      // Next request should now recycle since inFlight is 0
      mockGet.mockResolvedValueOnce({
        ok: true,
        statusCode: 200,
        text: '<html>After recycle</html>',
        headers: {},
        cookies: [],
      });
      await httpRequest('https://example.com/after', {}, undefined, 2 * 60 * 60 * 1000);
      expect(mockClose.mock.calls.length).toBeGreaterThan(closedBeforeFast);
    });

    it('evicts LRU session when cache reaches MAX_SESSIONS', async () => {
      mockGet.mockResolvedValue({
        ok: true,
        statusCode: 200,
        text: '<html>OK</html>',
        headers: {},
        cookies: [],
      });

      // Fill cache with 50 sessions using different presets
      for (let i = 0; i < 50; i++) {
        await httpRequest('https://example.com/page', {}, `preset_${i}`);
      }

      const closedBefore = mockClose.mock.calls.length;

      // 51st session should trigger LRU eviction
      await httpRequest('https://example.com/page', {}, 'preset_new');

      // At least one session should have been evicted and closed
      expect(mockClose.mock.calls.length).toBeGreaterThan(closedBefore);
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

      // Both the cached session and the fresh 304-retry session must have the proxy
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
