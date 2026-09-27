export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR', isOperational = true) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class AnimeNotFoundError extends AppError {
  constructor(slugOrId: string) {
    super(`Anime tidak ditemukan: ${slugOrId}`, 404, 'ANIME_NOT_FOUND');
  }
}

export class EpisodeNotFoundError extends AppError {
  constructor(slugOrId: string) {
    super(`Episode tidak ditemukan: ${slugOrId}`, 404, 'EPISODE_NOT_FOUND');
  }
}

export class BatchNotFoundError extends AppError {
  constructor(slugOrId: string) {
    super(`Batch tidak ditemukan: ${slugOrId}`, 404, 'BATCH_NOT_FOUND');
  }
}

export class SourceUnavailableError extends AppError {
  constructor(message = 'Website sumber (Samehadaku) tidak dapat diakses') {
    super(message, 503, 'SOURCE_UNAVAILABLE');
  }
}

export class ParsingError extends AppError {
  public readonly isDegraded: boolean;

  constructor(message: string, isDegraded = false) {
    super(message, 502, isDegraded ? 'PARSER_DEGRADED' : 'PARSER_ERROR');
    this.isDegraded = isDegraded;
  }
}

export class RateLimitError extends AppError {
  public readonly retryAfterSeconds?: number;

  constructor(message = 'Batas akses tercapai, coba lagi nanti', retryAfterSeconds?: number) {
    super(message, 429, 'RATE_LIMIT_EXCEEDED');
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class CircuitOpenError extends AppError {
  public readonly cooldownRemainingSeconds?: number;

  constructor(message = 'Circuit breaker terbuka: akses ke website sumber dihentikan sementara', cooldownRemainingSeconds?: number) {
    super(message, 503, 'CIRCUIT_OPEN');
    this.cooldownRemainingSeconds = cooldownRemainingSeconds;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}
