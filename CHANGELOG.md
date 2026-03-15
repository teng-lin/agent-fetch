# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Documented cookie file, web crawling, CSS selector, PDF, and TLS preset features

## [0.1.6] - 2026-02-14

### Added

- Netscape HTTP Cookie File support via `--cookie-file` flag and `AGENT_FETCH_COOKIE_FILE` env var
- Cookie file cookies merge with `--cookie` flags; explicit `--cookie` values take precedence on conflicts

## [0.1.5] - 2026-02-14

### Added

- Mobile API extraction with configurable auth token and token type for publisher endpoints
- Web crawler with sliding-window concurrency
- 183 new integration tests; coverage thresholds enforced in CI

### Changed

- Decomposed monolithic modules into focused sub-modules (content-extractors, http-fetch)
- E2E analysis scripts now group results by site name by default (`--no-group` to disable)
- E2E tests default to `TEST_SET=all` (previously `stable`)

### Fixed

- CLI process hangs caused by httpcloak orphaned libuv references — `process.exit(0)` in CLI entry point
- E2E `minWords` threshold bug
- Type-safe `FetchError`; `TurndownService` cached as singleton for batch performance
- Request correlation IDs added to fetch-layer logs for tracing concurrent requests

## [0.1.4] - 2026-02-05

### Added

- CLI `--version` / `-v` flag to display package version
- CLI warns on unknown flags instead of silently ignoring them
- Configurable request timeout with `--timeout <ms>` flag (default: 20s)

### Fixed

- Prevent pino-pretty crash when running via npx by moving to dependencies and adding availability check

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
- Multi-strategy content extraction (Readability, JSON-LD, Text Density, Next.js RSC, CSS selectors)
- WordPress REST API auto-detection and extraction
- Per-field metadata composition across strategies
- Markdown output via Turndown
- CLI with 5 output modes (default, --json, --raw, --text, -q)
- Site-specific configuration via `AGENT_FETCH_SITES_JSON`
- E2E test framework with SQLite database recording

[Unreleased]: https://github.com/teng-lin/agent-fetch/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/teng-lin/agent-fetch/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/teng-lin/agent-fetch/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/teng-lin/agent-fetch/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/teng-lin/agent-fetch/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/teng-lin/agent-fetch/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/teng-lin/agent-fetch/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/teng-lin/agent-fetch/releases/tag/v0.1.0
