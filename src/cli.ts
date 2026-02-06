#!/usr/bin/env node
/**
 * CLI entry point for agent-fetch
 */
import { fileURLToPath } from 'url';
import { realpathSync, readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { httpFetch } from './fetch/http-fetch.js';
import { httpRequest, closeAllSessions } from './fetch/http-client.js';
import { extractPdfFromBuffer } from './extract/pdf-extractor.js';
import { crawl } from './crawl/crawler.js';
import type { CrawlOptions } from './crawl/types.js';

/** Read version from package.json */
function getVersion(): string {
  const srcDir = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(srcDir, '..', 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch (error) {
    // Log for debugging but don't fail - 'unknown' is a safe fallback
    console.debug('Failed to read version from package.json:', error);
    return 'unknown';
  }
}

/** Shared flags common to both fetch and crawl commands. */
interface SharedFlags {
  json: boolean;
  quiet: boolean;
  text: boolean;
  preset?: string;
  timeout?: number;
  select?: string;
  remove?: string;
}

type SharedFlagResult = { handled: true; index: number } | { handled: false } | { error: string };

/**
 * Try to parse a shared flag at position i.
 * Returns { handled: true, index } with updated index if consumed,
 * { handled: false } if unrecognized, or { error } on validation failure.
 */
function parseSharedFlag(args: string[], i: number, flags: SharedFlags): SharedFlagResult {
  const arg = args[i];

  switch (arg) {
    case '--json':
      flags.json = true;
      return { handled: true, index: i };
    case '-q':
    case '--quiet':
      flags.quiet = true;
      return { handled: true, index: i };
    case '--text':
      flags.text = true;
      return { handled: true, index: i };
    case '--preset':
      if (i + 1 >= args.length) return { error: '--preset requires a value' };
      flags.preset = args[++i];
      return { handled: true, index: i };
    case '--timeout': {
      if (i + 1 >= args.length) return { error: '--timeout requires a value' };
      const v = parseInt(args[++i], 10);
      if (isNaN(v) || v <= 0)
        return { error: '--timeout must be a positive integer (milliseconds)' };
      flags.timeout = v;
      return { handled: true, index: i };
    }
    case '--select':
      if (i + 1 >= args.length) return { error: '--select requires a value' };
      flags.select = args[++i];
      return { handled: true, index: i };
    case '--remove':
      if (i + 1 >= args.length) return { error: '--remove requires a value' };
      flags.remove = args[++i];
      return { handled: true, index: i };
    default:
      return { handled: false };
  }
}

interface CliOptions {
  url: string;
  json: boolean;
  raw: boolean;
  quiet: boolean;
  text: boolean;
  preset?: string;
  timeout?: number;
  select?: string;
  remove?: string;
}

type ParseResult =
  | { kind: 'ok'; opts: CliOptions; warnings: string[] }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; message: string };

export function parseArgs(args: string[]): ParseResult {
  const positional: string[] = [];
  const warnings: string[] = [];
  const flags: SharedFlags = { json: false, quiet: false, text: false };
  let raw = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Try shared flags first
    const shared = parseSharedFlag(args, i, flags);
    if ('error' in shared) return { kind: 'error', message: shared.error };
    if (shared.handled) {
      i = shared.index;
      continue;
    }

    switch (arg) {
      case '--raw':
        raw = true;
        break;
      case '-h':
      case '--help':
        return { kind: 'help' };
      case '-v':
      case '--version':
        return { kind: 'version' };
      default:
        if (arg.startsWith('-')) {
          warnings.push(`Unknown option: ${arg}`);
        } else {
          positional.push(arg);
        }
    }
  }

  if (positional.length === 0) {
    return { kind: 'error', message: 'Missing required <url> argument' };
  }

  return {
    kind: 'ok',
    opts: { url: positional[0], raw, ...flags },
    warnings,
  };
}

interface CrawlCliOptions extends CrawlOptions {
  url: string;
  json: boolean;
  quiet: boolean;
  text: boolean;
}

type CrawlParseResult =
  | { kind: 'ok'; opts: CrawlCliOptions; warnings: string[] }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

export function parseCrawlArgs(args: string[]): CrawlParseResult {
  const positional: string[] = [];
  const warnings: string[] = [];
  const flags: SharedFlags = { json: false, quiet: false, text: false };
  let depth: number | undefined;
  let limit: number | undefined;
  let concurrency: number | undefined;
  let include: string[] | undefined;
  let exclude: string[] | undefined;
  let sameOrigin: boolean | undefined;
  let delayMs: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Try shared flags first
    const shared = parseSharedFlag(args, i, flags);
    if ('error' in shared) return { kind: 'error', message: shared.error };
    if (shared.handled) {
      i = shared.index;
      continue;
    }

    switch (arg) {
      case '-h':
      case '--help':
        return { kind: 'help' };
      case '--depth': {
        if (i + 1 >= args.length) return { kind: 'error', message: '--depth requires a value' };
        const v = parseInt(args[++i], 10);
        if (isNaN(v) || v < 0)
          return { kind: 'error', message: '--depth must be a non-negative integer' };
        depth = v;
        break;
      }
      case '--limit': {
        if (i + 1 >= args.length) return { kind: 'error', message: '--limit requires a value' };
        const v = parseInt(args[++i], 10);
        if (isNaN(v) || v <= 0)
          return { kind: 'error', message: '--limit must be a positive integer' };
        if (v > 10_000) return { kind: 'error', message: '--limit must not exceed 10000' };
        limit = v;
        break;
      }
      case '--concurrency': {
        if (i + 1 >= args.length)
          return { kind: 'error', message: '--concurrency requires a value' };
        const v = parseInt(args[++i], 10);
        if (isNaN(v) || v <= 0)
          return { kind: 'error', message: '--concurrency must be a positive integer' };
        if (v > 50) return { kind: 'error', message: '--concurrency must not exceed 50' };
        concurrency = v;
        break;
      }
      case '--include':
        if (i + 1 >= args.length) return { kind: 'error', message: '--include requires a value' };
        include = args[++i].split(',').map((s) => s.trim());
        break;
      case '--exclude':
        if (i + 1 >= args.length) return { kind: 'error', message: '--exclude requires a value' };
        exclude = args[++i].split(',').map((s) => s.trim());
        break;
      case '--same-origin':
        sameOrigin = true;
        break;
      case '--no-same-origin':
        sameOrigin = false;
        break;
      case '--delay': {
        if (i + 1 >= args.length) return { kind: 'error', message: '--delay requires a value' };
        const v = parseInt(args[++i], 10);
        if (isNaN(v) || v < 0)
          return { kind: 'error', message: '--delay must be a non-negative integer' };
        delayMs = v;
        break;
      }
      default:
        if (arg.startsWith('-')) {
          warnings.push(`Unknown option: ${arg}`);
        } else {
          positional.push(arg);
        }
    }
  }

  if (positional.length === 0) {
    return { kind: 'error', message: 'Missing required <url> argument for crawl' };
  }

  const crawlUrl = positional[0];
  if (!crawlUrl.startsWith('http://') && !crawlUrl.startsWith('https://')) {
    return { kind: 'error', message: 'Crawl URL must start with http:// or https://' };
  }

  return {
    kind: 'ok',
    opts: {
      url: positional[0],
      ...flags,
      maxDepth: depth,
      maxPages: limit,
      concurrency,
      include,
      exclude,
      sameOrigin,
      delay: delayMs,
      targetSelector: flags.select,
      removeSelector: flags.remove,
    },
    warnings,
  };
}

function printUsage(): void {
  console.log(`Usage: agent-fetch <url> [options]
       agent-fetch crawl <url> [crawl-options]

Output is markdown by default, preserving article structure (headings, links, lists).

Options:
  --json              Full JSON output (title, content, markdown, etc)
  --raw               Raw HTML output (no extraction)
  -q, --quiet         Markdown content only (no metadata)
  --text              Plain text content only (no metadata, no markdown)
  --select <css>      Extract only elements matching CSS selector
  --remove <css>      Remove elements matching CSS selector before extraction
  --preset <value>    TLS fingerprint preset (e.g. chrome-143, android-chrome-143, ios-safari-18)
  --timeout <ms>      Request timeout in milliseconds (default: 20000)
  -v, --version       Show version number
  -h, --help          Show this help message

Crawl options:
  --depth <n>         Max link-following depth (default: 3)
  --limit <n>         Max pages to fetch (default: 100)
  --concurrency <n>   Parallel requests (default: 5)
  --include <globs>   URL glob patterns to include (comma-separated)
  --exclude <globs>   URL glob patterns to exclude (comma-separated)
  --same-origin       Stay on same origin (default)
  --no-same-origin    Allow cross-origin links
  --delay <ms>        Delay between batches of requests in ms (default: 0)

Disclaimer:
  Users are responsible for complying with website terms of service,
  robots.txt directives, and applicable laws. See README for details.`);
}

async function runCrawl(args: string[]): Promise<void> {
  const result = parseCrawlArgs(args);

  if (result.kind === 'help') {
    printUsage();
    process.exit(0);
  }
  if (result.kind === 'error') {
    console.error(`Error: ${result.message}`);
    printUsage();
    process.exit(1);
  }

  const { opts, warnings } = result;
  for (const warning of warnings) {
    console.error(`Warning: ${warning}`);
  }

  try {
    for await (const item of crawl(opts.url, opts)) {
      if (opts.json) {
        console.log(JSON.stringify(item));
      } else if (opts.quiet && 'success' in item && item.success) {
        // Quiet mode: just output URLs
        console.log(item.url);
      } else if (opts.text && 'success' in item && item.success) {
        console.log(`--- ${item.url} ---`);
        if (item.textContent) console.log(item.textContent);
      } else if ('type' in item && item.type === 'summary') {
        if (!opts.json) {
          const blocked = item.pagesBlocked > 0 ? `, ${item.pagesBlocked} blocked` : '';
          console.error(
            `\nCrawl complete: ${item.pagesSuccess}/${item.pagesTotal} pages${blocked}, ${item.durationMs}ms (${item.source})`
          );
        }
      } else {
        // Default: JSONL output for crawl
        console.log(JSON.stringify(item));
      }
    }
  } finally {
    await closeAllSessions();
  }
}

export async function main(): Promise<void> {
  // Check for 'crawl' subcommand
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === 'crawl') {
    await runCrawl(rawArgs.slice(1));
    return;
  }

  const result = parseArgs(rawArgs);

  switch (result.kind) {
    case 'version':
      console.log(`agent-fetch ${getVersion()}`);
      process.exit(0);
      break;
    case 'help':
      printUsage();
      process.exit(0);
      break;
    case 'error':
      console.error(`Error: ${result.message}`);
      printUsage();
      process.exit(1);
      break;
  }

  const { opts, warnings } = result;

  for (const warning of warnings) {
    console.error(`Warning: ${warning}`);
  }

  try {
    // Local PDF file: read from disk and extract
    const isLocalFile = !opts.url.startsWith('http://') && !opts.url.startsWith('https://');
    if (isLocalFile && opts.url.toLowerCase().endsWith('.pdf')) {
      const filePath = resolve(opts.url);
      if (!existsSync(filePath)) {
        console.error(`Error: File not found: ${filePath}`);
        process.exit(1);
      }

      const buffer = readFileSync(filePath);
      const fetchResult = await extractPdfFromBuffer(buffer, filePath);

      if (opts.json) {
        console.log(JSON.stringify(fetchResult, null, 2));
        if (!fetchResult.success) process.exit(1);
        return;
      }

      if (!fetchResult.success) {
        console.error(`Error: ${fetchResult.error}`);
        process.exit(1);
      }

      if (opts.text) {
        if (fetchResult.textContent) console.log(fetchResult.textContent);
        return;
      }

      const body = fetchResult.markdown || fetchResult.textContent || '';

      if (opts.quiet) {
        console.log(body);
        return;
      }

      if (fetchResult.title) console.log(`Title: ${fetchResult.title}`);
      if (fetchResult.byline) console.log(`Author: ${fetchResult.byline}`);
      if (fetchResult.publishedTime) console.log(`Published: ${fetchResult.publishedTime}`);
      console.log(`Extracted in ${fetchResult.latencyMs}ms`);
      console.log('---');
      console.log(body);
      return;
    }

    // --raw mode: fetch HTML without extraction
    if (opts.raw) {
      const response = await httpRequest(opts.url, {}, opts.preset, opts.timeout);
      if (response.statusCode !== 200) {
        console.error(`HTTP ${response.statusCode}`);
        process.exit(1);
      }
      console.log(response.html);
      return;
    }

    // Default: fetch + extract
    const fetchResult = await httpFetch(opts.url, {
      preset: opts.preset,
      timeout: opts.timeout,
      targetSelector: opts.select,
      removeSelector: opts.remove,
    });

    if (opts.json) {
      console.log(JSON.stringify(fetchResult, null, 2));
      if (!fetchResult.success) process.exit(1);
      return;
    }

    if (!fetchResult.success) {
      console.error(`Error: ${fetchResult.error}`);
      if (fetchResult.hint) console.error(`Hint: ${fetchResult.hint}`);
      process.exit(1);
    }

    if (opts.text) {
      if (fetchResult.textContent) console.log(fetchResult.textContent);
      return;
    }

    const body = fetchResult.markdown || fetchResult.textContent || '';

    if (opts.quiet) {
      console.log(body);
      return;
    }

    // Default output: metadata + markdown
    if (fetchResult.title) console.log(`Title: ${fetchResult.title}`);
    if (fetchResult.byline) console.log(`Author: ${fetchResult.byline}`);
    if (fetchResult.siteName) console.log(`Site: ${fetchResult.siteName}`);
    if (fetchResult.publishedTime) console.log(`Published: ${fetchResult.publishedTime}`);
    if (fetchResult.lang) console.log(`Language: ${fetchResult.lang}`);
    console.log(`Fetched in ${fetchResult.latencyMs}ms`);
    console.log('---');
    console.log(body);
  } finally {
    await closeAllSessions();
  }
}

const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isDirectRun) {
  main().catch((err) => {
    console.error(`Fatal: ${err}`);
    process.exit(1);
  });
}
