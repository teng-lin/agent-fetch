/**
 * Strategy 4: Extract from Next.js __NEXT_DATA__
 * Some sites embed full article content in the page props JSON.
 */
import { parseHTML } from 'linkedom';

import { type ExtractionResult, MIN_CONTENT_LENGTH } from './types.js';
import {
  extractPublishedTime,
  extractTitle,
  extractSiteName,
  generateExcerpt,
} from './metadata-extractors.js';
import { getNestedValue, sanitizeHtml } from './utils.js';
import { getSiteNextDataPath } from '../sites/site-config.js';
import { logger } from '../logger.js';

/**
 * Extract text content from HTML string
 */
function extractTextFromHtml(html: string): string {
  // Wrap in full HTML structure so linkedom parses correctly
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  return document.body.textContent?.trim() ?? '';
}

/**
 * Extract byline from an authors array
 */
function extractBylineFromAuthors(authors: unknown): string | null {
  if (!Array.isArray(authors) || authors.length === 0) return null;
  const names = authors
    .map((author: unknown) => {
      if (
        author &&
        typeof author === 'object' &&
        'name' in author &&
        typeof (author as { name: unknown }).name === 'string'
      ) {
        return (author as { name: string }).name;
      }
      return null;
    })
    .filter((name): name is string => name !== null && name.length > 0);
  return names.length > 0 ? names.join(', ') : null;
}

/**
 * Content block with type and text/textHtml fields
 */
interface ContentBlock {
  type?: string;
  text?: string;
  textHtml?: string;
  components?: ContentBlock[];
  items?: ContentBlock[];
}

/**
 * Extract text from an array of content blocks.
 * Handles structures where body is an array of typed blocks with text/textHtml fields.
 */
function extractTextFromContentBlocks(blocks: ContentBlock[]): string {
  const textParts: string[] = [];

  function processBlock(block: ContentBlock): void {
    if (!block || typeof block !== 'object') return;
    const blockType = typeof block.type === 'string' ? block.type.toUpperCase() : undefined;

    // Extract text from paragraph-like blocks
    if (blockType === 'PARAGRAPH' || blockType === 'HEADING' || blockType === 'SUBHEADING') {
      const text = block.text ?? (block.textHtml ? extractTextFromHtml(block.textHtml) : '');
      if (text) {
        textParts.push(text);
        textParts.push('\n\n');
      }
      return;
    }

    // Handle list items
    if (blockType === 'UNORDERED_LIST' || blockType === 'ORDERED_LIST') {
      if (Array.isArray(block.items)) {
        for (const item of block.items) {
          if (!item || typeof item !== 'object') continue;
          const text = item.text ?? (item.textHtml ? extractTextFromHtml(item.textHtml) : '');
          if (text) {
            textParts.push(`• ${text}\n`);
          }
        }
        textParts.push('\n');
      }
      return;
    }

    // Recurse into nested components (e.g., INFOBOX)
    if (Array.isArray(block.components)) {
      for (const component of block.components) {
        processBlock(component);
      }
    }
  }

  for (const block of blocks) {
    processBlock(block);
  }

  return textParts.join('').trim();
}

/**
 * Common paths where Next.js sites store article content as arrays of content blocks.
 * These are probed in order when no site-specific config exists.
 */
const NEXT_DATA_CONTENT_PATHS = [
  'props.pageProps.content.body',
  'props.pageProps.article.body',
  'props.pageProps.article.content',
  'props.pageProps.post.body',
  'props.pageProps.post.content',
  'props.pageProps.data.body',
];

/**
 * Check if a value looks like an array of content blocks (has objects with type/text fields).
 */
function isContentBlockArray(value: unknown): value is ContentBlock[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  // Check first few items for content block structure
  const sample = value.slice(0, 5);
  return sample.some(
    (item) =>
      item && typeof item === 'object' && ('type' in item || 'text' in item || 'textHtml' in item)
  );
}

/**
 * Try to extract metadata for content block arrays from various pageProps locations.
 */
function extractContentBlockMetadata(
  pageProps: Record<string, unknown>,
  document: Document
): {
  title: string | null;
  byline: string | null;
  excerpt: string | null;
  publishedTime: string | null;
} {
  // Try content.headline, article.headline, post.title, etc.
  const content = pageProps.content as Record<string, unknown> | undefined;
  const article = pageProps.article as Record<string, unknown> | undefined;
  const post = pageProps.post as Record<string, unknown> | undefined;

  const title =
    (content?.headline as string) ??
    (article?.headline as string) ??
    (article?.title as string) ??
    (post?.title as string) ??
    (pageProps.title as string) ??
    extractTitle(document);

  const byline =
    extractBylineFromAuthors(content?.authors) ??
    extractBylineFromAuthors(article?.authors) ??
    extractBylineFromAuthors(post?.authors) ??
    (pageProps.author as { name?: string })?.name ??
    null;

  const excerpt =
    (content?.description as string) ??
    (article?.description as string) ??
    (article?.excerpt as string) ??
    (post?.excerpt as string) ??
    (pageProps.description as string) ??
    null;

  const publishedTime =
    (content?.datePublished as string) ??
    (article?.datePublished as string) ??
    (article?.publishedAt as string) ??
    (post?.date as string) ??
    (pageProps.publishedAt as string) ??
    extractPublishedTime(document);

  return { title, byline, excerpt, publishedTime };
}

/**
 * Try to extract an ExtractionResult from a string body (HTML or plain text).
 * Shared by both the custom-path and auto-detect branches of tryNextDataExtraction.
 */
function tryStringBodyExtraction(
  content: string,
  meta: Record<string, unknown>,
  document: Document
): ExtractionResult | null {
  if (content.length < MIN_CONTENT_LENGTH) return null;

  const isHtml = /<(?:p|div)>/.test(content);
  const sanitized = isHtml ? sanitizeHtml(content) : content;
  const textContent = isHtml ? extractTextFromHtml(sanitized) : content;
  if (textContent.length < MIN_CONTENT_LENGTH) return null;

  return {
    title: (meta.headline as string) ?? (meta.title as string) ?? extractTitle(document),
    byline: extractBylineFromAuthors(meta.authors) ?? (meta.byline as string) ?? null,
    content: isHtml ? sanitized : textContent,
    textContent,
    excerpt:
      (meta.description as string) ??
      (meta.excerpt as string) ??
      generateExcerpt(null, textContent),
    siteName: extractSiteName(document),
    publishedTime:
      (meta.datePublished as string) ??
      (meta.publishedAt as string) ??
      extractPublishedTime(document),
    lang: document.documentElement.lang || 'en',
    method: isHtml ? 'next-data-html' : 'next-data',
  };
}

/**
 * Strategy 4: Extract from Next.js __NEXT_DATA__
 * Some sites embed full article content in the page props JSON.
 * Supports three modes (tried in order):
 * 1. Site-specific: Use nextDataPath config to specify custom JSON path
 * 2. Auto-detect: Probe common content paths for content block arrays or string bodies
 * 3. Default: Look for story.body.content structured blocks
 */
export function tryNextDataExtraction(document: Document, url: string): ExtractionResult | null {
  try {
    const script = document.querySelector('script#__NEXT_DATA__');
    if (!script?.textContent) return null;

    const data = JSON.parse(script.textContent);
    const pageProps = data?.props?.pageProps;
    if (!pageProps) return null;

    // Try site-specific path first
    const customPath = getSiteNextDataPath(url);
    if (customPath) {
      const content = getNestedValue(data, customPath);

      // Handle array of content blocks
      if (Array.isArray(content)) {
        const textContent = extractTextFromContentBlocks(
          content.filter((item): item is ContentBlock => item && typeof item === 'object')
        );
        if (textContent.length >= MIN_CONTENT_LENGTH) {
          logger.debug(
            { url, path: customPath },
            'Next.js custom path (array) extraction succeeded'
          );
          // Extract metadata from content structure
          const contentMeta = pageProps.content ?? {};
          return {
            title: contentMeta.headline ?? pageProps.title ?? extractTitle(document),
            byline: extractBylineFromAuthors(contentMeta.authors) ?? pageProps.author?.name ?? null,
            content: textContent,
            textContent,
            excerpt:
              contentMeta.description ??
              pageProps.teaser_body ??
              generateExcerpt(null, textContent),
            siteName: extractSiteName(document),
            publishedTime:
              contentMeta.datePublished ??
              pageProps.publishedAt ??
              pageProps.changed_formatted ??
              extractPublishedTime(document),
            lang: document.documentElement.lang || 'en',
            method: 'next-data',
          };
        }
      }

      // Handle string content (HTML or plain text)
      if (typeof content === 'string') {
        // Map pageProps fields to the generic metadata shape expected by tryStringBodyExtraction
        const meta: Record<string, unknown> = {
          title: pageProps.title,
          byline: pageProps.author?.name ?? null,
          description: pageProps.teaser_body ?? pageProps.description,
          publishedAt: pageProps.publishedAt ?? pageProps.changed_formatted,
        };
        const result = tryStringBodyExtraction(content, meta, document);
        if (result) {
          logger.debug({ url, path: customPath }, 'Next.js custom path extraction succeeded');
          return result;
        }
      }
    }

    // Auto-detect: Probe common content paths for content block arrays or string bodies
    for (const path of NEXT_DATA_CONTENT_PATHS) {
      const content = getNestedValue(data, path);
      if (isContentBlockArray(content)) {
        const textContent = extractTextFromContentBlocks(
          content.filter((item): item is ContentBlock => item && typeof item === 'object')
        );
        if (textContent.length >= MIN_CONTENT_LENGTH) {
          logger.debug({ url, path }, 'Next.js auto-detected content path extraction succeeded');
          const meta = extractContentBlockMetadata(pageProps as Record<string, unknown>, document);
          return {
            title: meta.title ?? extractTitle(document),
            byline: meta.byline,
            content: textContent,
            textContent,
            excerpt: meta.excerpt ?? generateExcerpt(null, textContent),
            siteName: extractSiteName(document),
            publishedTime: meta.publishedTime ?? extractPublishedTime(document),
            lang: document.documentElement.lang || 'en',
            method: 'next-data',
          };
        }
      }

      // Handle string content (HTML or plain text)
      if (typeof content === 'string') {
        const parentPath = path.split('.').slice(0, -1).join('.');
        const parent = (getNestedValue(data, parentPath) ?? {}) as Record<string, unknown>;
        // Fall back to pageProps.title when parent has no title fields
        const metaWithFallback = { ...parent, title: parent.title ?? pageProps.title };
        const result = tryStringBodyExtraction(content, metaWithFallback, document);
        if (result) {
          logger.debug({ url, path }, 'Next.js auto-detected string content extraction succeeded');
          return result;
        }
      }
    }

    // Default: Try story.body.content structured blocks
    const story = pageProps?.story;
    if (!story?.body?.content) return null;

    // Extract text from the structured content
    const textParts: string[] = [];

    function extractText(node: unknown): void {
      if (!node || typeof node !== 'object') return;

      const obj = node as Record<string, unknown>;

      // Handle text nodes
      if (obj.type === 'text' && typeof obj.value === 'string') {
        textParts.push(obj.value);
        return;
      }

      // Skip non-content types
      const skipTypes = ['inline-newsletter', 'ad', 'related-content', 'inline-recirc'];
      if (typeof obj.type === 'string' && skipTypes.includes(obj.type)) {
        return;
      }

      // Add newlines after paragraphs
      if (obj.type === 'paragraph') {
        if (Array.isArray(obj.content)) {
          obj.content.forEach(extractText);
        }
        textParts.push('\n\n');
        return;
      }

      // Recurse into content arrays
      if (Array.isArray(obj.content)) {
        obj.content.forEach(extractText);
      }
    }

    // Process all content blocks
    if (Array.isArray(story.body.content)) {
      story.body.content.forEach(extractText);
    }

    const textContent = textParts.join('').trim();
    if (textContent.length < MIN_CONTENT_LENGTH) return null;

    // Extract author
    let byline: string | null = null;
    if (Array.isArray(story.authors) && story.authors.length > 0) {
      byline = story.authors
        .map((a: { name?: string }) => a.name)
        .filter(Boolean)
        .join(', ');
    }

    return {
      title: story.headline ?? story.title ?? extractTitle(document),
      byline,
      content: textContent,
      textContent,
      excerpt: story.abstract?.[0] ?? generateExcerpt(null, textContent),
      siteName: extractSiteName(document),
      publishedTime: story.publishedAt ?? extractPublishedTime(document),
      lang: document.documentElement.lang || 'en',
      method: 'next-data',
    };
  } catch (e) {
    logger.debug({ url, error: String(e) }, 'Next.js data extraction failed');
    return null;
  }
}

/**
 * Extract the Next.js buildId from a __NEXT_DATA__ script tag.
 * Returns null if the page is not a Next.js page or has no buildId.
 */
export function extractNextBuildId(document: Document): string | null {
  try {
    const script = document.querySelector('script#__NEXT_DATA__');
    if (!script?.textContent) return null;
    const data = JSON.parse(script.textContent);
    const buildId = data?.buildId;
    return typeof buildId === 'string' && /^[\w-]+$/.test(buildId) ? buildId : null;
  } catch {
    return null;
  }
}
