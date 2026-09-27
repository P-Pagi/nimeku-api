import * as cheerio from 'cheerio';
import { selectors } from '../selectors/samehadaku.selectors.js';
import { ParsingError } from '../../resilience/errors.js';
import { logger } from '../../config/logger.js';
import { extractEpisodeNumber } from '../utils/episode-number.extractor.js';

export interface ScrapedEpisodeRef {
  slug: string;
  episodeNumber: number | null;
  title: string;
  url: string;
  releasedAt: string | null;
}

export interface ScrapedAnimeDetail {
  slug: string;
  title: string;
  alternativeTitle: string | null;
  japaneseTitle: string | null;
  poster: string | null;
  synopsis: string | null;
  status: string | null;
  type: string | null;
  score: number | null;
  rating: string | null;
  duration: string | null;
  totalEpisodes: number | null;
  latestEpisode: string | null;
  season: string | null;
  releaseYear: number | null;
  studio: string | null;
  producers: string | null;
  releasedAt: string | null;
  sourceUrl: string;
  genres: Array<{ name: string; slug: string }>;
  episodes: ScrapedEpisodeRef[];
  batchSlug: string | null;
  isDegraded: boolean;
}

export function parseAnimeHtml(html: string, fallbackSlug: string, sourceUrl: string): ScrapedAnimeDetail {
  if (!html || typeof html !== 'string') {
    throw new ParsingError(`HTML kosong untuk anime: ${fallbackSlug}`);
  }

  const $ = cheerio.load(html);

  // Title extraction
  const rawTitle = $(selectors.anime.title).first().text().trim();
  const cleanTitle = rawTitle.replace(/\s*Sub\s*Indo.*$/i, '').trim();

  // Poster extraction
  const posterImg = $(selectors.anime.poster).first();
  const poster = posterImg.attr('src') || posterImg.attr('data-src') || null;

  // Synopsis extraction
  // Target .desc container and its paragraphs (avoids SEO banner at top of page)
  const descEl = $('.desc, .sinopsis, [itemprop="description"]').first();
  // Remove hidden gambling spam links, ads, scripts
  $('.desc, .sinopsis, [itemprop="description"]')
    .find('script, style, ins, .ads, .iklan, [hidden], div[style*="font-size:12px"], div[style*="display:none"]')
    .remove();

  const synopsisParagraphs: string[] = [];
  $('.desc p, .sinopsis p').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text && !/^nonton streaming/i.test(text) && !/^download/i.test(text)) {
      synopsisParagraphs.push(text);
    }
  });

  let synopsis: string | null = null;
  if (synopsisParagraphs.length > 0) {
    synopsis = synopsisParagraphs.join('\n\n');
  } else if (descEl.length) {
    // Fallback: extract text directly and clean boilerplate
    let raw = descEl.text().replace(/\s+/g, ' ').trim();
    raw = raw.replace(/^Nonton Streaming anime[\s\S]*?(terbaru di Samehadaku!?|Samehadaku!)\s*/i, '').trim();
    synopsis = raw || null;
  }

  // Rating / Score
  const scoreText = $(selectors.anime.ratingScore).first().text().trim();
  const scoreMatch = scoreText.match(/(\d+\.\d+|\d+)/);
  const score = scoreMatch ? parseFloat(scoreMatch[1]) : null;

  // Genres
  const genres: Array<{ name: string; slug: string }> = [];
  $(selectors.anime.genres).each((_, el) => {
    const name = $(el).text().trim();
    const href = $(el).attr('href') || '';
    const slugMatch = href.match(/\/genre\/([^/]+)/);
    const slug = slugMatch ? slugMatch[1] : name.toLowerCase().replace(/\s+/g, '-');
    if (name && slug) {
      genres.push({ name, slug });
    }
  });

  // Metadata from .spe span stored in object to avoid TypeScript control-flow narrowing to never
  const meta: Record<string, string | null> = {
    japaneseTitle: null,
    alternativeTitle: null,
    status: null,
    type: null,
    duration: null,
    season: null,
    studio: null,
    producers: null,
    releasedAt: null,
    rating: null,
  };
  let totalEpisodes: number | null = null;

  $(selectors.anime.infoSpans).each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();

    if (/^Japanese/i.test(text)) {
      meta.japaneseTitle = text.replace(/^Japanese\s*:?\s*/i, '').trim() || null;
    } else if (/^(English|Synonyms)/i.test(text)) {
      meta.alternativeTitle = text.replace(/^(English|Synonyms)\s*:?\s*/i, '').trim() || null;
    } else if (/^Status/i.test(text)) {
      meta.status = text.replace(/^Status\s*:?\s*/i, '').trim() || null;
    } else if (/^Type/i.test(text)) {
      meta.type = text.replace(/^Type\s*:?\s*/i, '').trim() || null;
    } else if (/^Duration/i.test(text)) {
      meta.duration = text.replace(/^Duration\s*:?\s*/i, '').trim() || null;
    } else if (/^Total\s*Episode/i.test(text)) {
      const epCountStr = text.replace(/^Total\s*Episode\s*:?\s*/i, '').trim();
      const count = parseInt(epCountStr, 10);
      totalEpisodes = !isNaN(count) ? count : null;
    } else if (/^Season/i.test(text)) {
      meta.season = text.replace(/^Season\s*:?\s*/i, '').trim() || null;
    } else if (/^Studio/i.test(text)) {
      meta.studio = text.replace(/^Studio\s*:?\s*/i, '').trim() || null;
    } else if (/^Producers/i.test(text)) {
      meta.producers = text.replace(/^Producers\s*:?\s*/i, '').trim() || null;
    } else if (/^Released/i.test(text)) {
      meta.releasedAt = text.replace(/^Released\s*:?\s*/i, '').trim() || null;
    } else if (/^Rating/i.test(text)) {
      meta.rating = text.replace(/^Rating\s*:?\s*/i, '').trim() || null;
    }
  });

  const japaneseTitle = meta.japaneseTitle;
  const alternativeTitle = meta.alternativeTitle;
  const status = meta.status;
  const type = meta.type;
  const duration = meta.duration;
  const studio = meta.studio;
  const producers = meta.producers;
  const releasedAt = meta.releasedAt;
  const rating = meta.rating;

  // Derive season from releasedAt if missing
  let season = meta.season;
  if (!season && meta.releasedAt) {
    const yearMatch = meta.releasedAt.match(/\b(19\d\d|20\d\d)\b/);
    if (yearMatch) {
      const year = parseInt(yearMatch[1], 10);
      const lower = meta.releasedAt.toLowerCase();
      const monthMap: Record<string, number> = {
        jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, may: 5, jun: 6,
        jul: 7, agu: 8, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12
      };
      for (const [key, m] of Object.entries(monthMap)) {
        if (lower.includes(key)) {
          if (m >= 1 && m <= 3) season = `Winter ${year}`;
          else if (m >= 4 && m <= 6) season = `Spring ${year}`;
          else if (m >= 7 && m <= 9) season = `Summer ${year}`;
          else season = `Fall ${year}`;
          break;
        }
      }
    }
  }

  // Extract release year from season or releasedAt
  let releaseYear: number | null = null;
  if (season) {
    const yearMatch = season.match(/\b(19\d\d|20\d\d)\b/);
    if (yearMatch) releaseYear = parseInt(yearMatch[1], 10);
  }
  if (!releaseYear && releasedAt) {
    const yearMatch = releasedAt.match(/\b(19\d\d|20\d\d)\b/);
    if (yearMatch) releaseYear = parseInt(yearMatch[1], 10);
  }

  // Episodes list
  const episodes: ScrapedEpisodeRef[] = [];
  $(selectors.anime.episodeList).each((_, el) => {
    const linkEl = $(el).find('a').first();
    const href = linkEl.attr('href') || '';
    const rawEpTitle = linkEl.text().trim() || $(el).find('.lstep').text().trim();
    const dateText = $(el).find('.date, .epsdate').text().trim() || null;

    // Episode slug from URL e.g. /one-piece-episode-1179/
    const epSlugMatch = href.match(/\/([^/]+?)\/?$/);
    const epSlug = epSlugMatch ? epSlugMatch[1] : '';

    // Episode number extraction using robust extractor
    const episodeNumber = extractEpisodeNumber(epSlug, rawEpTitle, type);

    if (epSlug && href) {
      episodes.push({
        slug: epSlug,
        episodeNumber,
        title: rawEpTitle || `Episode ${episodeNumber ?? ''}`.trim(),
        url: href,
        releasedAt: dateText,
      });
    }
  });

  // Infer totalEpisodes if missing
  if (totalEpisodes === null) {
    if (type === 'Movie') {
      totalEpisodes = 1;
    } else if (status === 'Completed' && episodes.length > 0) {
      totalEpisodes = episodes.length;
    }
  }

  // Batch link if available
  let batchSlug: string | null = null;
  const batchHref = $(selectors.anime.batchLink).first().attr('href');
  if (batchHref) {
    const bMatch = batchHref.match(/\/batch\/([^/]+)/);
    if (bMatch) batchSlug = bMatch[1];
  }

  const latestEpisode = episodes.length > 0
    ? (episodes[0]?.episodeNumber !== null ? String(episodes[0].episodeNumber) : (type === 'Movie' ? 'Movie' : '1'))
    : null;

  // Degradation detection (Rule #40)
  const isDegraded = !cleanTitle || (!poster && !synopsis);
  if (isDegraded) {
    logger.error(
      { slug: fallbackSlug, cleanTitle, hasPoster: !!poster, hasSynopsis: !!synopsis },
      'Anime parser marked DEGRADED! Key fields missing from HTML.'
    );
  }

  return {
    slug: fallbackSlug,
    title: cleanTitle || fallbackSlug,
    alternativeTitle,
    japaneseTitle,
    poster,
    synopsis,
    status,
    type,
    score,
    rating,
    duration,
    totalEpisodes,
    latestEpisode,
    season,
    releaseYear,
    studio,
    producers,
    releasedAt,
    sourceUrl,
    genres,
    episodes,
    batchSlug,
    isDegraded,
  };
}
