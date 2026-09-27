import * as cheerio from 'cheerio';
import { selectors } from '../selectors/samehadaku.selectors.js';
import { ParsingError } from '../../resilience/errors.js';

export interface CatalogAnimeItem {
  slug: string;
  title: string;
  poster: string | null;
  type: string | null;
  score: number | null;
  status: string | null;
  genres: string[];
  url: string;
}

export interface PaginationMeta {
  currentPage: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface CatalogParseResult {
  items: CatalogAnimeItem[];
  pagination: PaginationMeta;
  isDegraded: boolean;
}

export function parseCatalogHtml(html: string, requestedPage = 1): CatalogParseResult {
  if (!html || typeof html !== 'string') {
    throw new ParsingError('HTML kosong saat parsing daftar anime / genre');
  }

  const $ = cheerio.load(html);
  const items: CatalogAnimeItem[] = [];
  const seenSlugs = new Set<string>();

  $('.animpost').each((_, el) => {
    const linkEl = $(el).find('.animposx a, a').first();
    const href = linkEl.attr('href') || '';
    const imgEl = $(el).find('img').first();
    const poster = imgEl.attr('src') || imgEl.attr('data-src') || null;

    const rawTitle = $(el).find('.data .title, h2, .title').first().text().trim() ||
                     linkEl.attr('title') || '';
    const cleanTitle = rawTitle.replace(/\s*Sub\s*Indo.*$/i, '').trim();

    const slugMatch = href.match(/\/anime\/([^/]+)/);
    const slug = slugMatch ? slugMatch[1] : '';

    if (!slug || seenSlugs.has(slug)) return;
    seenSlugs.add(slug);

    const type = $(el).find('.content-thumb .type, .type').first().text().trim() || null;

    const scoreText = $(el).find('.score').first().text().trim();
    const scoreMatch = scoreText.match(/(\d+\.\d+|\d+)/);
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : null;

    const rawStatus = $(el).find('.data .type, .status').first().text().trim();
    const status = rawStatus || null;

    const genres: string[] = [];
    $(el).find('.genres a, .genre a').each((_, g) => {
      const gName = $(g).text().trim();
      if (gName) genres.push(gName);
    });

    items.push({
      slug,
      title: cleanTitle || slug,
      poster,
      type,
      score,
      status,
      genres,
      url: href,
    });
  });

  // Extract pagination
  let totalPages = requestedPage;
  const pagSpanText = $('.pagination span').first().text().replace(/\s+/g, ' ');
  const pageMatches = pagSpanText.match(/of\s*(\d+)/i) || pagSpanText.match(/Page\s*\d+\s*of\s*(\d+)/i);
  if (pageMatches) {
    totalPages = parseInt(pageMatches[1], 10);
  } else {
    // Find highest page number in links
    $('.pagination a, .page-numbers a').each((_, a) => {
      const num = parseInt($(a).text().trim(), 10);
      if (!isNaN(num) && num > totalPages) {
        totalPages = num;
      }
    });
  }

  const hasNextPage = requestedPage < totalPages || $('.pagination a.next, .page-numbers.next').length > 0;
  const hasPreviousPage = requestedPage > 1;

  return {
    items,
    pagination: {
      currentPage: requestedPage,
      totalPages: Math.max(totalPages, requestedPage),
      hasNextPage,
      hasPreviousPage,
    },
    isDegraded: items.length === 0,
  };
}

export function parseGenreListHtml(html: string): Array<{ name: string; slug: string }> {
  const $ = cheerio.load(html);
  const genreMap = new Map<string, string>();

  $('a[href*="/genre/"]').each((_, el) => {
    const name = $(el).text().trim();
    const href = $(el).attr('href') || '';
    const match = href.match(/\/genre\/([^/]+)/);
    if (name && match && !genreMap.has(match[1])) {
      genreMap.set(match[1], name);
    }
  });

  return Array.from(genreMap.entries()).map(([slug, name]) => ({ slug, name }));
}
