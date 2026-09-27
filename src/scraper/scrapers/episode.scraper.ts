import { httpClient } from '../client/http.client.js';
import { fetchPage } from '../client/page.fetcher.js';
import { parseEpisodeHtml, ScrapedEpisodeDetail, ScrapedServerOption } from '../parsers/episode.parser.js';
import { parseStreamServerEmbed, ResolvedStreamServer } from '../parsers/server.parser.js';
import { buildEpisodeUrl, buildPlayerAjaxUrl } from '../utils/url.builder.js';
import { logger } from '../../config/logger.js';
import { config } from '../../config/env.js';

export interface StreamServerProvider {
  getServers(episodeSlug: string): Promise<ScrapedServerOption[]>;
  resolveServer(episodeSlug: string, serverKey: string): Promise<ResolvedStreamServer>;
}

export class EpisodeScraper implements StreamServerProvider {
  public async scrape(slug: string): Promise<ScrapedEpisodeDetail> {
    const url = buildEpisodeUrl(slug);
    const { html, usedPlaywright } = await fetchPage(url, 'h1.entry-title, .server-list, .download-eps');

    let parsed = parseEpisodeHtml(html, slug);

    if (parsed.isDegraded) {
      const how = usedPlaywright ? 'Playwright' : 'fetch (403?)';
      logger.warn({ slug, url, how }, 'Episode parse degraded — selectors may need update');
    }

    return parsed;
  }

  public async getServers(episodeSlug: string): Promise<ScrapedServerOption[]> {
    const detail = await this.scrape(episodeSlug);
    return detail.servers;
  }

  /**
   * Resolves the real embed iframe URL by posting to WordPress player_ajax
   */
  public async resolveServer(episodeSlug: string, serverKey: string): Promise<ResolvedStreamServer> {
    const detail = await this.scrape(episodeSlug);
    const target = detail.servers.find(
      (s) => s.id === serverKey || s.nume === serverKey || s.name.toLowerCase() === serverKey.toLowerCase()
    );

    if (!target) {
      throw new Error(`Server ${serverKey} tidak ditemukan untuk episode ${episodeSlug}`);
    }

    const ajaxUrl = buildPlayerAjaxUrl();
    const episodeUrl = buildEpisodeUrl(episodeSlug);

    const form = new URLSearchParams();
    form.append('action', 'player_ajax');
    form.append('post', target.post);
    form.append('nume', target.nume);
    form.append('type', target.type || 'schtml');

    const response = await httpClient.fetch(ajaxUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: episodeUrl,
        Origin: config.SOURCE_BASE_URL.replace(/\/+$/, ''),
        Accept: '*/*',
        // Override navigation Sec-Fetch-* headers for XHR/AJAX context
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: form.toString(),
      useCacheHeaders: false,
    });

    const resolved = parseStreamServerEmbed(response.data, target.id);
    resolved.name = target.name;
    return resolved;
  }
}

export const episodeScraper = new EpisodeScraper();
