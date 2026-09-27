import { prisma } from '../db/prisma.js';
import { cacheService } from '../cache/cache.service.js';

export class GenreService {
  public async getAllGenres() {
    const cacheKey = 'genres:all';
    const cached = await cacheService.get<any>(cacheKey);
    if (cached) return cached;

    const genres = await prisma.genre.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        _count: {
          select: { animes: true },
        },
      },
    });

    const result = genres.map((g) => ({
      id: g.id,
      name: g.name,
      slug: g.slug,
      animeCount: g._count.animes,
    }));

    await cacheService.set(cacheKey, result, 86400); // 24 hours
    return result;
  }

  public async getAnimeByGenre(slug: string, page = 1, limit = 20) {
    const cacheKey = `genre:${slug}:${page}:${limit}`;
    const cached = await cacheService.get<any>(cacheKey);
    if (cached) return cached;

    const skip = (page - 1) * limit;

    const [total, animeGenres] = await Promise.all([
      prisma.animeGenre.count({
        where: {
          genre: { slug },
        },
      }),
      prisma.animeGenre.findMany({
        where: {
          genre: { slug },
        },
        skip,
        take: limit,
        include: {
          anime: {
            include: {
              genres: {
                include: { genre: true },
              },
            },
          },
        },
      }),
    ]);

    const totalPages = Math.ceil(total / limit);
    const result = {
      genre: slug,
      items: animeGenres.map((ag) => ({
        ...ag.anime,
        genres: ag.anime.genres.map((g) => g.genre),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };

    await cacheService.set(cacheKey, result, 3600);
    return result;
  }
}

export const genreService = new GenreService();
