/**
 * Post-extraction content cleanup.
 * Removes noise that Readability and other strategies leave behind:
 * duplicate preview paragraphs, image captions/credits, and non-article UI text.
 */
import { parseHTML } from 'linkedom';

export interface CleanedHtml {
  html: string;
  textContent: string;
}

const CAPTION_SELECTORS = 'figcaption, [itemprop="caption"]';

const BOILERPLATE_PATTERNS = [
  /^thank you for your patience/i,
  /^already a subscriber/i,
  /^skip advertisement$/i,
  /^advertisement$/i,
  /^subscribe for all/i,
  /^log in$/i,
];

const MAX_BOILERPLATE_LENGTH = 200;
const MIN_DEDUP_LENGTH = 80;

function stripCaptions(document: Document): void {
  for (const el of document.querySelectorAll(CAPTION_SELECTORS)) {
    el.remove();
  }
}

function isBoilerplate(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_BOILERPLATE_LENGTH) return false;
  return BOILERPLATE_PATTERNS.some((p) => p.test(trimmed));
}

function stripBoilerplate(document: Document): void {
  for (const el of document.querySelectorAll('p, span')) {
    if (isBoilerplate(el.textContent ?? '')) {
      el.remove();
    }
  }
}

/** Remove duplicate long paragraphs, keeping the later (article body) occurrence. */
function deduplicateParagraphs(document: Document): void {
  const seen = new Map<string, Element>();
  const toRemove: Element[] = [];

  for (const p of document.querySelectorAll('p')) {
    const text = (p.textContent ?? '').trim().replace(/\s+/g, ' ');
    if (text.length < MIN_DEDUP_LENGTH) continue;

    const prev = seen.get(text);
    if (prev) {
      toRemove.push(prev);
      seen.set(text, p);
    } else {
      seen.set(text, p);
    }
  }

  for (const el of toRemove) {
    el.remove();
  }
}

/** Run cleanup on a pre-parsed document (mutates in place). */
export function cleanDocument(document: Document): void {
  stripCaptions(document);
  stripBoilerplate(document);
  deduplicateParagraphs(document);
}

export function cleanExtractedHtml(html: string): CleanedHtml {
  if (!html) return { html: '', textContent: '' };

  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  cleanDocument(document);
  return {
    html: document.body.innerHTML,
    textContent: document.body.textContent?.trim() ?? '',
  };
}
