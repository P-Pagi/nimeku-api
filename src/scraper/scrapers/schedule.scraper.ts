import { httpClient } from '../client/http.client.js';
import {
  parseScheduleHtml,
  parseScheduleJson,
  ScheduleItem,
} from '../parsers/schedule.parser.js';
import { buildScheduleApiUrl, buildScheduleUrl } from '../utils/url.builder.js';
import { logger } from '../../config/logger.js';

export const DAYS_OF_WEEK = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

export class ScheduleScraper {
  public async scrapeAllDays(): Promise<ScheduleItem[]> {
    // 1. Try WP JSON API per-day first (most accurate: includes all 7 days with broadcast times)
    const apiItems = await this.scrapeFromJsonApi();
    if (apiItems.length > 0) {
      logger.info({ count: apiItems.length }, 'Schedule scraped successfully from JSON API');
      return apiItems;
    }

    // 2. Fallback: try HTML schedule page
    logger.warn('JSON API schedule empty, attempting HTML fallback');
    return this.scrapeFromHtml();
  }

  private async scrapeFromHtml(): Promise<ScheduleItem[]> {
    try {
      const htmlUrl = buildScheduleUrl();
      const res = await httpClient.fetch(htmlUrl);
      if (res.status === 200 && res.data) {
        return parseScheduleHtml(res.data);
      }
      return [];
    } catch (err: any) {
      logger.warn({ error: err.message }, 'HTML schedule fetch failed');
      return [];
    }
  }

  private async scrapeFromJsonApi(): Promise<ScheduleItem[]> {
    const allItems: ScheduleItem[] = [];
    for (const day of DAYS_OF_WEEK) {
      try {
        const url = buildScheduleApiUrl(day, 50);
        // bypassCircuitBreaker: 403 on this endpoint is expected policy, not a site outage
        const res = await httpClient.fetch(url, {
          useCacheHeaders: false,
          bypassCircuitBreaker: true,
        });
        if (res.status !== 200) {
          logger.debug({ day, status: res.status }, 'JSON schedule API not available for day');
          continue;
        }
        const json = JSON.parse(res.data);
        if (Array.isArray(json)) {
          allItems.push(...parseScheduleJson(json, day));
        }
      } catch (err: any) {
        logger.debug({ day, error: err.message }, 'JSON schedule API failed for day, skipping');
      }
    }
    return allItems;
  }

  public async scrapeDay(day: string): Promise<ScheduleItem[]> {
    try {
      const url = buildScheduleApiUrl(day, 50);
      const res = await httpClient.fetch(url, { bypassCircuitBreaker: true });
      if (res.status !== 200) return [];
      const json = JSON.parse(res.data);
      return parseScheduleJson(json, day);
    } catch {
      return [];
    }
  }
}

export const scheduleScraper = new ScheduleScraper();
