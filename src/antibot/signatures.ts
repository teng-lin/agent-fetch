import type { SuggestedAction, DetectionCategory } from './detector.js';

export interface CookiePattern {
  name: string;
  nameRegex?: boolean;
  confidence: number;
}

export interface HeaderPattern {
  name: string;
  nameRegex?: boolean;
  confidence: number;
}

export interface ContentPattern {
  text: string;
  textRegex?: boolean;
  confidence: number;
  description?: string;
}

export interface WindowPattern {
  path: string;
  confidence: number;
  description?: string;
}

export interface AntibotSignature {
  id: string;
  name: string;
  category: DetectionCategory;
  cookies: CookiePattern[];
  headers: HeaderPattern[];
  content: ContentPattern[];
  window: WindowPattern[];
  suggestedAction: SuggestedAction;
}

/**
 * Detection signatures for known anti-bot systems, CAPTCHAs, and fingerprinting techniques
 * Extracted from scrapfly/Antibot-Detector detector JSON files
 */
export const SIGNATURES: AntibotSignature[] = [
  // ==================== ANTI-BOT SYSTEMS ====================

  // AWS WAF - TLS fingerprint spoofing usually works
  {
    id: 'aws-waf',
    name: 'AWS WAF',
    category: 'antibot',
    suggestedAction: 'retry-tls',
    cookies: [
      { name: 'aws-waf-token', confidence: 95 },
      { name: 'awswaf', confidence: 90 },
    ],
    headers: [
      { name: 'x-amzn-waf-action', confidence: 100 },
      { name: 'x-amzn-requestid', confidence: 70 },
    ],
    content: [
      { text: 'challenge.js', confidence: 80, description: 'AWS WAF challenge script' },
      { text: 'awswaf', confidence: 85, description: 'AWS WAF reference' },
    ],
    window: [],
  },

  // Cloudflare - Difficult, may need real browser
  {
    id: 'cloudflare',
    name: 'Cloudflare Bot Management',
    category: 'antibot',
    suggestedAction: 'give-up',
    cookies: [
      { name: '__cf_bm', confidence: 95 },
      { name: 'cf_clearance', confidence: 100 },
      { name: '_cfuvid', confidence: 85 },
    ],
    headers: [
      { name: 'cf-ray', confidence: 80 },
      { name: 'cf-cache-status', confidence: 60 },
      { name: 'cf-mitigated', confidence: 100 },
    ],
    content: [
      { text: 'cf-browser-verification', confidence: 100, description: 'Cloudflare verification' },
      { text: 'turnstile.render', confidence: 100, description: 'Turnstile CAPTCHA' },
      { text: '__cf_chl_ctx', confidence: 90, description: 'Cloudflare challenge context' },
    ],
    window: [
      { path: '_cf_chl_opt', confidence: 95, description: 'Cloudflare challenge options' },
      { path: 'turnstile', confidence: 95, description: 'Cloudflare Turnstile' },
    ],
  },

  // PerimeterX - Very difficult, route to archive
  {
    id: 'perimeterx',
    name: 'PerimeterX (HUMAN)',
    category: 'antibot',
    suggestedAction: 'try-archive',
    cookies: [
      { name: '_px2', confidence: 95 },
      { name: '_px3', confidence: 100 },
      { name: '_pxhd', confidence: 90 },
      { name: '_pxvid', confidence: 85 },
    ],
    headers: [
      { name: 'x-px-authorization', confidence: 100 },
      { name: 'x-px-original-token', confidence: 95 },
    ],
    content: [
      { text: 'window._pxAppId', confidence: 100, description: 'PerimeterX app ID' },
      { text: 'pxInit', confidence: 95, description: 'PerimeterX initialization' },
      { text: '_pxAction', confidence: 90, description: 'PerimeterX action' },
    ],
    window: [
      { path: '_pxAppId', confidence: 100, description: 'PerimeterX application ID' },
      { path: 'pxInit', confidence: 95, description: 'PerimeterX init function' },
      { path: '_pxAction', confidence: 90, description: 'PerimeterX action identifier' },
    ],
  },

  // DataDome - Very difficult, route to archive
  {
    id: 'datadome',
    name: 'DataDome',
    category: 'antibot',
    suggestedAction: 'try-archive',
    cookies: [
      { name: 'datadome', confidence: 100 },
      { name: 'dd_', confidence: 90 }, // Session cookies like dd_session_*
    ],
    headers: [
      { name: 'x-datadome-cid', confidence: 100 },
      { name: 'x-datadome', confidence: 95 },
    ],
    content: [
      { text: 'window.dataDomeOptions', confidence: 95, description: 'DataDome options object' },
      { text: 'captcha.datadome.co', confidence: 100, description: 'DataDome CAPTCHA service' },
      {
        text: 'geo.captcha-delivery.com',
        confidence: 90,
        description: 'DataDome delivery network',
      },
      { text: 'datadome.co/js/', confidence: 85, description: 'DataDome JS SDK' },
    ],
    window: [
      { path: 'dataDomeOptions', confidence: 100, description: 'DataDome configuration' },
      { path: 'ddCaptcha', confidence: 95, description: 'DataDome CAPTCHA object' },
    ],
  },

  // Akamai - TLS fingerprint spoofing may help
  {
    id: 'akamai',
    name: 'Akamai Bot Manager',
    category: 'antibot',
    suggestedAction: 'retry-tls',
    cookies: [
      { name: '_abck', confidence: 100 },
      { name: 'ak_bmsc', confidence: 90 },
      { name: 'sbsd', confidence: 95 },
      { name: 'sbsd_o', confidence: 95 },
      { name: 'bm_sz', confidence: 80 },
      { name: 'bm_sv', confidence: 75 },
      { name: 'bm_mi', confidence: 70 },
    ],
    headers: [],
    content: [
      { text: 'ak_bmsc', confidence: 80, description: 'Akamai session cookie ref' },
      { text: '_abck', confidence: 85, description: 'Akamai bot cookie ref' },
      { text: 'bmak.', confidence: 90, description: 'Bot Manager API namespace' },
      { text: 'sensor_data', confidence: 85, description: 'Akamai sensor data' },
      {
        text: 'bazadebezolkohpepadr',
        confidence: 95,
        description: 'Akamai pixel challenge variable',
      },
    ],
    window: [{ path: 'bmak', confidence: 95, description: 'Akamai Bot Manager object' }],
  },

  // Incapsula/Imperva - Headers may help
  {
    id: 'incapsula',
    name: 'Incapsula (Imperva)',
    category: 'antibot',
    suggestedAction: 'retry-headers',
    cookies: [
      { name: 'incap_ses_', confidence: 100 },
      { name: 'visid_incap_', confidence: 95 },
      { name: 'nlbi_', confidence: 90 },
      { name: 'reese84', confidence: 100 },
      { name: 'utmvc', confidence: 95 },
    ],
    headers: [],
    content: [
      { text: '_Incapsula', confidence: 100, description: 'Incapsula global object' },
      { text: 'incapsula', confidence: 90, description: 'Incapsula reference' },
    ],
    window: [{ path: '_Incapsula', confidence: 100, description: 'Incapsula protection object' }],
  },

  // Shape Security - Very difficult
  {
    id: 'shape-security',
    name: 'Shape Security (F5)',
    category: 'antibot',
    suggestedAction: 'try-archive',
    cookies: [],
    headers: [
      // Shape uses dynamic header names like x-xxxxxxxx-a, x-xxxxxxxx-b, etc.
      { name: '^x-[a-z0-9]{8}-[a-z]$', nameRegex: true, confidence: 100 },
    ],
    content: [{ text: 'shapesecurity', confidence: 90, description: 'Shape Security namespace' }],
    window: [
      { path: '__xr_bmobdb', confidence: 95, description: 'Shape browser monitoring database' },
    ],
  },

  // Kasada - Very difficult
  {
    id: 'kasada',
    name: 'Kasada',
    category: 'antibot',
    suggestedAction: 'try-archive',
    cookies: [
      { name: 'kas.js', confidence: 95 },
      { name: 'kas_challenge', confidence: 90 },
      { name: '_kas', confidence: 85 },
    ],
    headers: [
      { name: 'x-kasada', confidence: 90 },
      { name: 'x-kasada-challenge', confidence: 85 },
    ],
    content: [
      { text: 'kasada', confidence: 85, description: 'Kasada namespace' },
      { text: '__kasada', confidence: 90, description: 'Kasada global object' },
      { text: 'kas_challenge', confidence: 85, description: 'Kasada challenge identifier' },
    ],
    window: [
      { path: '__kasada', confidence: 95, description: 'Kasada global object' },
      { path: 'kas', confidence: 90, description: 'Kasada API namespace' },
    ],
  },

  // ==================== CAPTCHA SYSTEMS ====================

  // Google reCAPTCHA - Try archive or CAPTCHA solver
  {
    id: 'recaptcha',
    name: 'Google reCAPTCHA',
    category: 'captcha',
    suggestedAction: 'solve-captcha',
    cookies: [],
    headers: [],
    content: [
      { text: 'grecaptcha', confidence: 100, description: 'reCAPTCHA global object' },
      { text: 'g-recaptcha', confidence: 90, description: 'reCAPTCHA container class' },
      { text: 'grecaptcha.execute', confidence: 95, description: 'reCAPTCHA v3 execution' },
      { text: 'grecaptcha.render', confidence: 90, description: 'reCAPTCHA v2 rendering' },
      { text: 'recaptcha/api', confidence: 100, description: 'reCAPTCHA API endpoint' },
      { text: 'gstatic.com/recaptcha', confidence: 95, description: 'reCAPTCHA static resources' },
    ],
    window: [
      { path: 'grecaptcha', confidence: 100, description: 'Google reCAPTCHA main object' },
      { path: 'grecaptcha.ready', confidence: 95, description: 'reCAPTCHA ready function' },
      { path: 'grecaptcha.execute', confidence: 95, description: 'reCAPTCHA execute function' },
      { path: '___grecaptcha_cfg', confidence: 90, description: 'reCAPTCHA configuration object' },
    ],
  },

  // hCaptcha - Try archive or CAPTCHA solver
  {
    id: 'hcaptcha',
    name: 'hCaptcha',
    category: 'captcha',
    suggestedAction: 'solve-captcha',
    cookies: [],
    headers: [],
    content: [
      { text: 'hcaptcha', confidence: 100, description: 'hCaptcha object' },
      { text: 'h-captcha', confidence: 95, description: 'hCaptcha container class' },
      { text: 'hcaptcha.render', confidence: 90, description: 'hCaptcha render function' },
      { text: 'hcaptcha.execute', confidence: 90, description: 'hCaptcha execute function' },
      { text: 'hcaptcha.com', confidence: 100, description: 'hCaptcha domain' },
    ],
    window: [
      { path: 'hcaptcha', confidence: 100, description: 'hCaptcha main object' },
      { path: 'hcaptcha.render', confidence: 95, description: 'hCaptcha render function' },
      { path: 'hcaptcha.execute', confidence: 90, description: 'hCaptcha execute function' },
    ],
  },

  // FunCaptcha (Arkose Labs) - Very difficult, try archive
  {
    id: 'funcaptcha',
    name: 'FunCaptcha (Arkose Labs)',
    category: 'captcha',
    suggestedAction: 'try-archive',
    cookies: [
      { name: 'arkose_token', confidence: 100 },
      { name: '_arkose', confidence: 95 },
    ],
    headers: [
      { name: 'x-arkose-challenge', confidence: 100 },
      { name: 'x-arkose-token', confidence: 95 },
    ],
    content: [
      { text: 'window.arkoseCallback', confidence: 100, description: 'Arkose callback function' },
      { text: 'ArkoseEnforce', confidence: 95, description: 'Arkose enforcement object' },
      { text: 'funcaptcha', confidence: 90, description: 'FunCaptcha reference' },
      { text: 'setupEnforcement', confidence: 85, description: 'Arkose setup function' },
      { text: 'client-api.arkoselabs.com', confidence: 100, description: 'Arkose Labs API' },
      { text: 'api.funcaptcha.com', confidence: 100, description: 'Legacy FunCaptcha API' },
    ],
    window: [
      { path: 'ArkoseEnforce', confidence: 100, description: 'Arkose enforcement object' },
      { path: 'arkoseCallback', confidence: 95, description: 'Arkose callback function' },
      { path: 'setupEnforcement', confidence: 85, description: 'Arkose setup enforcement' },
    ],
  },

  // GeeTest - Try archive
  {
    id: 'geetest',
    name: 'GeeTest',
    category: 'captcha',
    suggestedAction: 'try-archive',
    cookies: [
      { name: 'geetest_', confidence: 95 },
      { name: 'gt_', confidence: 90 },
    ],
    headers: [
      { name: 'x-geetest-challenge', confidence: 100 },
      { name: 'x-geetest-validate', confidence: 95 },
    ],
    content: [
      { text: 'window.initGeetest', confidence: 100, description: 'GeeTest initialization' },
      { text: 'geetest', confidence: 95, description: 'GeeTest reference' },
      { text: 'getGeetest', confidence: 90, description: 'GeeTest getter function' },
      { text: 'api.geetest.com', confidence: 100, description: 'GeeTest API endpoint' },
      { text: 'static.geetest.com', confidence: 100, description: 'GeeTest static resources' },
    ],
    window: [
      { path: 'initGeetest', confidence: 100, description: 'GeeTest initialization function' },
      { path: 'geetest', confidence: 95, description: 'GeeTest main object' },
      { path: 'getGeetest', confidence: 90, description: 'GeeTest getter function' },
    ],
  },

  // Friendly Captcha - Privacy-focused, try archive
  {
    id: 'friendlycaptcha',
    name: 'Friendly Captcha',
    category: 'captcha',
    suggestedAction: 'try-archive',
    cookies: [],
    headers: [],
    content: [
      { text: 'frc-captcha', confidence: 100, description: 'Friendly Captcha container' },
      { text: 'friendlyChallenge', confidence: 95, description: 'Friendly Captcha object' },
      { text: 'friendly-challenge', confidence: 95, description: 'Friendly Captcha element' },
      { text: 'FriendlyCaptcha', confidence: 90, description: 'Friendly Captcha constructor' },
      { text: 'friendlycaptcha.com', confidence: 100, description: 'Friendly Captcha domain' },
    ],
    window: [
      { path: 'friendlyChallenge', confidence: 95, description: 'Friendly Captcha main object' },
      { path: 'friendlyChallenge.render', confidence: 90, description: 'Friendly Captcha render' },
    ],
  },

  // Cloudflare Turnstile - Very difficult (integrated with Cloudflare)
  {
    id: 'turnstile',
    name: 'Cloudflare Turnstile',
    category: 'captcha',
    suggestedAction: 'give-up',
    cookies: [],
    headers: [],
    content: [
      { text: 'turnstile.render', confidence: 100, description: 'Turnstile render function' },
      { text: 'cf-turnstile', confidence: 95, description: 'Turnstile container class' },
      {
        text: 'challenges.cloudflare.com/turnstile',
        confidence: 100,
        description: 'Turnstile API',
      },
    ],
    window: [
      { path: 'turnstile', confidence: 100, description: 'Cloudflare Turnstile object' },
      { path: 'turnstile.render', confidence: 95, description: 'Turnstile render function' },
      { path: 'turnstile.execute', confidence: 95, description: 'Turnstile execute function' },
    ],
  },

  // ==================== FINGERPRINTING LIBRARIES ====================

  // FingerprintJS - Browser fingerprinting library
  {
    id: 'fingerprintjs',
    name: 'FingerprintJS',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [
      { name: '_vid_t', confidence: 85 },
      { name: 'fpjs_', confidence: 80, nameRegex: true },
    ],
    headers: [],
    content: [
      { text: 'fingerprintjs', confidence: 90, description: 'FingerprintJS library' },
      { text: 'fpjs', confidence: 80, description: 'FingerprintJS shorthand' },
      { text: 'FingerprintJS.load', confidence: 95, description: 'FingerprintJS initialization' },
    ],
    window: [],
  },

  // BotD - Bot detection by FingerprintJS
  {
    id: 'botd',
    name: 'BotD (FingerprintJS)',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      { text: '@aspect/botd', confidence: 90, description: 'BotD npm package' },
      { text: 'botd-agent', confidence: 85, description: 'BotD agent reference' },
      { text: 'openfpcdn.io', confidence: 80, description: 'FingerprintJS CDN (BotD)' },
    ],
    window: [],
  },

  // CreepJS - Advanced fingerprinting detection
  {
    id: 'creepjs',
    name: 'CreepJS',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      { text: 'creepjs', confidence: 90, description: 'CreepJS library' },
      { text: 'creep.js', confidence: 85, description: 'CreepJS script' },
    ],
    window: [],
  },

  // ==================== FINGERPRINT TECHNIQUES ====================

  {
    id: 'fp-audio',
    name: 'Audio Fingerprinting',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      {
        text: 'OfflineAudioContext',
        confidence: 65,
        description: 'Offline audio rendering (common fingerprint technique)',
      },
      { text: 'getChannelData', confidence: 70, description: 'Audio channel data extraction' },
      {
        text: 'createDynamicsCompressor',
        confidence: 65,
        description: 'Dynamics compressor (audio fingerprint)',
      },
    ],
    window: [
      {
        path: 'OfflineAudioContext',
        confidence: 40,
        description: 'OfflineAudioContext constructor',
      },
      {
        path: 'webkitOfflineAudioContext',
        confidence: 45,
        description: 'Webkit OfflineAudioContext',
      },
    ],
  },

  {
    id: 'fp-battery',
    name: 'Battery Status Fingerprinting',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      { text: 'navigator.getBattery', confidence: 70, description: 'Battery Status API access' },
      { text: 'BatteryManager', confidence: 65, description: 'BatteryManager interface' },
    ],
    window: [{ path: 'navigator.getBattery', confidence: 60, description: 'Battery Status API' }],
  },

  {
    id: 'fp-canvas',
    name: 'Canvas Fingerprinting',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      { text: 'toDataURL', confidence: 50, description: 'Canvas data URL extraction' },
      { text: 'getImageData', confidence: 50, description: 'Canvas pixel data extraction' },
    ],
    window: [],
  },

  {
    id: 'fp-clipboard',
    name: 'Clipboard Fingerprinting',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      {
        text: 'navigator.clipboard.readText',
        confidence: 60,
        description: 'Clipboard read access',
      },
      { text: 'navigator.clipboard.read', confidence: 55, description: 'Clipboard read' },
    ],
    window: [{ path: 'navigator.clipboard', confidence: 40, description: 'Clipboard API' }],
  },

  {
    id: 'fp-crypto',
    name: 'Crypto API Fingerprinting',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      { text: 'crypto.subtle.digest', confidence: 55, description: 'Crypto digest for hashing' },
      { text: 'crypto.subtle.generateKey', confidence: 55, description: 'Crypto key generation' },
    ],
    window: [{ path: 'crypto.subtle', confidence: 35, description: 'SubtleCrypto interface' }],
  },

  {
    id: 'fp-css',
    name: 'CSS Fingerprinting',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      { text: 'CSS.supports', confidence: 45, description: 'CSS feature detection' },
      { text: 'getComputedStyle', confidence: 40, description: 'Computed style enumeration' },
    ],
    window: [{ path: 'CSS.supports', confidence: 35, description: 'CSS supports API' }],
  },

  {
    id: 'fp-font',
    name: 'Font Fingerprinting',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      { text: 'document.fonts.check', confidence: 65, description: 'Font availability check' },
      { text: 'document.fonts', confidence: 55, description: 'FontFaceSet API' },
    ],
    window: [{ path: 'document.fonts', confidence: 40, description: 'FontFaceSet API' }],
  },

  {
    id: 'fp-gamepads',
    name: 'Gamepad Fingerprinting',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      { text: 'navigator.getGamepads', confidence: 65, description: 'Gamepad enumeration' },
      { text: 'gamepadconnected', confidence: 60, description: 'Gamepad connection event' },
    ],
    window: [{ path: 'navigator.getGamepads', confidence: 50, description: 'Gamepad API' }],
  },

  {
    id: 'fp-geolocation',
    name: 'Geolocation Fingerprinting',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      {
        text: 'navigator.geolocation.getCurrentPosition',
        confidence: 45,
        description: 'Position retrieval',
      },
      {
        text: 'navigator.geolocation.watchPosition',
        confidence: 45,
        description: 'Position watching',
      },
    ],
    window: [{ path: 'navigator.geolocation', confidence: 30, description: 'Geolocation API' }],
  },

  {
    id: 'fp-hardware',
    name: 'Hardware Fingerprinting',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      { text: 'navigator.hardwareConcurrency', confidence: 65, description: 'CPU core count' },
      { text: 'navigator.deviceMemory', confidence: 70, description: 'Device memory amount' },
      {
        text: 'navigator.maxTouchPoints',
        confidence: 55,
        description: 'Touch capability detection',
      },
    ],
    window: [
      { path: 'navigator.hardwareConcurrency', confidence: 50, description: 'CPU core count' },
      { path: 'navigator.deviceMemory', confidence: 55, description: 'Device memory' },
      { path: 'navigator.maxTouchPoints', confidence: 45, description: 'Touch points' },
    ],
  },

  {
    id: 'fp-indexeddb',
    name: 'IndexedDB Fingerprinting',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      {
        text: 'indexedDB.databases',
        confidence: 60,
        description: 'IndexedDB database enumeration',
      },
    ],
    window: [],
  },

  {
    id: 'fp-media',
    name: 'Media Device Fingerprinting',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      { text: 'enumerateDevices', confidence: 65, description: 'Media device enumeration' },
      { text: 'navigator.mediaDevices', confidence: 55, description: 'Media devices API' },
    ],
    window: [
      { path: 'navigator.mediaDevices', confidence: 40, description: 'MediaDevices API' },
      {
        path: 'navigator.mediaDevices.enumerateDevices',
        confidence: 55,
        description: 'Device enumeration',
      },
    ],
  },

  {
    id: 'fp-navigator',
    name: 'Navigator Fingerprinting',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      { text: 'navigator.plugins', confidence: 55, description: 'Plugin enumeration' },
      { text: 'navigator.languages', confidence: 45, description: 'Language list enumeration' },
      { text: 'navigator.doNotTrack', confidence: 50, description: 'DNT setting detection' },
    ],
    window: [
      { path: 'navigator.plugins', confidence: 40, description: 'Plugin list' },
      { path: 'navigator.languages', confidence: 35, description: 'Language list' },
    ],
  },

  {
    id: 'fp-orientation',
    name: 'Device Orientation Fingerprinting',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      { text: 'DeviceOrientationEvent', confidence: 55, description: 'Device orientation event' },
      { text: 'DeviceMotionEvent', confidence: 55, description: 'Device motion event' },
    ],
    window: [
      {
        path: 'DeviceOrientationEvent',
        confidence: 40,
        description: 'Orientation event constructor',
      },
      { path: 'DeviceMotionEvent', confidence: 40, description: 'Motion event constructor' },
    ],
  },

  {
    id: 'fp-performance',
    name: 'Performance API Fingerprinting',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      {
        text: 'performance.getEntries',
        confidence: 50,
        description: 'Performance entry enumeration',
      },
      { text: 'performance.memory', confidence: 60, description: 'Memory info (Chrome-specific)' },
    ],
    window: [{ path: 'performance.memory', confidence: 50, description: 'Memory info API' }],
  },

  {
    id: 'fp-screen',
    name: 'Screen Fingerprinting',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      { text: 'screen.colorDepth', confidence: 50, description: 'Color depth detection' },
      { text: 'screen.pixelDepth', confidence: 55, description: 'Pixel depth detection' },
      { text: 'window.devicePixelRatio', confidence: 45, description: 'Device pixel ratio' },
    ],
    window: [],
  },

  {
    id: 'fp-storage',
    name: 'Storage Fingerprinting',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      {
        text: 'navigator.storage.estimate',
        confidence: 55,
        description: 'Storage quota estimation',
      },
    ],
    window: [{ path: 'navigator.storage', confidence: 35, description: 'Storage Manager' }],
  },

  {
    id: 'fp-timezone',
    name: 'Timezone Fingerprinting',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      {
        text: 'Intl.DateTimeFormat',
        confidence: 45,
        description: 'Intl date formatting (timezone extraction)',
      },
      { text: 'getTimezoneOffset', confidence: 40, description: 'Timezone offset detection' },
    ],
    window: [
      { path: 'Intl.DateTimeFormat', confidence: 35, description: 'DateTimeFormat constructor' },
    ],
  },

  {
    id: 'fp-usb',
    name: 'USB Fingerprinting',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      { text: 'navigator.usb', confidence: 70, description: 'WebUSB API access' },
      { text: 'usb.getDevices', confidence: 75, description: 'USB device enumeration' },
      { text: 'usb.requestDevice', confidence: 65, description: 'USB device request' },
    ],
    window: [{ path: 'navigator.usb', confidence: 60, description: 'WebUSB API' }],
  },

  {
    id: 'fp-webgl',
    name: 'WebGL Fingerprinting',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      {
        text: 'WEBGL_debug_renderer_info',
        confidence: 80,
        description: 'WebGL renderer/vendor info (strong fingerprint signal)',
      },
      {
        text: 'getSupportedExtensions',
        confidence: 60,
        description: 'WebGL extension enumeration',
      },
      {
        text: 'getShaderPrecisionFormat',
        confidence: 70,
        description: 'WebGL shader precision query',
      },
    ],
    window: [
      { path: 'WebGLRenderingContext', confidence: 30, description: 'WebGL context constructor' },
      { path: 'WebGL2RenderingContext', confidence: 30, description: 'WebGL2 context constructor' },
    ],
  },

  {
    id: 'fp-webrtc',
    name: 'WebRTC Fingerprinting',
    category: 'fingerprint',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      { text: 'RTCPeerConnection', confidence: 55, description: 'WebRTC peer connection' },
      { text: 'createDataChannel', confidence: 60, description: 'WebRTC data channel creation' },
      { text: 'onicecandidate', confidence: 55, description: 'ICE candidate event handler' },
    ],
    window: [
      { path: 'RTCPeerConnection', confidence: 45, description: 'RTCPeerConnection constructor' },
      { path: 'webkitRTCPeerConnection', confidence: 50, description: 'Webkit RTCPeerConnection' },
    ],
  },

  // ==================== BOT DETECTION TECHNIQUES ====================
  // Detect when page JavaScript is actively probing for headless/automation signals.
  // Patterns derived from unwaller CreepJS battle testing.

  {
    id: 'bd-webdriver',
    name: 'Webdriver Detection',
    category: 'bot-detection',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      {
        text: 'navigator.webdriver',
        confidence: 75,
        description: 'Webdriver flag check (automation detection)',
      },
    ],
    window: [],
  },

  {
    id: 'bd-chrome-obj',
    name: 'Chrome Object Check',
    category: 'bot-detection',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      {
        text: '[\'"]chrome[\'"] in window',
        textRegex: true,
        confidence: 50,
        description: 'Chrome object presence check',
      },
    ],
    window: [],
  },

  {
    id: 'bd-fn-tostring',
    name: 'Function.toString Tampering Check',
    category: 'bot-detection',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      {
        text: 'Function.prototype.toString',
        confidence: 55,
        description: 'Function.toString proxy/tampering detection',
      },
    ],
    window: [],
  },

  {
    id: 'bd-chrome-runtime',
    name: 'Chrome Runtime Tampering',
    category: 'bot-detection',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      {
        text: 'chrome\\.runtime\\.(sendMessage|connect)',
        textRegex: true,
        confidence: 50,
        description: 'Chrome runtime tampering check',
      },
    ],
    window: [],
  },

  {
    id: 'bd-mimetypes',
    name: 'MIME Types Enumeration',
    category: 'bot-detection',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      {
        text: 'navigator.mimeTypes',
        confidence: 55,
        description: 'MIME type enumeration (deprecated API, fingerprinting signal)',
      },
    ],
    window: [],
  },

  {
    id: 'bd-permissions',
    name: 'Permissions API Probing',
    category: 'bot-detection',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      {
        text: 'navigator.permissions.query',
        confidence: 40,
        description: 'Permissions API probing',
      },
    ],
    window: [],
  },

  {
    id: 'bd-connection',
    name: 'Connection API Probing',
    category: 'bot-detection',
    suggestedAction: 'unknown',
    cookies: [],
    headers: [],
    content: [
      {
        text: 'navigator.connection',
        confidence: 40,
        description: 'Network Information API probing',
      },
    ],
    window: [],
  },
];
