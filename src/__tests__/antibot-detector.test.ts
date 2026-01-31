import { describe, it, expect } from 'vitest';
import {
  detectFromResponse,
  detectFromHtml,
  detectFromWindowResults,
  detectPrimaryAntibot,
  formatDetections,
  getWindowObjectChecks,
  mergeDetections,
  filterAntibotOnly,
  filterCaptchaOnly,
  filterFingerprintOnly,
  filterBotDetectionOnly,
  hasCaptcha,
  hasAntibot,
  hasFingerprinting,
  hasBotDetection,
  type AntibotDetection,
} from '../antibot/detector.js';

describe('antibot-detector', () => {
  describe('detectFromResponse', () => {
    it('detects AWS WAF from headers', () => {
      const detections = detectFromResponse(
        { 'x-amzn-waf-action': 'block', 'content-type': 'text/html' },
        []
      );

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('aws-waf');
      expect(detections[0].confidence).toBe(100);
      expect(detections[0].suggestedAction).toBe('retry-tls');
      expect(detections[0].evidence).toContain('header: x-amzn-waf-action');
    });

    it('detects AWS WAF from cookies', () => {
      const detections = detectFromResponse({}, ['aws-waf-token=abc123; Path=/; Secure']);

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('aws-waf');
      expect(detections[0].confidence).toBe(95);
      expect(detections[0].evidence).toContain('cookie: aws-waf-token');
    });

    it('detects Cloudflare from cookies', () => {
      const detections = detectFromResponse({ 'cf-ray': '123abc' }, ['__cf_bm=xyz; Path=/']);

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('cloudflare');
      expect(detections[0].name).toBe('Cloudflare Bot Management');
      expect(detections[0].suggestedAction).toBe('give-up');
    });

    it('detects PerimeterX from cookies', () => {
      const detections = detectFromResponse({}, ['_px3=abc123; Path=/']);

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('perimeterx');
      expect(detections[0].confidence).toBe(100);
      expect(detections[0].suggestedAction).toBe('try-archive');
    });

    it('detects DataDome from headers and cookies', () => {
      const detections = detectFromResponse({ 'x-datadome-cid': '123' }, ['datadome=xyz']);

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('datadome');
      expect(detections[0].confidence).toBe(100);
      expect(detections[0].evidence).toHaveLength(2);
    });

    it('detects Akamai from cookies', () => {
      const detections = detectFromResponse({}, ['_abck=abc; Path=/', 'ak_bmsc=xyz; Path=/']);

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('akamai');
      expect(detections[0].confidence).toBe(100);
      expect(detections[0].suggestedAction).toBe('retry-tls');
    });

    it('detects Incapsula from cookies', () => {
      const detections = detectFromResponse({}, [
        'incap_ses_123=abc; Path=/',
        'visid_incap_456=xyz; Path=/',
      ]);

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('incapsula');
      expect(detections[0].confidence).toBe(100);
      expect(detections[0].suggestedAction).toBe('retry-headers');
    });

    it('detects Shape Security from dynamic headers', () => {
      const detections = detectFromResponse(
        { 'x-abcd1234-a': 'value', 'x-abcd1234-b': 'value2' },
        []
      );

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('shape-security');
      expect(detections[0].confidence).toBe(100);
      expect(detections[0].suggestedAction).toBe('try-archive');
    });

    it('detects Kasada from headers', () => {
      const detections = detectFromResponse({ 'x-kasada': 'enabled' }, []);

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('kasada');
      expect(detections[0].suggestedAction).toBe('try-archive');
    });

    it('detects multiple protections', () => {
      // Cloudflare CDN + PerimeterX bot detection (common stack)
      const detections = detectFromResponse({ 'cf-ray': '123abc' }, [
        '__cf_bm=xyz; Path=/',
        '_px3=abc; Path=/',
      ]);

      expect(detections).toHaveLength(2);
      // Both should be detected
      const providers = detections.map((d) => d.provider);
      expect(providers).toContain('cloudflare');
      expect(providers).toContain('perimeterx');
    });

    it('returns empty array when no protection detected', () => {
      const detections = detectFromResponse({ 'content-type': 'text/html', server: 'nginx' }, [
        'session=abc123',
      ]);

      expect(detections).toHaveLength(0);
    });

    it('sorts detections by confidence (highest first)', () => {
      // Create a scenario with multiple detections at different confidence levels
      const detections = detectFromResponse(
        { 'cf-ray': '123' }, // Cloudflare cf-ray is 80% confidence
        ['_px3=abc'] // PerimeterX _px3 is 100% confidence
      );

      expect(detections).toHaveLength(2);
      expect(detections[0].provider).toBe('perimeterx'); // 100% first
      expect(detections[1].provider).toBe('cloudflare'); // 80% second
    });

    it('handles case-insensitive header matching', () => {
      const detections = detectFromResponse({ 'X-AMZN-WAF-ACTION': 'block' }, []);

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('aws-waf');
    });

    it('handles partial cookie name matching', () => {
      // awswaf* pattern should match awswaf_12345
      const detections = detectFromResponse({}, ['awswaf_session_12345=abc; Path=/']);

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('aws-waf');
    });
  });

  describe('detectPrimaryAntibot', () => {
    it('returns the highest confidence detection', () => {
      const detection = detectPrimaryAntibot({ 'cf-ray': '123' }, ['_px3=abc']);

      expect(detection).not.toBeNull();
      expect(detection!.provider).toBe('perimeterx');
    });

    it('returns null when no protection detected', () => {
      const detection = detectPrimaryAntibot({ 'content-type': 'text/html' }, []);

      expect(detection).toBeNull();
    });
  });

  describe('formatDetections', () => {
    it('formats empty detections', () => {
      const result = formatDetections([]);
      expect(result).toBe('No anti-bot protection detected');
    });

    it('formats single detection', () => {
      const detections: AntibotDetection[] = [
        {
          provider: 'aws-waf',
          name: 'AWS WAF',
          category: 'antibot',
          confidence: 95,
          evidence: ['cookie: aws-waf-token'],
          suggestedAction: 'retry-tls',
        },
      ];

      const result = formatDetections(detections);
      expect(result).toContain('AWS WAF');
      expect(result).toContain('95%');
      expect(result).toContain('retry-tls');
      expect(result).toContain('cookie: aws-waf-token');
    });

    it('formats multiple detections', () => {
      const detections: AntibotDetection[] = [
        {
          provider: 'perimeterx',
          name: 'PerimeterX (HUMAN)',
          category: 'antibot',
          confidence: 100,
          evidence: ['cookie: _px3'],
          suggestedAction: 'try-archive',
        },
        {
          provider: 'cloudflare',
          name: 'Cloudflare Bot Management',
          category: 'antibot',
          confidence: 80,
          evidence: ['header: cf-ray'],
          suggestedAction: 'give-up',
        },
      ];

      const result = formatDetections(detections);
      expect(result).toContain('PerimeterX');
      expect(result).toContain('Cloudflare');
      expect(result).toContain(';'); // Separator between detections
    });
  });

  describe('detectFromHtml', () => {
    it('detects PerimeterX from HTML content', () => {
      const html = '<script>window._pxAppId = "PX12345";</script>';
      const detections = detectFromHtml(html);

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('perimeterx');
      expect(detections[0].confidence).toBe(100);
      expect(detections[0].evidence).toContain('content: PerimeterX app ID');
    });

    it('detects Cloudflare from HTML content', () => {
      const html = '<div id="cf-browser-verification">Checking your browser...</div>';
      const detections = detectFromHtml(html);

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('cloudflare');
      expect(detections[0].confidence).toBe(100);
    });

    it('detects Akamai from HTML content', () => {
      const html = '<script>bmak.sensor_data = "...";</script>';
      const detections = detectFromHtml(html);

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('akamai');
      expect(detections[0].evidence.some((e) => e.includes('Bot Manager API'))).toBe(true);
    });

    it('detects AWS WAF from challenge script', () => {
      const html = '<script src="/challenge.js"></script><div>awswaf challenge</div>';
      const detections = detectFromHtml(html);

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('aws-waf');
    });

    it('detects multiple systems from HTML', () => {
      const html = `
        <script>window._pxAppId = "test";</script>
        <script>bmak.init();</script>
      `;
      const detections = detectFromHtml(html);

      expect(detections.length).toBeGreaterThanOrEqual(2);
      const providers = detections.map((d) => d.provider);
      expect(providers).toContain('perimeterx');
      expect(providers).toContain('akamai');
    });

    it('returns empty array for clean HTML', () => {
      const html = '<html><body><h1>Hello World</h1></body></html>';
      const detections = detectFromHtml(html);

      expect(detections).toHaveLength(0);
    });

    it('handles case-insensitive matching', () => {
      const html = '<script>WINDOW._PXAPPID = "test";</script>';
      const detections = detectFromHtml(html);

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('perimeterx');
    });
  });

  describe('detectFromWindowResults', () => {
    it('detects PerimeterX from window object', () => {
      const results = [
        { path: '_pxAppId', exists: true },
        { path: 'bmak', exists: false },
      ];
      const detections = detectFromWindowResults(results);

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('perimeterx');
      expect(detections[0].confidence).toBe(100);
    });

    it('detects Akamai from window object', () => {
      const results = [{ path: 'bmak', exists: true }];
      const detections = detectFromWindowResults(results);

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('akamai');
    });

    it('detects Cloudflare from window object', () => {
      const results = [
        { path: '_cf_chl_opt', exists: true },
        { path: 'turnstile', exists: true },
      ];
      const detections = detectFromWindowResults(results);

      // Both Cloudflare (antibot) and Turnstile (captcha) match on 'turnstile'
      expect(detections).toHaveLength(2);
      const providers = detections.map((d) => d.provider);
      expect(providers).toContain('cloudflare');
      expect(providers).toContain('turnstile');
      // Cloudflare has 2 evidence items, Turnstile has 1
      const cfDetection = detections.find((d) => d.provider === 'cloudflare');
      expect(cfDetection!.evidence).toHaveLength(2);
    });

    it('detects multiple systems', () => {
      const results = [
        { path: '_pxAppId', exists: true },
        { path: 'bmak', exists: true },
        { path: '__kasada', exists: true },
      ];
      const detections = detectFromWindowResults(results);

      expect(detections).toHaveLength(3);
      const providers = detections.map((d) => d.provider);
      expect(providers).toContain('perimeterx');
      expect(providers).toContain('akamai');
      expect(providers).toContain('kasada');
    });

    it('returns empty array when no paths exist', () => {
      const results = [
        { path: '_pxAppId', exists: false },
        { path: 'bmak', exists: false },
      ];
      const detections = detectFromWindowResults(results);

      expect(detections).toHaveLength(0);
    });
  });

  describe('getWindowObjectChecks', () => {
    it('returns providers with window patterns', () => {
      const checks = getWindowObjectChecks();

      expect(checks.length).toBeGreaterThan(0);
      // Should include providers that have window patterns
      const providers = checks.map((c) => c.provider);
      expect(providers).toContain('cloudflare');
      expect(providers).toContain('perimeterx');
      expect(providers).toContain('akamai');
    });

    it('excludes providers without window patterns', () => {
      const checks = getWindowObjectChecks();
      const providers = checks.map((c) => c.provider);

      // AWS WAF has no window patterns
      expect(providers).not.toContain('aws-waf');
    });

    it('includes path details', () => {
      const checks = getWindowObjectChecks();
      const pxCheck = checks.find((c) => c.provider === 'perimeterx');

      expect(pxCheck).toBeDefined();
      expect(pxCheck!.paths.length).toBeGreaterThan(0);
      expect(pxCheck!.paths[0]).toHaveProperty('path');
      expect(pxCheck!.paths[0]).toHaveProperty('confidence');
    });
  });

  describe('mergeDetections', () => {
    it('merges detections from different sources', () => {
      const fromResponse: AntibotDetection[] = [
        {
          provider: 'perimeterx',
          name: 'PerimeterX (HUMAN)',
          category: 'antibot',
          confidence: 100,
          evidence: ['cookie: _px3'],
          suggestedAction: 'try-archive',
        },
      ];
      const fromHtml: AntibotDetection[] = [
        {
          provider: 'perimeterx',
          name: 'PerimeterX (HUMAN)',
          category: 'antibot',
          confidence: 95,
          evidence: ['content: PerimeterX app ID'],
          suggestedAction: 'try-archive',
        },
      ];

      const merged = mergeDetections(fromResponse, fromHtml);

      expect(merged).toHaveLength(1);
      expect(merged[0].provider).toBe('perimeterx');
      expect(merged[0].confidence).toBe(100); // Highest confidence
      expect(merged[0].evidence).toContain('cookie: _px3');
      expect(merged[0].evidence).toContain('content: PerimeterX app ID');
    });

    it('includes detections from all sources', () => {
      const fromResponse: AntibotDetection[] = [
        {
          provider: 'cloudflare',
          name: 'Cloudflare Bot Management',
          category: 'antibot',
          confidence: 80,
          evidence: ['header: cf-ray'],
          suggestedAction: 'give-up',
        },
      ];
      const fromHtml: AntibotDetection[] = [
        {
          provider: 'perimeterx',
          name: 'PerimeterX (HUMAN)',
          category: 'antibot',
          confidence: 100,
          evidence: ['content: PerimeterX app ID'],
          suggestedAction: 'try-archive',
        },
      ];

      const merged = mergeDetections(fromResponse, fromHtml);

      expect(merged).toHaveLength(2);
      expect(merged[0].provider).toBe('perimeterx'); // Higher confidence first
      expect(merged[1].provider).toBe('cloudflare');
    });

    it('handles empty arrays', () => {
      const merged = mergeDetections([], []);
      expect(merged).toHaveLength(0);
    });

    it('deduplicates evidence', () => {
      const arr1: AntibotDetection[] = [
        {
          provider: 'akamai',
          name: 'Akamai Bot Manager',
          category: 'antibot',
          confidence: 90,
          evidence: ['cookie: _abck'],
          suggestedAction: 'retry-tls',
        },
      ];
      const arr2: AntibotDetection[] = [
        {
          provider: 'akamai',
          name: 'Akamai Bot Manager',
          category: 'antibot',
          confidence: 95,
          evidence: ['cookie: _abck', 'content: bmak.'],
          suggestedAction: 'retry-tls',
        },
      ];

      const merged = mergeDetections(arr1, arr2);

      expect(merged).toHaveLength(1);
      expect(merged[0].evidence).toHaveLength(2); // Deduplicated
      expect(merged[0].confidence).toBe(95);
    });
  });

  describe('CAPTCHA detection', () => {
    it('detects reCAPTCHA from HTML content', () => {
      const html = '<script src="https://www.google.com/recaptcha/api.js"></script>';
      const detections = detectFromHtml(html);

      const recaptcha = detections.find((d) => d.provider === 'recaptcha');
      expect(recaptcha).toBeDefined();
      expect(recaptcha!.category).toBe('captcha');
      expect(recaptcha!.suggestedAction).toBe('solve-captcha');
    });

    it('detects hCaptcha from HTML content', () => {
      const html = '<div class="h-captcha" data-sitekey="abc"></div>';
      const detections = detectFromHtml(html);

      const hcaptcha = detections.find((d) => d.provider === 'hcaptcha');
      expect(hcaptcha).toBeDefined();
      expect(hcaptcha!.category).toBe('captcha');
      expect(hcaptcha!.suggestedAction).toBe('solve-captcha');
    });

    it('detects FunCaptcha/Arkose from cookies', () => {
      const detections = detectFromResponse({}, ['arkose_token=abc123; Path=/']);

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('funcaptcha');
      expect(detections[0].category).toBe('captcha');
      expect(detections[0].suggestedAction).toBe('try-archive');
    });

    it('detects GeeTest from headers', () => {
      const detections = detectFromResponse({ 'x-geetest-challenge': 'abc' }, []);

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('geetest');
      expect(detections[0].category).toBe('captcha');
    });

    it('detects Cloudflare Turnstile from HTML', () => {
      const html = '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>';
      const detections = detectFromHtml(html);

      const turnstile = detections.find((d) => d.provider === 'turnstile');
      expect(turnstile).toBeDefined();
      expect(turnstile!.category).toBe('captcha');
      expect(turnstile!.suggestedAction).toBe('give-up');
    });

    it('detects Friendly Captcha from HTML', () => {
      const html = '<div class="frc-captcha"></div>';
      const detections = detectFromHtml(html);

      const fc = detections.find((d) => d.provider === 'friendlycaptcha');
      expect(fc).toBeDefined();
      expect(fc!.category).toBe('captcha');
    });
  });

  describe('category filtering', () => {
    it('filterAntibotOnly excludes CAPTCHAs', () => {
      const mixed: AntibotDetection[] = [
        {
          provider: 'cloudflare',
          name: 'Cloudflare',
          category: 'antibot',
          confidence: 90,
          evidence: [],
          suggestedAction: 'give-up',
        },
        {
          provider: 'recaptcha',
          name: 'reCAPTCHA',
          category: 'captcha',
          confidence: 100,
          evidence: [],
          suggestedAction: 'solve-captcha',
        },
      ];

      const filtered = filterAntibotOnly(mixed);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].provider).toBe('cloudflare');
    });

    it('filterCaptchaOnly excludes anti-bot systems', () => {
      const mixed: AntibotDetection[] = [
        {
          provider: 'cloudflare',
          name: 'Cloudflare',
          category: 'antibot',
          confidence: 90,
          evidence: [],
          suggestedAction: 'give-up',
        },
        {
          provider: 'recaptcha',
          name: 'reCAPTCHA',
          category: 'captcha',
          confidence: 100,
          evidence: [],
          suggestedAction: 'solve-captcha',
        },
      ];

      const filtered = filterCaptchaOnly(mixed);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].provider).toBe('recaptcha');
    });

    it('hasCaptcha returns true when CAPTCHA detected', () => {
      const withCaptcha: AntibotDetection[] = [
        {
          provider: 'hcaptcha',
          name: 'hCaptcha',
          category: 'captcha',
          confidence: 100,
          evidence: [],
          suggestedAction: 'solve-captcha',
        },
      ];
      const withoutCaptcha: AntibotDetection[] = [
        {
          provider: 'akamai',
          name: 'Akamai',
          category: 'antibot',
          confidence: 100,
          evidence: [],
          suggestedAction: 'retry-tls',
        },
      ];

      expect(hasCaptcha(withCaptcha)).toBe(true);
      expect(hasCaptcha(withoutCaptcha)).toBe(false);
    });

    it('hasAntibot returns true when anti-bot detected', () => {
      const withAntibot: AntibotDetection[] = [
        {
          provider: 'perimeterx',
          name: 'PerimeterX',
          category: 'antibot',
          confidence: 100,
          evidence: [],
          suggestedAction: 'try-archive',
        },
      ];
      const withoutAntibot: AntibotDetection[] = [
        {
          provider: 'recaptcha',
          name: 'reCAPTCHA',
          category: 'captcha',
          confidence: 100,
          evidence: [],
          suggestedAction: 'solve-captcha',
        },
      ];

      expect(hasAntibot(withAntibot)).toBe(true);
      expect(hasAntibot(withoutAntibot)).toBe(false);
    });

    it('filterFingerprintOnly returns only fingerprint detections', () => {
      const mixed: AntibotDetection[] = [
        {
          provider: 'cloudflare',
          name: 'Cloudflare',
          category: 'antibot',
          confidence: 90,
          evidence: [],
          suggestedAction: 'give-up',
        },
        {
          provider: 'fp-canvas',
          name: 'Canvas Fingerprinting',
          category: 'fingerprint',
          confidence: 50,
          evidence: [],
          suggestedAction: 'unknown',
        },
      ];
      const filtered = filterFingerprintOnly(mixed);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].provider).toBe('fp-canvas');
    });

    it('hasFingerprinting returns true when fingerprinting detected', () => {
      const withFp: AntibotDetection[] = [
        {
          provider: 'fp-webgl',
          name: 'WebGL Fingerprinting',
          category: 'fingerprint',
          confidence: 80,
          evidence: [],
          suggestedAction: 'unknown',
        },
      ];
      expect(hasFingerprinting(withFp)).toBe(true);
      expect(hasFingerprinting([])).toBe(false);
    });

    it('filterBotDetectionOnly returns only bot-detection detections', () => {
      const mixed: AntibotDetection[] = [
        {
          provider: 'cloudflare',
          name: 'Cloudflare',
          category: 'antibot',
          confidence: 90,
          evidence: [],
          suggestedAction: 'give-up',
        },
        {
          provider: 'bd-webdriver',
          name: 'Webdriver Detection',
          category: 'bot-detection',
          confidence: 75,
          evidence: [],
          suggestedAction: 'unknown',
        },
      ];
      const filtered = filterBotDetectionOnly(mixed);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].provider).toBe('bd-webdriver');
    });

    it('hasBotDetection returns true when bot-detection detected', () => {
      const withBd: AntibotDetection[] = [
        {
          provider: 'bd-webdriver',
          name: 'Webdriver Detection',
          category: 'bot-detection',
          confidence: 75,
          evidence: [],
          suggestedAction: 'unknown',
        },
      ];
      expect(hasBotDetection(withBd)).toBe(true);
      expect(hasBotDetection([])).toBe(false);
    });
  });

  describe('fingerprint technique detection', () => {
    it('detects Canvas fingerprinting from toDataURL', () => {
      const html = '<script>var fp = canvas.toDataURL("image/png");</script>';
      const detections = detectFromHtml(html);
      const canvas = detections.find((d) => d.provider === 'fp-canvas');
      expect(canvas).toBeDefined();
      expect(canvas!.category).toBe('fingerprint');
    });

    it('detects WebGL fingerprinting from WEBGL_debug_renderer_info', () => {
      const html = '<script>gl.getExtension("WEBGL_debug_renderer_info")</script>';
      const detections = detectFromHtml(html);
      const webgl = detections.find((d) => d.provider === 'fp-webgl');
      expect(webgl).toBeDefined();
      expect(webgl!.confidence).toBe(80);
    });

    it('detects Audio fingerprinting from OfflineAudioContext', () => {
      const html = '<script>new OfflineAudioContext(1, 44100, 44100)</script>';
      const detections = detectFromHtml(html);
      const audio = detections.find((d) => d.provider === 'fp-audio');
      expect(audio).toBeDefined();
    });

    it('detects WebRTC fingerprinting from RTCPeerConnection', () => {
      const html = '<script>new RTCPeerConnection({}).createDataChannel("")</script>';
      const detections = detectFromHtml(html);
      const webrtc = detections.find((d) => d.provider === 'fp-webrtc');
      expect(webrtc).toBeDefined();
    });

    it('detects Hardware fingerprinting from multiple signals', () => {
      const html = '<script>navigator.hardwareConcurrency + navigator.deviceMemory</script>';
      const detections = detectFromHtml(html);
      const hw = detections.find((d) => d.provider === 'fp-hardware');
      expect(hw).toBeDefined();
      expect(hw!.evidence.length).toBeGreaterThanOrEqual(2);
    });

    it('detects multiple fingerprint techniques in one page', () => {
      const html = `<script>
        canvas.toDataURL();
        new OfflineAudioContext(1, 44100, 44100);
        navigator.hardwareConcurrency;
        gl.getExtension('WEBGL_debug_renderer_info');
      </script>`;
      const detections = detectFromHtml(html);
      const fpDetections = detections.filter((d) => d.provider.startsWith('fp-'));
      expect(fpDetections.length).toBeGreaterThanOrEqual(3);
    });

    it('does not detect fingerprinting in clean HTML', () => {
      const html = '<html><body><h1>Hello World</h1></body></html>';
      const detections = detectFromHtml(html);
      expect(detections).toHaveLength(0);
    });

    it('all fp-* signatures use unknown suggestedAction', () => {
      const html = `<script>
        canvas.toDataURL();
        new OfflineAudioContext(1, 44100, 44100);
        navigator.hardwareConcurrency;
      </script>`;
      const detections = detectFromHtml(html);
      const fpDetections = detections.filter((d) => d.provider.startsWith('fp-'));
      for (const d of fpDetections) {
        expect(d.suggestedAction).toBe('unknown');
      }
    });
  });

  describe('bot-detection technique detection', () => {
    it('detects webdriver check from navigator.webdriver', () => {
      const html = '<script>if(navigator.webdriver){window.isBot=true}</script>';
      const detections = detectFromHtml(html);
      const wd = detections.find((d) => d.provider === 'bd-webdriver');
      expect(wd).toBeDefined();
      expect(wd!.category).toBe('bot-detection');
      expect(wd!.confidence).toBe(75);
    });

    it('detects chrome object presence check', () => {
      const html = "<script>if(!('chrome' in window)){flag()}</script>";
      const detections = detectFromHtml(html);
      const co = detections.find((d) => d.provider === 'bd-chrome-obj');
      expect(co).toBeDefined();
      expect(co!.category).toBe('bot-detection');
    });

    it('detects Function.toString tampering check', () => {
      const html = '<script>Function.prototype.toString.call(navigator.webdriver)</script>';
      const detections = detectFromHtml(html);
      const fn = detections.find((d) => d.provider === 'bd-fn-tostring');
      expect(fn).toBeDefined();
    });

    it('detects chrome.runtime tampering check', () => {
      const html = '<script>chrome.runtime.sendMessage("test")</script>';
      const detections = detectFromHtml(html);
      const cr = detections.find((d) => d.provider === 'bd-chrome-runtime');
      expect(cr).toBeDefined();
    });

    it('detects MIME types enumeration', () => {
      const html = '<script>var m = navigator.mimeTypes.length;</script>';
      const detections = detectFromHtml(html);
      const mt = detections.find((d) => d.provider === 'bd-mimetypes');
      expect(mt).toBeDefined();
    });

    it('detects permissions API probing', () => {
      const html = '<script>navigator.permissions.query({name:"notifications"})</script>';
      const detections = detectFromHtml(html);
      const p = detections.find((d) => d.provider === 'bd-permissions');
      expect(p).toBeDefined();
    });

    it('detects connection API probing', () => {
      const html = '<script>var c = navigator.connection.effectiveType;</script>';
      const detections = detectFromHtml(html);
      const conn = detections.find((d) => d.provider === 'bd-connection');
      expect(conn).toBeDefined();
    });

    it('detects multiple bot-detection techniques in one page', () => {
      const html = `<script>
        if(navigator.webdriver) return;
        if(!('chrome' in window)) return;
        Function.prototype.toString.call(eval);
        navigator.mimeTypes.length;
      </script>`;
      const detections = detectFromHtml(html);
      const bdDetections = detections.filter((d) => d.provider.startsWith('bd-'));
      expect(bdDetections).toHaveLength(4);
    });

    it('does not detect bot-detection in clean HTML', () => {
      const html = '<html><body><h1>Hello World</h1></body></html>';
      const detections = detectFromHtml(html);
      const bdDetections = detections.filter((d) => d.provider.startsWith('bd-'));
      expect(bdDetections).toHaveLength(0);
    });

    it('all bd-* signatures use unknown suggestedAction', () => {
      const html = `<script>
        navigator.webdriver;
        navigator.mimeTypes;
        Function.prototype.toString;
      </script>`;
      const detections = detectFromHtml(html);
      const bdDetections = detections.filter((d) => d.provider.startsWith('bd-'));
      for (const d of bdDetections) {
        expect(d.suggestedAction).toBe('unknown');
      }
    });
  });

  describe('DataDome enhanced detection', () => {
    it('should detect DataDome from dd_ session cookie', () => {
      const detections = detectFromResponse({}, ['dd_session_abc123=xyz; Path=/']);

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('datadome');
      expect(detections[0].confidence).toBeGreaterThanOrEqual(90);
    });

    it('should detect DataDome from x-datadome header', () => {
      const detections = detectFromResponse({ 'x-datadome': 'challenge' }, []);

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('datadome');
      expect(detections[0].confidence).toBeGreaterThanOrEqual(95);
    });

    it('should detect DataDome from window.dataDomeOptions in HTML', () => {
      const html = '<script>window.dataDomeOptions = {ajaxListenerPath: true}</script>';
      const detections = detectFromHtml(html);

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('datadome');
      expect(detections[0].confidence).toBeGreaterThanOrEqual(95);
    });

    it('should detect DataDome CAPTCHA from captcha.datadome.co', () => {
      const html = '<iframe src="https://captcha.datadome.co/captcha/"></iframe>';
      const detections = detectFromHtml(html);

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('datadome');
      expect(detections[0].confidence).toBe(100);
    });

    it('should detect DataDome from geo.captcha-delivery.com', () => {
      const html = '<script src="https://geo.captcha-delivery.com/captcha.js"></script>';
      const detections = detectFromHtml(html);

      expect(detections).toHaveLength(1);
      expect(detections[0].provider).toBe('datadome');
      expect(detections[0].confidence).toBeGreaterThanOrEqual(90);
    });
  });
});
