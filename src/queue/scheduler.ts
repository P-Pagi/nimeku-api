import cron from 'node-cron';
import { config } from '../config/env.js';
import { enqueueSyncJob } from './queues.js';
import { logger } from '../config/logger.js';

export function startScheduler(): cron.ScheduledTask[] {
  const tasks: cron.ScheduledTask[] = [];

  logger.info(
    {
      recent: config.SYNC_RECENT,
      ongoing: config.SYNC_ONGOING,
      popular: config.SYNC_POPULAR,
      schedule: config.SYNC_SCHEDULE,
      genres: config.SYNC_GENRES,
    },
    'Registering background sync cron schedules'
  );

  // ── Anime Terbaru: cek tiap 5–10 menit ────────────────────────────────
  if (cron.validate(config.SYNC_RECENT)) {
    tasks.push(
      cron.schedule(config.SYNC_RECENT, async () => {
        logger.info('Scheduler triggered: sync:recent');
        await enqueueSyncJob('recent');
      })
    );
  }

  // ── Ongoing: cek tiap 10–30 menit ─────────────────────────────────────
  if (cron.validate(config.SYNC_ONGOING)) {
    tasks.push(
      cron.schedule(config.SYNC_ONGOING, async () => {
        logger.info('Scheduler triggered: sync:ongoing');
        await enqueueSyncJob('ongoing');
      })
    );
  }

  // ── Popular: cek tiap 1–6 jam ──────────────────────────────────────────
  if (cron.validate(config.SYNC_POPULAR)) {
    tasks.push(
      cron.schedule(config.SYNC_POPULAR, async () => {
        logger.info('Scheduler triggered: sync:popular');
        await enqueueSyncJob('popular');
      })
    );
  }

  // ── Jadwal Tayang: cek tiap 1–6 jam ───────────────────────────────────
  if (cron.validate(config.SYNC_SCHEDULE)) {
    tasks.push(
      cron.schedule(config.SYNC_SCHEDULE, async () => {
        logger.info('Scheduler triggered: sync:schedule');
        await enqueueSyncJob('schedule');
      })
    );
  }

  // ── Genres: sekali sehari ──────────────────────────────────────────────
  if (cron.validate(config.SYNC_GENRES)) {
    tasks.push(
      cron.schedule(config.SYNC_GENRES, async () => {
        logger.info('Scheduler triggered: sync:genres');
        await enqueueSyncJob('genres');
      })
    );
  }

  return tasks;
}

