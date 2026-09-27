import { PrismaClient } from '@prisma/client';
import { logger } from '../config/logger.js';

export const prisma = new PrismaClient({
  log: [
    { emit: 'event', level: 'query' },
    { emit: 'event', level: 'error' },
    { emit: 'event', level: 'warn' },
  ],
});

prisma.$on('error', (e) => {
  logger.error({ error: e.message }, 'Database query error');
});

prisma.$on('warn', (e) => {
  logger.warn({ warning: e.message }, 'Database warning');
});
