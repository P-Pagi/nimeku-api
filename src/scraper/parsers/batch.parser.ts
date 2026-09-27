import * as cheerio from 'cheerio';
import { ParsingError } from '../../resilience/errors.js';
import { PaginationMeta } from './genre.parser.js';

export interface BatchItem {
  slug: string;
  title: string;
  poster: string | null;
  score: number | null;
  type: string | null;
  url: string;
}

export interface BatchDetail {
  slug: string;
  title: string;
  animeSlug: string | null;
  sourceUrl: string;
  downloadSections: Array<{
    format: string;
    qualities: Array<{
      quality: string;
      links: Array<{ host: string; url: string }>;
    }>;
  }>;
}

export interface BatchParseResult {
  items: BatchItem[];
  pagination: PaginationMeta;
  isDegraded: boolean;
}

export function parseBatchListHtml(html: string, requestedPage = 1): BatchParseResult {
  if (!html || typeof html !== 'string') {
    throw new ParsingError('HTML kosong saat parsing daftar batch');
  }

  const $ = cheerio.load(html);
  const items: BatchItem[] = [];

  $('.animpost, .animepost').each((_, el) => {
    const linkEl = $(el).find('a').first();
    const href = linkEl.attr('href') || '';
    const slugMatch = href.match(/\/batch\/([^/]+)/);
    const slug = slugMatch ? slugMatch[1] : '';

    const title = $(el).find('.data .title, h2').text().trim() || linkEl.attr('title') || '';
    const imgEl = $(el).find('img').first();
    const poster = imgEl.attr('src') || imgEl.attr('data-src') || null;

    const scoreText = $(el).find('.score').text().trim();
    const scoreMatch = scoreText.match(/(\d+\.\d+|\d+)/);
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : null;

    const type = $(el).find('.type').first().text().trim() || null;

    if (slug) {
      items.push({
        slug,
        title,
        poster,
        score,
        type,
        url: href,
      });
    }
  });

  // Extract pagination
  let totalPages = requestedPage;
  const pagText = $('.pagination, .page-numbers').text().replace(/\s+/g, ' ');
  const pageMatches = pagText.match(/Page\s*\d+\s*of\s*(\d+)/i) || pagText.match(/of\s*(\d+)/i);
  if (pageMatches) {
    totalPages = parseInt(pageMatches[1], 10);
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

export function parseBatchDetailHtml(html: string, slug: string, sourceUrl: string): BatchDetail {
  if (!html || typeof html !== 'string') {
    throw new ParsingError(`HTML kosong saat parsing detail batch: ${slug}`);
  }

  const $ = cheerio.load(html);
  const title = $('h1.entry-title').first().text().trim() || slug;

  // Find linked anime
  let animeSlug: string | null = null;
  const animeLink = $('a[href*="/anime/"]').first().attr('href');
  if (animeLink) {
    const aMatch = animeLink.match(/\/anime\/([^/]+)/);
    if (aMatch) animeSlug = aMatch[1];
  }

  const downloadSections: BatchDetail['downloadSections'] = [];

  $('.download-eps').each((_, sec) => {
    const format = $(sec).find('p, strong, b').first().text().trim() || 'General';
    const qualities: Array<{ quality: string; links: Array<{ host: string; url: string }> }> = [];

    $(sec).find('li, .binfo').each((_, li) => {
      const qText = $(li).find('strong, b').first().text().trim() || 'Default';
      const links: Array<{ host: string; url: string }> = [];

      $(li).find('a').each((_, a) => {
        const host = $(a).text().trim();
        const url = $(a).attr('href') || '';
        if (host && url && !url.startsWith('#')) {
          links.push({ host, url });
        }
      });

      if (links.length > 0) {
        qualities.push({ quality: qText, links });
      }
    });

    if (qualities.length > 0) {
      downloadSections.push({ format, qualities });
    }
  });

  return {
    slug,
    title,
    animeSlug,
    sourceUrl,
    downloadSections,
  };
}
