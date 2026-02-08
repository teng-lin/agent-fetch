import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { logger } from '../logger.js';

function createTurndownService(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });
  td.use(gfm);
  td.remove(['script', 'style']);
  return td;
}

/** Module-level singleton — created once and reused across all calls. */
const turndown = createTurndownService();

export function htmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return '';
  try {
    return turndown.turndown(html);
  } catch (e) {
    logger.debug({ error: String(e), htmlLength: html.length }, 'Turndown conversion failed');
    return '';
  }
}
