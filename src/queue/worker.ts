import { Worker, Job } from 'bullmq';
import { getBullMQConnectionOptions } from '../cache/redis.client.js';
import { SYNC_QUEUE_NAME, SyncJobData } from './queues.js';
import { executeSyncTask } from './sync-task.js';
import { logger } from '../config/logger.js';

export function createSyncWorker(): Worker<SyncJobData> {
  const worker = new Worker<SyncJobData>(
    SYNC_QUEUE_NAME,
    async (job: Job<SyncJobData>) => {
      const { type, slug } = job.data;
      logger.info({ jobId: job.id, type, slug }, 'Sync Worker processing job');
      return await executeSyncTask(type, slug);
    },
    {
      // @ts-ignore
      connection: getBullMQConnectionOptions(),
      concurrency: 1, // Controlled concurrency for scraping safety
    }
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Job completed successfully');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, error: err.message }, 'Job failed');
  });

  return worker;
}

