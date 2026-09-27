import * as cheerio from 'cheerio';
import { selectors } from '../selectors/samehadaku.selectors.js';
import { ParsingError } from '../../resilience/errors.js';
import { logger } from '../../config/logger.js';
import { extractEpisodeNumber } from '../utils/episode-number.extractor.js';

export interface ScrapedServerOption {
  id: string;
  name: string;
  post: string;
  nume: string;
  type: string;
}

export interface ScrapedDownloadLink {
  quality: string;
  links: Array<{ host: string; url: string }>;
}

export interface ScrapedEpisodeDetail {
  slug: string;
  title: string;
  episodeNumber: number | null;
  animeSlug: string | null;
  animeTitle: string | null;
  previousEpisodeSlug: string | null;
  nextEpisodeSlug: string | null;
  allEpisodesUrl: string | null;
  servers: ScrapedServerOption[];
  downloads: ScrapedDownloadLink[];
  isDegraded: boolean;
}

export function parseEpisodeHtml(html: string, fallbackSlug: string): ScrapedEpisodeDetail {
  if (!html || typeof html !== 'string') {
    throw new ParsingError(`HTML kosong untuk episode: ${fallbackSlug}`);
  }

  const $ = cheerio.load(html);

  // Title
  const rawTitle = $(selectors.episode.title).first().text().trim();
  const cleanTitle = rawTitle.replace(/\s*Sub\s*Indo.*$/i, '').trim();

  // Episode number using robust extractor
  const episodeNumber = extractEpisodeNumber(fallbackSlug, cleanTitle);

  // Nav prev / next / all
  let previousEpisodeSlug: string | null = null;
  let nextEpisodeSlug: string | null = null;
  let allEpisodesUrl: string | null = null;
  let animeSlug: string | null = null;

  $('.naveps a, .nvs a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim().toLowerCase();

    if (href.includes('/anime/')) {
      allEpisodesUrl = href;
      const aMatch = href.match(/\/anime\/([^/]+)/);
      if (aMatch) animeSlug = aMatch[1];
    } else if (text.includes('prev') || text.includes('sebelumnya') || $(el).find('i.fa-chevron-left, .dashicons-arrow-left-alt2').length > 0) {
      if (href && href !== '#') {
        const slugMatch = href.match(/\/([^/]+?)\/?$/);
        if (slugMatch) previousEpisodeSlug = slugMatch[1];
      }
    } else if (text.includes('next') || text.includes('selanjutnya') || $(el).find('i.fa-chevron-right, .dashicons-arrow-right-alt2').length > 0) {
      if (href && href !== '#') {
        const slugMatch = href.match(/\/([^/]+?)\/?$/);
        if (slugMatch) nextEpisodeSlug = slugMatch[1];
      }
    }
  });

  // Infer anime slug from fallback slug if not found in nav
  if (!animeSlug) {
    const inferred = fallbackSlug.replace(/-episode-\d+.*$/, '');
    if (inferred && inferred !== fallbackSlug) {
      animeSlug = inferred;
    }
  }

  // Server options
  const servers: ScrapedServerOption[] = [];
  const seenNume = new Set<string>();

  $('.east_player_option').each((_, el) => {
    const id = $(el).attr('id') || `player-option-${servers.length + 1}`;
    const name = $(el).text().replace(/\s+/g, ' ').trim();
    const post = $(el).attr('data-post') || '';
    const nume = $(el).attr('data-nume') || '';
    const type = $(el).attr('data-type') || 'schtml';

    if (nume && !seenNume.has(nume)) {
      seenNume.add(nume);
      servers.push({
        id,
        name: name || `Server ${nume}`,
        post,
        nume,
        type,
      });
    }
  });

  // Downloads
  const downloads: ScrapedDownloadLink[] = [];
  $('.download-eps').each((_, section) => {
    $(section).find('li').each((_, li) => {
      const quality = $(li).find('strong, b, span').first().text().trim() || 'Unknown';
      const hostLinks: Array<{ host: string; url: string }> = [];

      $(li).find('a').each((_, a) => {
        const host = $(a).text().trim();
        const url = $(a).attr('href') || '';
        if (host && url && !url.startsWith('#')) {
          hostLinks.push({ host, url });
        }
      });

      if (hostLinks.length > 0) {
        downloads.push({
          quality,
          links: hostLinks,
        });
      }
    });
  });

  const isDegraded = !cleanTitle || servers.length === 0;
  if (isDegraded) {
    logger.warn({ slug: fallbackSlug, serversCount: servers.length }, 'Episode parser warning: possible degraded structure');
  }

  return {
    slug: fallbackSlug,
    title: cleanTitle || fallbackSlug,
    episodeNumber,
    animeSlug,
    animeTitle: null,
    previousEpisodeSlug,
    nextEpisodeSlug,
    allEpisodesUrl,
    servers,
    downloads,
    isDegraded,
  };
}
