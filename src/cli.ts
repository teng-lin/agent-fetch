#!/usr/bin/env node
/**
 * CLI entry point for agent-fetch
 */
import { fileURLToPath } from 'url';
import { realpathSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { httpFetch } from './fetch/http-fetch.js';
import { httpRequest, closeAllSessions } from './fetch/http-client.js';

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

interface CliOptions {
  url: string;
  json: boolean;
  raw: boolean;
  quiet: boolean;
  text: boolean;
  preset?: string;
  timeout?: number;
}

type ParseResult =
  | { kind: 'ok'; opts: CliOptions; warnings: string[] }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; message: string };

export function parseArgs(args: string[]): ParseResult {
  const positional: string[] = [];
  const warnings: string[] = [];
  let json = false;
  let raw = false;
  let quiet = false;
  let text = false;
  let preset: string | undefined;
  let timeout: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--json':
        json = true;
        break;
      case '--raw':
        raw = true;
        break;
      case '-q':
      case '--quiet':
        quiet = true;
        break;
      case '--text':
        text = true;
        break;
      case '-h':
      case '--help':
        return { kind: 'help' };
      case '-v':
      case '--version':
        return { kind: 'version' };
      case '--preset':
        if (i + 1 >= args.length) {
          return { kind: 'error', message: '--preset requires a value' };
        }
        preset = args[++i];
        break;
      case '--timeout': {
        if (i + 1 >= args.length) {
          return { kind: 'error', message: '--timeout requires a value' };
        }
        const value = parseInt(args[++i], 10);
        if (isNaN(value) || value <= 0) {
          return { kind: 'error', message: '--timeout must be a positive integer (milliseconds)' };
        }
        timeout = value;
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
    return { kind: 'error', message: 'Missing required <url> argument' };
  }

  return {
    kind: 'ok',
    opts: { url: positional[0], json, raw, quiet, text, preset, timeout },
    warnings,
  };
}

function printUsage(): void {
  console.log(`Usage: agent-fetch <url> [options]

Output is markdown by default, preserving article structure (headings, links, lists).

Options:
  --json              Full JSON output (title, content, markdown, etc)
  --raw               Raw HTML output (no extraction)
  -q, --quiet         Markdown content only (no metadata)
  --text              Plain text content only (no metadata, no markdown)
  --preset <value>    TLS fingerprint preset (e.g. chrome-143, android-chrome-143, ios-safari-18)
  --timeout <ms>      Request timeout in milliseconds (default: 20000)
  -v, --version       Show version number
  -h, --help          Show this help message

Disclaimer:
  Users are responsible for complying with website terms of service,
  robots.txt directives, and applicable laws. See README for details.`);
}

export async function main(): Promise<void> {
  const result = parseArgs(process.argv.slice(2));

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
    const fetchResult = await httpFetch(opts.url, { preset: opts.preset, timeout: opts.timeout });

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
