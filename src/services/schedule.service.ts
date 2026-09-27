import { prisma } from '../db/prisma.js';
import { cacheService } from '../cache/cache.service.js';

export class ScheduleService {
  public async getWeeklySchedule() {
    const cacheKey = 'schedule:weekly';
    const cached = await cacheService.get<any>(cacheKey);
    if (cached) return cached;

    const schedules = await prisma.schedule.findMany({
      include: {
        anime: {
          select: {
            id: true,
            slug: true,
            title: true,
            poster: true,
            posterLocal: true,
            type: true,
            score: true,
            latestEpisode: true,
            genres: {
              include: { genre: true },
            },
          },
        },
      },
    });

    const daysOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const grouped: Record<string, any[]> = {};

    for (const day of daysOrder) {
      grouped[day] = [];
    }

    for (const item of schedules) {
      // Capitalize day
      const dayKey = item.day.charAt(0).toUpperCase() + item.day.slice(1).toLowerCase();
      if (!grouped[dayKey]) grouped[dayKey] = [];
      grouped[dayKey].push({
        time: item.time,
        anime: {
          ...item.anime,
          poster: item.anime.posterLocal || item.anime.poster,
          posterLocal: item.anime.posterLocal || null,
          genres: item.anime.genres.map((g) => g.genre),
        },
      });
    }

    await cacheService.set(cacheKey, grouped, 3600); // 1 hour
    return grouped;
  }
}

export const scheduleService = new ScheduleService();
