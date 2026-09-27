import { prisma } from '../db/prisma.js';

async function checkRatings() {
  const total = await prisma.anime.count();
  const stats = {
    total,
    withRating: await prisma.anime.count({ where: { rating: { not: null } } }),
    withTotalEpisodes: await prisma.anime.count({ where: { totalEpisodes: { not: null } } }),
    withSeason: await prisma.anime.count({ where: { season: { not: null } } }),
    withLatestEpisode: await prisma.anime.count({ where: { latestEpisode: { not: null } } }),
    withDuration: await prisma.anime.count({ where: { duration: { not: null } } }),
    withStudio: await prisma.anime.count({ where: { studio: { not: null } } }),
    withProducers: await prisma.anime.count({ where: { producers: { not: null } } }),
    withScore: await prisma.anime.count({ where: { score: { not: null } } }),
    nullScore: await prisma.anime.count({ where: { score: null } }),
  };
  
  console.log('Database Metadata Completeness:');
  console.table(stats);

  const sampleNullProd = await prisma.anime.findMany({
    where: { producers: null },
    take: 10,
    select: { slug: true, title: true, type: true, studio: true, producers: true },
  });
  console.log('\nSample Anime with producers = null:');
  console.table(sampleNullProd);
}

checkRatings().finally(() => prisma.$disconnect());
