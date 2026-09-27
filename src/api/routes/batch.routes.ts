import { FastifyPluginAsync } from 'fastify';
import { batchService } from '../../services/batch.service.js';

export const batchRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/batch
  fastify.get('/batch', {
    schema: {
      tags: ['Batch'],
      summary: 'Daftar batch download anime',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 20 },
        },
      },
    },
    handler: async (request) => {
      const { page = 1, limit = 20 } = request.query as any;
      const result = await batchService.listBatches(page, limit);
      return {
        success: true,
        data: result.items,
        meta: result.pagination,
      };
    },
  });

  // GET /api/v1/batch/:slug
  fastify.get('/batch/:slug', {
    schema: {
      tags: ['Batch'],
      summary: 'Detail download batch anime dengan berbagai resolusi dan host',
      params: {
        type: 'object',
        required: ['slug'],
        properties: {
          slug: { type: 'string' },
        },
      },
    },
    handler: async (request) => {
      const { slug } = request.params as { slug: string };
      const batch = await batchService.getBySlug(slug);
      return {
        success: true,
        data: batch,
      };
    },
  });
};
