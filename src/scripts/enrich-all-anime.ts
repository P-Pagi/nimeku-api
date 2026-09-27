import { prisma } from '../db/prisma.js';
import { crossReferenceService } from '../services/cross-reference.service.js';
import { cacheService } from '../cache/cache.service.js';

async function main() {
  const args = process.argv.slice(2);
  let limit: number | undefined = undefined;
  let concurrency = 5;
  let delayMs = 100;
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

  console.log('='.repeat(65));
  console.log('   ANIME METADATA ENRICHMENT & CROSS-REFERENCE BACKFILL');
  console.log('='.repeat(65));

  // Find all anime where at least one key field is missing
  const animes = await prisma.anime.findMany({
    where: {
      OR: [
        { rating: null },
        { totalEpisodes: null },
        { duration: null },
        { season: null },
        { latestEpisode: null },
        { studio: null },
        { producers: null },
      ],
    },
    include: {
      episodes: {
        orderBy: { episodeNumber: 'desc' },
        take: 1,
        select: { episodeNumber: true },
      },
      _count: {
        select: { episodes: true },
      },
    },
    take: limit,
  });

  const total = animes.length;
  console.log(`Found ${total} anime with one or more missing fields.\n`);

  if (total === 0) {
    console.log('All anime are fully populated!');
    return;
  }

  let processed = 0;
  let updatedCount = 0;

  for (let i = 0; i < animes.length; i += concurrency) {
    const chunk = animes.slice(i, i + concurrency);

    await Promise.all(
      chunk.map(async (anime) => {
        try {
          const patch: any = {};

          // 1. Local smart inference for latestEpisode
          if (!anime.latestEpisode) {
            if (anime.type === 'Movie') {
              patch.latestEpisode = 'Movie';
            } else if (anime.episodes.length > 0 && anime.episodes[0].episodeNumber != null) {
              patch.latestEpisode = String(anime.episodes[0].episodeNumber);
            } else if (anime._count.episodes > 0) {
              patch.latestEpisode = String(anime._count.episodes);
            }
          }

          // 2. Local smart inference for totalEpisodes
          if (anime.totalEpisodes == null) {
            if (anime.type === 'Movie') {
              patch.totalEpisodes = 1;
            } else if (anime.status === 'Completed' && anime._count.episodes > 0) {
              patch.totalEpisodes = anime._count.episodes;
            }
          }

          // 3. Local smart inference for season from releasedAt
          if (!anime.season && anime.releasedAt) {
            const derived = crossReferenceService.deriveSeason(anime.releasedAt);
            if (derived) patch.season = derived;
          }

          // 4. External Cross-Reference for remaining null fields
          const needsExternal =
            (!anime.rating && !patch.rating) ||
            (anime.totalEpisodes == null && patch.totalEpisodes == null) ||
            (!anime.duration && !patch.duration) ||
            (!anime.season && !patch.season) ||
            (!anime.studio && !patch.studio) ||
            (!anime.producers && !patch.producers);

          if (needsExternal) {
            const ext = await crossReferenceService.getEnrichedMetadata(
              anime.title,
              anime.alternativeTitle,
              anime.japaneseTitle
            );

            if (ext) {
              if (!anime.rating && !patch.rating && ext.rating) patch.rating = ext.rating;
              if (anime.totalEpisodes == null && patch.totalEpisodes == null && ext.totalEpisodes != null) {
                patch.totalEpisodes = ext.totalEpisodes;
              }
              if (!anime.duration && !patch.duration && ext.duration) patch.duration = ext.duration;
              if (!anime.season && !patch.season && ext.season) patch.season = ext.season;
              if (!anime.releaseYear && ext.releaseYear) patch.releaseYear = ext.releaseYear;
              if (!anime.studio && !patch.studio && ext.studio) patch.studio = ext.studio;
              if (!anime.producers && !patch.producers && ext.producers) patch.producers = ext.producers;
            }

            // Fallback producers to studio if still empty
            if (!anime.producers && !patch.producers && (patch.studio || anime.studio)) {
              patch.producers = patch.studio || anime.studio;
            }
          }

          // Apply patch if any changes
          if (Object.keys(patch).length > 0) {
            if (!dryRun) {
              await prisma.anime.update({
                where: { id: anime.id },
                data: patch,
              });
              await cacheService.invalidateAnime(anime.slug);
            }
            updatedCount++;
            console.log(`[PATCHED] ${anime.title} -> ${JSON.stringify(patch)}`);
          } else {
            console.log(`[UNCHANGED] ${anime.title}`);
          }
        } catch (err: any) {
          console.error(`[ERROR] ${anime.title}: ${err.message}`);
        } finally {
          processed++;
        }
      })
    );

    const percent = ((processed / total) * 100).toFixed(1);
    console.log(`--- Progress: ${processed}/${total} (${percent}%) | Updated: ${updatedCount} ---\n`);

    if (delayMs > 0 && i + concurrency < animes.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  console.log('='.repeat(65));
  console.log('   ENRICHMENT COMPLETED');
  console.log('='.repeat(65));
  console.log(`Total Processed : ${processed}`);
  console.log(`Updated Records : ${updatedCount}`);
}

main()
  .catch((err) => {
    console.error('Fatal error during enrichment:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
