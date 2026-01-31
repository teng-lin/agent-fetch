import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { z } from 'zod';
import { SiteTestConfigSchema } from './types.js';
import type { SiteTestConfig } from './types.js';

function findRepoRoot(): string {
  const gitDir = execSync('git rev-parse --git-common-dir', { encoding: 'utf-8' }).trim();
  return resolve(dirname(gitDir));
}

export function loadSiteConfigs(filePath?: string): SiteTestConfig[] {
  const resolved =
    filePath ?? process.env.SITE_FIXTURES ?? resolve(findRepoRoot(), 'site-fixtures.json');

  if (!existsSync(resolved)) return [];

  const raw = JSON.parse(readFileSync(resolved, 'utf-8'));
  return z.array(SiteTestConfigSchema).parse(raw);
}
