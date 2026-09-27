import fs from 'fs';
import path from 'path';
import { prisma } from '../db/prisma.js';
import { posterService } from '../services/poster.service.js';
import { logger } from '../config/logger.js';

async function fixNullAndBrokenPosters() {
  console.log('🔍 Scanning database for anime with null, missing, or corrupted posters...');

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
  });

  const posterDir = path.resolve(process.cwd(), 'public', 'posters');
  const targets: typeof animes = [];

  for (const anime of animes) {
    let needsFix = false;

    if (!anime.poster || !anime.posterLocal) {
      needsFix = true;
    } else {
      const filePath = path.join(posterDir, path.basename(anime.posterLocal));
      if (!fs.existsSync(filePath) || !posterService.isRealImageFile(filePath)) {
        needsFix = true;
      }
    }

    if (needsFix) {
      targets.push(anime);
    }
  }

  console.log(`📋 Found ${targets.length} anime needing poster repair/download.`);

  for (let i = 0; i < targets.length; i++) {
    const anime = targets[i];
    console.log(`\n[${i + 1}/${targets.length}] Processing "${anime.title}" (${anime.slug})...`);
    console.log(`  Current poster: ${anime.poster}`);
    console.log(`  Current posterLocal: ${anime.posterLocal}`);

    try {
      const localUrl = await posterService.ensurePoster(anime);
      if (localUrl) {
        console.log(`  ✅ Successfully resolved and saved poster: ${localUrl}`);
      } else {
        console.log(`  ❌ Failed to resolve poster for "${anime.title}"`);
      }
    } catch (err: any) {
      console.error(`  ❌ Error processing "${anime.title}":`, err.message);
    }
  }

  console.log('\n=============================================');
  console.log('🎉 Poster repair process finished!');
  console.log('=============================================\n');

  await prisma.$disconnect();
}

fixNullAndBrokenPosters()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error('Fatal error:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
