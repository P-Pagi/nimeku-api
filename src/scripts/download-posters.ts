import { prisma } from '../db/prisma.js';
import { posterService } from '../services/poster.service.js';
import { logger } from '../config/logger.js';

async function batchDownloadPosters(concurrency = 6) {
  console.log('🖼️  [Poster Downloader] Scanning database for anime posters...');

  const animes = await prisma.anime.findMany({
    select: {
      id: true,
      slug: true,
      title: true,
      alternativeTitle: true,
      japaneseTitle: true,
      poster: true,
      posterLocal: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  const total = animes.length;
  console.log(`📊 Found ${total} anime in database to verify/download posters.`);

  let downloadedCount = 0;
  let alreadyExistCount = 0;
  let failedCount = 0;
  let processed = 0;

  // Process items in chunks of concurrency
  for (let i = 0; i < animes.length; i += concurrency) {
    const chunk = animes.slice(i, i + concurrency);

    await Promise.all(
      chunk.map(async (anime) => {
        try {
          // Check if already had a local entry in DB
          const hadLocal = !!anime.posterLocal;
          const localUrl = await posterService.ensurePoster(anime);

          if (localUrl) {
            if (hadLocal && anime.poster === localUrl) {
              alreadyExistCount++;
            } else {
              downloadedCount++;
            }
          } else {
            failedCount++;
          }
        } catch (err: any) {
          failedCount++;
          logger.warn({ slug: anime.slug, error: err.message }, 'Failed downloading poster');
        } finally {
          processed++;
          if (processed % 25 === 0 || processed === total) {
            const pct = ((processed / total) * 100).toFixed(1);
            console.log(
              `⏳ [${processed}/${total}] (${pct}%) - Downloaded: ${downloadedCount} | Already cached: ${alreadyExistCount} | Failed: ${failedCount}`
            );
          }
        }
      })
    );
  }

  console.log('\n=============================================');
  console.log('🎉 [Poster Downloader] Finished processing all posters!');
  console.log(`   - Total Anime:      ${total}`);
  console.log(`   - Newly Downloaded: ${downloadedCount}`);
  console.log(`   - Already Existed:  ${alreadyExistCount}`);
  console.log(`   - Failed:           ${failedCount}`);
  console.log(`   - Location:         public/posters/`);
  console.log('=============================================\n');

  await prisma.$disconnect();
}

batchDownloadPosters()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error('Fatal error during poster download:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
