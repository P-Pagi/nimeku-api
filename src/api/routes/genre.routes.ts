import { FastifyPluginAsync } from 'fastify';
import { genreService } from '../../services/genre.service.js';

export const genreRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/genres
  fastify.get('/genres', {
    schema: {
      tags: ['Genre'],
      summary: 'Daftar semua genre anime beserta jumlah anime terkait',
    },
    handler: async () => {
      const genres = await genreService.getAllGenres();
      return {
        success: true,
        data: genres,
      };
    },
  });

  // GET /api/v1/genres/:slug?page=1
  fastify.get('/genres/:slug', {
    schema: {
      tags: ['Genre'],
      summary: 'Daftar anime berdasarkan genre',
      params: {
        type: 'object',
        required: ['slug'],
        properties: {
          slug: { type: 'string' },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 20 },
        },
      },
    },
    handler: async (request) => {
      const { slug } = request.params as { slug: string };
      const { page = 1, limit = 20 } = request.query as any;
      const result = await genreService.getAnimeByGenre(slug, page, limit);
      return {
        success: true,
        data: result.items,
        meta: result.pagination,
      };
    },
  });
};
