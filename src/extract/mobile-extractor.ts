/**
 * Mobile API content extraction via httpcloak.
 */
import httpcloak from 'httpcloak';

import { logger } from '../logger.js';
import * as siteConfig from '../sites/site-config.js';

let session: httpcloak.Session | null = null;

async function getSession(): Promise<httpcloak.Session> {
  session ??= new httpcloak.Session({
    preset: httpcloak.Preset.ANDROID_CHROME_143,
    timeout: 30,
  });
  return session;
}

export async function closeMobileApiClient(): Promise<void> {
  if (session) {
    session.close();
    session = null;
  }
}

interface MobileApiFrame {
  body?: { text: string };
  title?: { text: string };
}

interface MobileApiResponse {
  screens: { frames: MobileApiFrame[] }[];
}

export interface MobileApiExtractResult {
  success: boolean;
  content?: string;
  error?: string;
}

// --- Public API ---

/**
 * Extract article text content from a mobile API endpoint.
 *
 * @param articleId - The article ID (e.g. from meta[name="article.id"])
 * @param url - The article URL (used to resolve site config)
 */
export async function extractFromMobileApi(
  articleId: string,
  url: string
): Promise<MobileApiExtractResult> {
  const config = siteConfig.getMobileApiConfig(url);
  if (!config) {
    return { success: false, error: 'Not a mobile API site' };
  }

  const apiUrl = config.apiUrl + encodeURIComponent(articleId);

  logger.debug({ url, articleId }, 'Fetching from mobile API');

  try {
    const sess = await getSession();

    const response = await sess.get(apiUrl, {
      headers: {
        'app-identifier': config.appIdentifier,
        'device-type': 'phone',
        'x-access-token': config.authToken,
        Accept: 'application/json',
      },
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      return { success: false, error: `HTTP ${response.statusCode}` };
    }

    const data = response.json() as MobileApiResponse;

    if (!data.screens?.[0]?.frames?.length) {
      return { success: false, error: 'Empty response from API' };
    }

    const content = extractText(data.screens[0].frames);

    if (content.length < 100) {
      return { success: false, error: 'Insufficient content from API' };
    }

    logger.info({ url, contentLength: content.length }, 'Successfully extracted from mobile API');

    return { success: true, content };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ url, error: message }, 'Mobile API fetch failed');
    return { success: false, error: message };
  }
}

// --- Text extraction ---

function extractText(frames: MobileApiFrame[]): string {
  const lines: string[] = [];

  for (const frame of frames) {
    if (frame.body?.text) {
      lines.push(frame.body.text);
    } else if (frame.title?.text) {
      lines.push(frame.title.text);
    }
  }

  return lines.join('\n\n').trim();
}
