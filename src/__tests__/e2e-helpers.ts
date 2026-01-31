/**
 * Shared utilities for E2E tests (fetch).
 *
 * All functions take explicit parameters — no module-level state closures.
 */
import { loadSiteConfigs } from './fixtures/sites.js';
import type { SiteTestConfig, TestCase } from './fixtures/types.js';

/**
 * Load site test configurations from external JSON fixture file.
 */
export function loadFixtures(): SiteTestConfig[] {
  return loadSiteConfigs();
}

/**
 * Run tasks with concurrency limit, preserving order.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index], index);
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

/**
 * Convert SiteTestConfig[] to TestCase[] based on test set selection.
 */
export function getTestCases(configs: SiteTestConfig[], testSet: string): TestCase[] {
  const cases: TestCase[] = [];
  for (const config of configs) {
    const { site, technique, priority, tags, expectedToFail } = config;
    const shared = { site, technique, priority, tags, expectedToFail };

    if (testSet === 'stable' || testSet === 'all') {
      cases.push({ ...shared, ...config.stable });
    }
    if ((testSet === 'latest' || testSet === 'all') && config.latest) {
      cases.push({ ...shared, site: `${site} (latest)`, ...config.latest });
    }
  }
  return cases;
}

/** Minimal interface for filterable test cases */
interface Filterable {
  site: string;
  priority?: 'critical' | 'important';
  tags?: string[];
}

/**
 * Filter test cases by priority, tags, and site names.
 */
export function filterTestCases<T extends Filterable>(
  cases: T[],
  filters: { priority?: string[]; tags?: string[]; sites?: string[] }
): T[] {
  const { priority = [], tags = [], sites = [] } = filters;

  // Site names override everything (partial match, case-insensitive)
  if (sites.length > 0) {
    return cases.filter((c) => sites.some((s) => c.site.toLowerCase().includes(s.toLowerCase())));
  }

  // No filters = run all
  if (priority.length === 0 && tags.length === 0) {
    return cases;
  }

  return cases.filter((c) => {
    const matchesPriority = priority.length === 0 || priority.includes(c.priority || 'standard');
    const matchesTags = tags.length === 0 || tags.some((t) => c.tags?.includes(t));

    return matchesPriority && matchesTags; // AND across dimensions
  });
}

/**
 * Count words in text content.
 */
export function wordCount(text: string | null | undefined): number {
  if (!text) return 0;
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}
