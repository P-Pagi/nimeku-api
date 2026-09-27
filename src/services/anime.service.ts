import { prisma } from '../db/prisma.js';
import { cacheService } from '../cache/cache.service.js';
import { ChangeDetector } from '../sync/change.detector.js';
import { ScrapedAnimeDetail } from '../scraper/parsers/anime.parser.js';
import { AnimeNotFoundError } from '../resilience/errors.js';
import { logger } from '../config/logger.js';
import { posterService } from './poster.service.js';
import { crossReferenceService } from './cross-reference.service.js';
import { homeScraper } from '../scraper/scrapers/home.scraper.js';
import { Prisma } from '@prisma/client';

export interface AnimeListQuery {
  page?: number;
  limit?: number;
  status?: string;
  type?: string;
  order?: 'popular' | 'latest' | 'score' | 'title';
  genre?: string;
  year?: number;
  season?: string;
  minScore?: number;
}

export class AnimeService {
  /**
   * Format anime object to prefer local poster path if available
   */
  public formatAnime(anime: any) {
    if (!anime) return anime;

    let totalEpisodes = anime.totalEpisodes;
    if (totalEpisodes == null) {
      if (anime.type === 'Movie') totalEpisodes = 1;
      else if (anime.status === 'Completed' && (anime.episodes?.length || anime._count?.episodes)) {
        totalEpisodes = anime.episodes?.length || anime._count?.episodes;
      }
    }

    let latestEpisode = anime.latestEpisode;
    if (!latestEpisode) {
      if (anime.type === 'Movie') latestEpisode = 'Movie';
      else if (anime.episodes && anime.episodes.length > 0) {
        latestEpisode = anime.episodes[0].episodeNumber != null
          ? String(anime.episodes[0].episodeNumber)
          : '1';
      }
    }

    const season = anime.season || crossReferenceService.deriveSeason(anime.releasedAt);
    const studio = anime.studio || null;
    const producers = anime.producers || studio || null;

    return {
      ...anime,
      poster: anime.posterLocal || anime.poster,
      posterOriginal: anime.poster,
      posterLocal: anime.posterLocal || null,
      season,
      totalEpisodes,
      latestEpisode,
      studio,
      producers,
      genres: anime.genres ? anime.genres.map((g: any) => g.genre || g) : [],
    };
  }

  /**
   * Format anime for public list response — only include relevant public fields.
   * Excludes internal fields: contentHash, sourceUrl, posterOriginal, lastSyncedAt, etc.
   */
  public formatAnimeList(anime: any) {
    const full = this.formatAnime(anime);
    if (!full) return null;
    return {
      id: full.id,
      slug: full.slug,
      title: full.title,
      alternativeTitle: full.alternativeTitle || null,
      japaneseTitle: full.japaneseTitle || null,
      poster: full.poster,
      status: full.status,
      type: full.type,
      score: full.score,
      rating: full.rating || null,
      duration: full.duration || null,
      totalEpisodes: full.totalEpisodes,
      latestEpisode: full.latestEpisode || null,
      season: full.season || null,
      releaseYear: full.releaseYear || null,
      studio: full.studio || null,
      genres: full.genres,
    };
  }

  private extractBaseTitle(title: string): string[] {
    if (!title) return [];
    let base = title.split(/[:：–—]| - /)[0].trim();
    base = base
      .replace(/\s*(Season|\bS\b|\bPart\b|\bCour\b)\s*\d+.*$/i, '')
      .replace(/\s*\d+(st|nd|rd|th)\s+Season.*$/i, '')
      .replace(/\s+(II|III|IV|V|VI|VII|VIII|IX|X)$/i, '')
      .replace(/\s+(Movie|The Movie|Film|The Final|TV|Special|OVA|ONA|Live Action|Side Story|Gaiden|Fan Letter).*$/i, '')
      .trim();

    const candidates = new Set<string>();
    if (base.length >= 3) candidates.add(base);

    const words = base.split(/\s+/);
    if (words.length >= 3) {
      const twoWords = words.slice(0, 2).join(' ');
      if (twoWords.length >= 6) candidates.add(twoWords);
    }

    return Array.from(candidates);
  }

  /**
   * Find single anime by slug, checking Redis cache first
   */
  public async getBySlug(slug: string) {
    const cacheKey = `anime:${slug}`;
    const cached = await cacheService.get<any>(cacheKey);
    if (cached) return cached;

    const anime = await prisma.anime.findUnique({
      where: { slug },
      include: {
        genres: {
          include: {
            genre: true,
          },
        },
        episodes: {
          orderBy: { episodeNumber: 'desc' },
          select: {
            id: true,
            slug: true,
            episodeNumber: true,
            title: true,
            thumbnail: true,
            releasedAt: true,
          },
        },
        batches: {
          select: {
            id: true,
            slug: true,
            title: true,
          },
        },
        schedules: true,
      },
    });

    if (!anime) {
      throw new AnimeNotFoundError(slug);
    }

    const episodes = anime.episodes || [];
    const latestEp = episodes.length > 0 ? episodes[0] : null;
    const firstEp = episodes.length > 0 ? episodes[episodes.length - 1] : null;

    const navigation = {
      firstEpisode: firstEp
        ? {
            id: firstEp.id,
            slug: firstEp.slug,
            episodeNumber: firstEp.episodeNumber,
            title: firstEp.title,
            releasedAt: firstEp.releasedAt,
          }
        : null,
      latestEpisode: latestEp
        ? {
            id: latestEp.id,
            slug: latestEp.slug,
            episodeNumber: latestEp.episodeNumber,
            title: latestEp.title,
            releasedAt: latestEp.releasedAt,
          }
        : null,
    };

    const genreSlugs = anime.genres
      .map((g: any) => g.genre?.slug || g.slug)
      .filter(Boolean);

    const titleCandidates = this.extractBaseTitle(anime.title);

    // Parallel fetch related recommendations, franchise/movies, and same studio anime
    const [relatedRaw, franchiseRaw, sameStudioRaw] = await Promise.all([
      genreSlugs.length > 0
        ? prisma.anime.findMany({
            where: {
              NOT: { id: anime.id },
              score: { not: null },
              genres: {
                some: {
                  genre: {
                    slug: { in: genreSlugs },
                  },
                },
              },
            },
            include: {
              genres: { include: { genre: true } },
            },
            orderBy: { score: { sort: 'desc', nulls: 'last' } },
            take: 12,
          })
        : Promise.resolve([]),

      titleCandidates.length > 0
        ? prisma.anime.findMany({
            where: {
              NOT: { id: anime.id },
              OR: titleCandidates.map((t) => ({
                title: { contains: t, mode: 'insensitive' as Prisma.QueryMode },
              })),
            },
            include: {
              genres: { include: { genre: true } },
            },
            orderBy: [
              { releaseYear: { sort: 'asc', nulls: 'last' } },
              { createdAt: 'asc' },
            ],
            take: 10,
          })
        : Promise.resolve([]),

      anime.studio && anime.studio.trim() && anime.studio.trim().toLowerCase() !== 'unknown'
        ? prisma.anime.findMany({
            where: {
              studio: { equals: anime.studio.trim(), mode: 'insensitive' },
              NOT: { id: anime.id },
              score: { not: null },
            },
            include: {
              genres: { include: { genre: true } },
            },
            orderBy: { score: { sort: 'desc', nulls: 'last' } },
            take: 6,
          })
        : Promise.resolve([]),
    ]);

    const franchiseIds = new Set(franchiseRaw.map((f) => f.id));
    const filteredRelated = relatedRaw.filter((r) => !franchiseIds.has(r.id)).slice(0, 8);
    const filteredSameStudio = sameStudioRaw.filter((s) => !franchiseIds.has(s.id));

    const formatted = {
      ...this.formatAnime(anime),
      navigation,
      franchise: franchiseRaw.map((a) => this.formatAnime(a)),
      related: filteredRelated.map((a) => this.formatAnime(a)),
      sameStudio: filteredSameStudio.map((a) => this.formatAnime(a)),
    };

    // Cache anime detail for 1 hour
    await cacheService.set(cacheKey, formatted, 3600);
    return formatted;
  }

  /**
   * Paginated anime listing with filters and sorting
   */
  public async list(query: AnimeListQuery) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(50, Math.max(1, query.limit || 20));
    const skip = (page - 1) * limit;

    const cacheKey = `anime:list:${JSON.stringify({ ...query, page, limit })}`;
    const cached = await cacheService.get<any>(cacheKey);
    if (cached) return cached;

    const where: Prisma.AnimeWhereInput = {};
    if (query.status) {
      where.status = { equals: query.status, mode: 'insensitive' };
    }
    if (query.type) {
      where.type = { equals: query.type, mode: 'insensitive' };
    }
    if (query.genre) {
      where.genres = {
        some: {
          genre: {
            slug: { equals: query.genre, mode: 'insensitive' },
          },
        },
      };
    }
    if (query.year) {
      where.releaseYear = query.year;
    }
    if (query.season) {
      where.season = { contains: query.season, mode: 'insensitive' };
    }
    if (query.minScore !== undefined && query.minScore > 0) {
      where.score = { gte: query.minScore, not: null };
    }

    const orderBy: Prisma.AnimeOrderByWithRelationInput = {};
    if (query.order === 'popular' || query.order === 'score') {
      if (!where.score) where.score = { not: null };
      orderBy.score = { sort: 'desc', nulls: 'last' };
    } else if (query.order === 'title') {
      orderBy.title = 'asc';
    } else if (query.order === 'latest') {
      orderBy.updatedAt = 'desc';
    } else {
      orderBy.createdAt = 'desc';
    }

    const [total, items] = await Promise.all([
      prisma.anime.count({ where }),
      prisma.anime.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        select: {
          id: true,
          slug: true,
          title: true,
          alternativeTitle: true,
          japaneseTitle: true,
          poster: true,
          posterLocal: true,
          status: true,
          type: true,
          score: true,
          rating: true,
          duration: true,
          totalEpisodes: true,
          latestEpisode: true,
          season: true,
          releaseYear: true,
          studio: true,
          releasedAt: true,
          genres: {
            include: {
              genre: true,
            },
          },
        },
      }),
    ]);

    const totalPages = Math.ceil(total / limit);
    const result = {
      items: items.map((a) => this.formatAnimeList(a)).filter(Boolean),
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };

    // Cache list for 5 minutes
    await cacheService.set(cacheKey, result, 300);
    return result;
  }

  /**
   * Search anime using PostgreSQL full-text search / trigram matching
   * Strictly reads from PostgreSQL, NEVER queries Samehadaku.
   */
  public async search(
    queryText: string,
    page = 1,
    limit = 20,
    filters?: { type?: string; status?: string; genre?: string; minScore?: number },
  ) {
    const cleanQuery = queryText.trim();
    if (!cleanQuery) {
      return {
        items: [],
        pagination: { page: 1, limit, total: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false },
      };
    }

    const cacheKey = `search:${cleanQuery.toLowerCase()}:${page}:${limit}:${JSON.stringify(filters || {})}`;
    const cached = await cacheService.get<any>(cacheKey);
    if (cached) return cached;

    const skip = (page - 1) * limit;

    // Search query using multi-term ILIKE matching on title, alternativeTitle, and slug
    const terms = cleanQuery.split(/\s+/).filter(Boolean);
    const searchCondition: Prisma.AnimeWhereInput = {
      OR: [
        { title: { contains: cleanQuery, mode: 'insensitive' } },
        { alternativeTitle: { contains: cleanQuery, mode: 'insensitive' } },
        { japaneseTitle: { contains: cleanQuery, mode: 'insensitive' } },
        { slug: { contains: cleanQuery.toLowerCase().replace(/\s+/g, '-'), mode: 'insensitive' } },
        // Also match individual terms
        ...terms.map((term) => ({
          title: { contains: term, mode: 'insensitive' as Prisma.QueryMode },
        })),
      ],
    };

    // Apply optional filters as AND conditions
    const andConditions: Prisma.AnimeWhereInput[] = [searchCondition];
    if (filters?.type) andConditions.push({ type: { equals: filters.type, mode: 'insensitive' } });
    if (filters?.status) andConditions.push({ status: { equals: filters.status, mode: 'insensitive' } });
    if (filters?.genre) {
      andConditions.push({
        genres: { some: { genre: { slug: { equals: filters.genre, mode: 'insensitive' } } } },
      });
    }
    if (filters?.minScore && filters.minScore > 0) {
      andConditions.push({ score: { gte: filters.minScore, not: null } });
    }

    const where: Prisma.AnimeWhereInput = andConditions.length > 1 ? { AND: andConditions } : searchCondition;

    const [total, items] = await Promise.all([
      prisma.anime.count({ where }),
      prisma.anime.findMany({
        where,
        skip,
        take: limit,
        orderBy: { score: { sort: 'desc', nulls: 'last' } },
        select: {
          id: true,
          slug: true,
          title: true,
          alternativeTitle: true,
          japaneseTitle: true,
          poster: true,
          posterLocal: true,
          status: true,
          type: true,
          score: true,
          rating: true,
          duration: true,
          totalEpisodes: true,
          latestEpisode: true,
          season: true,
          releaseYear: true,
          studio: true,
          releasedAt: true,
          genres: {
            include: { genre: true },
          },
        },
      }),
    ]);

    const totalPages = Math.ceil(total / limit);
    const result = {
      items: items.map((a) => this.formatAnimeList(a)).filter(Boolean),
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };

    await cacheService.set(cacheKey, result, 300);
    return result;
  }

  /**
   * Get anime with recently released/added episodes.
   * Priority:
   * 1. Ordered slug list from Redis (populated by syncRecent every ~5 min)
   * 2. Fallback: anime ordered by lastSyncedAt DESC
   */
  public async getRecentlyUpdated(page = 1, limit = 20) {
    const cacheKey = `anime:recently-updated:${page}:${limit}`;
    const cached = await cacheService.get<any>(cacheKey);
    if (cached) return cached;

    const skip = (page - 1) * limit;

    // Try Redis ordered slug list first (set by syncRecent)
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
        logger.warn({ error: err.message }, 'Failed on-demand scrape for recent anime slugs in animeService');
      }
    }

    if (orderedSlugs && orderedSlugs.length > 0) {
      const pageSlugs = orderedSlugs.slice(skip, skip + limit);
      const animes = await prisma.anime.findMany({
        where: { slug: { in: pageSlugs } },
        include: {
          genres: { include: { genre: true } },
          episodes: {
            orderBy: { episodeNumber: 'desc' },
            take: 1,
            select: { slug: true, episodeNumber: true, releasedAt: true },
          },
        },
      });
      // Preserve slug order
      const orderedAnimes = pageSlugs
        .map((slug) => animes.find((a) => a.slug === slug))
        .filter(Boolean) as typeof animes;

      const total = orderedSlugs.length;
      const totalPages = Math.ceil(total / limit);
      const result = {
        items: orderedAnimes.map((a) => this.formatAnime(a)),
        pagination: { page, limit, total, totalPages, hasNextPage: page < totalPages, hasPreviousPage: page > 1 },
      };
      await cacheService.set(cacheKey, result, 180);
      return result;
    }

    // Fallback: order by anime with recently added episodes (no status filter —
    // recent includes episode finals from completed anime too)
    const where: Prisma.AnimeWhereInput = {};
    const [total, items] = await Promise.all([
      prisma.anime.count({ where }),
      prisma.anime.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
        include: {
          genres: { include: { genre: true } },
          episodes: {
            orderBy: { episodeNumber: 'desc' },
            take: 1,
            select: { slug: true, episodeNumber: true, releasedAt: true },
          },
        },
      }),
    ]);

    const totalPages = Math.ceil(total / limit);
    const result = {
      items: items.map((a) => this.formatAnime(a)),
      pagination: { page, limit, total, totalPages, hasNextPage: page < totalPages, hasPreviousPage: page > 1 },
    };

    await cacheService.set(cacheKey, result, 180);
    return result;
  }

  /**
   * Safe upsert for anime with merge protection and relationship linking
   */
  public async upsertAnime(data: ScrapedAnimeDetail) {
    const existing = await prisma.anime.findUnique({
      where: { slug: data.slug },
    });

    const newHash = ChangeDetector.computeHash({
      title: data.title,
      latestEpisode: data.latestEpisode,
      status: data.status,
      episodeCount: data.totalEpisodes || data.episodes.length,
      score: data.score,
      synopsis: data.synopsis,
    });

    // Check if unchanged
    if (existing && existing.contentHash === newHash && !data.isDegraded) {
      logger.debug({ slug: data.slug }, 'Anime content unchanged, skipping update');
      return existing;
    }

    // Merge safely (Rule #41)
    const mergedData = ChangeDetector.mergeSafe(existing, {
      title: data.title,
      alternativeTitle: data.alternativeTitle,
      japaneseTitle: data.japaneseTitle,
      poster: existing?.poster?.startsWith('/public/posters') ? existing.poster : data.poster,
      synopsis: data.synopsis,
      status: data.status,
      type: data.type,
      score: data.score,
      rating: data.rating,
      duration: data.duration,
      totalEpisodes: data.totalEpisodes,
      latestEpisode: data.latestEpisode,
      season: data.season,
      releaseYear: data.releaseYear,
      studio: data.studio,
      producers: data.producers,
      releasedAt: data.releasedAt,
      sourceUrl: data.sourceUrl,
      contentHash: newHash,
      lastSyncedAt: new Date(),
    });

    // Upsert anime record
    const anime = await prisma.anime.upsert({
      where: { slug: data.slug },
      create: {
        ...mergedData,
        slug: data.slug,
      },
      update: mergedData,
    });

    // Upsert genres and associations
    if (data.genres && data.genres.length > 0) {
      for (const g of data.genres) {
        const genre = await prisma.genre.upsert({
          where: { slug: g.slug },
          create: { name: g.name, slug: g.slug },
          update: { name: g.name },
        });

        await prisma.animeGenre.upsert({
          where: {
            animeId_genreId: {
              animeId: anime.id,
              genreId: genre.id,
            },
          },
          create: {
            animeId: anime.id,
            genreId: genre.id,
          },
          update: {},
        });
      }
    }

    // Upsert episodes
    if (data.episodes && data.episodes.length > 0) {
      for (const ep of data.episodes) {
        await prisma.episode.upsert({
          where: { slug: ep.slug },
          create: {
            animeId: anime.id,
            slug: ep.slug,
            episodeNumber: ep.episodeNumber,
            title: ep.title,
            sourceUrl: ep.url,
            releasedAt: ep.releasedAt,
            lastSyncedAt: new Date(),
          },
          update: {
            episodeNumber: ep.episodeNumber,
            title: ep.title,
            releasedAt: ep.releasedAt,
            lastSyncedAt: new Date(),
          },
        });
      }
    }

    // Download and cache local poster in background (with cross-platform fallback)
    posterService
      .ensurePoster({
        id: anime.id,
        slug: anime.slug,
        title: anime.title,
        alternativeTitle: anime.alternativeTitle,
        japaneseTitle: anime.japaneseTitle,
        poster: data.poster || anime.poster,
        posterLocal: anime.posterLocal,
      })
      .catch((err) => {
        logger.warn({ slug: data.slug, error: err.message }, 'Failed background poster download during upsert');
      });

    // Cross-reference metadata in background if key fields are missing
    const needsEnrichment = !anime.rating || !anime.totalEpisodes || !anime.duration || !anime.season;
    if (needsEnrichment) {
      crossReferenceService
        .getEnrichedMetadata(data.title, data.alternativeTitle, data.japaneseTitle)
        .then(async (meta) => {
          if (meta) {
            const patch: any = {};
            if (!anime.rating && meta.rating) patch.rating = meta.rating;
            if (!anime.totalEpisodes && meta.totalEpisodes) patch.totalEpisodes = meta.totalEpisodes;
            if (!anime.duration && meta.duration) patch.duration = meta.duration;
            if (!anime.season && meta.season) patch.season = meta.season;
            if (!anime.releaseYear && meta.releaseYear) patch.releaseYear = meta.releaseYear;
            if (!anime.studio && meta.studio) patch.studio = meta.studio;
            if (!anime.producers && meta.producers) patch.producers = meta.producers;

            if (Object.keys(patch).length > 0) {
              await prisma.anime.update({
                where: { id: anime.id },
                data: patch,
              });
              await cacheService.invalidateAnime(data.slug);
            }
          }
        })
        .catch((err) => {
          logger.warn({ slug: data.slug, error: err.message }, 'Failed background metadata cross-reference');
        });
    }

    // Invalidate cache
    await cacheService.invalidateAnime(data.slug);
    return anime;
  }
}

export const animeService = new AnimeService();
