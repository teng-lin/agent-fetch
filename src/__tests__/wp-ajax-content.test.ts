import { describe, it, expect } from 'vitest';
import { detectWpAjaxContent, parseWpAjaxResponse } from '../extract/wp-ajax-content.js';

describe('extract/wp-ajax-content', () => {
  describe('detectWpAjaxContent', () => {
    const pageUrl = 'https://www.example.com/news/some-article';

    const buildHtml = (opts: { ajaxUrl?: string; action?: string; articleId?: string }) => {
      const ajaxLine = opts.ajaxUrl ? `var ajaxurl = '${opts.ajaxUrl}';` : '';
      const actionLine = opts.action
        ? `jQuery.ajax({ action: '${opts.action}', data: {id: articleId} });`
        : '';
      const idLine = opts.articleId ? `let article_id = "${opts.articleId}";` : '';
      return `<html><head><script>${ajaxLine}\n${idLine}\n${actionLine}</script></head><body></body></html>`;
    };

    it('detects standard pattern (ajaxurl + action + UUID)', () => {
      const html = buildHtml({
        ajaxUrl: 'https://www.example.com/wp-admin/admin-ajax.php',
        action: 'fetch_article_content',
        articleId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      });
      const result = detectWpAjaxContent(html, pageUrl);
      expect(result).toEqual({
        ajaxUrl: 'https://www.example.com/wp-admin/admin-ajax.php',
        action: 'fetch_article_content',
        articleId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      });
    });

    it('detects numeric article ID', () => {
      const html = buildHtml({
        ajaxUrl: 'https://www.example.com/wp-admin/admin-ajax.php',
        action: 'fetch_article_content',
        articleId: '12345',
      });
      const result = detectWpAjaxContent(html, pageUrl);
      expect(result).not.toBeNull();
      expect(result!.articleId).toBe('12345');
    });

    it('returns null when ajaxurl is missing', () => {
      const html = buildHtml({
        action: 'fetch_article_content',
        articleId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      });
      expect(detectWpAjaxContent(html, pageUrl)).toBeNull();
    });

    it('returns null when action is missing', () => {
      const html = buildHtml({
        ajaxUrl: 'https://www.example.com/wp-admin/admin-ajax.php',
        articleId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      });
      expect(detectWpAjaxContent(html, pageUrl)).toBeNull();
    });

    it('returns null when article ID is missing', () => {
      const html = buildHtml({
        ajaxUrl: 'https://www.example.com/wp-admin/admin-ajax.php',
        action: 'fetch_article_content',
      });
      expect(detectWpAjaxContent(html, pageUrl)).toBeNull();
    });

    it('rejects cross-origin AJAX URLs', () => {
      const html = buildHtml({
        ajaxUrl: 'https://evil.example.com/wp-admin/admin-ajax.php',
        action: 'fetch_article_content',
        articleId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      });
      expect(detectWpAjaxContent(html, pageUrl)).toBeNull();
    });

    it('handles alternative action names', () => {
      for (const action of ['unlock_article', 'get_article_content', 'fetch_content']) {
        const html = buildHtml({
          ajaxUrl: 'https://www.example.com/wp-admin/admin-ajax.php',
          action,
          articleId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        });
        const result = detectWpAjaxContent(html, pageUrl);
        expect(result).not.toBeNull();
        expect(result!.action).toBe(action);
      }
    });

    it('handles variable naming variants', () => {
      // articleId variant
      const html1 = `<html><script>
        var ajaxurl = 'https://www.example.com/wp-admin/admin-ajax.php';
        let articleId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        jQuery.ajax({ action: 'fetch_article_content' });
      </script></html>`;
      expect(detectWpAjaxContent(html1, pageUrl)).not.toBeNull();

      // post_id variant
      const html2 = `<html><script>
        var ajaxurl = 'https://www.example.com/wp-admin/admin-ajax.php';
        var post_id = "99999";
        jQuery.ajax({ action: 'fetch_article_content' });
      </script></html>`;
      const result2 = detectWpAjaxContent(html2, pageUrl);
      expect(result2).not.toBeNull();
      expect(result2!.articleId).toBe('99999');
    });

    it('returns null for empty HTML', () => {
      expect(detectWpAjaxContent('', pageUrl)).toBeNull();
    });

    it('rejects relative AJAX URLs (no scheme)', () => {
      const html = `<html><script>
        var ajaxurl = '/wp-admin/admin-ajax.php';
        let article_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        jQuery.ajax({ action: 'fetch_article_content' });
      </script></html>`;
      expect(detectWpAjaxContent(html, pageUrl)).toBeNull();
    });
  });

  describe('parseWpAjaxResponse', () => {
    const pageUrl = 'https://www.example.com/news/some-article';
    const longContent = '<p>' + 'This is a paragraph with enough content. '.repeat(30) + '</p>';

    it('parses raw HTML response with sufficient content', () => {
      const result = parseWpAjaxResponse(longContent, pageUrl);
      expect(result).not.toBeNull();
      expect(result!.method).toBe('wp-ajax-content');
      expect(result!.textContent!.length).toBeGreaterThan(500);
      expect(result!.content).toBeDefined();
      expect(result!.markdown).toBeDefined();
    });

    it('strips script, style, and iframe elements', () => {
      const html = `<script>alert('xss')</script><style>.evil{}</style><iframe src="evil"></iframe>${longContent}`;
      const result = parseWpAjaxResponse(html, pageUrl);
      expect(result).not.toBeNull();
      expect(result!.content).not.toContain('<script');
      expect(result!.content).not.toContain('<style');
      expect(result!.content).not.toContain('<iframe');
    });

    it('strips event handler attributes and javascript: URIs', () => {
      const html = `<img src="x" onerror="alert(1)"><a href="javascript:alert(1)">link</a>${longContent}`;
      const result = parseWpAjaxResponse(html, pageUrl);
      expect(result).not.toBeNull();
      expect(result!.content).not.toContain('onerror');
      expect(result!.content).not.toContain('javascript:');
    });

    it('returns null for insufficient content', () => {
      expect(parseWpAjaxResponse('<p>Short</p>', pageUrl)).toBeNull();
    });

    it('returns null for empty response', () => {
      expect(parseWpAjaxResponse('', pageUrl)).toBeNull();
    });

    it('parses JSON-wrapped HTML response', () => {
      const jsonResponse = JSON.stringify({ data: longContent });
      const result = parseWpAjaxResponse(jsonResponse, pageUrl);
      expect(result).not.toBeNull();
      expect(result!.textContent!.length).toBeGreaterThan(500);
    });

    it('parses JSON with content field', () => {
      const jsonResponse = JSON.stringify({ content: longContent });
      const result = parseWpAjaxResponse(jsonResponse, pageUrl);
      expect(result).not.toBeNull();
    });

    it('parses JSON with html field', () => {
      const jsonResponse = JSON.stringify({ html: longContent });
      const result = parseWpAjaxResponse(jsonResponse, pageUrl);
      expect(result).not.toBeNull();
    });

    it('sets null metadata fields', () => {
      const result = parseWpAjaxResponse(longContent, pageUrl);
      expect(result).not.toBeNull();
      expect(result!.title).toBeNull();
      expect(result!.byline).toBeNull();
      expect(result!.siteName).toBeNull();
      expect(result!.publishedTime).toBeNull();
    });

    it('parses JSON bare string response', () => {
      const jsonString = JSON.stringify(longContent);
      const result = parseWpAjaxResponse(jsonString, pageUrl);
      expect(result).not.toBeNull();
      expect(result!.textContent!.length).toBeGreaterThan(500);
    });

    it('handles malformed JSON gracefully', () => {
      const malformedJson = '{"data": "<p>Content</p>';
      const result = parseWpAjaxResponse(malformedJson, pageUrl);
      // Malformed JSON is treated as raw HTML — too short to pass threshold
      expect(result).toBeNull();
    });
  });
});
