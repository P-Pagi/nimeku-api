import { fetchPage } from '../client/page.fetcher.js';
import { parseAnimeHtml, ScrapedAnimeDetail } from '../parsers/anime.parser.js';
import { buildAnimeUrl } from '../utils/url.builder.js';
import { logger } from '../../config/logger.js';

/**
 * AnimeScraper — fetches and parses anime detail page.
 * Uses PageFetcher which automatically routes through Playwright
 * when ENABLE_PLAYWRIGHT_FALLBACK=true (bypasses Cloudflare).
 */
export class AnimeScraper {
  public async scrape(slug: string): Promise<ScrapedAnimeDetail> {
    const url = buildAnimeUrl(slug);

    // fetchPage handles Playwright vs fetch decision automatically
    const { html, usedPlaywright } = await fetchPage(url, 'h1.entry-title, .anime-detail, .episodelist');

    let parsed = parseAnimeHtml(html, slug, url);

    if (parsed.isDegraded && usedPlaywright) {
      // Playwright was used but still degraded — site structure changed
      logger.warn({ slug, url }, 'Anime parse degraded even after Playwright render. Selectors may need update.');
    } else if (parsed.isDegraded && !usedPlaywright) {
      // fetch returned 403/empty, Playwright disabled
      logger.warn({ slug, url }, 'Anime parse degraded (fetch). Enable ENABLE_PLAYWRIGHT_FALLBACK=true to bypass Cloudflare.');
    }

    return parsed;
  }
}

export const animeScraper = new AnimeScraper();
