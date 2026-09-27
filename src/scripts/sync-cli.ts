import { syncEngine } from '../sync/sync.engine.js';
import { logger } from '../config/logger.js';
import { prisma } from '../db/prisma.js';

async function runCliSync() {
  logger.info('=== Starting Initial Sync CLI ===');
  const startTime = Date.now();

  try {
    const pages = process.argv[2] ? parseInt(process.argv[2], 10) : undefined;
    await syncEngine.syncInitial({ maxPages: pages });

    const durationSec = Math.round((Date.now() - startTime) / 1000);
    logger.info({ durationSec }, '=== Initial Sync Completed Successfully! ===');
  } catch (err: any) {
    logger.error({ error: err.message }, 'Initial sync failed');
    process.exit(1);
  } finally {
    await prisma.$disconnect();
    process.exit(0);
  }
}

runCliSync();
