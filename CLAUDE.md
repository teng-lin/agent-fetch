# CLAUDE.md — lynxget

Stealth web fetcher and article extractor for AI agents. Uses Chrome TLS fingerprinting (httpcloak) to bypass bot detection, with multi-strategy content extraction and 30+ antibot signature detection.

## Commands

```bash
npm run lint          # ESLint with typescript-eslint
npm run format:check  # Prettier check
npm run format        # Prettier write
npm run test          # Unit tests only (excludes e2e)
npm run test:e2e      # E2E tests (hit real sites, flaky — don't run in CI)
npm run build         # TypeScript compilation
```

## Before Committing

Run all checks before every commit:

```bash
npm run lint && npm run format:check && npm run test && npm run build
```

If format:check fails, run `npm run format` and re-stage the changes.

## Before Creating a PR

Run the full check suite including tests:

```bash
npm run lint && npm run format:check && npm run test && npm run build
```

All four must pass. Do not create a PR with failing checks.

## Worktree Workflow

After creating a git worktree for feature work, **immediately `cd` to the worktree directory** before running any commands or making changes. This ensures you're working in the correct isolated context, not the main repository.

```bash
cd .worktrees/<worktree-name>
```

## Project Structure

```
src/
  cli.ts                  # CLI entry point (5 output modes: default, --json, --raw, --detect, -q)
  index.ts                # Public API exports
  logger.ts               # Pino logging
  fetch/                  # HTTP client with stealth TLS fingerprinting
    http-client.ts        #   Low-level HTTP via httpcloak
    http-fetch.ts         #   High-level fetch orchestrator
    content-validator.ts  #   Response validation (challenge pages, content types)
    types.ts
  extract/                # Multi-strategy content extraction
    content-extractors.ts #   5 strategies: Next.js, JSON-LD, Readability, CSS selectors, unfluff
    utils.ts              #   Extraction helpers
    types.ts
  antibot/                # Bot detection identification
    detector.ts           #   Detection logic (cookies, headers, HTML, window objects)
    signatures.ts         #   30+ provider signatures
  sites/                  # Site-specific configurations
    site-config.ts        #   Per-site user agents, referers, CSS selectors
    constants.ts
    minimal-defaults.ts
  __tests__/              # Vitest unit tests
    fixtures/             #   Test data
```

## Code Conventions

- **TypeScript**: Strict mode, ES2022 target, NodeNext modules
- **Style**: Prettier (single quotes, trailing commas, 100 char width, 2-space indent)
- **Lint**: `@typescript-eslint/no-unused-vars` is an error (prefix unused args with `_`)
- **Lint**: `@typescript-eslint/no-explicit-any` is a warning
- **Tests**: Vitest with explicit imports (`import { describe, it, expect, vi } from 'vitest'`)
- **Test files**: Colocated in `src/__tests__/`, named `*.test.ts`
- **Imports**: Use `.js` extensions for local imports (NodeNext module resolution)
- **No e2e in CI**: E2E tests hit real sites with 30s timeouts — too flaky for automated checks
