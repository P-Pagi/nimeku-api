import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { FastifyInstance } from 'fastify';

describe('Fastify REST API Integration Tests', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it('GET /health returns status and system details', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/health',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBeDefined();
    expect(body.database).toBeDefined();
    expect(body.redis).toBeDefined();
  });

  it('GET /health/source returns source circuit breaker stats', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/health/source',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.sourceBaseUrl).toContain('samehadaku');
    expect(body.data.circuitBreaker).toBeDefined();
  });

  it('GET /docs returns OpenAPI Swagger UI', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/docs/',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('Protected admin endpoint rejects unauthorized requests', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/sync/recent',
      headers: {
        'x-admin-key': 'wrong-key',
      },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('GET /api/v1/anime returns catalog with pagination', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/anime?limit=5',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta).toBeDefined();
    expect(body.meta.limit).toBe(5);
  });

  it('GET /api/v1/anime/:slug returns detail for synced anime', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/anime/compass2-0-animation-project',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.slug).toBe('compass2-0-animation-project');
    expect(body.data.title).toBe('#Compass2.0 Animation Project');
    expect(body.data.episodes.length).toBeGreaterThan(0);
  });

  it('GET /api/v1/genres returns list of genres', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/genres',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('GET /api/v1/search returns matching anime', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/search?q=Compass',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.some((a: any) => a.slug === 'compass2-0-animation-project')).toBe(true);
  });
});
