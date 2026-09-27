import { prisma } from '../db/prisma.js';
import { extractEpisodeNumber } from '../scraper/utils/episode-number.extractor.js';
import { logger } from '../config/logger.js';

async function main() {
  console.log('--- FIXING NULL EPISODE NUMBERS IN DATABASE ---');

  const nullEpisodes = await prisma.episode.findMany({
    where: { episodeNumber: null },
    select: {
      id: true,
      slug: true,
      title: true,
      anime: {
        select: {
          type: true,
          title: true,
        },
      },
    },
  });

  console.log(`Found ${nullEpisodes.length} episodes with null episodeNumber.`);
  let updatedCount = 0;
  let unparsedCount = 0;

  for (const ep of nullEpisodes) {
    const num = extractEpisodeNumber(ep.slug, ep.title, ep.anime?.type);
    if (num !== null) {
      await prisma.episode.update({
        where: { id: ep.id },
        data: { episodeNumber: num },
      });
      updatedCount++;
    } else {
      unparsedCount++;
      console.log(`Could not parse: [${ep.slug}] title: "${ep.title}"`);
    }
  }

  console.log(`\nDONE: Successfully updated ${updatedCount}/${nullEpisodes.length} episodes.`);
  if (unparsedCount > 0) {
    console.log(`Remaining unparsed: ${unparsedCount}`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
