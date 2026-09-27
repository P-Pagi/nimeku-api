import { prisma } from '../db/prisma.js';
import { animeScraper } from '../scraper/scrapers/anime.scraper.js';
import { homeScraper } from '../scraper/scrapers/home.scraper.js';
import { genreScraper } from '../scraper/scrapers/genre.scraper.js';
import { scheduleScraper } from '../scraper/scrapers/schedule.scraper.js';
import { batchScraper } from '../scraper/scrapers/batch.scraper.js';
import { animeService } from '../services/anime.service.js';
import { syncStateService } from '../services/sync-state.service.js';
import { cacheService } from '../cache/cache.service.js';
import { logger } from '../config/logger.js';

export class SyncEngine {
  /**
   * Rule #14: INCREMENTAL SYNC
   * Checks recent episodes on Samehadaku.
   * If episode already exists in DB -> SKIP.
   * If new -> fetch anime detail, update anime, insert episode, invalidate Redis.
   */
  public async syncRecent(): Promise<{ processed: number; created: number; updated: number }> {
    const jobName = 'sync:recent';
    await syncStateService.startJob(jobName);
    logger.info('Starting incremental sync (recent episodes)');

    let processed = 0;
    let created = 0;
    let updated = 0;

    try {
      const homeData = await homeScraper.scrape();
      const recentEpisodes = homeData.recentEpisodes;

      // Save weekly Top 10 to Redis
      if (homeData.top10 && homeData.top10.length > 0) {
        await cacheService.set('anime:top10:weekly', homeData.top10, 86400); // 24 hours
        logger.info({ count: homeData.top10.length }, 'Saved weekly Top 10 slider data to Redis');
      }

      // Track ordered slugs from this sync run
      const orderedSlugs: string[] = [];

      for (const item of recentEpisodes) {
        processed++;
        if (!item.animeSlug) continue;

        // Collect ordered slugs for the "recent" list regardless of new/existing
        if (!orderedSlugs.includes(item.animeSlug)) {
          orderedSlugs.push(item.animeSlug);
        }

        // Check if episode already exists in PostgreSQL
        const existingEp = await prisma.episode.findFirst({
          where: {
            anime: { slug: item.animeSlug },
            episodeNumber: item.episodeNumber ? parseFloat(item.episodeNumber) : undefined,
          },
        });

        if (existingEp) {
          logger.debug({ animeSlug: item.animeSlug, ep: item.episodeNumber }, 'Episode already in DB, skipping');
          continue;
        }

        // Episode is new! Scrape anime detail and insert
        try {
          logger.info({ animeSlug: item.animeSlug, ep: item.episodeNumber }, 'New episode detected! Syncing anime detail.');
          const animeDetail = await animeScraper.scrape(item.animeSlug);
          await animeService.upsertAnime(animeDetail);
          created++;
          updated++;
        } catch (err: any) {
          logger.warn({ animeSlug: item.animeSlug, error: err.message }, 'Failed syncing anime in syncRecent, continuing');
        }
      }

      // Persist ordered slugs to Redis so /anime/recent and home can serve correct order
      if (orderedSlugs.length > 0) {
        await cacheService.set('anime:recent:ordered-slugs', orderedSlugs, 3600); // 1 hour
        // Invalidate the recently-updated list cache and home cache
        await cacheService.delByPattern('anime:recently-updated:*');
        await cacheService.del('home');
        logger.info({ count: orderedSlugs.length }, 'Saved ordered recent anime slugs to Redis and cleared home cache');
      }

      await syncStateService.completeJob(jobName, { processed, created, updated });
      logger.info({ processed, created, updated }, 'Incremental sync finished successfully');
      return { processed, created, updated };
    } catch (err: any) {
      logger.error({ error: err.message }, 'Incremental sync failed');
      await syncStateService.failJob(jobName, err.message);
      throw err;
    }
  }

  /**
   * Sync single anime detail by slug
   */
  public async syncAnime(slug: string): Promise<void> {
    const jobName = `sync:anime:${slug}`;
    await syncStateService.startJob(jobName);
    try {
      logger.info({ slug }, 'Syncing single anime');
      const detail = await animeScraper.scrape(slug);
      await animeService.upsertAnime(detail);
      await syncStateService.completeJob(jobName, { processed: 1, created: 0, updated: 1 });
    } catch (err: any) {
      logger.error({ slug, error: err.message }, 'Failed syncing single anime');
      await syncStateService.failJob(jobName, err.message);
      throw err;
    }
  }

  /**
   * Sync ongoing anime — scrapes the catalog filtered by status=ongoing
   * and upserts any anime whose data has changed (new episodes, status shift, etc.)
   * Runs every 10-30 minutes.
   */
  public async syncOngoing(): Promise<{ processed: number; updated: number }> {
    const jobName = 'sync:ongoing';
    await syncStateService.startJob(jobName);
    logger.info('Starting ongoing anime sync');

    let processed = 0;
    let updated = 0;

    try {
      // Scrape first 3 pages of ongoing catalog (~90 anime)
      const MAX_PAGES = 3;
      for (let p = 1; p <= MAX_PAGES; p++) {
        const catalog = await genreScraper.scrapeCatalog({ status: 'ongoing', page: p });
        logger.info({ page: p, count: catalog.items.length }, 'Ongoing catalog page scraped');

        for (const item of catalog.items) {
          processed++;
          try {
            // Check if anime needs a refresh (no synopsis = never fully synced)
            const existing = await prisma.anime.findUnique({
              where: { slug: item.slug },
              select: { synopsis: true, status: true },
            });

            const needsFullSync = !existing || !existing.synopsis || existing.synopsis.length < 20;

            if (needsFullSync) {
              const detail = await animeScraper.scrape(item.slug);
              if (!detail.isDegraded) {
                await animeService.upsertAnime(detail);
                updated++;
              }
            } else {
              // Quick update: only refresh score/status from catalog data
              await prisma.anime.update({
                where: { slug: item.slug },
                data: {
                  score: item.score ?? undefined,
                  status: item.status ?? undefined,
                },
              });
            }
          } catch (err: any) {
            logger.warn({ slug: item.slug, error: err.message }, 'Failed syncing ongoing anime item');
          }

          // Polite delay
          await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1000));
        }

        // Stop if no more pages
        if (!catalog.pagination.hasNextPage) break;
      }

      await cacheService.delByPattern('anime:*');
      await cacheService.delByPattern('recent:*');
      await cacheService.del('home');

      await syncStateService.completeJob(jobName, { processed, created: 0, updated });
      logger.info({ processed, updated }, 'Ongoing anime sync complete');
      return { processed, updated };
    } catch (err: any) {
      logger.error({ error: err.message }, 'Ongoing sync failed');
      await syncStateService.failJob(jobName, err.message);
      throw err;
    }
  }

  /**
   * Sync popular anime — scrapes catalog ordered by popularity
   * and refreshes score/stats for the top anime.
   * Runs every 1-6 hours.
   */
  public async syncPopular(): Promise<{ processed: number; updated: number }> {
    const jobName = 'sync:popular';
    await syncStateService.startJob(jobName);
    logger.info('Starting popular anime sync');

    let processed = 0;
    let updated = 0;

    try {
      // Scrape first 2 pages of popular catalog (~60 anime)
      const MAX_PAGES = 2;
      for (let p = 1; p <= MAX_PAGES; p++) {
        const catalog = await genreScraper.scrapeCatalog({ order: 'popular', page: p });
        logger.info({ page: p, count: catalog.items.length }, 'Popular catalog page scraped');

        for (const item of catalog.items) {
          processed++;
          try {
            await prisma.anime.upsert({
              where: { slug: item.slug },
              create: {
                slug: item.slug,
                title: item.title,
                poster: item.poster,
                type: item.type,
                score: item.score,
                status: item.status,
                sourceUrl: item.url,
              },
              update: {
                score: item.score ?? undefined,
                status: item.status ?? undefined,
              },
            });
            updated++;
          } catch (err: any) {
            logger.warn({ slug: item.slug, error: err.message }, 'Failed upserting popular anime');
          }
        }

        if (!catalog.pagination.hasNextPage) break;
      }

      await cacheService.delByPattern('anime:*');

      await syncStateService.completeJob(jobName, { processed, created: 0, updated });
      logger.info({ processed, updated }, 'Popular anime sync complete');
      return { processed, updated };
    } catch (err: any) {
      logger.error({ error: err.message }, 'Popular sync failed');
      await syncStateService.failJob(jobName, err.message);
      throw err;
    }
  }

  /**
   * Sync schedule and seed database
   */

  public async syncSchedule(): Promise<void> {
    const jobName = 'sync:schedule';
    await syncStateService.startJob(jobName);
    logger.info('Syncing weekly schedule');

    try {
      const scheduleItems = await scheduleScraper.scrapeAllDays();
      let created = 0;
      let updated = 0;

      // Delete any obsolete or 'Unknown' schedule entries
      await prisma.schedule.deleteMany({
        where: { day: 'Unknown' },
      });

      for (const item of scheduleItems) {
        if (!item.animeSlug) continue;

        // Ensure anime exists or create stub
        const anime = await prisma.anime.upsert({
          where: { slug: item.animeSlug },
          create: {
            slug: item.animeSlug,
            title: item.title,
            poster: item.poster,
            type: item.type,
            score: item.score,
            sourceUrl: item.url,
            status: 'Ongoing',
          },
          update: {
            title: item.title,
            type: item.type || undefined,
            score: item.score || undefined,
          },
        });

        // Upsert schedule
        await prisma.schedule.upsert({
          where: {
            animeId_day: {
              animeId: anime.id,
              day: item.day,
            },
          },
          create: {
            animeId: anime.id,
            day: item.day,
            time: item.time,
          },
          update: {
            time: item.time,
          },
        });

        updated++;
      }

      await cacheService.del('schedule:weekly');
      await syncStateService.completeJob(jobName, { processed: scheduleItems.length, created, updated });
      logger.info({ itemsCount: scheduleItems.length }, 'Schedule sync complete');
    } catch (err: any) {
      logger.error({ error: err.message }, 'Schedule sync failed');
      await syncStateService.failJob(jobName, err.message);
      throw err;
    }
  }

  /**
   * Sync all genres
   */
  public async syncGenres(): Promise<void> {
    const jobName = 'sync:genres';
    await syncStateService.startJob(jobName);
    try {
      const genres = await genreScraper.scrapeGenresList();
      for (const g of genres) {
        await prisma.genre.upsert({
          where: { slug: g.slug },
          create: { name: g.name, slug: g.slug },
          update: { name: g.name },
        });
      }
      await cacheService.del('genres:all');
      await syncStateService.completeJob(jobName, { processed: genres.length, created: 0, updated: genres.length });
    } catch (err: any) {
      await syncStateService.failJob(jobName, err.message);
      throw err;
    }
  }

  /**
   * Sync batches
   */
  public async syncBatches(maxPages = 2): Promise<void> {
    const jobName = 'sync:batches';
    await syncStateService.startJob(jobName);
    try {
      let processed = 0;
      for (let p = 1; p <= maxPages; p++) {
        const batchPage = await batchScraper.scrapeList(p);
        for (const item of batchPage.items) {
          processed++;
          const detail = await batchScraper.scrapeDetail(item.slug);

          let animeId: string | null = null;
          const candidateSlug = (detail.animeSlug || item.slug)
            .replace(/-episode-[\d-]+-batch$/i, '')
            .replace(/-batch$/i, '')
            .toLowerCase();

          const anime = await prisma.anime.findFirst({
            where: {
              OR: [
                { slug: candidateSlug },
                ...(detail.animeSlug ? [{ slug: detail.animeSlug }] : []),
              ],
            },
            select: { id: true },
          });
          if (anime) animeId = anime.id;

          await prisma.batch.upsert({
            where: { slug: item.slug },
            create: {
              slug: item.slug,
              animeId,
              title: detail.title,
              sourceUrl: detail.sourceUrl,
              downloadLinks: detail.downloadSections as any,
              lastSyncedAt: new Date(),
            },
            update: {
              title: detail.title,
              ...(animeId ? { animeId } : {}),
              downloadLinks: detail.downloadSections as any,
              lastSyncedAt: new Date(),
            },
          });
        }
      }
      await cacheService.delByPattern('batch:*');
      await syncStateService.completeJob(jobName, { processed, created: 0, updated: processed });
    } catch (err: any) {
      await syncStateService.failJob(jobName, err.message);
      throw err;
    }
  }

  /**
   * Rule #13: INITIAL SYNC
   * Seeds database: Genres -> Schedule -> Ongoing -> Batches
   */
  public async syncInitial(options: { maxPages?: number } = {}): Promise<void> {
    const jobName = 'sync:initial';
    await syncStateService.startJob(jobName);

    try {
      // 1. Sync genres
      await this.syncGenres();

      // 2. Sync schedule
      await this.syncSchedule();

      // 3. Detect total catalog pages automatically from page 1
      const firstPage = await genreScraper.scrapeCatalog({ page: 1 });
      const totalAvailablePages = firstPage.pagination.totalPages || 26;
      const targetPages = options.maxPages && options.maxPages > 0
        ? Math.min(options.maxPages, totalAvailablePages)
        : totalAvailablePages;

      logger.info(
        { targetPages, totalAvailablePages },
        `Starting catalog synchronization (${targetPages} pages, ~${targetPages * 30} anime)`
      );

      let totalSynced = 0;
      let totalSkipped = 0;

      for (let p = 1; p <= targetPages; p++) {
        const catalog = p === 1 ? firstPage : await genreScraper.scrapeCatalog({ page: p });
        logger.info(
          { page: p, targetPages, itemsCount: catalog.items.length },
          `Syncing catalog page ${p}/${targetPages}`
        );

        // Seed base catalog data immediately so every anime has valid title/poster/status
        for (const item of catalog.items) {
          await prisma.anime.upsert({
            where: { slug: item.slug },
            create: {
              slug: item.slug,
              title: item.title,
              poster: item.poster,
              type: item.type,
              score: item.score,
              status: item.status,
              sourceUrl: item.url,
            },
            update: {
              title: item.title,
              type: item.type || undefined,
              score: item.score || undefined,
              status: item.status || undefined,
            },
          });
        }

        // Enrich with detailed synopsis, episodes, and genres
        let consecutiveCloudflareFailures = 0;
        const COOLDOWN_THRESHOLD = 3;       // failures before cooldown
        const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

        for (let i = 0; i < catalog.items.length; i++) {
          const item = catalog.items[i];
          try {
            // --- SMART SKIP: if anime already has valid synopsis + poster in DB, skip detail scrape ---
            const existing = await prisma.anime.findUnique({
              where: { slug: item.slug },
              select: { synopsis: true, poster: true, genres: { select: { genreId: true } } },
            });
            const alreadyEnriched =
              existing &&
              existing.synopsis &&
              existing.synopsis.length > 20 &&
              existing.poster &&
              existing.genres.length > 0;

            if (alreadyEnriched) {
              totalSkipped++;
              consecutiveCloudflareFailures = 0; // reset on any success/skip
              logger.debug(
                `[Page ${p}/${targetPages}] [${i + 1}/${catalog.items.length}] SKIP (enriched): ${item.title}`
              );
              continue;
            }

            logger.info(
              `[Page ${p}/${targetPages}] [${i + 1}/${catalog.items.length}] Syncing: ${item.title}`
            );
            let detail = await animeScraper.scrape(item.slug);

            // If degraded (e.g. temporary challenge hit), wait 5s and retry once
            if (detail.isDegraded) {
              logger.info({ slug: item.slug }, 'Page returned degraded content, retrying in 5s...');
              await new Promise((r) => setTimeout(r, 5000));
              detail = await animeScraper.scrape(item.slug);
            }

            // Safe update: only upsert detail if not degraded to prevent wiping valid metadata
            if (!detail.isDegraded) {
              await animeService.upsertAnime(detail);
              totalSynced++;
              consecutiveCloudflareFailures = 0; // reset on success
            } else {
              consecutiveCloudflareFailures++;
              logger.warn(
                { slug: item.slug, consecutiveCloudflareFailures },
                'Detail scrape remained degraded, keeping catalog base info'
              );
            }
          } catch (err: any) {
            const isCloudflareBlock = err.message?.includes('HTML kosong') || err.message?.includes('cloudflare');
            if (isCloudflareBlock) {
              consecutiveCloudflareFailures++;
            }
            logger.warn({ slug: item.slug, error: err.message, consecutiveCloudflareFailures }, 'Failed syncing catalog item, continuing');
          }

          // --- AUTO-COOLDOWN: Cloudflare IP rate limit recovery ---
          if (consecutiveCloudflareFailures >= COOLDOWN_THRESHOLD) {
            const cooldownMinutes = COOLDOWN_MS / 60000;
            logger.warn(
              { consecutiveCloudflareFailures, cooldownMinutes },
              `⚠️  ${consecutiveCloudflareFailures} consecutive Cloudflare blocks detected. Cooling down for ${cooldownMinutes} minutes to reset IP reputation...`
            );

            // Close and reset Playwright session to get fresh context & cookies
            try {
              const { playwrightClient } = await import('../scraper/client/playwright.client.js');
              await playwrightClient.close();
              logger.info('Playwright session reset — will reinitialize on next request');
            } catch {}

            await new Promise((r) => setTimeout(r, COOLDOWN_MS));
            consecutiveCloudflareFailures = 0;
            logger.info('Cooldown complete — resuming sync');
          }

          // Politeness delay: 3s - 6s with random jitter (more conservative after cooldown)
          const delayMs = 3000 + Math.floor(Math.random() * 3000);
          await new Promise((r) => setTimeout(r, delayMs));
        }

        logger.info(
          { page: p, targetPages, totalSynced, totalSkipped },
          `Page ${p}/${targetPages} done — synced: ${totalSynced}, skipped (already enriched): ${totalSkipped}`
        );
      }

      // 4. Sync batches
      await this.syncBatches(1);

      await syncStateService.completeJob(jobName, { processed: totalSynced + totalSkipped, created: totalSynced, updated: 0 });
      logger.info({ totalSynced, totalSkipped, pagesScraped: targetPages }, 'Initial synchronization complete!');
    } catch (err: any) {
      await syncStateService.failJob(jobName, err.message);
      throw err;
    }
  }
}

export const syncEngine = new SyncEngine();
