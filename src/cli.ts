#!/usr/bin/env node
/**
 * CLI entry point for agent-fetch
 */
import { fileURLToPath } from 'url';
import { realpathSync } from 'fs';
import { httpFetch } from './fetch/http-fetch.js';
import { httpRequest, closeAllSessions } from './fetch/http-client.js';

interface CliOptions {
  url: string;
  json: boolean;
  raw: boolean;
  quiet: boolean;
  text: boolean;
  preset?: string;
}

type ParseResult =
  | { kind: 'ok'; opts: CliOptions }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

export function parseArgs(args: string[]): ParseResult {
  const positional: string[] = [];
  let json = false;
  let raw = false;
  let quiet = false;
  let text = false;
  let preset: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if (arg === '--raw') raw = true;
    else if (arg === '-q' || arg === '--quiet') quiet = true;
    else if (arg === '--text') text = true;
    else if (arg === '--help' || arg === '-h') return { kind: 'help' };
    else if (arg === '--preset') {
      if (i + 1 >= args.length) return { kind: 'error', message: '--preset requires a value' };
      preset = args[++i];
    } else if (!arg.startsWith('-')) positional.push(arg);
  }

  if (positional.length === 0) {
    return { kind: 'error', message: 'Missing required <url> argument' };
  }

  return {
    kind: 'ok',
    opts: {
      url: positional[0],
      json,
      raw,
      quiet,
      text,
      preset,
    },
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
  -h, --help          Show this help message`);
}

export async function main(): Promise<void> {
  const result = parseArgs(process.argv.slice(2));

  if (result.kind !== 'ok') {
    if (result.kind === 'error') console.error(`Error: ${result.message}`);
    printUsage();
    process.exit(result.kind === 'help' ? 0 : 1);
  }

  const opts = result.opts;

  try {
    // --raw mode: fetch HTML without extraction
    if (opts.raw) {
      const response = await httpRequest(opts.url, {}, opts.preset);
      if (response.statusCode !== 200) {
        console.error(`HTTP ${response.statusCode}`);
        process.exit(1);
      }
      console.log(response.html);
      return;
    }

    // Default: fetch + extract
    const fetchResult = await httpFetch(opts.url, { preset: opts.preset });

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
