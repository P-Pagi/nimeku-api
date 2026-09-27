import { buildServer } from './api/server.js';
import { config } from './config/env.js';
import { logger } from './config/logger.js';
import { redis } from './cache/redis.client.js';
import { prisma } from './db/prisma.js';

async function bootstrapApi() {
  try {
    const server = await buildServer();

    // Check optional redis initial connect
    redis.connect().catch((err) => {
      logger.warn({ error: err.message }, 'Redis initial connect deferred');
    });

    await server.listen({
      port: config.PORT,
      host: config.HOST,
    });

    logger.info(`✨ Samehadaku REST API is running on http://${config.HOST}:${config.PORT}`);
    logger.info(`📖 OpenAPI Swagger Documentation available at http://${config.HOST}:${config.PORT}/docs`);

    // Optional Embedded Worker & Scheduler (All-in-one process)
    let worker: any = null;
    let schedulerTasks: any[] = [];
    if (config.EMBED_WORKER) {
      const { createSyncWorker } = await import('./queue/worker.js');
      const { startScheduler } = await import('./queue/scheduler.js');
      worker = createSyncWorker();
      schedulerTasks = startScheduler();
      logger.info(
        { scheduledTasksCount: schedulerTasks.length },
        '🚀 Embedded Sync Worker & Schedulers activated in API process'
      );
    }

    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Graceful API shutdown requested');
      for (const t of schedulerTasks) t.stop();
      if (worker) await worker.close();
      await server.close();
      await prisma.$disconnect();
      await redis.quit();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err: any) {
    logger.fatal({ error: err.message }, 'Fatal error during API bootstrap');
    process.exit(1);
  }
}

bootstrapApi();
