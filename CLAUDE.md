# CLAUDE.md — agent-fetch

Full-content web fetcher and article extractor for AI agents. Browser impersonation (httpcloak) with multi-strategy content extraction.

## Commands

```bash
npm run lint          # ESLint with typescript-eslint
npm run format:check  # Prettier check
npm run format        # Prettier write
npm run test          # Unit tests only (excludes e2e)
npm run test:e2e      # E2E tests (hit real sites, flaky — don't run in CI)
npm run build         # TypeScript compilation
```

## Before Committing or Creating a PR

Run all checks — all four must pass:

```bash
npm run lint && npm run format:check && npm run test && npm run build
```

If format:check fails, run `npm run format` and re-stage.

## Worktree Workflow

**Never modify files directly on the main branch.** All feature work, bug fixes, and changes must be done in a git worktree. When asked to implement something, always create a worktree first.

After creating a git worktree for feature work, **immediately `cd` to the worktree directory** before running any commands or making changes. This ensures you're working in the correct isolated context, not the main repository.

```bash
git worktree add .worktrees/<name> -b feature/<name>
cd .worktrees/<name>
```

## Project Structure

```
src/
  cli.ts                  # CLI entry point (5 output modes: default, --json, --raw, --text, -q)
  index.ts                # Public API exports
  logger.ts               # Pino logging
  fetch/                  # HTTP client with browser impersonation
    http-client.ts        #   Low-level HTTP via httpcloak
    http-fetch.ts         #   High-level fetch orchestrator
    content-validator.ts  #   Response validation (challenge pages, content types)
    types.ts
  extract/                # Multi-strategy content extraction
    content-extractors.ts #   Strategies: Next.js, JSON-LD, Readability, CSS selectors, text-density, RSC
    utils.ts              #   Extraction helpers
    types.ts
  sites/                  # Site-specific configurations
    site-config.ts        #   Per-site config (AGENT_FETCH_SITES_JSON)
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

## Running E2E Tests

E2E tests fetch real URLs and record results to a local SQLite database (`e2e.db`). The database accumulates history across runs for regression tracking.

```bash
npm run test:e2e:fetch              # Run all fetch e2e tests (records to DB automatically)
npm run test:e2e:fetch:critical     # Critical-priority sites only
npm run test:e2e:fetch:quick        # Critical + important priority
```

Environment variables for filtering:

- `TEST_SET`: 'stable' (default), 'latest', or 'all'
- `TEST_PRIORITY`: 'critical', 'important' (comma-separated)
- `TEST_TAGS`: filter by tags (comma-separated)
- `TEST_SITES`: filter by site names (overrides other filters)
- `TEST_CONCURRENCY`: parallel requests (default: 5)

Database query and management:

```bash
npm run e2e:db:query -- --stats     # Per-site pass/fail statistics (grouped by default)
npm run e2e:db:query -- --stats --no-group  # Per-URL stats (ungrouped)
npm run e2e:db:query -- --overall   # Overall statistics across all runs
npm run e2e:db:query -- --runs      # List test runs with metadata
npm run e2e:db:query -- --quality   # Extraction quality analysis
npm run e2e:db:compare              # Compare 2 most recent runs (grouped by site)
npm run e2e:db:compare -- --no-group  # Compare without site grouping
npm run e2e:db:cleanup -- --before "30d"  # Delete runs older than 30 days
```
