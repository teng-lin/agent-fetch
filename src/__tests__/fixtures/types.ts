import { z } from 'zod';

export const SiteTestConfigSchema = z.object({
  site: z.string(),
  technique: z.string(),
  priority: z.enum(['critical', 'important']).optional(),
  tags: z.array(z.string()).optional(),
  expectedToFail: z.boolean().optional(),
  stable: z.object({
    url: z.string(),
    minWords: z.number(),
  }),
  latest: z
    .object({
      url: z.string(),
      minWords: z.number(),
    })
    .optional(),
  fetch: z
    .object({
      minWords: z.number(),
    })
    .optional(),
});

export interface SiteTestConfig {
  site: string;
  technique: string;
  priority?: 'critical' | 'important';
  tags?: string[];
  expectedToFail?: boolean;
  stable: {
    url: string;
    minWords: number;
  };
  latest?: {
    url: string;
    minWords: number;
  };
  /** HTTP-only fetch test configuration. Sites without this field are skipped by fetch e2e. */
  fetch?: {
    minWords: number;
  };
}

export interface TestCase {
  site: string;
  url: string;
  minWords: number;
  technique: string;
  priority?: 'critical' | 'important';
  tags?: string[];
  expectedToFail?: boolean;
}
