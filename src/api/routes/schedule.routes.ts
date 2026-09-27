import { FastifyPluginAsync } from 'fastify';
import { scheduleService } from '../../services/schedule.service.js';

export const scheduleRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/schedule
  fastify.get('/schedule', {
    schema: {
      tags: ['Schedule'],
      summary: 'Jadwal rilis anime mingguan dikelompokkan berdasarkan hari',
    },
    handler: async () => {
      const schedule = await scheduleService.getWeeklySchedule();
      return {
        success: true,
        data: schedule,
      };
    },
  });
};
