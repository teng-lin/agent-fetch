import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { SiteTestConfigSchema } from './types.js';
import type { SiteTestConfig } from './types.js';
import { getDatabasePath } from '../db-utils.js';

/** Project root, derived from the same location as e2e.db */
const PROJECT_ROOT = path.dirname(getDatabasePath());

export function loadSiteConfigs(filePath?: string): SiteTestConfig[] {
  const resolved =
    filePath ??
    process.env.AGENT_FETCH_E2E_FIXTURES ??
    path.join(PROJECT_ROOT, 'e2e-fixtures.json');
  if (!existsSync(resolved)) return [];

  const raw = JSON.parse(readFileSync(resolved, 'utf-8'));
  return z.array(SiteTestConfigSchema).parse(raw);
}
