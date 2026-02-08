/**
 * Integration tests for http-client.ts: SSRF edge cases, proxy validation,
 * and session management gaps not covered by http-client.test.ts or proxy-cookie.test.ts.
 *
 * Mocks httpcloak and dns modules — no real network calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockClose = vi.fn();
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
  validateProxyUrl,
  redactProxyUrl,
  getSession,
  closeAllSessions,
  httpRequest,
  httpPost,
} from '../fetch/http-client.js';
import { promises as dns } from 'dns';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockDnsIPv4Only(ipv4: string): void {
  vi.mocked(dns.resolve4).mockResolvedValue([ipv4]);
  vi.mocked(dns.resolve6).mockRejectedValue(new Error('no AAAA'));
}

function mockDnsPublic(): void {
  mockDnsIPv4Only('93.184.216.34');
}

function mockOkResponse() {
  return {
    ok: true,
    statusCode: 200,
    text: '<html>OK</html>',
    headers: { 'content-type': 'text/html' },
    cookies: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('http-client integration', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockSessionOptions.length = 0;
    await closeAllSessions();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── SSRF edge cases not covered elsewhere ─────────────────────────────

  describe('SSRF: IPv4-mapped IPv6 with public IP', () => {
    it('allows ::ffff:93.184.216.34 (public IPv4-mapped IPv6)', async () => {
      vi.mocked(dns.resolve4).mockRejectedValue(new Error('no A'));
      vi.mocked(dns.resolve6).mockResolvedValue(['::ffff:93.184.216.34']);

      const result = await validateSSRF('https://example.com/page');
      expect(result).toContain('::ffff:93.184.216.34');
    });

    it('allows ::ffff:8.8.8.8 (Google DNS as IPv4-mapped)', async () => {
      vi.mocked(dns.resolve4).mockRejectedValue(new Error('no A'));
      vi.mocked(dns.resolve6).mockResolvedValue(['::ffff:8.8.8.8']);

      const result = await validateSSRF('https://example.com/page');
      expect(result).toContain('::ffff:8.8.8.8');
    });

    it('blocks ::ffff:10.0.0.1 (private IPv4-mapped IPv6)', async () => {
      vi.mocked(dns.resolve4).mockRejectedValue(new Error('no A'));
      vi.mocked(dns.resolve6).mockResolvedValue(['::ffff:10.0.0.1']);

      await expect(validateSSRF('https://example.com/page')).rejects.toThrow('SSRF protection');
    });

    it('blocks ::ffff:192.168.0.1 (private IPv4-mapped IPv6)', async () => {
      vi.mocked(dns.resolve4).mockRejectedValue(new Error('no A'));
      vi.mocked(dns.resolve6).mockResolvedValue(['::ffff:192.168.0.1']);

      await expect(validateSSRF('https://example.com/page')).rejects.toThrow('SSRF protection');
    });

    it('blocks ::ffff:169.254.1.1 (link-local IPv4-mapped IPv6)', async () => {
      vi.mocked(dns.resolve4).mockRejectedValue(new Error('no A'));
      vi.mocked(dns.resolve6).mockResolvedValue(['::ffff:169.254.1.1']);

      await expect(validateSSRF('https://example.com/page')).rejects.toThrow('SSRF protection');
    });
  });

  describe('SSRF: unspecified address (::)', () => {
    it('blocks :: (IPv6 unspecified address)', async () => {
      vi.mocked(dns.resolve4).mockRejectedValue(new Error('no A'));
      vi.mocked(dns.resolve6).mockResolvedValue(['::']);

      await expect(validateSSRF('https://example.com/page')).rejects.toThrow('SSRF protection');
    });
  });

  describe('SSRF: public IPs allowed', () => {
    it('allows 8.8.8.8 (Google DNS)', async () => {
      mockDnsIPv4Only('8.8.8.8');
      const result = await validateSSRF('https://example.com/page');
      expect(result).toEqual(['8.8.8.8']);
    });

    it('allows 1.1.1.1 (Cloudflare DNS)', async () => {
      mockDnsIPv4Only('1.1.1.1');
      const result = await validateSSRF('https://example.com/page');
      expect(result).toEqual(['1.1.1.1']);
    });

    it('allows 2606:4700::1 (public IPv6)', async () => {
      vi.mocked(dns.resolve4).mockRejectedValue(new Error('no A'));
      vi.mocked(dns.resolve6).mockResolvedValue(['2606:4700::1']);

      const result = await validateSSRF('https://example.com/page');
      expect(result).toEqual(['2606:4700::1']);
    });
  });

  describe('SSRF: IPv4 private range boundaries', () => {
    it('blocks 172.16.0.1 (start of 172.16-31 range)', async () => {
      mockDnsIPv4Only('172.16.0.1');
      await expect(validateSSRF('https://example.com')).rejects.toThrow('SSRF protection');
    });

    it('blocks 172.31.255.254 (end of 172.16-31 range)', async () => {
      mockDnsIPv4Only('172.31.255.254');
      await expect(validateSSRF('https://example.com')).rejects.toThrow('SSRF protection');
    });

    it('allows 172.32.0.1 (just outside 172.16-31 range)', async () => {
      mockDnsIPv4Only('172.32.0.1');
      const result = await validateSSRF('https://example.com');
      expect(result).toEqual(['172.32.0.1']);
    });

    it('allows 172.15.255.254 (just before 172.16-31 range)', async () => {
      mockDnsIPv4Only('172.15.255.254');
      const result = await validateSSRF('https://example.com');
      expect(result).toEqual(['172.15.255.254']);
    });
  });

  describe('SSRF: IP literal hostnames bypass DNS', () => {
    it('validates IPv4 literal directly without DNS', async () => {
      // Requesting http://93.184.216.34/ — isIP() returns true, no DNS needed
      const result = await validateSSRF('http://93.184.216.34/page');

      expect(result).toEqual(['93.184.216.34']);
      // DNS should NOT be called for IP literals
      expect(dns.resolve4).not.toHaveBeenCalled();
      expect(dns.resolve6).not.toHaveBeenCalled();
    });

    it('blocks private IPv4 literal without DNS', async () => {
      await expect(validateSSRF('http://127.0.0.1/page')).rejects.toThrow(
        'SSRF protection: hostname 127.0.0.1 is a private IP'
      );
      expect(dns.resolve4).not.toHaveBeenCalled();
    });

    it('blocks private IPv4 10.x literal without DNS', async () => {
      await expect(validateSSRF('http://10.0.0.1/')).rejects.toThrow(
        'SSRF protection: hostname 10.0.0.1 is a private IP'
      );
      expect(dns.resolve4).not.toHaveBeenCalled();
    });

    it('blocks private IPv4 192.168.x literal without DNS', async () => {
      await expect(validateSSRF('http://192.168.1.1/')).rejects.toThrow(
        'SSRF protection: hostname 192.168.1.1 is a private IP'
      );
      expect(dns.resolve4).not.toHaveBeenCalled();
    });
  });

  // ── Proxy validation gaps ─────────────────────────────────────────────

  describe('validateProxyUrl: additional scheme tests', () => {
    beforeEach(() => {
      mockDnsPublic();
    });

    it('rejects file:// proxy scheme', async () => {
      await expect(validateProxyUrl('file:///etc/passwd')).rejects.toThrow('Invalid proxy scheme');
    });

    it('rejects data: proxy scheme', async () => {
      await expect(validateProxyUrl('data:text/plain,hello')).rejects.toThrow(
        'Invalid proxy scheme'
      );
    });
  });

  describe('validateProxyUrl: DNS-resolved private proxy', () => {
    it('rejects proxy hostname resolving to private IP via DNS', async () => {
      // Proxy URL has a valid hostname but DNS resolves to a private IP
      vi.mocked(dns.resolve4).mockResolvedValue(['192.168.1.1']);
      vi.mocked(dns.resolve6).mockRejectedValue(new Error('no AAAA'));

      await expect(validateProxyUrl('http://proxy.example.com:8080')).rejects.toThrow(
        'SSRF protection'
      );
    });

    it('rejects proxy hostname resolving to 10.x via DNS', async () => {
      vi.mocked(dns.resolve4).mockResolvedValue(['10.0.0.1']);
      vi.mocked(dns.resolve6).mockRejectedValue(new Error('no AAAA'));

      await expect(validateProxyUrl('http://proxy.example.com:3128')).rejects.toThrow(
        'SSRF protection'
      );
    });

    it('rejects proxy hostname resolving to localhost via DNS', async () => {
      vi.mocked(dns.resolve4).mockResolvedValue(['127.0.0.1']);
      vi.mocked(dns.resolve6).mockRejectedValue(new Error('no AAAA'));

      await expect(validateProxyUrl('http://proxy.example.com:8080')).rejects.toThrow(
        'SSRF protection'
      );
    });
  });

  describe('redactProxyUrl: additional cases', () => {
    it('redacts only username when no password', () => {
      const result = redactProxyUrl('http://admin@proxy.example.com:8080');
      expect(result).not.toContain('admin');
      expect(result).toContain('***');
      expect(result).toContain('proxy.example.com');
    });

    it('preserves port and path', () => {
      const result = redactProxyUrl('http://user:pass@proxy.example.com:3128/path');
      expect(result).toContain(':3128');
      expect(result).toContain('/path');
      expect(result).not.toContain('pass');
    });

    it('handles socks5 URL with credentials', () => {
      const result = redactProxyUrl('socks5://user:secret@proxy.example.com:1080');
      expect(result).not.toContain('secret');
      expect(result).toContain('socks5://');
    });
  });

  // ── Session management gaps ───────────────────────────────────────────

  describe('Session cache keying by preset', () => {
    it('returns different sessions for different presets', async () => {
      const session1 = await getSession('chrome_143');
      const session2 = await getSession('firefox_133');

      expect(session1).not.toBe(session2);
      expect(mockSessionOptions.length).toBe(2);
      expect(mockSessionOptions[0]).toEqual(expect.objectContaining({ preset: 'chrome_143' }));
      expect(mockSessionOptions[1]).toEqual(expect.objectContaining({ preset: 'firefox_133' }));
    });

    it('reuses session for same preset', async () => {
      const session1 = await getSession('chrome_143');
      const session2 = await getSession('chrome_143');

      expect(session1).toBe(session2);
      expect(mockSessionOptions.length).toBe(1);
    });

    it('session key includes both preset and proxy', async () => {
      const s1 = await getSession('chrome_143');
      const s2 = await getSession('chrome_143', 'http://proxy.example.com:8080');
      const s3 = await getSession('firefox_133', 'http://proxy.example.com:8080');

      // All three should be different sessions
      expect(s1).not.toBe(s2);
      expect(s2).not.toBe(s3);
      expect(s1).not.toBe(s3);
      expect(mockSessionOptions.length).toBe(3);
    });
  });

  describe('httpPost Content-Type and body passing', () => {
    beforeEach(() => {
      mockDnsPublic();
    });

    it('sets Content-Type to application/x-www-form-urlencoded', async () => {
      mockPost.mockResolvedValue(mockOkResponse());

      await httpPost('https://example.com/api', { key: 'value' });

      const callOpts = mockPost.mock.calls[0][1];
      expect(callOpts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    });

    it('passes form data as body object', async () => {
      mockPost.mockResolvedValue(mockOkResponse());

      await httpPost('https://example.com/api', {
        action: 'get_content',
        'data[id]': '42',
        token: 'abc=def',
      });

      const callOpts = mockPost.mock.calls[0][1];
      expect(callOpts.body).toEqual({
        action: 'get_content',
        'data[id]': '42',
        token: 'abc=def',
      });
    });

    it('POST custom headers merge with Content-Type', async () => {
      mockPost.mockResolvedValue(mockOkResponse());

      await httpPost(
        'https://example.com/api',
        { action: 'test' },
        { 'X-Requested-With': 'XMLHttpRequest' }
      );

      const callOpts = mockPost.mock.calls[0][1];
      expect(callOpts.headers).toEqual({
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
      });
    });
  });

  // ── httpRequest through SSRF validation ───────────────────────────────

  describe('httpRequest SSRF integration', () => {
    it('blocks request to IPv4 literal private IP', async () => {
      const result = await httpRequest('http://127.0.0.1/admin');

      expect(result.success).toBe(false);
      expect(result.error).toContain('SSRF protection');
      expect(result.statusCode).toBe(0);
      // httpcloak session.get should NOT have been called
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('blocks request to 10.x.x.x literal', async () => {
      const result = await httpRequest('http://10.0.0.1/internal');

      expect(result.success).toBe(false);
      expect(result.error).toContain('SSRF protection');
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('blocks request when DNS resolves to private IP', async () => {
      mockDnsIPv4Only('192.168.1.1');

      const result = await httpRequest('https://example.com/page');

      expect(result.success).toBe(false);
      expect(result.error).toContain('SSRF protection');
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('allows request when DNS resolves to public IP', async () => {
      mockDnsPublic();
      mockGet.mockResolvedValue(mockOkResponse());

      const result = await httpRequest('https://example.com/page');

      expect(result.success).toBe(true);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });
  });

  // ── Proxy SSRF through httpRequest ────────────────────────────────────

  describe('httpRequest with proxy SSRF', () => {
    it('rejects request when proxy URL resolves to private IP', async () => {
      // Target URL DNS is public, but proxy DNS resolves to private
      vi.mocked(dns.resolve4).mockImplementation((hostname: string) => {
        if (hostname === 'proxy.example.com') return Promise.resolve(['192.168.1.1']);
        return Promise.resolve(['93.184.216.34']);
      });
      vi.mocked(dns.resolve6).mockRejectedValue(new Error('no AAAA'));

      const result = await httpRequest(
        'https://example.com/page',
        {},
        undefined,
        undefined,
        'http://proxy.example.com:8080'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('SSRF protection');
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('rejects request when proxy has invalid scheme', async () => {
      mockDnsPublic();

      const result = await httpRequest(
        'https://example.com/page',
        {},
        undefined,
        undefined,
        'ftp://proxy.example.com:21'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid proxy scheme');
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  // ── DNS edge cases through httpRequest ────────────────────────────────

  describe('DNS edge cases through httpRequest', () => {
    it('handles DNS returning both IPv4 and IPv6 (both public)', async () => {
      vi.mocked(dns.resolve4).mockResolvedValue(['93.184.216.34']);
      vi.mocked(dns.resolve6).mockResolvedValue(['2606:2800:220:1:248:1893:25c8:1946']);
      mockGet.mockResolvedValue(mockOkResponse());

      const result = await httpRequest('https://example.com/page');
      expect(result.success).toBe(true);
    });

    it('blocks when IPv4 is public but IPv6 is private', async () => {
      vi.mocked(dns.resolve4).mockResolvedValue(['93.184.216.34']);
      vi.mocked(dns.resolve6).mockResolvedValue(['::1']);

      const result = await httpRequest('https://example.com/page');
      expect(result.success).toBe(false);
      expect(result.error).toContain('SSRF protection');
    });

    it('handles DNS failure gracefully (fail closed)', async () => {
      vi.mocked(dns.resolve4).mockRejectedValue(new Error('SERVFAIL'));
      vi.mocked(dns.resolve6).mockRejectedValue(new Error('SERVFAIL'));

      const result = await httpRequest('https://example.com/page');
      expect(result.success).toBe(false);
      expect(result.error).toContain('DNS resolution');
    });
  });
});
