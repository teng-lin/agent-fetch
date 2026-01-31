import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { logger } from '../logger.js';

const turndown = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined',
});

turndown.use(gfm);

// Remove script and style elements (Turndown keeps their text content by default)
turndown.remove(['script', 'style']);

export function htmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return '';
  try {
    return turndown.turndown(html);
  } catch (e) {
    logger.debug({ error: String(e), htmlLength: html.length }, 'Turndown conversion failed');
    return '';
  }
}
