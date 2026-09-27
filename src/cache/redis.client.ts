import { Redis, RedisOptions } from 'ioredis';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

const isLocalRedis = config.REDIS_URL.startsWith('redis://localhost') ||
  config.REDIS_URL.startsWith('redis://127.0.0.1');

export function getBullMQConnectionOptions(): RedisOptions {
  const parsed = new Redis(config.REDIS_URL, { lazyConnect: true }).options;
  delete (parsed as any).lazyConnect;
  return {
    ...parsed,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // keepAlive only needed for cloud connections (Upstash drops idle TLS sockets)
    ...(isLocalRedis ? {} : { keepAlive: 15000 }),
    retryStrategy(times: number) {
      // Local: retry fast; Cloud: exponential backoff
      return isLocalRedis ? Math.min(times * 100, 1000) : Math.min(times * 500, 5000);
    },
    reconnectOnError(err) {
      const targetErrors = ['READONLY', 'ETIMEDOUT', 'ECONNRESET', 'Connection is closed'];
      return targetErrors.some((target) => err.message.includes(target));
    },
  };
}

export function createRedisClient(): Redis {
  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,
    lazyConnect: true,
    // keepAlive only needed for cloud — local socket doesn't time out
    ...(isLocalRedis ? {} : { keepAlive: 15000 }),
    retryStrategy(times) {
      // Local: reconnect quickly; Cloud: exponential backoff to avoid hammering
      return isLocalRedis ? Math.min(times * 100, 1000) : Math.min(times * 500, 5000);
    },
    reconnectOnError: (err) => {
      const targetErrors = ['READONLY', 'ETIMEDOUT', 'ECONNRESET', 'Connection is closed'];
      return targetErrors.some((target) => err.message.includes(target));
    },
  });

  // Track warning count to avoid log spam when Redis is unavailable
  let warnCount = 0;

  redis.on('connect', () => {
    warnCount = 0; // Reset counter on successful connection
    logger.info('Connected to Redis');
  });

  redis.on('error', (err) => {
    warnCount++;
    if (warnCount <= 3) {
      logger.warn(
        { error: err.message },
        'Redis unavailable or connection dropped — retrying in background'
      );
    }
  });

  return redis;
}

export const redis = createRedisClient();

