# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] - 2026-02-05

### Fixed

- Send logs to stderr in JSON mode (#18)

## [0.1.2] - 2026-02-05

### Added

- npm publish workflow triggered on `v*` tag push with provenance attestation
- Releasing checklist in CONTRIBUTING.md

## [0.1.1] - 2026-02-04

### Added

- Nuxt 3 payload extraction strategy (#5)
- React Router / Remix hydration data extraction strategy (#10)
- WP AJAX content extraction strategy (#9)
- Arc XP Prism content API extraction strategy (#2)
- `isAccessibleForFree` detection from JSON-LD structured data (#3)
- Next.js `__NEXT_DATA__` extraction made unconditional (#7)
- README badges, CI node matrix, extraction pipeline diagram (#13)
- Responsible use disclaimer (#15)

### Fixed

- Catastrophic regex backtracking in content validator (#14)
- HTTP 304 handling and GET request headers (#11)
- Truncated WP REST API response detection (#4)

### Changed

- Removed unused `allowCookies` config property (#12)

## [0.1.0] - 2026-02-03

Initial release.

### Added

- HTTP client with Chrome TLS fingerprinting via httpcloak
- SSRF protection with DNS validation
- Multi-strategy content extraction (Readability, JSON-LD, Text Density, Next.js RSC, CSS selectors, unfluff)
- WordPress REST API auto-detection and extraction
- Per-field metadata composition across strategies
- Markdown output via Turndown
- CLI with 5 output modes (default, --json, --raw, --text, -q)
- Site-specific configuration via `AGENT_FETCH_SITES_JSON`
- E2E test framework with SQLite database recording

[Unreleased]: https://github.com/teng-lin/agent-fetch/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/teng-lin/agent-fetch/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/teng-lin/agent-fetch/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/teng-lin/agent-fetch/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/teng-lin/agent-fetch/releases/tag/v0.1.0
