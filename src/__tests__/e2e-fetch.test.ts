/**
 * E2E Fetch Tests
 *
 * Tests the HTTP-only fetch (httpFetch) against configured sites.
 *
 * Run with: npm run test:e2e:fetch
 * Filter with environment variables:
 *   TEST_SET=stable|latest|all        - Which URLs to test (default: stable)
 *   TEST_PRIORITY=critical,important  - Filter by priority (OR within)
 *   TEST_TAGS=ua-spoofing,cookies     - Filter by tags (OR within)
 *   TEST_SITES=NYTimes,WSJ            - Filter by site name (overrides others)
 *   TEST_CONCURRENCY=5                - Parallel HTTP requests (default: 5)
 */
import { describe, it, expect } from 'vitest';
import { httpFetch } from '../fetch/http-fetch.js';
import type { SiteTestConfig } from './fixtures/types.js';
import { loadFixtures, runWithConcurrency, filterTestCases, wordCount } from './e2e-helpers.js';
import { recordTestResult, startTestRun, endTestRun } from './db-recorder.js';

const TEST_CONCURRENCY = parseInt(process.env.TEST_CONCURRENCY || '5', 10);
const TEST_SET = process.env.TEST_SET || 'stable';

/** Fetch-specific test case */
interface FetchTestCase {
  site: string;
  url: string;
  minWords: number;
  priority?: 'critical' | 'important';
  tags?: string[];
  expectedToFail?: boolean;
}

/**
 * Build fetch test cases from site configs.
 * Only includes sites with a `fetch` configuration.
 */
function getFetchTestCases(configs: SiteTestConfig[], testSet: string): FetchTestCase[] {
  const cases: FetchTestCase[] = [];
  for (const config of configs) {
    const minWords = config.fetch?.minWords ?? config.stable.minWords;
    const { site, priority, tags, expectedToFail } = config;
    const shared = { minWords, priority, tags, expectedToFail };

    if (testSet === 'stable' || testSet === 'all') {
      cases.push({ site, url: config.stable.url, ...shared });
    }
    if ((testSet === 'latest' || testSet === 'all') && config.latest) {
      cases.push({ site: `${site} (latest)`, url: config.latest.url, ...shared });
    }
  }
  return cases;
}

describe('E2E Fetch Tests', () => {
  const configs = loadFixtures();

  if (configs.length === 0) {
    console.warn(
      'No site fixture file found. Set SITE_FIXTURES env var or place site-fixtures.json in repo root. Skipping E2E fetch tests.'
    );
    it.skip('no fixtures available', () => {});
    return;
  }

  it('should fetch articles from all configured sites', async () => {
    const allCases = getFetchTestCases(configs, TEST_SET);
    const filteredCases = filterTestCases(allCases, {
      priority: process.env.TEST_PRIORITY?.split(',').map((s) => s.trim()),
      tags: process.env.TEST_TAGS?.split(',').map((s) => s.trim()),
      sites: process.env.TEST_SITES?.split(',').map((s) => s.trim()),
    });

    console.log(
      `\nRunning ${filteredCases.length} of ${allCases.length} fetch tests (TEST_SET=${TEST_SET})`
    );
    console.log(`  Concurrency: ${TEST_CONCURRENCY}`);
    console.log('');

    // Start a new test run
    startTestRun({ runType: 'fetch', preset: process.env.LYNXGET_PRESET });
    let passCount = 0;
    let failCount = 0;

    const failures: string[] = [];
    const transientSkips: string[] = [];
    // Previously included dns_rebinding_detected for CDN rotation false positives.
    // Fixed in the DNS rebinding check - now CDN IP rotation is allowed.
    const TRANSIENT_ERRORS: string[] = [];

    await runWithConcurrency(filteredCases, TEST_CONCURRENCY, async (tc) => {
      console.log(`Testing ${tc.site}...`);

      try {
        const result = await httpFetch(tc.url);
        recordTestResult({
          testName: tc.site,
          url: tc.url,
          status: result.success ? 'pass' : 'fail',
          httpStatus: result.statusCode ?? undefined,
          fetchDurationMs: result.latencyMs,
          extractStrategy: result.extractionMethod ?? undefined,
          contentLength: result.textContent?.length,
          errorMessage: result.error,
          antibotDetections: result.antibot?.map((d) => d.provider),
          archiveUrl: result.archiveUrl,
        });
        const words = wordCount(result.textContent);
        console.log(`${tc.site}: ${result.success ? 'OK' : 'FAIL'} - ${words} words`);

        if (!result.success) {
          if (tc.expectedToFail) {
            console.log(`${tc.site}: Expected failure (${result.error})`);
            return;
          }
          if (TRANSIENT_ERRORS.some((e) => result.error?.includes(e))) {
            transientSkips.push(`${tc.site}: ${result.error}`);
            console.log(`${tc.site}: Transient error (skipped) - ${result.error}`);
            return;
          }
          failures.push(`${tc.site}: fetch failed - ${result.error}`);
          failCount++;
          return;
        }

        if (words < tc.minWords) {
          if (tc.expectedToFail) {
            console.log(`${tc.site}: Expected failure (${words} words < ${tc.minWords})`);
            return;
          }
          failures.push(`${tc.site}: ${words} words (expected ${tc.minWords}+)`);
          failCount++;
          return;
        }

        if (!result.title) {
          failures.push(`${tc.site}: no title`);
          failCount++;
          return;
        }

        passCount++;
      } catch (err) {
        if (tc.expectedToFail) {
          console.log(`${tc.site}: Expected failure (${err})`);
          return;
        }
        failures.push(`${tc.site}: ${err}`);
        failCount++;
      }
    });

    // End the test run with statistics
    endTestRun(passCount, failCount);

    if (transientSkips.length > 0) {
      console.log(`\n=== TRANSIENT SKIPS (${transientSkips.length}) ===`);
      transientSkips.forEach((s) => console.log(s));
    }

    if (failures.length > 0) {
      console.log('\n=== FAILURES ===');
      failures.forEach((f) => console.log(f));
      expect(failures).toHaveLength(0);
    }
  }, 1800000);
});
