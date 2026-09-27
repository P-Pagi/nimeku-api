import { FastifyPluginAsync } from 'fastify';
import { animeService } from '../../services/anime.service.js';
import { cacheService } from '../../cache/cache.service.js';
import { prisma } from '../../db/prisma.js';
import { homeScraper } from '../../scraper/scrapers/home.scraper.js';
import { logger } from '../../config/logger.js';

// Helper: get current anime season string e.g. "Summer 2026"
function getCurrentSeason(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-12
  let season: string;
  if (month >= 1 && month <= 3) season = 'Winter';
  else if (month >= 4 && month <= 6) season = 'Spring';
  else if (month >= 7 && month <= 9) season = 'Summer';
  else season = 'Fall';
  return `${season} ${year}`;
}

// Helper: get today's day name in English e.g. "Friday"
function getTodayDayName(): string {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[new Date().getDay()];
}

export const animeRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/home
  fastify.get('/home', {
    schema: {
      tags: ['Anime'],
      summary: 'Home page data: top10, featured, newSeason, movies, schedule, recent, ongoing',
    },
    handler: async () => {
      const cacheKey = 'home';
      const cached = await cacheService.get<any>(cacheKey);
      if (cached) {
        return { success: true, data: cached };
      }

      // 1. Ambil Top 10 minggu ini dari Samehadaku (slider beranda)
      let weeklyTop10 = await cacheService.get<any[]>('anime:top10:weekly');
      if (!weeklyTop10 || weeklyTop10.length === 0) {
        try {
          const homeData = await homeScraper.scrape();
          if (homeData.top10 && homeData.top10.length > 0) {
            weeklyTop10 = homeData.top10;
            await cacheService.set('anime:top10:weekly', weeklyTop10, 86400); // 24 hours
          }
        } catch (err: any) {
          logger.warn({ error: err.message }, 'Failed fetching weekly Top 10 slider');
        }
      }

      let topAnime: any[] = [];
      if (weeklyTop10 && weeklyTop10.length > 0) {
        const slugs = weeklyTop10.map((i) => i.slug).filter(Boolean);
        const dbItems = await prisma.anime.findMany({
          where: { slug: { in: slugs } },
          select: {
            id: true,
            slug: true,
            title: true,
            poster: true,
            score: true,
            rating: true,
            type: true,
            status: true,
          },
        });

        topAnime = weeklyTop10.map((item) => {
          const db = dbItems.find((a) => a.slug === item.slug);
          return {
            rank: item.rank,
            id: db?.id || null,
            slug: item.slug,
            title: db?.title || item.title,
            poster: db?.poster || item.poster,
            score: item.score ?? db?.score ?? null,
            type: db?.type || 'TV',
            status: db?.status || 'Ongoing',
          };
        });
      }

      // Fallback jika slider gagal di-scrape
      if (topAnime.length === 0) {
        topAnime = await prisma.anime.findMany({
          where: { score: { not: null } },
          take: 10,
          orderBy: { score: { sort: 'desc', nulls: 'last' } },
          select: {
            id: true,
            slug: true,
            title: true,
            poster: true,
            score: true,
            type: true,
            status: true,
          },
        });
      }

      const currentSeason = getCurrentSeason();
      const todayDay = getTodayDayName();

      // ── Recent: Redis ordered-slugs first (exact Samehadaku order) ─────────
      let dedupedRecent: any[] = [];
      let orderedSlugs = await cacheService.get<string[]>('anime:recent:ordered-slugs');

      if (!orderedSlugs || orderedSlugs.length === 0) {
        try {
          const homeData = await homeScraper.scrape();
          if (homeData.recentEpisodes && homeData.recentEpisodes.length > 0) {
            orderedSlugs = homeData.recentEpisodes
              .map((i) => i.animeSlug)
              .filter(Boolean)
              .filter((slug, idx, arr) => arr.indexOf(slug) === idx);
            if (orderedSlugs.length > 0) {
              await cacheService.set('anime:recent:ordered-slugs', orderedSlugs, 3600);
            }
          }
        } catch (err: any) {
          logger.warn({ error: err.message }, 'Failed on-demand scrape for recent anime slugs in home route');
        }
      }

      if (orderedSlugs && orderedSlugs.length > 0) {
        // Primary: gunakan urutan yang sudah di-scrape dari Samehadaku
        const recentSlugs = orderedSlugs.slice(0, 12);
        const recentAnimes = await prisma.anime.findMany({
          where: { slug: { in: recentSlugs } },
          select: {
            id: true,
            slug: true,
            title: true,
            poster: true,
            score: true,
            latestEpisode: true,
            status: true,
            episodes: {
              orderBy: { episodeNumber: 'desc' },
              take: 1,
              select: { episodeNumber: true, releasedAt: true },
            },
          },
        });
        // Preserve slug order dari Samehadaku
        dedupedRecent = recentSlugs
          .map((slug) => {
            const a = recentAnimes.find((x) => x.slug === slug);
            if (!a) return null;
            const latestEp = a.episodes[0];
            return {
              id: a.id,
              slug: a.slug,
              title: a.title,
              poster: a.poster,
              score: a.score,
              latestEpisode: a.latestEpisode,
              status: a.status,
              latestEpisodeNumber: latestEp?.episodeNumber ?? null,
              latestEpisodeReleasedAt: latestEp?.releasedAt ?? null,
            };
          })
          .filter(Boolean);
      } else {
        // Fallback: 60 episode terbaru berdasarkan createdAt (waktu insert/sinkronisasi terbaru),
        // deduplikasi per anime — TANPA filter status
        const recentEps = await prisma.episode.findMany({
          take: 60,
          orderBy: { createdAt: 'desc' },
          select: {
            animeId: true,
            anime: {
              select: {
                id: true,
                slug: true,
                title: true,
                poster: true,
                score: true,
                latestEpisode: true,
                status: true,
              },
            },
            episodeNumber: true,
            releasedAt: true,
          },
        });
        const seenIds = new Set<string>();
        for (const ep of recentEps) {
          if (!seenIds.has(ep.animeId) && dedupedRecent.length < 12) {
            seenIds.add(ep.animeId);
            dedupedRecent.push({
              ...ep.anime,
              latestEpisodeNumber: ep.episodeNumber,
              latestEpisodeReleasedAt: ep.releasedAt,
            });
          }
        }
      }

      const [ongoingAnime, featuredAnime, newSeasonAnime, topMovies, todaySchedule] = await Promise.all([
        // Ongoing terpopuler (score tertinggi)
        prisma.anime.findMany({
          take: 8,
          where: {
            status: { equals: 'Ongoing', mode: 'insensitive' },
            score: { not: null },
          },
          orderBy: { score: { sort: 'desc', nulls: 'last' } },
          select: {
            id: true,
            slug: true,
            title: true,
            poster: true,
            score: true,
            type: true,
          },
        }),
        // Featured: 5 anime ongoing score tertinggi dengan synopsis (hero banner)
        prisma.anime.findMany({
          take: 5,
          where: {
            status: { equals: 'Ongoing', mode: 'insensitive' },
            score: { not: null },
            synopsis: { not: null },
            poster: { not: null },
          },
          orderBy: { score: { sort: 'desc', nulls: 'last' } },
          select: {
            id: true,
            slug: true,
            title: true,
            alternativeTitle: true,
            poster: true,
            synopsis: true,
            score: true,
            rating: true,
            type: true,
            season: true,
            genres: { include: { genre: true } },
          },
        }),
        // New Season: anime yang tayang di season ini
        prisma.anime.findMany({
          take: 12,
          where: {
            season: { contains: currentSeason, mode: 'insensitive' },
          },
          orderBy: { score: { sort: 'desc', nulls: 'last' } },
          select: {
            id: true,
            slug: true,
            title: true,
            poster: true,
            score: true,
            type: true,
            status: true,
            totalEpisodes: true,
            latestEpisode: true,
            season: true,
          },
        }),
        // Top Movies
        prisma.anime.findMany({
          take: 8,
          where: {
            type: { equals: 'Movie', mode: 'insensitive' },
            score: { not: null },
          },
          orderBy: { score: { sort: 'desc', nulls: 'last' } },
          select: {
            id: true,
            slug: true,
            title: true,
            poster: true,
            score: true,
            rating: true,
            duration: true,
            releaseYear: true,
          },
        }),
        // Schedule hari ini
        prisma.schedule.findMany({
          where: {
            day: { equals: todayDay, mode: 'insensitive' },
          },
          orderBy: { time: 'asc' },
          include: {
            anime: {
              select: {
                id: true,
                slug: true,
                title: true,
                poster: true,
                score: true,
                type: true,
                latestEpisode: true,
                status: true,
              },
            },
          },
        }),
      ]);

      let finalNewSeasonItems = newSeasonAnime;
      if (finalNewSeasonItems.length === 0) {
        finalNewSeasonItems = await prisma.anime.findMany({
          take: 12,
          where: { status: { equals: 'Ongoing', mode: 'insensitive' } },
          orderBy: { score: { sort: 'desc', nulls: 'last' } },
          select: {
            id: true,
            slug: true,
            title: true,
            poster: true,
            score: true,
            type: true,
            status: true,
            totalEpisodes: true,
            latestEpisode: true,
            season: true,
          },
        });
      }

      const payload = {
        top10: topAnime,
        featured: featuredAnime.map((a) => ({
          ...a,
          genres: a.genres.map((g) => g.genre),
        })),
        newSeason: {
          season: currentSeason,
          items: finalNewSeasonItems,
        },
        movies: topMovies,
        todaySchedule: {
          day: todayDay,
          items: todaySchedule.map((s) => ({
            time: s.time,
            anime: s.anime,
          })),
        },
        recent: dedupedRecent,
        ongoing: ongoingAnime,
      };

      await cacheService.set(cacheKey, payload, 300);
      return { success: true, data: payload };
    },
  });

  // GET /api/v1/anime (Catalog)
  fastify.get('/anime', {
    schema: {
      tags: ['Anime'],
      summary: 'Daftar katalog anime dengan filter dan pagination',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 20 },
          status: { type: 'string', enum: ['Ongoing', 'Completed', 'Upcoming'], description: 'Filter by status' },
          type: { type: 'string', enum: ['TV', 'Movie', 'OVA', 'ONA', 'Special', 'Music'], description: 'Filter by type' },
          order: { type: 'string', enum: ['popular', 'latest', 'score', 'title'], default: 'latest' },
          genre: { type: 'string', description: 'Filter by genre slug (e.g. action, romance)' },
          year: { type: 'integer', description: 'Filter by release year (e.g. 2024)' },
          season: { type: 'string', description: 'Filter by season string (e.g. "Fall 2024", "Summer 2026")' },
          minScore: { type: 'number', description: 'Minimum score filter (e.g. 7.5)' },
        },
      },
    },
    handler: async (request) => {
      const query = request.query as any;
      if (query.year) query.year = Number(query.year);
      if (query.minScore) query.minScore = Number(query.minScore);
      const result = await animeService.list(query);
      return {
        success: true,
        data: result.items,
        meta: result.pagination,
      };
    },
  });

  // GET /api/v1/anime/recent
  fastify.get('/anime/recent', {
    schema: {
      tags: ['Anime'],
      summary: 'Anime terbaru berdasarkan episode yang paling baru ditambahkan',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 20 },
        },
      },
    },
    handler: async (request) => {
      const { page = 1, limit = 20 } = request.query as any;
      const result = await animeService.getRecentlyUpdated(page, limit);
      return {
        success: true,
        data: result.items,
        meta: result.pagination,
      };
    },
  });

  // GET /api/v1/anime/ongoing
  fastify.get('/anime/ongoing', {
    schema: {
      tags: ['Anime'],
      summary: 'Daftar anime ongoing',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 20 },
        },
      },
    },
    handler: async (request) => {
      const { page = 1, limit = 20 } = request.query as any;
      const result = await animeService.list({ page, limit, status: 'Ongoing', order: 'popular' });
      return {
        success: true,
        data: result.items,
        meta: result.pagination,
      };
    },
  });

  // GET /api/v1/anime/completed
  fastify.get('/anime/completed', {
    schema: {
      tags: ['Anime'],
      summary: 'Daftar anime tamat (completed)',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 20 },
        },
      },
    },
    handler: async (request) => {
      const { page = 1, limit = 20 } = request.query as any;
      const result = await animeService.list({ page, limit, status: 'Completed', order: 'popular' });
      return {
        success: true,
        data: result.items,
        meta: result.pagination,
      };
    },
  });

  // GET /api/v1/anime/top10 (Slider mingguan resmi Samehadaku)
  fastify.get('/anime/top10', {
    schema: {
      tags: ['Anime'],
      summary: 'Top 10 anime minggu ini langsung dari slider beranda Samehadaku',
    },
    handler: async () => {
      let weeklyTop10 = await cacheService.get<any[]>('anime:top10:weekly');
      if (!weeklyTop10 || weeklyTop10.length === 0) {
        try {
          const homeData = await homeScraper.scrape();
          if (homeData.top10 && homeData.top10.length > 0) {
            weeklyTop10 = homeData.top10;
            await cacheService.set('anime:top10:weekly', weeklyTop10, 86400);
          }
        } catch (err: any) {
          logger.warn({ error: err.message }, 'Failed fetching weekly Top 10');
        }
      }

      if (!weeklyTop10 || weeklyTop10.length === 0) {
        return { success: true, data: [] };
      }

      const slugs = weeklyTop10.map((i) => i.slug).filter(Boolean);
      const dbItems = await prisma.anime.findMany({
        where: { slug: { in: slugs } },
      });

      const items = weeklyTop10.map((item) => {
        const db = dbItems.find((a) => a.slug === item.slug);
        return animeService.formatAnime({
          ...(db || {}),
          rank: item.rank,
          title: db?.title || item.title,
          slug: item.slug,
          score: item.score ?? db?.score ?? null,
          poster: db?.poster || item.poster,
        });
      });

      return { success: true, data: items };
    },
  });

  // GET /api/v1/anime/popular
  fastify.get('/anime/popular', {
    schema: {
      tags: ['Anime'],
      summary: 'Daftar anime populer (bisa mingguan/weekly atau all-time score)',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 20 },
          timeframe: { type: 'string', enum: ['weekly', 'all'], default: 'weekly' },
        },
      },
    },
    handler: async (request) => {
      const { page = 1, limit = 20, timeframe = 'weekly' } = request.query as any;

      // Jika timeframe mingguan dan page 1, sajikan Top 10 mingguan Samehadaku
      if (timeframe === 'weekly' && page === 1) {
        let weeklyTop10 = await cacheService.get<any[]>('anime:top10:weekly');
        if (!weeklyTop10 || weeklyTop10.length === 0) {
          try {
            const homeData = await homeScraper.scrape();
            if (homeData.top10 && homeData.top10.length > 0) {
              weeklyTop10 = homeData.top10;
              await cacheService.set('anime:top10:weekly', weeklyTop10, 86400);
            }
          } catch {}
        }

        if (weeklyTop10 && weeklyTop10.length > 0) {
          const slugs = weeklyTop10.map((i) => i.slug).filter(Boolean);
          const dbItems = await prisma.anime.findMany({
            where: { slug: { in: slugs } },
          });

          const items = weeklyTop10.slice(0, limit).map((item) => {
            const db = dbItems.find((a) => a.slug === item.slug);
            return animeService.formatAnime({
              ...(db || {}),
              rank: item.rank,
              title: db?.title || item.title,
              slug: item.slug,
              score: item.score ?? db?.score ?? null,
              poster: db?.poster || item.poster,
            });
          });

          return {
            success: true,
            data: items,
            meta: {
              page: 1,
              limit,
              total: weeklyTop10.length,
              totalPages: 1,
              hasNextPage: false,
              hasPreviousPage: false,
            },
          };
        }
      }

      // Default: urutkan berdasarkan all-time score tertinggi
      const result = await animeService.list({ page, limit, order: 'popular' });
      return {
        success: true,
        data: result.items,
        meta: result.pagination,
      };
    },
  });

  // GET /api/v1/anime/movies
  fastify.get('/anime/movies', {
    schema: {
      tags: ['Anime'],
      summary: 'Daftar anime tipe Movie',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 20 },
        },
      },
    },
    handler: async (request) => {
      const { page = 1, limit = 20 } = request.query as any;
      const result = await animeService.list({ page, limit, type: 'Movie', order: 'score' });
      return {
        success: true,
        data: result.items,
        meta: result.pagination,
      };
    },
  });

  // GET /api/v1/anime/:slug/episodes
  fastify.get('/anime/:slug/episodes', {
    schema: {
      tags: ['Anime'],
      summary: 'Daftar episode anime berdasarkan slug, diurutkan dari episode terbaru',
      params: {
        type: 'object',
        required: ['slug'],
        properties: {
          slug: { type: 'string' },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 50 },
          order: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
        },
      },
    },
    handler: async (request) => {
      const { slug } = request.params as { slug: string };
      const { page = 1, limit = 50, order = 'desc' } = request.query as any;

      const anime = await prisma.anime.findUnique({
        where: { slug },
        select: { id: true, slug: true, title: true, totalEpisodes: true },
      });

      if (!anime) {
        return { success: false, error: { code: 'NOT_FOUND', message: `Anime '${slug}' tidak ditemukan` } };
      }

      const skip = (page - 1) * limit;

      const [total, episodes] = await Promise.all([
        prisma.episode.count({ where: { animeId: anime.id } }),
        prisma.episode.findMany({
          where: { animeId: anime.id },
          orderBy: { episodeNumber: order as 'asc' | 'desc' },
          skip,
          take: limit,
          select: {
            id: true,
            slug: true,
            episodeNumber: true,
            title: true,
            thumbnail: true,
            releasedAt: true,
          },
        }),
      ]);

      const totalPages = Math.ceil(total / limit);
      return {
        success: true,
        data: {
          anime: { id: anime.id, slug: anime.slug, title: anime.title, totalEpisodes: anime.totalEpisodes },
          episodes,
        },
        meta: {
          page,
          limit,
          total,
          totalPages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1,
        },
      };
    },
  });

  // GET /api/v1/anime/:slug
  fastify.get('/anime/:slug', {
    schema: {
      tags: ['Anime'],
      summary: 'Detail lengkap anime berdasarkan slug',
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
      const anime = await animeService.getBySlug(slug);
      return {
        success: true,
        data: anime,
      };
    },
  });

  // GET /api/v1/search?q=one+piece
  fastify.get('/search', {
    schema: {
      tags: ['Anime'],
      summary: 'Pencarian anime dari database PostgreSQL dengan opsional filter tambahan',
      querystring: {
        type: 'object',
        required: ['q'],
        properties: {
          q: { type: 'string', description: 'Kata kunci pencarian' },
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 20 },
          type: { type: 'string', enum: ['TV', 'Movie', 'OVA', 'ONA', 'Special', 'Music'], description: 'Filter tipe anime' },
          status: { type: 'string', enum: ['Ongoing', 'Completed', 'Upcoming'], description: 'Filter status' },
          genre: { type: 'string', description: 'Filter genre slug' },
          minScore: { type: 'number', description: 'Minimum score (e.g. 7.0)' },
        },
      },
    },
    handler: async (request) => {
      const { q, page = 1, limit = 20, type, status, genre, minScore } = request.query as {
        q: string;
        page?: number;
        limit?: number;
        type?: string;
        status?: string;
        genre?: string;
        minScore?: number;
      };
      const result = await animeService.search(q, page, limit, { type, status, genre, minScore: minScore ? Number(minScore) : undefined });
      return {
        success: true,
        data: result.items,
        meta: result.pagination,
      };
    },
  });
};
