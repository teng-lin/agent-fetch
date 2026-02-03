#!/usr/bin/env node
/**
 * CLI entry point for lynxget
 */
import { fileURLToPath } from 'url';
import { httpFetch } from './fetch/http-fetch.js';
import { httpRequest, closeAllSessions } from './fetch/http-client.js';
import { detectFromResponse, detectFromHtml, mergeDetections } from './antibot/detector.js';

interface CliOptions {
  url: string;
  json: boolean;
  raw: boolean;
  detect: boolean;
  quiet: boolean;
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
  let detect = false;
  let quiet = false;
  let preset: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if (arg === '--raw') raw = true;
    else if (arg === '--detect') detect = true;
    else if (arg === '-q' || arg === '--quiet') quiet = true;
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
      detect,
      quiet,
      preset: preset ?? process.env.LYNXGET_PRESET,
    },
  };
}

function printUsage(): void {
  console.log(`Usage: lynxget <url> [options]

Options:
  --json              Full JSON output (title, content, antibot detections, etc)
  --raw               Raw HTML output (no extraction)
  --detect            Show antibot detection only
  -q, --quiet         Text content only (no metadata)
  --preset <value>    TLS fingerprint preset (e.g. chrome-143, android-chrome-143, ios-safari-18)
  -h, --help          Show this help message

Environment:
  LYNXGET_PRESET      Default TLS preset (overridden by --preset flag)`);
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

    // --detect mode: antibot detection only
    if (opts.detect) {
      const response = await httpRequest(opts.url, {}, opts.preset);
      const cookieStrings = response.cookies.map((c) => `${c.name}=${c.value}`);
      const responseDetections = detectFromResponse(response.headers, cookieStrings);
      const htmlDetections = detectFromHtml(response.html || '');
      const all = mergeDetections(responseDetections, htmlDetections);

      if (all.length === 0) {
        console.log('No antibot providers detected');
      } else {
        console.log(JSON.stringify({ detections: all }, null, 2));
      }
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
      if (fetchResult.antibot && fetchResult.antibot.length > 0) {
        console.error(
          `\nAntibot: ${fetchResult.antibot.map((d) => `${d.name} (${d.confidence}%)`).join(', ')}`
        );
      }
      process.exit(1);
    }

    if (opts.quiet) {
      if (fetchResult.textContent) console.log(fetchResult.textContent);
      return;
    }

    // Default output: metadata + text
    if (fetchResult.title) console.log(`Title: ${fetchResult.title}`);
    if (fetchResult.byline) console.log(`Author: ${fetchResult.byline}`);
    if (fetchResult.siteName) console.log(`Site: ${fetchResult.siteName}`);
    if (fetchResult.publishedTime) console.log(`Published: ${fetchResult.publishedTime}`);
    if (fetchResult.lang) console.log(`Language: ${fetchResult.lang}`);
    if (fetchResult.antibot && fetchResult.antibot.length > 0) {
      console.log(
        `Antibot: ${fetchResult.antibot.map((d) => `${d.name} (${d.confidence}%)`).join(', ')}`
      );
    }
    console.log(`Fetched in ${fetchResult.latencyMs}ms`);
    console.log('---');
    if (fetchResult.textContent) console.log(fetchResult.textContent);
  } finally {
    await closeAllSessions();
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((err) => {
    console.error(`Fatal: ${err}`);
    process.exit(1);
  });
}
