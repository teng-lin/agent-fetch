/**
 * Site-level grouping helpers for E2E analysis scripts.
 *
 * Groups "SiteName" and "SiteName (latest)" test results into a single
 * site-level entry. Used by both db-query and db-compare scripts.
 */

export interface TestResultEntry {
  url: string;
  status: string;
  error: string | null;
  length: number | null;
  strategy: string | null;
}

export interface SiteGroup {
  site: string;
  stable: TestResultEntry | null;
  latest: TestResultEntry | null;
}

const LATEST_SUFFIX = ' (latest)';

/**
 * Strip the trailing " (latest)" suffix from a test name to get the base site name.
 */
export function baseSiteName(testName: string): string {
  if (testName.endsWith(LATEST_SUFFIX)) {
    return testName.slice(0, -LATEST_SUFFIX.length);
  }
  return testName;
}

/**
 * Returns true if the test name represents a "latest" URL test.
 */
export function isLatest(testName: string): boolean {
  return testName.endsWith(LATEST_SUFFIX);
}

/**
 * Group a map of test_name → TestResultEntry into site-level groups.
 *
 * "SiteName" and "SiteName (latest)" are merged into a single SiteGroup
 * keyed by the base site name.
 */
export function groupResultsBySite(results: Map<string, TestResultEntry>): Map<string, SiteGroup> {
  const groups = new Map<string, SiteGroup>();

  for (const [testName, result] of results) {
    const site = baseSiteName(testName);
    let group = groups.get(site);
    if (!group) {
      group = { site, stable: null, latest: null };
      groups.set(site, group);
    }
    if (isLatest(testName)) {
      group.latest = result;
    } else {
      group.stable = result;
    }
  }

  return groups;
}
