import { prisma } from '../db/prisma.js';

async function main() {
  console.log('--- AUTO-LINKING BATCHES TO ANIMES IN DATABASE ---');

  const batches = await prisma.batch.findMany({
    where: { animeId: null },
    select: { id: true, slug: true, title: true },
  });

  console.log(`Found ${batches.length} batches without animeId.`);

  const animes = await prisma.anime.findMany({
    select: { id: true, slug: true, title: true },
  });

  const animeSlugMap = new Map(animes.map((a) => [a.slug.toLowerCase(), a.id]));

  let matched = 0;
  for (const b of batches) {
    // 1. Try slug candidate by stripping -episode-...-batch or -batch
    const candidateSlug = b.slug
      .replace(/-episode-[\d-]+-batch$/i, '')
      .replace(/-batch$/i, '')
      .toLowerCase();

    let animeId = animeSlugMap.get(candidateSlug);

    // 2. Try prefix / partial slug match
    if (!animeId) {
      const found = animes.find(
        (a) =>
          a.slug === candidateSlug ||
          candidateSlug.startsWith(a.slug) ||
          a.slug.startsWith(candidateSlug)
      );
      if (found) animeId = found.id;
    }

    // 3. Try title matching
    if (!animeId) {
      const cleanBatchTitle = b.title
        .replace(/Episode.*$/i, '')
        .replace(/\[BATCH\].*$/i, '')
        .trim()
        .toLowerCase();
      const foundByTitle = animes.find(
        (a) =>
          a.title.toLowerCase().includes(cleanBatchTitle) ||
          cleanBatchTitle.includes(a.title.toLowerCase())
      );
      if (foundByTitle) animeId = foundByTitle.id;
    }

    if (animeId) {
      await prisma.batch.update({
        where: { id: b.id },
        data: { animeId },
      });
      matched++;
      const anime = animes.find((a) => a.id === animeId);
      console.log(`Linked [${b.slug}] -> Anime: "${anime?.title}" (${anime?.slug})`);
    } else {
      console.log(`Unmatched batch: [${b.slug}] "${b.title}"`);
    }
  }

  console.log(`\nDONE: Successfully linked ${matched}/${batches.length} batches.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
