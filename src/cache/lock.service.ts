import { redis } from './redis.client.js';
import { logger } from '../config/logger.js';
import { randomUUID } from 'crypto';

export class DistributedLockService {
  /**
   * Acquire a lock using Redis SET with NX and EX flags.
   * Returns a lock token if acquired, or null if lock is already held.
   */
  public async acquireLock(key: string, ttlSeconds = 60): Promise<string | null> {
    try {
      if (redis.status !== 'ready' && redis.status !== 'connect') {
        // Fallback for standalone / offline environments
        return randomUUID();
      }

      const token = randomUUID();
      const lockKey = `lock:${key}`;
      const result = await redis.set(lockKey, token, 'EX', ttlSeconds, 'NX');

      if (result === 'OK') {
        logger.debug({ lockKey, ttlSeconds }, 'Acquired distributed lock');
        return token;
      }

      logger.debug({ lockKey }, 'Lock already acquired by another worker');
      return null;
    } catch (err: any) {
      logger.warn({ key, error: err.message }, 'Failed to acquire distributed lock');
      return null;
    }
  }

  /**
   * Release lock only if the token matches (atomic release using Lua script)
   */
  public async releaseLock(key: string, token: string): Promise<boolean> {
    try {
      if (redis.status !== 'ready' && redis.status !== 'connect') {
        return true;
      }

      const lockKey = `lock:${key}`;
      const luaScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;

      const result = await redis.eval(luaScript, 1, lockKey, token);
      return result === 1;
    } catch (err: any) {
      logger.warn({ key, error: err.message }, 'Failed to release distributed lock');
      return false;
    }
  }
}

export const lockService = new DistributedLockService();
