# E2E Run Database Design

**Date:** 2026-02-01
**Status:** Approved
**Author:** Brainstorming Session

## Overview

Automatically capture every E2E test run into a local SQLite database to enable debugging, analysis, and monitoring of extraction performance across sites. Each run records git commit info, extraction results from all strategies, performance metrics, bot detection signatures, and request/response metadata.

## Requirements

- **Automatic recording** - Every E2E test run automatically saves data (no opt-in needed)
- **Comprehensive data** - Capture extracted content, performance metrics, request/response details, site metadata
- **Git traceability** - Track which code version (commit hash) produced each result
- **Timestamps** - Record precise when each run occurred
- **Local storage** - SQLite database stored at project root (git-ignored)
- **Optional HTML capture** - Store compressed raw HTML only when explicitly enabled via env var
- **Manual cleanup** - Provide script to delete old runs when desired

## Use Cases

1. **Debugging** - Understand why extraction failed on a site, compare strategy effectiveness, identify patterns
2. **Analysis** - Track extraction success rates per strategy, site, and time period
3. **Monitoring** - Observe performance trends, detect regressions, identify problematic sites
4. **Reproducibility** - Link any test result to exact git commit and reproduce locally

## Architecture

### Storage

- **Location:** `lynxget-e2e.db` in the main repo root (`~/src/lynxget/lynxget-e2e.db`). When running E2E from a git worktree, symlink the worktree's db path to the main repo to keep a single database.
- **Technology:** SQLite (file-based, no external dependencies)
- **Git ignore:** Add `lynxget-e2e.db` to `.gitignore` (local data only)

### Data Flow

```
E2E Test Execution
  ↓
Vitest Hook (after-each)
  ↓
Capture: status, timing, URL, git commit, timestamp
  ↓
Intercept extraction results from all 5 strategies
  ↓
Extract antibot detections from detector
  ↓
Write records to SQLite tables
  ↓
Data available for queries and analysis
```

### Integration Points

1. **Vitest setup hook** - Capture git info before tests, hook after-each to record results
2. **HTTP client** - Log request/response metadata (headers, status, fingerprint, cookies)
3. **Extraction strategies** - Record success/failure and timing for each strategy
4. **Antibot detector** - Record detected signatures

## Database Schema

### `e2e_runs` Table

Primary record for each test execution.

| Column            | Type                | Description                                     |
| ----------------- | ------------------- | ----------------------------------------------- |
| `id`              | INTEGER PRIMARY KEY | Auto-increment identifier                       |
| `test_name`       | TEXT NOT NULL       | Name of the E2E test case                       |
| `git_commit`      | TEXT NOT NULL       | Git commit hash (40 chars)                      |
| `timestamp`       | DATETIME NOT NULL   | ISO 8601 timestamp when test ran                |
| `url`             | TEXT NOT NULL       | Target URL being tested                         |
| `status`          | TEXT NOT NULL       | 'pass' \| 'fail' \| 'error'                     |
| `duration_ms`     | INTEGER             | Total test execution time in milliseconds       |
| `http_status`     | INTEGER             | HTTP response status code (e.g., 200, 403, 429) |
| `tls_fingerprint` | TEXT                | TLS fingerprint used (from httpcloak)           |
| `user_agent`      | TEXT                | User agent header sent                          |
| `referer`         | TEXT                | Referer header sent                             |

### `extraction_results` Table

Results from each of the 5 extraction strategies per run.

| Column                | Type                | Description                                                                      |
| --------------------- | ------------------- | -------------------------------------------------------------------------------- |
| `id`                  | INTEGER PRIMARY KEY | Auto-increment                                                                   |
| `run_id`              | INTEGER FOREIGN KEY | References `e2e_runs.id`                                                         |
| `strategy`            | TEXT NOT NULL       | Strategy: 'nextjs' \| 'json-ld' \| 'readability' \| 'css-selectors' \| 'unfluff' |
| `success`             | INTEGER NOT NULL    | 1 (success) or 0 (failure)                                                       |
| `title`               | TEXT                | Extracted article title                                                          |
| `body`                | TEXT                | Extracted article body/content                                                   |
| `author`              | TEXT                | Extracted author name                                                            |
| `publish_date`        | TEXT                | Extracted publication date                                                       |
| `extraction_time_ms`  | INTEGER             | How long this strategy took to extract                                           |
| `raw_html_compressed` | BLOB                | Optional gzipped raw HTML (only if `RECORD_HTML=true`)                           |

### `antibot_detections` Table

Bot detection signatures found during request.

| Column           | Type                | Description                                                       |
| ---------------- | ------------------- | ----------------------------------------------------------------- |
| `id`             | INTEGER PRIMARY KEY | Auto-increment                                                    |
| `run_id`         | INTEGER FOREIGN KEY | References `e2e_runs.id`                                          |
| `signature_type` | TEXT NOT NULL       | Detection type: 'cookie' \| 'header' \| 'html' \| 'window_object' |
| `provider`       | TEXT NOT NULL       | Provider name (e.g., 'cloudflare', 'imperva', 'akamai')           |

### `http_details` Table

Additional HTTP request/response metadata.

| Column                | Type                | Description                         |
| --------------------- | ------------------- | ----------------------------------- |
| `id`                  | INTEGER PRIMARY KEY | Auto-increment                      |
| `run_id`              | INTEGER FOREIGN KEY | References `e2e_runs.id`            |
| `request_headers`     | TEXT                | JSON string of all request headers  |
| `response_headers`    | TEXT                | JSON string of all response headers |
| `response_size_bytes` | INTEGER             | Size of response body in bytes      |
| `cookies_received`    | TEXT                | JSON array of Set-Cookie headers    |

## Implementation Details

### Vitest Integration

**File:** `src/__tests__/db-recorder.ts` (new)

- Initialize SQLite connection on test suite startup
- Provide after-hook to capture test results
- Serialize extraction results to database
- Handle errors gracefully (log but don't fail tests)

**File:** `vitest.setup.ts` (modify)

- Import db-recorder
- Initialize database on startup
- Register after-each hook

### Environment Variables

```bash
# Enable/disable E2E run recording (default: true)
RECORD_E2E_DB=true

# Store compressed raw HTML (default: false, opt-in only)
RECORD_HTML=true
```

### Cleanup Script

**File:** `scripts/e2e-db-cleanup.ts` (new)

Usage:

```bash
npm run e2e:db:cleanup -- --before "2025-01-15"
npm run e2e:db:cleanup -- --before "30d"  # Delete runs older than 30 days
npm run e2e:db:cleanup -- --all           # Delete everything
```

Behavior:

- Accept date in ISO format or relative format (Xd, Xh, Xm)
- Show summary: "Deleted 1,234 runs and 5,678 extraction results"
- Require confirmation before deletion

**File:** `package.json` (modify)

Add scripts:

```json
{
  "scripts": {
    "e2e:db:cleanup": "tsx scripts/e2e-db-cleanup.ts",
    "e2e:db:query": "tsx scripts/e2e-db-query.ts"
  }
}
```

### Query Utilities

**File:** `src/__tests__/db-query.ts` (new)

Helper functions for analysis:

- `getSuccessRateByStrategy()` - % success per extraction strategy
- `getSuccessRateByStrategyAndSite()` - % success per strategy per domain
- `getSlowestStrategies()` - Average extraction time per strategy
- `getMostFailedSites()` - Sites with highest failure rates
- `getRunsByCommit(hash)` - All runs for a specific git commit
- `getRunsBySite(domain)` - All runs for a specific site

**File:** `scripts/e2e-db-query.ts` (new)

CLI tool for querying database:

```bash
npm run e2e:db:query -- --strategy readability --stats
npm run e2e:db:query -- --site example.com --since "2025-01-01"
npm run e2e:db:query -- --commit abc123def --show-details
```

## HTML Compression

Raw HTML is stored only when `RECORD_HTML=true`:

- Use Node.js built-in `zlib` to compress HTML before storing
- Store as BLOB in database
- Query functions automatically decompress on retrieval
- Typical compression ratio: 10:1 to 20:1 (1MB HTML → 50-100KB compressed)

## Error Handling

- Database errors should not cause tests to fail
- Log database write failures to stderr (visible in test output)
- If database is locked, queue and retry with exponential backoff
- On severe errors, gracefully degrade to no recording

## Testing

- Unit tests for db-recorder functions
- Integration test: run a real E2E test and verify record is created
- Query tests: verify helper functions return expected results
- Cleanup script tests: verify date filtering and deletion

## Migration & Backwards Compatibility

- Database schema created automatically on first use
- If schema changes needed, provide migration script
- Old database can be safely deleted (re-created on next run)

## Performance Considerations

- SQLite writes are fast for typical test volumes (< 1000 runs/day)
- Index on `git_commit` and `timestamp` for common queries
- HTML compression reduces database file size from hundreds of MB to tens of MB
- No impact on test execution time (async writes or post-test recording)

## Future Enhancements

- Export runs to JSON/CSV for external analysis
- Web dashboard to visualize trends
- Remote sync (upload to cloud storage)
- Performance benchmarking against baseline commits
- Automatic alerts for regression detection
