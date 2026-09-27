import * as cheerio from 'cheerio';
import { ParsingError } from '../../resilience/errors.js';

export interface ScheduleItem {
  animeSlug: string;
  title: string;
  day: string;
  time: string | null;
  type: string | null;
  score: number | null;
  poster: string | null;
  genres: string[];
  url: string;
}

export function parseScheduleJson(jsonData: any[], day: string): ScheduleItem[] {
  if (!Array.isArray(jsonData)) return [];

  return jsonData.map((item) => {
    const rawUrl = item.url || '';
    const slugMatch = rawUrl.match(/\/anime\/([^/]+)/);
    const slug = item.slug || (slugMatch ? slugMatch[1] : '');

    const genres: string[] = item.genre
      ? item.genre.split(',').map((g: string) => g.trim()).filter(Boolean)
      : [];

    const score = item.east_score ? parseFloat(item.east_score) : null;

    const rawDay = (item.east_schedule || day || '').trim().toLowerCase();
    const dayMap: Record<string, string> = {
      monday: 'Monday',
      senin: 'Monday',
      tuesday: 'Tuesday',
      selasa: 'Tuesday',
      wednesday: 'Wednesday',
      rabu: 'Wednesday',
      thursday: 'Thursday',
      kamis: 'Thursday',
      friday: 'Friday',
      jumat: 'Friday',
      saturday: 'Saturday',
      sabtu: 'Saturday',
      sunday: 'Sunday',
      minggu: 'Sunday',
    };
    const normalizedDay = dayMap[rawDay] || (rawDay ? rawDay.charAt(0).toUpperCase() + rawDay.slice(1) : 'Unknown');

    return {
      animeSlug: slug,
      title: item.title || slug,
      day: normalizedDay,
      time: item.east_time || null,
      type: item.east_type || null,
      score: isNaN(score as any) ? null : score,
      poster: item.featured_img_src || null,
      genres,
      url: rawUrl,
    };
  });
}

export function parseScheduleHtml(html: string): ScheduleItem[] {
  if (!html || typeof html !== 'string') {
    throw new ParsingError('HTML kosong saat parsing jadwal');
  }

  const $ = cheerio.load(html);
  const items: ScheduleItem[] = [];

  $('.schedule .animepost, .result-schedule .animepost').each((_, el) => {
    const linkEl = $(el).find('a').first();
    const href = linkEl.attr('href') || '';
    const slugMatch = href.match(/\/anime\/([^/]+)/);
    const slug = slugMatch ? slugMatch[1] : '';

    const title = $(el).find('.data .title').text().trim() || linkEl.attr('title') || '';
    const type = $(el).find('.type').first().text().trim() || null;

    const scoreText = $(el).find('.score').text().trim();
    const scoreMatch = scoreText.match(/(\d+\.\d+|\d+)/);
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : null;

    const time = $(el).find('.ltseps').text().trim() || null;
    const imgEl = $(el).find('img').first();
    const poster = imgEl.attr('src') || imgEl.attr('data-src') || null;

    if (slug) {
      items.push({
        animeSlug: slug,
        title,
        day: 'Unknown',
        time,
        type,
        score,
        poster,
        genres: [],
        url: href,
      });
    }
  });

  return items;
}
