import { FastifyPluginAsync } from 'fastify';
import { enqueueSyncJob } from '../../queue/queues.js';
import { syncStateService } from '../../services/sync-state.service.js';
import { cacheService } from '../../cache/cache.service.js';
import { syncEngine } from '../../sync/sync.engine.js';
import { config } from '../../config/env.js';
import { UnauthorizedError } from '../../resilience/errors.js';

export const adminRoutes: FastifyPluginAsync = async (fastify) => {
  // Authentication hook for all admin routes
  fastify.addHook('onRequest', async (request) => {
    const apiKey =
      (request.headers['x-admin-key'] as string) ||
      (request.headers['authorization']?.replace(/^Bearer\s+/i, ''));

    if (!apiKey || apiKey !== config.ADMIN_API_KEY) {
      throw new UnauthorizedError('Akses ditolak: ADMIN_API_KEY tidak valid');
    }
  });

  // POST /api/v1/admin/sync/recent
  fastify.post('/sync/recent', {
    schema: {
      tags: ['Admin Sync'],
      summary: 'Trigger incremental sync for recent anime episodes',
      security: [{ apiKey: [] }],
    },
    handler: async () => {
      const jobId = await enqueueSyncJob('recent');
      return {
        success: true,
        data: {
          jobId,
          message: 'Job sync recent berhasil dijadwalkan ke antrian',
        },
      };
    },
  });

  // POST /api/v1/admin/sync/anime/:slug
  fastify.post('/sync/anime/:slug', {
    schema: {
      tags: ['Admin Sync'],
      summary: 'Trigger sync for a specific anime by slug',
      security: [{ apiKey: [] }],
      params: {
        type: 'object',
        required: ['slug'],
        properties: {
          slug: { type: 'string' },
        },
      },
    },
    handler: async (request) => {
      const { slug } = request.params as { slug: string };
      const jobId = await enqueueSyncJob('anime', slug);
      return {
        success: true,
        data: {
          jobId,
          slug,
          message: `Job sync anime '${slug}' berhasil dijadwalkan ke antrian`,
        },
      };
    },
  });

  // POST /api/v1/admin/sync/all
  fastify.post('/sync/all', {
    schema: {
      tags: ['Admin Sync'],
      summary: 'Trigger full synchronization',
      security: [{ apiKey: [] }],
    },
    handler: async () => {
      const jobId = await enqueueSyncJob('all');
      return {
        success: true,
        data: {
          jobId,
          message: 'Job sync all berhasil dijadwalkan ke antrian',
        },
      };
    },
  });

  // GET /api/v1/admin/sync/status
  fastify.get('/sync/status', {
    schema: {
      tags: ['Admin Sync'],
      summary: 'Lihat status dan riwayat sinkronisasi scraper',
      security: [{ apiKey: [] }],
    },
    handler: async () => {
      const states = await syncStateService.getAllStates();
      return {
        success: true,
        data: states,
      };
    },
  });

  // POST /api/v1/admin/cache/clear
  fastify.post('/cache/clear', {
    schema: {
      tags: ['Admin Sync'],
      summary: 'Clear home + recent cache from Redis (force fresh data)',
      security: [{ apiKey: [] }],
    },
    handler: async () => {
      await cacheService.del('home');
      await cacheService.del('anime:recent:ordered-slugs');
      await cacheService.delByPattern('anime:recently-updated:*');
      return {
        success: true,
        data: { message: 'Cache home, ordered-slugs, dan recently-updated berhasil dihapus' },
      };
    },
  });

  // POST /api/v1/admin/sync/recent/run — direct in-process run (bypasses BullMQ dedup)
  fastify.post('/sync/recent/run', {
    schema: {
      tags: ['Admin Sync'],
      summary: 'Run syncRecent immediately in-process (bypass queue dedup), then clear home cache',
      security: [{ apiKey: [] }],
    },
    handler: async (_req, reply) => {
      // Fire-and-forget so the HTTP response returns immediately
      setImmediate(async () => {
        try {
          await syncEngine.syncRecent();
          await cacheService.del('home');
        } catch (err: any) {
          // logged inside syncEngine
        }
      });
      return reply.send({
        success: true,
        data: { message: 'syncRecent dimulai langsung (in-process). Home cache akan di-clear otomatis setelah selesai.' },
      });
    },
  });
};
