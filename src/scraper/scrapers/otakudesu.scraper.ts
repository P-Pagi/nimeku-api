import * as cheerio from 'cheerio';
import { cacheService } from '../../cache/cache.service.js';
import { logger } from '../../config/logger.js';
import { crossReferenceService } from '../../services/cross-reference.service.js';
import { checkEmbedReachable, detectServerProvider, ServerProvider } from '../../services/server.health.js';

export interface OtakudesuServerOption {
  id: string;
  name: string;
  serverKey: string;
  quality: string;
  type: string;
  source: 'otakudesu';
  embedUrl?: string | null;
  dataContent?: {
    id: number | string;
    i: number | string;
    q: string;
    epUrl?: string;
    embedUrl?: string;
  };
  action?: string;
  nonceAction?: string;
}

export interface ResolvedOtakudesuServer {
  serverKey: string;
  name: string;
  embedUrl: string;
  serverProvider: ServerProvider;
  isReachable: boolean;
  source: 'otakudesu';
  resolvedAt: string;
}

export class OtakudesuScraper {
  private readonly baseUrl = 'https://otakudesu.blog';
  private readonly defaultHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
  };

  /**
   * Search for anime URL on Otakudesu using anime title
   */
  public async searchAnime(animeTitle: string): Promise<string | null> {
    const cleanTitle = animeTitle.trim();
    if (!cleanTitle) return null;

    const cacheKey = `otakudesu:search:${cleanTitle.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    const cached = await cacheService.get<string>(cacheKey);
    if (cached) return cached;

    const variations = crossReferenceService.generateTitleVariations(cleanTitle);

    for (const query of variations.slice(0, 3)) {
      try {
        const searchUrl = `${this.baseUrl}/?s=${encodeURIComponent(query)}&post_type=anime`;
        const res = await fetch(searchUrl, {
          headers: this.defaultHeaders,
          signal: AbortSignal.timeout(8000),
        });

        if (!res.ok) continue;

        const html = await res.text();
        const $ = cheerio.load(html);

        let candidateUrls: Array<{ url: string; score: number }> = [];

        $('.chivsrc li h2 a').each((_, el) => {
          const text = $(el).text().trim();
          const textLower = text.toLowerCase();
          const href = $(el).attr('href');
          if (!href) return;

          let score = 0;
          const queryLower = query.toLowerCase();

          // Check season parity
          const queryHasS2 = /season\s*2|\bs2\b/i.test(cleanTitle);
          const queryHasS3 = /season\s*3|\bs3\b/i.test(cleanTitle);
          const queryHasS4 = /season\s*4|\bs4\b/i.test(cleanTitle);

          const itemHasS2 = /season\s*2|\bs2\b/i.test(text);
          const itemHasS3 = /season\s*3|\bs3\b/i.test(text);
          const itemHasS4 = /season\s*4|\bs4\b/i.test(text);

          if (queryHasS2 === itemHasS2 && queryHasS3 === itemHasS3 && queryHasS4 === itemHasS4) {
            score += 10;
          } else {
            score -= 10;
          }

          const baseItemTitle = text.replace(/\([^)]*\)/g, '').replace(/subtitle\s*indonesia/gi, '').trim().toLowerCase();
          if (baseItemTitle === queryLower) {
            score += 20;
          } else if (textLower.includes(queryLower)) {
            score += 5;
          }

          candidateUrls.push({ url: href, score });
        });

        candidateUrls.sort((a, b) => b.score - a.score);
        const bestCandidate = candidateUrls[0];

        if (bestCandidate && bestCandidate.score >= 0) {
          logger.info({ animeTitle, query, matchedUrl: bestCandidate.url, score: bestCandidate.score }, 'Found anime on Otakudesu');
          await cacheService.set(cacheKey, bestCandidate.url, 86400 * 7); // Cache for 7 days
          return bestCandidate.url;
        }
      } catch (err: any) {
        logger.debug({ query, error: err.message }, 'Failed search query on Otakudesu');
      }
    }

    return null;
  }

  /**
   * Find specific episode URL from an anime page
   */
  public async findEpisodeUrl(animeUrl: string, episodeNumber: number): Promise<string | null> {
    const cacheKey = `otakudesu:epurl:${animeUrl}:${episodeNumber}`;
    const cached = await cacheService.get<string>(cacheKey);
    if (cached) return cached;

    try {
      const res = await fetch(animeUrl, {
        headers: this.defaultHeaders,
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) return null;

      const html = await res.text();
      const $ = cheerio.load(html);

      let epUrl: string | null = null;
      $('.episodelist ul li a').each((_, el) => {
        if (epUrl) return;
        const text = $(el).text().trim();
        const href = $(el).attr('href');
        if (!href) return;

        // Ignore batch links
        if (text.toLowerCase().includes('batch') || href.includes('/batch/')) return;

        // Match episode number: e.g. "Episode 12", "Episode 12 (End)"
        const match = text.match(/Episode\s*(\d+(\.\d+)?)/i);
        if (match && parseFloat(match[1]) === episodeNumber) {
          epUrl = href;
        }
      });

      if (epUrl) {
        logger.info({ animeUrl, episodeNumber, epUrl }, 'Found episode on Otakudesu');
        await cacheService.set(cacheKey, epUrl, 86400 * 7);
        return epUrl;
      }
    } catch (err: any) {
      logger.warn({ animeUrl, episodeNumber, error: err.message }, 'Failed reading Otakudesu anime episodes');
    }

    return null;
  }

  /**
   * Get all streaming servers (default + mirrors) for an anime episode
   */
  public async getEpisodeServers(animeTitle: string, episodeNumber: number): Promise<OtakudesuServerOption[]> {
    const cacheKey = `otakudesu:servers:${animeTitle.toLowerCase().replace(/[^a-z0-9]/g, '_')}:${episodeNumber}`;
    const cached = await cacheService.get<OtakudesuServerOption[]>(cacheKey);
    if (cached && cached.length > 0) {
      return cached;
    }

    const animeUrl = await this.searchAnime(animeTitle);
    if (!animeUrl) return [];

    const epUrl = await this.findEpisodeUrl(animeUrl, episodeNumber);
    if (!epUrl) return [];

    try {
      const res = await fetch(epUrl, {
        headers: this.defaultHeaders,
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) return [];

      const html = await res.text();
      const $ = cheerio.load(html);

      // Extract dynamic AJAX actions from script
      let nonceAction = 'aa1208d27f29ca340c92c66d1926f13f';
      let streamAction = '2a3505c93b0035d3f455df82bf976b84';

      const scriptText = $('script').text();
      const nonceMatch = scriptText.match(/action:\s*["']([a-f0-9]{32})["']/g);
      if (nonceMatch && nonceMatch.length >= 2) {
        const actions = nonceMatch.map((m) => m.replace(/action:\s*["']|["']/g, ''));
        if (actions.length >= 2) {
          streamAction = actions[0];
          nonceAction = actions[1];
        }
      }

      const servers: OtakudesuServerOption[] = [];

      // 1. Default embed player
      const defaultIframe = $('#pembed iframe, .responsive-embed-stream iframe, iframe').first().attr('src');
      if (defaultIframe) {
        servers.push({
          id: 'otakudesu_default',
          name: '[Otakudesu] Default Player',
          serverKey: 'otakudesu_default',
          quality: 'default',
          type: 'embed',
          source: 'otakudesu',
          embedUrl: defaultIframe,
          dataContent: {
            id: 'default',
            i: '0',
            q: 'default',
            epUrl,
            embedUrl: defaultIframe,
          },
        });
      }

      // 2. Mirrors (360p, 480p, 720p)
      $('.mirrorstream ul li a').each((_, el) => {
        const rawName = $(el).text().trim();
        const rawContent = $(el).attr('data-content');
        const quality = $(el).closest('ul').attr('class')?.replace(/^m/, '') || 'default';

        if (rawContent && rawName) {
          try {
            const dataContent = JSON.parse(Buffer.from(rawContent, 'base64').toString('utf8'));
            const serverKey = `otakudesu_${rawName.toLowerCase()}_${quality}`;
            servers.push({
              id: serverKey,
              name: `[Otakudesu] ${rawName.toUpperCase()} (${quality})`,
              serverKey,
              quality,
              type: 'otakudesu_mirror',
              source: 'otakudesu',
              dataContent: {
                ...dataContent,
                epUrl,
              },
              action: streamAction,
              nonceAction: nonceAction,
            });
          } catch {}
        }
      });

      if (servers.length > 0) {
        // Cache servers for 7 days
        await cacheService.set(cacheKey, servers, 86400 * 7);
      }

      return servers;
    } catch (err: any) {
      logger.warn({ epUrl, error: err.message }, 'Failed parsing Otakudesu episode page');
      return [];
    }
  }

  /**
   * Resolve an Otakudesu server option to a playable embed URL
   */
  public async resolveServer(serverOption: OtakudesuServerOption): Promise<ResolvedOtakudesuServer> {
    const { serverKey, name, type, dataContent, action, nonceAction } = serverOption;

    const cacheKey = `otakudesu:resolved:${serverKey}:${dataContent?.id || ''}:${dataContent?.i || ''}`;
    const cached = await cacheService.get<ResolvedOtakudesuServer>(cacheKey);
    if (cached) {
      return cached;
    }

    // Default embed iframe (already has URL)
    if (type === 'embed' && (serverOption.embedUrl || dataContent?.embedUrl)) {
      const embedUrl = (serverOption.embedUrl || dataContent?.embedUrl)!;
      const isReachable = await checkEmbedReachable(embedUrl);
      const res: ResolvedOtakudesuServer = {
        serverKey,
        name,
        embedUrl,
        serverProvider: detectServerProvider(embedUrl),
        isReachable,
        source: 'otakudesu',
        resolvedAt: new Date().toISOString(),
      };
      await cacheService.set(cacheKey, res, isReachable ? 3600 : 90);
      return res;
    }

    if (!dataContent) {
      throw new Error(`Data content tidak valid untuk server Otakudesu ${serverKey}`);
    }

    // Mirror resolution via Otakudesu admin-ajax.php
    try {
      // Step 1: Request nonce
      const nonceRes = await fetch(`${this.baseUrl}/wp-admin/admin-ajax.php`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': this.defaultHeaders['User-Agent'],
          'Origin': this.baseUrl,
          'Referer': dataContent.epUrl || `${this.baseUrl}/`,
        },
        body: new URLSearchParams({ action: nonceAction || 'aa1208d27f29ca340c92c66d1926f13f' }),
        signal: AbortSignal.timeout(8000),
      });

      if (!nonceRes.ok) {
        throw new Error(`Otakudesu nonce fetch failed with status ${nonceRes.status}`);
      }

      const nonceJson = await nonceRes.json();
      const nonce = nonceJson.data;

      // Step 2: Request stream iframe
      const form = new URLSearchParams({
        id: String(dataContent.id),
        i: String(dataContent.i),
        q: String(dataContent.q),
        nonce,
        action: action || '2a3505c93b0035d3f455df82bf976b84',
      });

      const streamRes = await fetch(`${this.baseUrl}/wp-admin/admin-ajax.php`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': this.defaultHeaders['User-Agent'],
          'Origin': this.baseUrl,
          'Referer': dataContent.epUrl || `${this.baseUrl}/`,
        },
        body: form,
        signal: AbortSignal.timeout(8000),
      });

      if (!streamRes.ok) {
        throw new Error(`Otakudesu stream mirror fetch failed with status ${streamRes.status}`);
      }

      const streamJson = await streamRes.json();
      if (!streamJson.data) {
        throw new Error('Response kosong dari Otakudesu mirror AJAX');
      }

      const rawHtml = Buffer.from(streamJson.data, 'base64').toString('utf8');
      const $ = cheerio.load(rawHtml);
      const embedUrl = $('iframe').attr('src') || $('iframe').attr('data-src') || $('video source').attr('src') || '';

      if (!embedUrl) {
        throw new Error(`Gagal mengekstrak iframe dari respon server Otakudesu: ${rawHtml.slice(0, 150)}`);
      }

      const isReachable = await checkEmbedReachable(embedUrl);
      const resolved: ResolvedOtakudesuServer = {
        serverKey,
        name,
        embedUrl,
        serverProvider: detectServerProvider(embedUrl),
        isReachable,
        source: 'otakudesu',
        resolvedAt: new Date().toISOString(),
      };

      await cacheService.set(cacheKey, resolved, isReachable ? 3600 : 90);
      return resolved;
    } catch (err: any) {
      logger.warn({ serverKey, error: err.message }, 'Failed resolving Otakudesu mirror stream');
      throw err;
    }
  }
}

export const otakudesuScraper = new OtakudesuScraper();
