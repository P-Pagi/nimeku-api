import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../../db/prisma.js';
import { redis } from '../../cache/redis.client.js';
import { sourceCircuitBreaker } from '../../resilience/circuit-breaker.js';
import { config } from '../../config/env.js';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /health
  fastify.get('/health', {
    schema: {
      tags: ['Health'],
      summary: 'API and database health check',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            database: { type: 'string' },
            redis: { type: 'string' },
            uptimeSeconds: { type: 'number' },
          },
        },
      },
    },
    handler: async () => {
      let dbStatus = 'connected';
      let redisStatus = 'connected';

      try {
        await prisma.$queryRaw`SELECT 1`;
      } catch {
        dbStatus = 'disconnected';
      }

      try {
        if (redis.status !== 'ready' && redis.status !== 'connect') {
          redisStatus = 'disconnected';
        }
      } catch {
        redisStatus = 'disconnected';
      }

      return {
        status: dbStatus === 'connected' ? 'ok' : 'degraded',
        database: dbStatus,
        redis: redisStatus,
        uptimeSeconds: Math.floor(process.uptime()),
      };
    },
  });

  // GET /health/source (Lightweight check, no full scraping)
  fastify.get('/health/source', {
    schema: {
      tags: ['Health'],
      summary: 'Source website availability check',
    },
    handler: async () => {
      const circuit = sourceCircuitBreaker.getStats();

      let reachability = 'unknown';
      let latencyMs = 0;

      if (circuit.state === 'OPEN') {
        reachability = 'circuit_open';
      } else {
        const start = Date.now();
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5000);
          const res = await fetch(config.SOURCE_BASE_URL, {
            method: 'HEAD',
            signal: controller.signal,
          });
          clearTimeout(timer);
          latencyMs = Date.now() - start;
          reachability = res.ok || res.status === 403 ? 'reachable' : `status_${res.status}`;
        } catch {
          reachability = 'unreachable';
        }
      }

      return {
        success: true,
        data: {
          sourceBaseUrl: config.SOURCE_BASE_URL,
          reachability,
          latencyMs,
          circuitBreaker: circuit,
        },
      };
    },
  });
};
