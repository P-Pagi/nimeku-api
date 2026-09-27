import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../resilience/errors.js';
import { healthRoutes } from './routes/health.routes.js';
import { animeRoutes } from './routes/anime.routes.js';
import { episodeRoutes } from './routes/episode.routes.js';
import { scheduleRoutes } from './routes/schedule.routes.js';
import { genreRoutes } from './routes/genre.routes.js';
import { batchRoutes } from './routes/batch.routes.js';
import { adminRoutes } from './routes/admin.routes.js';
import { statsRoutes } from './routes/stats.routes.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildServer(): Promise<any> {
  const server = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
      transport: config.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' } }
        : undefined,
    },
  });

  // Serve static files (Posters, images)
  await server.register(fastifyStatic, {
    root: path.resolve(process.cwd(), 'public'),
    prefix: '/public/',
    decorateReply: false,
    maxAge: '30d',
    immutable: true,
  });

  // Security headers (Rule #32)
  await server.register(helmet, {
    contentSecurityPolicy: false, // Allows Swagger UI to render smoothly
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allows frontends on other ports/domains to load images
  });

  // CORS
  await server.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // Public API Rate Limit (Rule #32)
  await server.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
  });

  // OpenAPI Swagger Documentation (Rule #46)
  await server.register(swagger, {
    openapi: {
      info: {
        title: 'Samehadaku Anime REST API',
        description:
          'Production-ready anime REST API for streaming backends with PostgreSQL, Redis cache, and native Cheerio sync worker.',
        version: '1.0.0',
      },
      servers: [
        {
          url: `http://localhost:${config.PORT}`,
          description: 'Local environment',
        },
      ],
      components: {
        securitySchemes: {
          apiKey: {
            type: 'apiKey',
            name: 'x-admin-key',
            in: 'header',
          },
        },
      },
    },
  });

  await server.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });

  // Global Error Handler (Rule #34)
  server.setErrorHandler((error: any, request, reply) => {
    logger.error(
      {
        url: request.raw.url,
        method: request.raw.method,
        error: error.message,
        name: error.name,
      },
      'Request error'
    );

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        success: false,
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }

    // Default 500 error: NEVER expose internal stack trace in production
    const isProd = config.NODE_ENV === 'production';
    return reply.status(error.statusCode || 500).send({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: isProd ? 'Terjadi kesalahan internal server' : error.message,
      },
    });
  });

  // Register Routes
  await server.register(healthRoutes);
  await server.register(animeRoutes, { prefix: '/api/v1' });
  await server.register(episodeRoutes, { prefix: '/api/v1' });
  await server.register(scheduleRoutes, { prefix: '/api/v1' });
  await server.register(genreRoutes, { prefix: '/api/v1' });
  await server.register(batchRoutes, { prefix: '/api/v1' });
  await server.register(statsRoutes, { prefix: '/api/v1' });
  await server.register(adminRoutes, { prefix: '/api/v1/admin' });

  return server;
}
