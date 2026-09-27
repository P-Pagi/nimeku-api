import { Queue } from 'bullmq';
import { getBullMQConnectionOptions } from '../cache/redis.client.js';
import { executeSyncTask } from './sync-task.js';
import { logger } from '../config/logger.js';

export const SYNC_QUEUE_NAME = 'samehadaku-sync';

export interface SyncJobData {
  type: 'recent' | 'anime' | 'schedule' | 'genres' | 'batches' | 'all' | 'ongoing' | 'popular';
  slug?: string;
}

let syncQueue: Queue<SyncJobData> | null = null;

export function getSyncQueue(): Queue<SyncJobData> {
  if (!syncQueue) {
    syncQueue = new Queue<SyncJobData>(SYNC_QUEUE_NAME, {
      // @ts-ignore
      connection: getBullMQConnectionOptions(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    });

    syncQueue.on('error', (err) => {
      logger.warn({ error: err.message }, 'BullMQ sync queue warning');
    });
  }

  return syncQueue;
}

/**
 * Add sync job with deterministic job ID to prevent duplicate jobs (Rule #22)
 * If BullMQ or Redis is unavailable, runs directly in-process as fallback.
 */
export async function enqueueSyncJob(type: SyncJobData['type'], slug?: string): Promise<string> {
  const jobId = slug ? `sync-${type}-${slug}` : `sync-${type}`;

  try {
    const queue = getSyncQueue();
    const job = await queue.add(
      `job:${type}`,
      { type, slug },
      {
        jobId, // Deterministic ID ensures duplicate jobs are discarded if already pending
      }
    );

    logger.info({ jobId: job.id, type, slug }, 'Enqueued synchronization job');
    return job.id || jobId;
  } catch (err: any) {
    logger.warn(
      { jobId, error: err.message },
      'Failed to enqueue BullMQ job, running in-process fallback'
    );

    // Fallback: run directly in-process so scheduled sync is never dropped
    executeSyncTask(type, slug).catch((fallbackErr: any) => {
      logger.error({ jobId, error: fallbackErr.message }, 'In-process fallback sync execution failed');
    });

    return jobId;
  }
}

