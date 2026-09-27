import { createHash } from 'crypto';

export class ChangeDetector {
  /**
   * Generates a deterministic hash representing key anime metadata
   */
  public static computeHash(data: {
    title?: string | null;
    latestEpisode?: string | null;
    status?: string | null;
    episodeCount?: number | null;
    score?: number | null;
    synopsis?: string | null;
    poster?: string | null;
  }): string {
    const raw = [
      data.title || '',
      data.latestEpisode || '',
      data.status || '',
      data.episodeCount ?? '',
      data.score ?? '',
      data.synopsis || '',
      data.poster || '',
    ].join('|');

    return createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Safely merges scraped data with existing database data without nullifying valid fields
   * Implements Rule #41 (Safe Database Update)
   */
  public static mergeSafe<T extends Record<string, any>>(existing: T | null, incoming: Partial<T>): T {
    if (!existing) {
      return incoming as T;
    }

    const merged = { ...existing } as Record<string, any>;

    for (const [key, value] of Object.entries(incoming)) {
      // Do not overwrite an existing valid field with null or undefined
      if (value === null || value === undefined || value === '') {
        const existingVal = existing[key];
        if (existingVal !== null && existingVal !== undefined && existingVal !== '') {
          // Keep existing valid value
          continue;
        }
      }
      merged[key] = value;
    }

    return merged as T;
  }
}
