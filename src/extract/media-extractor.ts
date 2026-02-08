/**
 * Media extraction from HTML content.
 * Extracts images, documents, videos, and audio in document order.
 */
import { parseHTML } from 'linkedom';
import type { MediaElement } from './types.js';
import { logger } from '../logger.js';

/**
 * Resolve a potentially relative URL against a base URL.
 * Returns null if the URL is invalid or empty.
 */
function resolveUrl(url: string | null | undefined, baseUrl: string): string | null {
  if (!url) return null;
  try {
    return new URL(url, baseUrl).href;
  } catch (e) {
    logger.debug({ url, baseUrl, error: String(e) }, 'URL resolution failed');
    return null;
  }
}

/**
 * Helper to add media to the result array if not already seen.
 * Returns true if the media was added.
 */
function addIfUnseen(
  media: MediaElement[],
  seen: Set<string>,
  url: string | null,
  element: MediaElement
): boolean {
  if (!url || seen.has(url)) return false;
  seen.add(url);
  media.push(element);
  return true;
}

/** Image types we prefer (skip avif for broader compatibility) */
const COMPATIBLE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Document extensions to detect */
const DOCUMENT_EXTENSIONS = new Set([
  // Documents
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  // Data
  '.csv',
  '.json',
  '.xml',
  // Text
  '.txt',
  '.md',
  '.rtf',
]);

/**
 * Check if href points to a document and return its extension.
 * Returns null if not a document link.
 * Uses a dummy base URL to parse relative paths like "/report.pdf".
 */
function getDocumentExtension(href: string | null): string | null {
  if (!href) return null;

  try {
    const pathname = new URL(href, 'http://example.com').pathname;
    const lastDot = pathname.lastIndexOf('.');
    if (lastDot === -1) return null;

    const ext = pathname.slice(lastDot).toLowerCase();
    return DOCUMENT_EXTENSIONS.has(ext) ? ext : null;
  } catch (e) {
    logger.debug({ href, error: String(e) }, 'Failed to parse href in getDocumentExtension');
    return null;
  }
}

/**
 * Parse video embed URLs from iframes (YouTube, Vimeo).
 * Returns normalized watch/view URL and provider name.
 */
function parseVideoEmbed(src: string | null): { src: string; provider: string } | null {
  if (!src) return null;

  // YouTube: youtube.com/embed/ID or youtu.be/ID
  const ytMatch = src.match(/(?:youtube\.com\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]+)/);
  if (ytMatch) {
    return {
      src: `https://www.youtube.com/watch?v=${ytMatch[1]}`,
      provider: 'youtube',
    };
  }

  // Vimeo: player.vimeo.com/video/ID or vimeo.com/video/ID
  const vimeoMatch = src.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vimeoMatch) {
    return {
      src: `https://vimeo.com/${vimeoMatch[1]}`,
      provider: 'vimeo',
    };
  }

  return null;
}

/**
 * Parse srcset and return the URL with the largest descriptor.
 * Prefers width descriptors (w) over density descriptors (x) when present.
 * Within each type, picks the largest value.
 */
function parseSrcsetLargest(srcset: string | null): string | null {
  if (!srcset) return null;

  const candidates = srcset
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let bestUrl: string | null = null;
  let bestW = 0;
  let bestX = 0;
  let hasW = false;

  for (const candidate of candidates) {
    const parts = candidate.split(/\s+/);
    const url = parts[0];
    const descriptor = parts[1] || '1x';

    const wMatch = descriptor.match(/^(\d+)w$/i);
    const xMatch = descriptor.match(/^(\d+(?:\.\d+)?)x$/i);

    if (wMatch) {
      hasW = true;
      const w = parseInt(wMatch[1], 10);
      if (w > bestW) {
        bestW = w;
        bestUrl = url;
      }
    } else if (xMatch && !hasW) {
      // Only consider x descriptors if we haven't seen any w descriptors
      const x = parseFloat(xMatch[1]);
      if (x > bestX) {
        bestX = x;
        bestUrl = url;
      }
    } else if (!bestUrl) {
      // No descriptor, use as fallback
      bestUrl = url;
    }
  }

  return bestUrl;
}

/**
 * Get the best image source, handling <picture> srcset.
 * Prefers compatible image types and largest resolution.
 */
function getBestImageSrc(img: Element): string | null {
  const picture =
    img.parentElement?.tagName?.toUpperCase() === 'PICTURE' ? img.parentElement : null;

  if (!picture) {
    // Simple <img> - prefer srcset's largest, fall back to src
    const srcset = img.getAttribute('srcset');
    return parseSrcsetLargest(srcset) || img.getAttribute('src');
  }

  // <picture> element - find best <source>
  const sources = Array.from(picture.querySelectorAll('source'));

  for (const source of sources) {
    const srcset = source.getAttribute('srcset');
    if (srcset) {
      // Prefer compatible types (skip avif for broader support)
      const type = source.getAttribute('type');
      if (!type || COMPATIBLE_IMAGE_TYPES.has(type)) {
        const best = parseSrcsetLargest(srcset);
        if (best) return best;
      }
    }
  }

  // Fallback to <img> src
  return img.getAttribute('src');
}

/** Extract media from a pre-parsed DOM element, deduplicating by resolved URL. */
export function extractMediaFromElement(root: Element, baseUrl: string): MediaElement[] {
  const media: MediaElement[] = [];
  const seen = new Set<string>();

  const walker = root.ownerDocument.createTreeWalker(root, 1); // 1 = NodeFilter.SHOW_ELEMENT

  let node: Node | null = walker.currentNode;
  while (node) {
    const el = node as Element;
    const tagName = el.tagName?.toUpperCase();

    switch (tagName) {
      case 'IMG': {
        const src = resolveUrl(getBestImageSrc(el), baseUrl);
        if (src) {
          const alt = el.getAttribute('alt');
          addIfUnseen(media, seen, src, {
            type: 'image',
            src,
            alt: alt || undefined,
          });
        }
        break;
      }

      case 'A': {
        const href = el.getAttribute('href');
        const ext = getDocumentExtension(href);
        if (ext) {
          const resolved = resolveUrl(href, baseUrl);
          if (resolved) {
            addIfUnseen(media, seen, resolved, {
              type: 'document',
              href: resolved,
              text: el.textContent?.trim() || undefined,
              extension: ext,
            });
          }
        }
        break;
      }

      case 'VIDEO': {
        const src = resolveUrl(el.getAttribute('src'), baseUrl);
        if (src) {
          addIfUnseen(media, seen, src, { type: 'video', src });
        }
        break;
      }

      case 'IFRAME': {
        const videoInfo = parseVideoEmbed(el.getAttribute('src'));
        if (videoInfo) {
          addIfUnseen(media, seen, videoInfo.src, {
            type: 'video',
            src: videoInfo.src,
            provider: videoInfo.provider,
          });
        }
        break;
      }

      case 'AUDIO': {
        const src = resolveUrl(el.getAttribute('src'), baseUrl);
        if (src) {
          addIfUnseen(media, seen, src, { type: 'audio', src });
        }
        break;
      }
    }

    node = walker.nextNode();
  }

  return media;
}

export function extractMedia(contentHtml: string, baseUrl: string): MediaElement[] {
  try {
    const { document } = parseHTML(`<div>${contentHtml}</div>`);
    const root = document.querySelector('div');
    if (!root) return [];
    return extractMediaFromElement(root, baseUrl);
  } catch (e) {
    logger.debug({ baseUrl, error: String(e) }, 'Media extraction failed');
    return [];
  }
}
