#!/usr/bin/env node
/**
 * lynxget CLI - stealth fetch with content extraction and antibot detection
 *
 * Usage:
 *   lynxget <url>             Extract article text
 *   lynxget <url> --json      Full JSON output (title, content, antibot, etc)
 *   lynxget <url> --raw       Raw HTML (no extraction)
 *   lynxget <url> --detect    Show antibot detection only
 *   lynxget <url> -q          Quiet (text content only, no metadata)
 */
import 'dotenv/config';
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

  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg === '--raw') raw = true;
    else if (arg === '--detect') detect = true;
    else if (arg === '-q' || arg === '--quiet') quiet = true;
    else if (arg === '--help' || arg === '-h') return { kind: 'help' };
    else if (!arg.startsWith('-')) positional.push(arg);
  }

  if (positional.length === 0) {
    return { kind: 'error', message: 'Missing required <url> argument' };
  }

  return { kind: 'ok', opts: { url: positional[0], json, raw, detect, quiet } };
}

function printUsage(): void {
  console.log(`Usage: lynxget <url> [options]

Options:
  --json      Full JSON output (title, content, antibot detections, etc)
  --raw       Raw HTML output (no extraction)
  --detect    Show antibot detection only
  -q, --quiet Text content only (no metadata)
  -h, --help  Show this help message`);
}

export async function main(): Promise<void> {
  const result = parseArgs(process.argv.slice(2));

  if (result.kind !== 'ok') {
    printUsage();
    process.exit(result.kind === 'help' ? 0 : 1);
  }

  const opts = result.opts;

  try {
    // --raw mode: fetch HTML without extraction
    if (opts.raw) {
      const response = await httpRequest(opts.url);
      if (response.html) {
        process.stdout.write(response.html);
      } else {
        console.error(`Error: ${response.error || `HTTP ${response.statusCode}`}`);
        process.exit(1);
      }
      return;
    }

    // --detect mode: antibot detection only
    if (opts.detect) {
      const response = await httpRequest(opts.url);
      const cookieStrings = response.cookies.map((c) => `${c.name}=${c.value}`);
      const responseDetections = detectFromResponse(response.headers, cookieStrings);
      const htmlDetections = response.html ? detectFromHtml(response.html) : [];
      const detections = mergeDetections(responseDetections, htmlDetections);

      if (opts.json) {
        console.log(JSON.stringify({ url: opts.url, detections }, null, 2));
      } else if (detections.length === 0) {
        console.log('No antibot protection detected.');
      } else {
        console.log(`Antibot detections for ${opts.url}:\n`);
        for (const d of detections) {
          console.log(`  ${d.name} (${d.category})`);
          console.log(`    Confidence: ${d.confidence}%`);
          console.log(`    Action: ${d.suggestedAction}`);
          console.log(`    Evidence: ${d.evidence.join(', ')}`);
          console.log('');
        }
      }
      return;
    }

    // Default: fetch + extract
    const fetchResult = await httpFetch(opts.url);

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
