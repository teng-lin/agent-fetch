import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseDateString, parseArgs } from '../../scripts/e2e-db-cleanup.js';

describe('e2e-db-cleanup', () => {
  describe('parseDateString', () => {
    it('should parse ISO date format correctly', () => {
      const result = parseDateString('2026-01-25');
      expect(result.toISOString()).toBe('2026-01-25T00:00:00.000Z');
    });

    it('should parse relative days format', () => {
      const before7Days = parseDateString('7d');
      const now = new Date();
      const expected = new Date(now);
      expected.setDate(expected.getDate() - 7);

      // Allow 1 second tolerance for test execution time
      const diff = Math.abs(before7Days.getTime() - expected.getTime());
      expect(diff).toBeLessThan(1000);
    });

    it('should parse relative hours format', () => {
      const before24Hours = parseDateString('24h');
      const now = new Date();
      const expected = new Date(now);
      expected.setHours(expected.getHours() - 24);

      const diff = Math.abs(before24Hours.getTime() - expected.getTime());
      expect(diff).toBeLessThan(1000);
    });

    it('should parse relative minutes format', () => {
      const before5Minutes = parseDateString('5m');
      const now = new Date();
      const expected = new Date(now);
      expected.setMinutes(expected.getMinutes() - 5);

      const diff = Math.abs(before5Minutes.getTime() - expected.getTime());
      expect(diff).toBeLessThan(1000);
    });

    it('should throw on invalid ISO date format', () => {
      // These don't match the ISO regex pattern so they throw
      expect(() => parseDateString('26-01-25')).toThrow(/Invalid date format/);
      expect(() => parseDateString('2026/01/25')).toThrow(/Invalid date format/);
      expect(() => parseDateString('2026-1-25')).toThrow(/Invalid date format/);
    });

    it('should throw on invalid relative format', () => {
      expect(() => parseDateString('invalid')).toThrow(/Invalid date format/);
      expect(() => parseDateString('7')).toThrow(/Invalid date format/);
      expect(() => parseDateString('7x')).toThrow(/Invalid date format/);
      expect(() => parseDateString('-7d')).toThrow(/Invalid date format/);
    });

    it('should handle edge cases: zero days', () => {
      const today = parseDateString('0d');
      const now = new Date();

      // Should be approximately now (within 1 second)
      const diff = Math.abs(today.getTime() - now.getTime());
      expect(diff).toBeLessThan(1000);
    });

    it('should handle large relative values', () => {
      const result = parseDateString('999d');
      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBeLessThan(new Date().getTime());
    });
  });

  describe('parseArgs', () => {
    let originalArgv: string[];

    beforeEach(() => {
      originalArgv = process.argv;
    });

    afterEach(() => {
      process.argv = originalArgv;
    });

    it('should parse --before flag', () => {
      process.argv = ['node', 'script.ts', '--before', '2026-01-25'];
      const args = parseArgs();
      expect(args.before).toBe('2026-01-25');
      expect(args.all).toBeUndefined();
      expect(args.yes).toBeUndefined();
    });

    it('should parse --all flag', () => {
      process.argv = ['node', 'script.ts', '--all'];
      const args = parseArgs();
      expect(args.all).toBe(true);
      expect(args.before).toBeUndefined();
      expect(args.yes).toBeUndefined();
    });

    it('should parse --yes flag', () => {
      process.argv = ['node', 'script.ts', '--before', '30d', '--yes'];
      const args = parseArgs();
      expect(args.before).toBe('30d');
      expect(args.yes).toBe(true);
    });

    it('should parse multiple flags together', () => {
      process.argv = ['node', 'script.ts', '--all', '--yes'];
      const args = parseArgs();
      expect(args.all).toBe(true);
      expect(args.yes).toBe(true);
    });

    it('should return empty object with no flags', () => {
      process.argv = ['node', 'script.ts'];
      const args = parseArgs();
      expect(Object.keys(args).length).toBe(0);
    });

    it('should ignore unrecognized flags', () => {
      process.argv = ['node', 'script.ts', '--before', '7d', '--unknown', 'value'];
      const args = parseArgs();
      expect(args.before).toBe('7d');
      expect(Object.prototype.hasOwnProperty.call(args, 'unknown')).toBe(false);
    });
  });
});
