import { prisma } from '../db/prisma.js';

async function main() {
  const animeCount = await prisma.anime.count();
  const episodeCount = await prisma.episode.count();
  const genreCount = await prisma.genre.count();
  console.log(`=== DATABASE STATS ===`);
  console.log(`Anime count: ${animeCount}`);
  console.log(`Episode count: ${episodeCount}`);
  console.log(`Genre count: ${genreCount}`);
  await prisma.$disconnect();
}

main().catch(console.error);
