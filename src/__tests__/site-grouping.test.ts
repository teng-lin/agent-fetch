import { describe, it, expect } from 'vitest';
import {
  baseSiteName,
  isLatest,
  groupResultsBySite,
  type TestResultEntry,
} from './site-grouping.js';

describe('baseSiteName', () => {
  it('strips trailing (latest) suffix', () => {
    expect(baseSiteName('ExampleNews (latest)')).toBe('ExampleNews');
  });

  it('preserves names without the suffix', () => {
    expect(baseSiteName('ExampleNews')).toBe('ExampleNews');
  });

  it('preserves other parenthesized content', () => {
    expect(baseSiteName('Site (beta)')).toBe('Site (beta)');
  });

  it('only strips suffix at the end', () => {
    expect(baseSiteName('(latest) prefix')).toBe('(latest) prefix');
  });

  it('handles empty string', () => {
    expect(baseSiteName('')).toBe('');
  });

  it('handles name that is exactly the suffix', () => {
    expect(baseSiteName(' (latest)')).toBe('');
  });

  it('handles names with multiple parentheses', () => {
    expect(baseSiteName('Site (v2) (latest)')).toBe('Site (v2)');
  });
});

describe('isLatest', () => {
  it('returns true for names ending with (latest)', () => {
    expect(isLatest('ExampleNews (latest)')).toBe(true);
  });

  it('returns false for names without the suffix', () => {
    expect(isLatest('ExampleNews')).toBe(false);
  });

  it('returns false for partial match', () => {
    expect(isLatest('ExampleNews (latest')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isLatest('')).toBe(false);
  });
});

describe('groupResultsBySite', () => {
  const makeResult = (overrides: Partial<TestResultEntry> = {}): TestResultEntry => ({
    url: 'https://example.com',
    status: 'pass',
    error: null,
    length: 5000,
    strategy: 'readability',
    ...overrides,
  });

  it('groups stable-only entry', () => {
    const results = new Map<string, TestResultEntry>([['ExampleNews', makeResult()]]);
    const groups = groupResultsBySite(results);

    expect(groups.size).toBe(1);
    const group = groups.get('ExampleNews')!;
    expect(group.site).toBe('ExampleNews');
    expect(group.stable).toEqual(makeResult());
    expect(group.latest).toBeNull();
  });

  it('groups latest-only entry', () => {
    const latestResult = makeResult({ url: 'https://example.com/latest' });
    const results = new Map<string, TestResultEntry>([['ExampleNews (latest)', latestResult]]);
    const groups = groupResultsBySite(results);

    expect(groups.size).toBe(1);
    const group = groups.get('ExampleNews')!;
    expect(group.site).toBe('ExampleNews');
    expect(group.stable).toBeNull();
    expect(group.latest).toEqual(latestResult);
  });

  it('groups stable and latest into one entry', () => {
    const stableResult = makeResult({ url: 'https://example.com/stable' });
    const latestResult = makeResult({ url: 'https://example.com/latest', status: 'fail' });
    const results = new Map<string, TestResultEntry>([
      ['ExampleNews', stableResult],
      ['ExampleNews (latest)', latestResult],
    ]);
    const groups = groupResultsBySite(results);

    expect(groups.size).toBe(1);
    const group = groups.get('ExampleNews')!;
    expect(group.stable).toEqual(stableResult);
    expect(group.latest).toEqual(latestResult);
  });

  it('keeps different sites separate', () => {
    const results = new Map<string, TestResultEntry>([
      ['ExampleNews', makeResult()],
      ['ExampleBlog', makeResult({ url: 'https://blog.example.com' })],
    ]);
    const groups = groupResultsBySite(results);

    expect(groups.size).toBe(2);
    expect(groups.has('ExampleNews')).toBe(true);
    expect(groups.has('ExampleBlog')).toBe(true);
  });

  it('preserves all data fields', () => {
    const result = makeResult({
      url: 'https://example.com/article',
      status: 'fail',
      error: 'timeout',
      length: 0,
      strategy: 'json-ld',
    });
    const results = new Map<string, TestResultEntry>([['TestSite', result]]);
    const groups = groupResultsBySite(results);

    expect(groups.get('TestSite')!.stable).toEqual(result);
  });

  it('handles empty input', () => {
    const groups = groupResultsBySite(new Map());
    expect(groups.size).toBe(0);
  });
});
