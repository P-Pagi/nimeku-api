import { FastifyPluginAsync } from 'fastify';
import { episodeService } from '../../services/episode.service.js';
import { cacheService } from '../../cache/cache.service.js';
import { invalidateDomainHealth } from '../../services/server.health.js';

export const episodeRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/episode/:slug
  fastify.get('/episode/:slug', {
    schema: {
      tags: ['Episode'],
      summary: 'Detail episode anime, navigasi episode, dan daftar server streaming',
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
      const episode = await episodeService.getBySlug(slug);
      return {
        success: true,
        data: episode,
      };
    },
  });

  // GET /api/v1/episode/:slug/servers
  fastify.get('/episode/:slug/servers', {
    schema: {
      tags: ['Episode'],
      summary: 'Daftar server streaming untuk episode tertentu',
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
      const servers = await episodeService.getEpisodeServers(slug);
      return {
        success: true,
        data: servers,
      };
    },
  });

  /**
   * GET /api/v1/episode/:slug/servers/batch
   * Resolves all servers for an episode in parallel and returns them with health status.
   * Useful for frontend to show which servers are up before user clicks.
   */
  fastify.get('/episode/:slug/servers/batch', {
    schema: {
      tags: ['Episode'],
      summary: 'Resolve semua server sekaligus (parallel) dengan status kesehatan masing-masing',
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
      const serverList = await episodeService.getEpisodeServers(slug);

      // Resolve all servers in parallel (each resolveServerEmbed is cached individually)
      const results = await Promise.allSettled(
        serverList.map((s) => {
          const key = s.serverKey || s.id;
          return episodeService.resolveServerEmbed(slug, key);
        })
      );

      const data = serverList.map((s, i) => {
        const r = results[i];
        if (r.status === 'fulfilled') {
          return r.value;
        }
        return {
          serverKey: s.serverKey || s.id,
          name: s.name,
          embedUrl: null,
          serverProvider: 'unknown',
          isReachable: false,
          error: (r as PromiseRejectedResult).reason?.message ?? 'Resolve failed',
          resolvedAt: new Date().toISOString(),
        };
      });

      return {
        success: true,
        data,
      };
    },
  });

  // GET /api/v1/episode/:slug/servers/:serverId
  fastify.get('/episode/:slug/servers/:serverId', {
    schema: {
      tags: ['Episode'],
      summary: 'Resolve embed URL untuk server streaming tertentu (Lazy resolution dengan caching)',
      description:
        'Mengembalikan embedUrl, serverProvider (nama platform streaming), dan isReachable ' +
        '(apakah server saat ini bisa diakses). Server yang down di-cache hanya 90 detik ' +
        'sehingga otomatis dicoba ulang setelah server pulih.',
      params: {
        type: 'object',
        required: ['slug', 'serverId'],
        properties: {
          slug: { type: 'string' },
          serverId: { type: 'string' },
        },
      },
    },
    handler: async (request) => {
      const { slug, serverId } = request.params as { slug: string; serverId: string };
      const resolved = await episodeService.resolveServerEmbed(slug, serverId);
      return {
        success: true,
        data: resolved,
      };
    },
  });

  /**
   * DELETE /api/v1/episode/:slug/servers/:serverId
   * Force-retry a server that was cached as unreachable.
   * Clears both the Redis embed cache and the in-memory domain health cache
   * so the next resolve call will re-probe the server.
   */
  fastify.delete('/episode/:slug/servers/:serverId', {
    schema: {
      tags: ['Episode'],
      summary: 'Paksa retry server yang sedang down (hapus cache embed dan domain health)',
      params: {
        type: 'object',
        required: ['slug', 'serverId'],
        properties: {
          slug: { type: 'string' },
          serverId: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const { slug, serverId } = request.params as { slug: string; serverId: string };
      const cacheKey = `server:${slug}:${serverId}`;

      // Retrieve cached payload to get embedUrl for domain invalidation
      const cached = await cacheService.get<any>(cacheKey);
      if (cached?.embedUrl) {
        invalidateDomainHealth(cached.embedUrl);
      }

      await cacheService.del(cacheKey);

      reply.code(200);
      return {
        success: true,
        message: `Cache server ${serverId} untuk episode ${slug} berhasil dihapus. Resolve berikutnya akan cek ulang server.`,
      };
    },
  });

  // GET /api/v1/episode/:slug/downloads
  fastify.get('/episode/:slug/downloads', {
    schema: {
      tags: ['Episode'],
      summary: 'Daftar link download episode per resolusi (360p, 480p, 720p, 1080p)',
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
      const downloads = await episodeService.getEpisodeDownloads(slug);
      return {
        success: true,
        data: downloads,
      };
    },
  });
};
