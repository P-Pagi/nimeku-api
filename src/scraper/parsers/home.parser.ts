import * as cheerio from 'cheerio';
import { selectors } from '../selectors/samehadaku.selectors.js';
import { ParsingError } from '../../resilience/errors.js';
import { logger } from '../../config/logger.js';

export interface Top10Item {
  rank: number;
  title: string;
  slug: string;
  poster: string | null;
  score: number | null;
  url: string;
}

export interface RecentEpisodeItem {
  title: string;
  animeSlug: string;
  episodeNumber: string | null;
  poster: string | null;
  postedBy: string | null;
  releasedOn: string | null;
  url: string;
}

export interface HomeParseResult {
  top10: Top10Item[];
  recentEpisodes: RecentEpisodeItem[];
  isDegraded: boolean;
}

export function parseHomeHtml(html: string): HomeParseResult {
  if (!html || typeof html !== 'string') {
    throw new ParsingError('HTML kosong atau tidak valid saat parsing halaman utama');
  }

  const $ = cheerio.load(html);
  const top10: Top10Item[] = [];
  const recentEpisodes: RecentEpisodeItem[] = [];

  // Parse Top 10 section
  $('.widget-post').first().find('li').each((index, el) => {
    const linkEl = $(el).find('a').first();
    const href = linkEl.attr('href') || '';
    const imgEl = $(el).find('img').first();
    const poster = imgEl.attr('src') || imgEl.attr('data-src') || null;

    // Title & rank: e.g. "TOP1 One Piece"
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    const scoreMatch = text.match(/(\d+\.\d+)/);
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : null;

    // Extract slug from URL: /anime/one-piece/ -> one-piece
    const slugMatch = href.match(/\/anime\/([^/]+)/);
    const slug = slugMatch ? slugMatch[1] : '';

    // Title extraction
    const titleEl = $(el).find('h2, h3, h4, .title, strong').last();
    const rawTitle = titleEl.length ? titleEl.text().trim() : $(el).find('a').last().text().trim();
    const cleanTitle = rawTitle
      .replace(/TOP\s*\d+/gi, '')
      .replace(/^\s*\d+(\.\d+)?\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (slug) {
      top10.push({
        rank: index + 1,
        title: cleanTitle || slug,
        slug,
        poster,
        score,
        url: href,
      });
    }
  });

  // Parse Recent Episodes section (.post-show ul li)
  $('.post-show ul li').each((_, el) => {
    const titleLink = $(el).find('.entry-title a, h2 a, .dtla a').first();
    const href = titleLink.attr('href') || $(el).find('.thumb a').attr('href') || '';
    const title = titleLink.text().trim();
    const imgEl = $(el).find('img').first();
    const poster = imgEl.attr('src') || imgEl.attr('data-src') || null;

    // Episode number: span:contains("Episode") author or text
    const epAuthor = $(el).find('span:contains("Episode") author').text().trim();
    const epMatch = epAuthor || $(el).text().match(/Episode\s*(\d+(\.\d+)?)/i)?.[1] || null;

    // Posted by
    const postedBy = $(el).find('span.author author').text().trim() || null;

    // Released on
    const releasedText = $(el).find('span:contains("Released on")').text().trim();
    const releasedOn = releasedText.replace(/Released\s*on\s*:\s*/i, '').trim() || null;

    const slugMatch = href.match(/\/anime\/([^/]+)/);
    const animeSlug = slugMatch ? slugMatch[1] : '';

    if (title && href) {
      recentEpisodes.push({
        title,
        animeSlug,
        episodeNumber: epMatch,
        poster,
        postedBy,
        releasedOn,
        url: href,
      });
    }
  });

  // Degraded check
  const isDegraded = recentEpisodes.length === 0;
  if (isDegraded) {
    logger.warn('Parser warning: No recent episodes extracted from home page. HTML might have changed.');
  }

  return {
    top10,
    recentEpisodes,
    isDegraded,
  };
}
