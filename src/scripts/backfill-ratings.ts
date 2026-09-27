import { prisma } from '../db/prisma.js';
import { crossReferenceService } from '../services/cross-reference.service.js';
import { cacheService } from '../cache/cache.service.js';

async function main() {
  const args = process.argv.slice(2);
  let limit: number | undefined = undefined;
  let concurrency = 4;
  let delayMs = 120;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--concurrency' && args[i + 1]) {
      concurrency = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--delay' && args[i + 1]) {
      delayMs = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  console.log('='.repeat(60));
  console.log('  ANIME RATING CROSS-REFERENCE BACKFILL');
  console.log('='.repeat(60));
  console.log(`Settings: concurrency=${concurrency}, delay=${delayMs}ms, dryRun=${dryRun}${limit ? `, limit=${limit}` : ''}`);

  const animes = await prisma.anime.findMany({
    where: { rating: null },
    select: {
      id: true,
      slug: true,
      title: true,
      alternativeTitle: true,
      japaneseTitle: true,
    },
    take: limit,
  });

  const total = animes.length;
  console.log(`Found ${total} anime with rating = null.\n`);

  if (total === 0) {
    console.log('No anime need rating update.');
    return;
  }

  let processed = 0;
  let matched = 0;
  let failed = 0;

  // Process in chunks of `concurrency`
  for (let i = 0; i < animes.length; i += concurrency) {
    const chunk = animes.slice(i, i + concurrency);

    await Promise.all(
      chunk.map(async (anime) => {
        try {
          const rating = await crossReferenceService.getAnimeRating(
            anime.title,
            anime.alternativeTitle,
            anime.japaneseTitle
          );

          if (rating) {
            matched++;
            if (!dryRun) {
              await prisma.anime.update({
                where: { id: anime.id },
                data: { rating },
              });
              await cacheService.invalidateAnime(anime.slug);
            }
            console.log(`[OK] ${anime.title} -> "${rating}"`);
          } else {
            failed++;
            console.log(`[SKIP] ${anime.title} -> (No rating found)`);
          }
        } catch (err: any) {
          failed++;
          console.error(`[ERR] ${anime.title}: ${err.message}`);
        } finally {
          processed++;
        }
      })
    );

    const percent = ((processed / total) * 100).toFixed(1);
    console.log(`--- Progress: ${processed}/${total} (${percent}%) | Matched: ${matched} | Skipped: ${failed} ---\n`);

    if (delayMs > 0 && i + concurrency < animes.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  console.log('='.repeat(60));
  console.log('  BACKFILL COMPLETED');
  console.log('='.repeat(60));
  console.log(`Total Scanned : ${total}`);
  console.log(`Matched & Updated : ${matched}`);
  console.log(`Skipped / Not Found: ${failed}`);
  console.log(`Success Rate  : ${((matched / total) * 100).toFixed(1)}%`);
}

main()
  .catch((err) => {
    console.error('Fatal error during backfill:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
