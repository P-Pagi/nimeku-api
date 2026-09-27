import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { CircuitOpenError } from './errors.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private nextAttempt: number = Date.now();
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(
    threshold = config.SOURCE_FAILURE_THRESHOLD,
    cooldownMinutes = config.SOURCE_COOLDOWN_MINUTES
  ) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMinutes * 60 * 1000;
  }

  public getState(): CircuitState {
    if (this.state === 'OPEN' && Date.now() >= this.nextAttempt) {
      this.state = 'HALF_OPEN';
      logger.info({ state: this.state }, 'Circuit breaker transitioned to HALF_OPEN');
    }
    return this.state;
  }

  public checkAvailability(): void {
    const currentState = this.getState();
    if (currentState === 'OPEN') {
      const remainingSeconds = Math.ceil((this.nextAttempt - Date.now()) / 1000);
      throw new CircuitOpenError(
        `Source circuit is OPEN. Cooldown active for ${remainingSeconds}s`,
        remainingSeconds
      );
    }
  }

  public recordSuccess(): void {
    if (this.state !== 'CLOSED') {
      logger.info({ previousState: this.state }, 'Circuit breaker RESET to CLOSED on success');
    }
    this.failureCount = 0;
    this.state = 'CLOSED';
  }

  public recordFailure(error?: unknown): void {
    this.failureCount += 1;
    logger.warn(
      { failureCount: this.failureCount, threshold: this.threshold, error: (error as Error)?.message },
      'Circuit breaker registered failure'
    );

    if (this.failureCount >= this.threshold || this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.cooldownMs;
      logger.error(
        { nextAttempt: new Date(this.nextAttempt).toISOString(), cooldownMs: this.cooldownMs },
        'Circuit breaker tripped to OPEN'
      );
    }
  }

  public getStats() {
    return {
      state: this.getState(),
      failureCount: this.failureCount,
      threshold: this.threshold,
      nextAttempt: new Date(this.nextAttempt).toISOString(),
    };
  }
}

export const sourceCircuitBreaker = new CircuitBreaker();
