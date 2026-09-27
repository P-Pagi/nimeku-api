import { createSyncWorker } from './queue/worker.js';
import { startScheduler } from './queue/scheduler.js';
import { logger } from './config/logger.js';
import { redis } from './cache/redis.client.js';

async function bootstrapWorker() {
  logger.info('🚀 Starting Samehadaku Background Sync Worker process...');

  try {
    await redis.connect().catch((e) => {
      logger.warn({ error: e.message }, 'Redis not connected directly, connecting on demand');
    });

    const worker = createSyncWorker();
    const tasks = startScheduler();

    logger.info(
      { scheduledTasksCount: tasks.length },
      'Sync Worker and Schedulers running. Waiting for jobs.'
    );

    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutting down worker process...');
      for (const t of tasks) t.stop();
      await worker.close();
      await redis.quit();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err: any) {
    logger.fatal({ error: err.message }, 'Failed to start worker process');
    process.exit(1);
  }
}

bootstrapWorker();
