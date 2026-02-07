/**
 * PDF fetch helper — lives in fetch/ to avoid extract/ → fetch/ dependency cycle.
 */
import { httpRequest } from './http-client.js';
import { logger } from '../logger.js';

/**
 * Fetch a remote PDF via httpRequest (inherits SSRF protection and size limits).
 * The response body is returned as a string by httpcloak; we convert to Buffer
 * using latin1 encoding which preserves all byte values (0-255) losslessly.
 */
export async function fetchRemotePdfBuffer(
  url: string,
  preset?: string,
  timeout?: number,
  proxy?: string,
  cookies?: Record<string, string>
): Promise<{ buffer: Buffer; statusCode: number } | null> {
  try {
    const response = await httpRequest(
      url,
      { Accept: 'application/pdf,*/*' },
      preset,
      timeout,
      proxy,
      cookies
    );

    if (!response.success || !response.html) {
      logger.debug({ url, statusCode: response.statusCode }, 'Remote PDF fetch failed');
      return null;
    }

    // Convert string body to Buffer using latin1 (preserves byte values 0-255)
    const buffer = Buffer.from(response.html, 'latin1');
    return { buffer, statusCode: response.statusCode };
  } catch (e) {
    logger.debug({ url, error: String(e) }, 'Remote PDF fetch error');
    return null;
  }
}
