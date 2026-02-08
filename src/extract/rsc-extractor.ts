/**
 * Strategy 6: Extract from Next.js RSC (React Server Components) streaming payload.
 * App Router pages embed article text inside self.__next_f.push() script calls
 * rather than rendering it into the DOM.
 */
import { parseHTML } from 'linkedom';

import { type ExtractionResult, MIN_CONTENT_LENGTH } from './types.js';
import {
  extractPublishedTime,
  extractTitle,
  extractSiteName,
  generateExcerpt,
} from './metadata-extractors.js';
import { logger } from '../logger.js';

/** Minimum length for RSC text segments to be considered article content */
const RSC_MIN_SEGMENT_LENGTH = 100;

/**
 * Check whether a string looks like natural language (not HTML/JS).
 */
function isNaturalLanguage(text: string): boolean {
  const len = text.length;
  if (len === 0) return false;

  // Reject HTML-heavy content (more than 1 tag per 100 chars)
  const tagCount = text.split('<').length - 1;
  if (tagCount > len / 100) return false;

  // Reject JS-heavy content
  if (text.includes('function(') || text.includes('function (')) return false;
  const arrowCount = text.split('=>').length - 1;
  if (arrowCount > 3) return false;

  // Must have word-like content: spaces between words
  const spaceCount = text.split(' ').length - 1;
  return spaceCount / len > 0.1;
}

export function tryNextRscExtraction(html: string, url: string): ExtractionResult | null {
  try {
    if (!html.includes('self.__next_f.push(')) return null;

    // Extract all self.__next_f.push([...]) calls, anchored on </script> boundary
    const pushPattern = /self\.__next_f\.push\(([\s\S]*?)\)<\/script>/g;
    const chunks: string[] = [];
    let match;
    while ((match = pushPattern.exec(html)) !== null) {
      try {
        const arr = JSON.parse(match[1]);
        if (Array.isArray(arr) && arr[0] === 1 && typeof arr[1] === 'string') {
          chunks.push(arr[1]);
        }
      } catch {
        // Skip malformed JSON (some chunks contain unescaped JS)
      }
    }

    if (chunks.length === 0) return null;

    // Concatenate all type-1 chunks into a single stream
    const stream = chunks.join('');

    // Extract text segments from RSC T markers: id:Thexlen,<content>
    const textSegments: string[] = [];
    const tMarkerPattern = /[0-9a-f]+:T[0-9a-f]+,/g;
    let tMatch;
    const tPositions: number[] = [];
    while ((tMatch = tMarkerPattern.exec(stream)) !== null) {
      tPositions.push(tMatch.index + tMatch[0].length);
    }

    // For each T marker, extract text until next RSC row prefix or end
    const rowPrefixPattern = /\n[0-9a-f]+:[A-Z["$]/;
    for (const pos of tPositions) {
      const rest = stream.slice(pos);
      const nextRow = rest.search(rowPrefixPattern);
      const segment = nextRow === -1 ? rest : rest.slice(0, nextRow);

      if (segment.length >= RSC_MIN_SEGMENT_LENGTH && isNaturalLanguage(segment)) {
        textSegments.push(segment.trim());
      }
    }

    // Also check for continuation chunks (raw text with no row prefix)
    for (const chunk of chunks) {
      if (
        chunk.length >= RSC_MIN_SEGMENT_LENGTH &&
        !/^[0-9a-f]+:/.test(chunk) &&
        isNaturalLanguage(chunk)
      ) {
        textSegments.push(chunk.trim());
      }
    }

    // Deduplicate (continuation chunks may overlap with T marker extraction)
    const unique = [...new Set(textSegments)];
    const textContent = unique.join('\n\n');

    if (textContent.length < MIN_CONTENT_LENGTH) return null;

    const { document } = parseHTML(html);

    return {
      title: extractTitle(document),
      byline: null,
      content: textContent,
      textContent,
      excerpt: generateExcerpt(null, textContent),
      siteName: extractSiteName(document),
      publishedTime: extractPublishedTime(document),
      lang: document.documentElement.lang || null,
      method: 'next-rsc',
    };
  } catch (e) {
    logger.debug({ url, error: String(e) }, 'Next.js RSC extraction failed');
    return null;
  }
}
