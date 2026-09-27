import { redis } from './redis.client.js';
import { logger } from '../config/logger.js';

export interface CacheEntry<T> {
  data: T;
  cachedAt: number;
  staleAfter: number;
}

export class CacheService {
  private isConnected = false;

  private async ensureConnection(): Promise<boolean> {
    try {
      if (redis.status === 'ready' || redis.status === 'connect') {
        return true;
      }
      if (redis.status === 'wait' || redis.status === 'close' || redis.status === 'end') {
        await redis.connect();
        this.isConnected = true;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  public async get<T>(key: string): Promise<T | null> {
    try {
      const ready = await this.ensureConnection();
      if (!ready) return null;

      const raw = await redis.get(key);
      if (!raw) {
        logger.debug({ key }, 'Cache MISS');
        return null;
      }
      logger.debug({ key }, 'Cache HIT');
      return JSON.parse(raw) as T;
    } catch (err: any) {
      logger.warn({ key, error: err.message }, 'Redis get error, bypassing cache');
      return null;
    }
  }

  public async set(key: string, value: any, ttlSeconds = 300): Promise<void> {
    try {
      const ready = await this.ensureConnection();
      if (!ready) return;

      const stringified = JSON.stringify(value);
      if (ttlSeconds > 0) {
        await redis.setex(key, ttlSeconds, stringified);
      } else {
        await redis.set(key, stringified);
      }
    } catch (err: any) {
      logger.warn({ key, error: err.message }, 'Redis set error');
    }
  }

  public async del(key: string): Promise<void> {
    try {
      const ready = await this.ensureConnection();
      if (!ready) return;
      await redis.del(key);
    } catch (err: any) {
      logger.warn({ key, error: err.message }, 'Redis del error');
    }
  }

  public async delByPattern(pattern: string): Promise<void> {
    try {
      const ready = await this.ensureConnection();
      if (!ready) return;

      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
        logger.info({ pattern, deletedCount: keys.length }, 'Invalidated cache pattern');
      }
    } catch (err: any) {
      logger.warn({ pattern, error: err.message }, 'Redis delByPattern error');
    }
  }

  /**
   * Invalidate all related caches when anime or episodes are updated
   */
  public async invalidateAnime(slug: string): Promise<void> {
    logger.info({ slug }, 'Invalidating cache for anime and lists');
    await Promise.allSettled([
      this.del(`anime:${slug}`),
      this.del('home'),
      this.del('schedule'),
      this.delByPattern('recent:*'),
      this.delByPattern('ongoing:*'),
      this.delByPattern('popular:*'),
      this.delByPattern(`episode:${slug}*`),
      this.delByPattern('anime:recently-updated:*'),
    ]);
  }

  /**
   * Stale-While-Revalidate wrapper
   */
  public async swr<T>(
    key: string,
    ttlSeconds: number,
    staleSeconds: number,
    fetchFresh: () => Promise<T>,
    onRevalidate?: () => void
  ): Promise<T> {
    const cached = await this.get<CacheEntry<T>>(key);

    if (cached) {
      const now = Date.now();
      const isStale = now > cached.staleAfter;

      if (isStale && onRevalidate) {
        logger.debug({ key }, 'Serving STALE cache and triggering background revalidation');
        onRevalidate();
      }

      return cached.data;
    }

    const fresh = await fetchFresh();
    const entry: CacheEntry<T> = {
      data: fresh,
      cachedAt: Date.now(),
      staleAfter: Date.now() + staleSeconds * 1000,
    };

    await this.set(key, entry, ttlSeconds);
    return fresh;
  }
}

export const cacheService = new CacheService();
