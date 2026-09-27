import { SyncJobData } from './queues.js';
import { syncEngine } from '../sync/sync.engine.js';
import { lockService } from '../cache/lock.service.js';
import { logger } from '../config/logger.js';

export async function executeSyncTask(type: SyncJobData['type'], slug?: string) {
  // Acquire distributed lock for deduplication across distributed workers (Rule #23)
  const lockKey = slug ? `sync:${type}:${slug}` : `sync:${type}`;
  const token = await lockService.acquireLock(lockKey, 300);

  if (!token) {
    logger.info({ lockKey }, 'Lock active on another worker, skipping duplicate execution');
    return { skipped: true, reason: 'LOCKED' };
  }

  try {
    switch (type) {
      case 'recent':
        return await syncEngine.syncRecent();
      case 'ongoing':
        return await syncEngine.syncOngoing();
      case 'popular':
        return await syncEngine.syncPopular();
      case 'anime':
        if (slug) {
          await syncEngine.syncAnime(slug);
          return { success: true, slug };
        }
        break;
      case 'schedule':
        await syncEngine.syncSchedule();
        return { success: true };
      case 'genres':
        await syncEngine.syncGenres();
        return { success: true };
      case 'batches':
        await syncEngine.syncBatches(1);
        return { success: true };
      case 'all':
        await syncEngine.syncInitial({ maxPages: 2 });
        return { success: true };
      default:
        logger.warn({ type }, 'Unknown job type');
    }
  } finally {
    await lockService.releaseLock(lockKey, token);
  }
}
