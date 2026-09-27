import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

export class AsyncRateLimiter {
  private activeCount = 0;
  private queue: Array<() => void> = [];
  private lastRequestTime = 0;
  private readonly maxConcurrency: number;
  private readonly minDelayMs: number;

  constructor(
    maxConcurrency = config.SCRAPER_MAX_CONCURRENCY,
    minDelayMs = config.SCRAPER_MIN_DELAY_MS
  ) {
    this.maxConcurrency = maxConcurrency;
    this.minDelayMs = minDelayMs;
  }

  public async acquire(): Promise<void> {
    if (this.activeCount < this.maxConcurrency) {
      this.activeCount++;
      await this.enforceDelay();
      return;
    }

    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });

    this.activeCount++;
    await this.enforceDelay();
  }

  public release(): void {
    this.activeCount--;
    if (this.queue.length > 0 && this.activeCount < this.maxConcurrency) {
      const next = this.queue.shift();
      if (next) next();
    }
  }

  private async enforceDelay(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    // Add jitter between 100ms and 500ms
    const jitter = Math.floor(Math.random() * 400) + 100;
    const requiredDelay = this.minDelayMs + jitter;

    if (elapsed < requiredDelay) {
      const waitTime = requiredDelay - elapsed;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
    this.lastRequestTime = Date.now();
  }

  public getQueueLength(): number {
    return this.queue.length;
  }

  public getActiveCount(): number {
    return this.activeCount;
  }
}

export const scraperRateLimiter = new AsyncRateLimiter();
