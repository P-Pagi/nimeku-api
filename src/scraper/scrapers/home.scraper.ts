import { httpClient } from '../client/http.client.js';
import { parseHomeHtml, HomeParseResult } from '../parsers/home.parser.js';
import { buildHomeUrl } from '../utils/url.builder.js';
import { playwrightClient } from '../client/playwright.client.js';
import { logger } from '../../config/logger.js';

export class HomeScraper {
  public async scrape(): Promise<HomeParseResult> {
    const url = buildHomeUrl();
    const res = await httpClient.fetch(url);

    let parsed = parseHomeHtml(res.data);

    // Fallback to Playwright only if strictly needed (JS rendered content)
    if (parsed.isDegraded) {
      logger.warn({ url }, 'Native home parsing incomplete. Attempting Playwright check.');
      const rendered = await playwrightClient.fetchRenderedHtml(url, '.post-show ul li');
      if (rendered) {
        const jsParsed = parseHomeHtml(rendered);
        if (!jsParsed.isDegraded) {
          logger.info({ url }, 'Playwright fallback succeeded for home page.');
          return jsParsed;
        }
      }
    }

    return parsed;
  }
}

export const homeScraper = new HomeScraper();
