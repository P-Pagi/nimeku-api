import fs from 'fs';
import path from 'path';
import { prisma } from '../db/prisma.js';

function isRealImage(buffer: Buffer): { valid: boolean; type?: string } {
  if (buffer.length < 8) return { valid: false };

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { valid: true, type: 'jpeg' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { valid: true, type: 'png' };
  }
  // GIF: GIF87a or GIF89a
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return { valid: true, type: 'gif' };
  }
  // WEBP: RIFF....WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { valid: true, type: 'webp' };
  }

  return { valid: false };
}

async function scanAllPosters() {
  const animes = await prisma.anime.findMany({
    select: {
      id: true,
      slug: true,
      title: true,
      poster: true,
      posterLocal: true,
      sourceUrl: true,
    },
  });

  const posterDir = path.resolve(process.cwd(), 'public', 'posters');
  const invalidAnime: any[] = [];

  for (const anime of animes) {
    let fileToCheck: string | null = null;
    let reason = '';

    if (!anime.poster && !anime.posterLocal) {
      reason = 'Null poster in DB';
    } else {
      const posterPath = anime.posterLocal || anime.poster;
      if (posterPath && posterPath.startsWith('/public/posters/')) {
        const filePath = path.join(posterDir, path.basename(posterPath));
        fileToCheck = filePath;
        if (!fs.existsSync(filePath)) {
          reason = 'File does not exist on disk';
        } else {
          const buf = Buffer.alloc(16);
          const fd = fs.openSync(filePath, 'r');
          fs.readSync(fd, buf, 0, 16, 0);
          fs.closeSync(fd);

          const check = isRealImage(buf);
          if (!check.valid) {
            const preview = fs.readFileSync(filePath, 'utf8').slice(0, 100).replace(/\s+/g, ' ');
            reason = `Not a valid image file (Header: "${preview}")`;
          }
        }
      } else if (posterPath && posterPath.startsWith('http')) {
        reason = `Remote URL not downloaded yet: ${posterPath}`;
      }
    }

    if (reason) {
      invalidAnime.push({
        id: anime.id,
        slug: anime.slug,
        title: anime.title,
        reason,
        fileToCheck,
      });
    }
  }

  console.log(`Scan completed! Total anime: ${animes.length}`);
  console.log(`Invalid or missing posters: ${invalidAnime.length}`);
  for (const inv of invalidAnime) {
    console.log(`- [${inv.slug}] "${inv.title}": ${inv.reason}`);
  }

  await prisma.$disconnect();
}

scanAllPosters().catch(console.error);
