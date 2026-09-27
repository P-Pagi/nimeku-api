import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../../db/prisma.js';
import { cacheService } from '../../cache/cache.service.js';

export const statsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/stats
  fastify.get('/stats', {
    schema: {
      tags: ['Stats'],
      summary: 'Statistik global API: total anime, episode, genre, server streaming, dll.',
    },
    handler: async () => {
      const cacheKey = 'api:stats';
      const cached = await cacheService.get<any>(cacheKey);
      if (cached) return { success: true, data: cached };

      const [
        totalAnime,
        totalEpisodes,
        totalGenres,
        totalServers,
        totalBatches,
        totalSchedules,
        ongoingAnime,
        completedAnime,
        animeByType,
        topGenres,
      ] = await Promise.all([
        prisma.anime.count(),
        prisma.episode.count(),
        prisma.genre.count(),
        prisma.streamServer.count(),
        prisma.batch.count(),
        prisma.schedule.count(),
        prisma.anime.count({ where: { status: { equals: 'Ongoing', mode: 'insensitive' } } }),
        prisma.anime.count({ where: { status: { equals: 'Completed', mode: 'insensitive' } } }),
        // Breakdown by type
        prisma.anime.groupBy({
          by: ['type'],
          _count: { _all: true },
          orderBy: { _count: { type: 'desc' } },
        }),
        // Top 10 genres by anime count
        prisma.genre.findMany({
          take: 10,
          include: {
            _count: { select: { animes: true } },
          },
          orderBy: {
            animes: { _count: 'desc' },
          },
        }),
      ]);

      const episodesWithServers = await prisma.episode.count({
        where: { servers: { some: {} } },
      });

      const stats = {
        anime: {
          total: totalAnime,
          ongoing: ongoingAnime,
          completed: completedAnime,
          byType: animeByType.map((t) => ({ type: t.type || 'Unknown', count: t._count._all })),
        },
        episodes: {
          total: totalEpisodes,
          withServers: episodesWithServers,
          withoutServers: totalEpisodes - episodesWithServers,
          serverCoverage:
            totalEpisodes > 0 ? `${((episodesWithServers / totalEpisodes) * 100).toFixed(1)}%` : '0%',
        },
        genres: {
          total: totalGenres,
          top10: topGenres.map((g) => ({ name: g.name, slug: g.slug, count: g._count.animes })),
        },
        streamServers: {
          total: totalServers,
        },
        batches: {
          total: totalBatches,
        },
        schedules: {
          total: totalSchedules,
        },
        generatedAt: new Date().toISOString(),
      };

      // Cache for 10 minutes
      await cacheService.set(cacheKey, stats, 600);
      return { success: true, data: stats };
    },
  });
};
