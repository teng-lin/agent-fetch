/**
 * WP AJAX content extraction strategy.
 * Detects WordPress sites that load article content via AJAX POST
 * requests to admin-ajax.php and fetches it directly.
 */
import { htmlToMarkdown } from './markdown.js';
import type { ExtractionResult } from './types.js';
import { GOOD_CONTENT_LENGTH } from './types.js';
import { htmlToText, sanitizeHtml } from './utils.js';
import { logger } from '../logger.js';

export interface WpAjaxConfig {
  ajaxUrl: string;
  action: string;
  articleId: string;
}

/** Known AJAX action names used to fetch article content. */
const AJAX_ACTIONS = [
  'fetch_article_content',
  'unlock_article',
  'get_article_content',
  'fetch_content',
];

const ACTION_PATTERN = new RegExp(`action\\s*:\\s*['"]?(${AJAX_ACTIONS.join('|')})['"]?`);

/** Match AJAX URL variable assignments pointing to admin-ajax.php (requires https?://). */
const AJAX_URL_PATTERN =
  /\bajaxurl\s*=\s*['"](https?:\/\/[^'"]{1,500}\/wp-admin\/admin-ajax\.php)['"]/;

/** Match article ID assignments (UUID or numeric). */
const ARTICLE_ID_PATTERN =
  /\b(?:article_id|articleId|post_id)\s*=\s*['"]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)['"]/i;

/**
 * Detect WP AJAX content configuration from raw HTML.
 * Scans for ajaxurl, action name, and article ID in inline scripts.
 * Returns null if any required signal is missing or the AJAX URL is cross-origin.
 */
export function detectWpAjaxContent(html: string, pageUrl: string): WpAjaxConfig | null {
  try {
    const ajaxUrlMatch = AJAX_URL_PATTERN.exec(html);
    if (!ajaxUrlMatch) return null;

    const actionMatch = ACTION_PATTERN.exec(html);
    if (!actionMatch) return null;

    const articleIdMatch = ARTICLE_ID_PATTERN.exec(html);
    if (!articleIdMatch) return null;

    const ajaxUrl = ajaxUrlMatch[1];
    const action = actionMatch[1];
    const articleId = articleIdMatch[1];

    // SSRF protection: validate AJAX URL is same-origin as the page
    const pageOrigin = new URL(pageUrl).origin;
    const ajaxOrigin = new URL(ajaxUrl).origin;
    if (ajaxOrigin !== pageOrigin) {
      logger.debug({ pageUrl, ajaxUrl }, 'WP AJAX URL is cross-origin, rejecting');
      return null;
    }

    return { ajaxUrl, action, articleId };
  } catch (e) {
    logger.debug({ error: String(e) }, 'Failed to detect WP AJAX content');
    return null;
  }
}

/**
 * Parse and sanitize an AJAX response containing article HTML.
 * Strips dangerous elements, extracts text, and checks minimum content length.
 */
export function parseWpAjaxResponse(html: string, _pageUrl: string): ExtractionResult | null {
  try {
    if (!html || html.trim().length === 0) return null;

    // Try to parse as JSON first — some endpoints wrap HTML in a JSON response
    let contentHtml = html;
    try {
      const json = JSON.parse(html);
      if (typeof json === 'string') {
        contentHtml = json;
      } else if (typeof json === 'object' && json !== null) {
        // Common response shapes: { data: "<html>" }, { content: "<html>" }, { html: "<html>" }
        const candidate =
          (typeof json.data === 'string' && json.data) ||
          (typeof json.content === 'string' && json.content) ||
          (typeof json.html === 'string' && json.html);
        if (candidate) {
          contentHtml = candidate;
        }
      }
    } catch {
      // Not JSON — treat as raw HTML
    }

    const sanitizedHtml = sanitizeHtml(contentHtml);
    const textContent = htmlToText(sanitizedHtml);

    if (textContent.length < GOOD_CONTENT_LENGTH) return null;

    return {
      title: null,
      byline: null,
      content: sanitizedHtml,
      textContent,
      excerpt: null,
      siteName: null,
      publishedTime: null,
      lang: null,
      markdown: htmlToMarkdown(sanitizedHtml),
      method: 'wp-ajax-content',
    };
  } catch (e) {
    logger.debug({ error: String(e) }, 'Failed to parse WP AJAX response');
    return null;
  }
}
