import { prisma } from '../db/prisma.js';
import { cacheService } from '../cache/cache.service.js';
import { BatchNotFoundError } from '../resilience/errors.js';

export class BatchService {
  public async listBatches(page = 1, limit = 20) {
    const cacheKey = `batch:list:${page}:${limit}`;
    const cached = await cacheService.get<any>(cacheKey);
    if (cached) return cached;

    const skip = (page - 1) * limit;

    const [total, items] = await Promise.all([
      prisma.batch.count(),
      prisma.batch.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          anime: {
            select: {
              id: true,
              slug: true,
              title: true,
              poster: true,
              posterLocal: true,
            },
          },
        },
      }),
    ]);

    const totalPages = Math.ceil(total / limit);
    const result = {
      items: items.map((b) => ({
        ...b,
        anime: b.anime
          ? {
              ...b.anime,
              poster: b.anime.posterLocal || b.anime.poster,
              posterLocal: b.anime.posterLocal || null,
            }
          : null,
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

  public async getBySlug(slug: string) {
    const cacheKey = `batch:${slug}`;
    const cached = await cacheService.get<any>(cacheKey);
    if (cached) return cached;

    const batch = await prisma.batch.findUnique({
      where: { slug },
      include: {
        anime: {
          select: {
            id: true,
            slug: true,
            title: true,
            poster: true,
            posterLocal: true,
            synopsis: true,
          },
        },
      },
    });

    if (!batch) {
      throw new BatchNotFoundError(slug);
    }

    const formatted = {
      ...batch,
      anime: batch.anime
        ? {
            ...batch.anime,
            poster: batch.anime.posterLocal || batch.anime.poster,
            posterLocal: batch.anime.posterLocal || null,
          }
        : null,
    };

    await cacheService.set(cacheKey, formatted, 86400);
    return formatted;
  }
}

export const batchService = new BatchService();
