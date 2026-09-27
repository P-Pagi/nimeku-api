import { prisma } from '../db/prisma.js';

export class SyncStateService {
  public async startJob(job: string) {
    return prisma.syncState.upsert({
      where: { job },
      create: {
        job,
        status: 'RUNNING',
        lastStartedAt: new Date(),
        error: null,
      },
      update: {
        status: 'RUNNING',
        lastStartedAt: new Date(),
        error: null,
      },
    });
  }

  public async completeJob(
    job: string,
    stats: { processed: number; created: number; updated: number }
  ) {
    const now = new Date();
    return prisma.syncState.upsert({
      where: { job },
      create: {
        job,
        status: 'SUCCESS',
        lastCompletedAt: now,
        lastSuccessAt: now,
        itemsProcessed: stats.processed,
        itemsCreated: stats.created,
        itemsUpdated: stats.updated,
        error: null,
      },
      update: {
        status: 'SUCCESS',
        lastCompletedAt: now,
        lastSuccessAt: now,
        itemsProcessed: { increment: stats.processed },
        itemsCreated: { increment: stats.created },
        itemsUpdated: { increment: stats.updated },
        error: null,
      },
    });
  }

  public async failJob(job: string, errorMessage: string) {
    const now = new Date();
    return prisma.syncState.upsert({
      where: { job },
      create: {
        job,
        status: 'FAILED',
        lastCompletedAt: now,
        lastFailureAt: now,
        error: errorMessage,
      },
      update: {
        status: 'FAILED',
        lastCompletedAt: now,
        lastFailureAt: now,
        error: errorMessage,
      },
    });
  }

  public async getAllStates() {
    return prisma.syncState.findMany({
      orderBy: { updatedAt: 'desc' },
    });
  }
}

export const syncStateService = new SyncStateService();
