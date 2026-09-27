import { prisma } from '../db/prisma.js';
import { cacheService } from '../cache/cache.service.js';
import { lockService } from '../cache/lock.service.js';
import { episodeScraper } from '../scraper/scrapers/episode.scraper.js';
import { EpisodeNotFoundError } from '../resilience/errors.js';
import { logger } from '../config/logger.js';
import { crossReferenceService } from './cross-reference.service.js';
import { checkEmbedReachable, detectServerProvider, ServerProvider } from './server.health.js';
import { otakudesuScraper } from '../scraper/scrapers/otakudesu.scraper.js';

export class EpisodeService {
  /**
   * Get episode detail with servers metadata
   */
  public async getBySlug(slug: string) {
    const cacheKey = `episode:${slug}`;
    const cached = await cacheService.get<any>(cacheKey);
    // Only return cached if it already has servers populated and includes cross-platform servers
    if (
      cached &&
      Array.isArray(cached.servers) &&
      cached.servers.length > 0 &&
      cached.servers.some((s: any) => s.source === 'otakudesu')
    ) {
      return cached;
    }

    const episode = await prisma.episode.findUnique({
      where: { slug },
      include: {
        anime: {
          include: {
            genres: {
              include: {
                genre: true,
              },
            },
          },
        },
        servers: {
          select: {
            id: true,
            name: true,
            serverKey: true,
            type: true,
          },
        },
      },
    });

    if (!episode) {
      // If missing from DB, try to scrape episode and upsert parent anime
      return await this.syncAndGetEpisode(slug);
    }

    // Select episodes for navigation with thumbnails
    const [prev, next, rawEpisodeList, cachedDownloads, cachedServers] = await Promise.all([
      episode.episodeNumber !== null
        ? prisma.episode.findFirst({
            where: { animeId: episode.animeId, episodeNumber: { lt: episode.episodeNumber } },
            orderBy: { episodeNumber: 'desc' },
            select: { id: true, slug: true, episodeNumber: true, title: true },
          })
        : null,
      episode.episodeNumber !== null
        ? prisma.episode.findFirst({
            where: { animeId: episode.animeId, episodeNumber: { gt: episode.episodeNumber } },
            orderBy: { episodeNumber: 'asc' },
            select: { id: true, slug: true, episodeNumber: true, title: true },
          })
        : null,
      prisma.episode.findMany({
        where: { animeId: episode.animeId },
        orderBy: { episodeNumber: 'asc' },
        select: {
          id: true,
          slug: true,
          episodeNumber: true,
          title: true,
          thumbnail: true,
          releasedAt: true,
        },
      }),
      cacheService.get<any[]>(`episode:${slug}:downloads`),
      cacheService.get<any[]>(`episode:${slug}:servers`),
    ]);

    let servers = cachedServers && cachedServers.length > 0 ? cachedServers : episode.servers;
    let downloads = cachedDownloads || [];

    // AUTO-POPULATE: If servers are empty in DB and Redis, scrape once and save to DB
    if (!servers || servers.length === 0) {
      try {
        logger.info({ slug }, 'Episode servers empty in DB — auto-fetching from source and saving to DB');
        const scraped = await episodeScraper.scrape(slug);

        if (scraped.servers && scraped.servers.length > 0) {
          const createdServers = await Promise.all(
            scraped.servers.map(async (s) => {
              const serverKey = s.nume || s.id;
              const existing = await prisma.streamServer.findFirst({
                where: { episodeId: episode.id, serverKey },
              });
              if (existing) {
                return prisma.streamServer.update({
                  where: { id: existing.id },
                  data: { name: s.name, type: s.type || 'schtml' },
                  select: { id: true, name: true, serverKey: true, type: true },
                });
              }
              return prisma.streamServer.create({
                data: {
                  episodeId: episode.id,
                  name: s.name,
                  serverKey,
                  type: s.type || 'schtml',
                },
                select: { id: true, name: true, serverKey: true, type: true },
              });
            })
          );

          servers = createdServers;
          await cacheService.set(`episode:${slug}:servers`, servers, 86400 * 7);
        }

        if (scraped.downloads && scraped.downloads.length > 0) {
          downloads = scraped.downloads;
          await cacheService.set(`episode:${slug}:downloads`, downloads, 86400 * 7);
        }

        await prisma.episode.update({
          where: { id: episode.id },
          data: { lastSyncedAt: new Date() },
        });
      } catch (err: any) {
        logger.warn({ slug, error: err.message }, 'Failed auto-fetching episode servers/downloads');
      }
    }

    const animeObj = episode.anime as any;
    const anime = animeObj
      ? {
          id: animeObj.id,
          slug: animeObj.slug,
          title: animeObj.title,
          alternativeTitle: animeObj.alternativeTitle,
          poster: animeObj.posterLocal || animeObj.poster,
          posterLocal: animeObj.posterLocal || null,
          status: animeObj.status,
          type: animeObj.type,
          score: animeObj.score,
          synopsis: animeObj.synopsis,
          totalEpisodes: animeObj.totalEpisodes,
          genres: animeObj.genres?.map((g: any) => g.genre?.name || g.name || g) || [],
        }
      : null;

    // Cross-platform episode thumbnail resolution
    let thumbnail = episode.thumbnail;
    if (!thumbnail && episode.episodeNumber !== null && anime?.title) {
      try {
        const enrichedThumb = await crossReferenceService.fetchEpisodeThumbnail(
          anime.title,
          episode.episodeNumber
        );
        if (enrichedThumb) {
          thumbnail = enrichedThumb;
          // Asynchronously update in DB so next reads are instant
          prisma.episode.update({
            where: { id: episode.id },
            data: { thumbnail: enrichedThumb },
          }).catch((err) => {
            logger.warn({ slug, error: err.message }, 'Failed persisting enriched episode thumbnail to DB');
          });
        }
      } catch (err: any) {
        logger.debug({ slug, error: err.message }, 'Failed cross-platform thumbnail enrichment');
      }
    }

    // Fallback thumbnail to anime poster if still null
    if (!thumbnail) {
      thumbnail = anime?.posterLocal || anime?.poster || null;
    }

    const fallbackPoster = anime?.posterLocal || anime?.poster || null;
    const episodeList = rawEpisodeList.map((ep) => ({
      id: ep.id,
      slug: ep.slug,
      episodeNumber: ep.episodeNumber,
      title: ep.title,
      thumbnail: ep.thumbnail || fallbackPoster,
      releasedAt: ep.releasedAt,
    }));

    const navigation = {
      previousEpisode: prev,
      nextEpisode: next,
      allEpisodesSlug: episode.anime?.slug || null,
    };

    const finalServers = await this.enrichWithCrossPlatformServers(
      slug,
      anime?.title,
      episode.episodeNumber,
      servers
    );

    const result = {
      id: episode.id,
      slug: episode.slug,
      episodeNumber: episode.episodeNumber,
      title: episode.title,
      thumbnail,
      releasedAt: episode.releasedAt,
      anime,
      navigation,
      episodeList,
      servers: finalServers,
      downloads,
    };

    const ttl = finalServers && finalServers.length > 0 ? 3600 : 15;
    await cacheService.set(cacheKey, result, ttl);
    return result;
  }

  /**
   * Enrich server list with cross-platform servers (e.g. Otakudesu) as alternative/backup options
   */
  private async enrichWithCrossPlatformServers(
    slug: string,
    animeTitle?: string | null,
    episodeNumber?: number | null,
    samehadakuServers: any[] = []
  ): Promise<any[]> {
    // 1. Deduplicate & format Samehadaku servers
    const seenSamehadaku = new Set<string>();
    const cleanedSamehadaku: any[] = [];
    for (const s of samehadakuServers) {
      const normName = s.name.trim().toLowerCase();
      if (!seenSamehadaku.has(normName)) {
        seenSamehadaku.add(normName);
        cleanedSamehadaku.push({
          ...s,
          name: s.name.startsWith('[') ? s.name : `[Samehadaku] ${s.name}`,
          source: 'samehadaku',
        });
      }
    }

    if (!animeTitle || episodeNumber == null || isNaN(episodeNumber)) {
      return cleanedSamehadaku;
    }

    try {
      const otakuServers = await otakudesuScraper.getEpisodeServers(animeTitle, episodeNumber);
      if (otakuServers && otakuServers.length > 0) {
        const taggedOtakudesu = otakuServers.map((s) => ({
          id: s.id,
          name: s.name.startsWith('[') ? s.name : `[Otakudesu] ${s.name}`,
          serverKey: s.serverKey,
          type: s.type,
          source: 'otakudesu',
          quality: s.quality,
        }));
        // Merge both platforms together side-by-side
        return [...cleanedSamehadaku, ...taggedOtakudesu];
      }
    } catch (err: any) {
      logger.debug({ slug, error: err.message }, 'Could not enrich with Otakudesu servers');
    }

    return cleanedSamehadaku;
  }

  /**
   * Get download links for episode (by quality and host).
   * Checks Redis cache first (TTL 7 days), then scrapes live if missing.
   */
  public async getEpisodeDownloads(slug: string) {
    const cacheKey = `episode:${slug}:downloads`;
    const cached = await cacheService.get<any[]>(cacheKey);
    if (cached && cached.length > 0) {
      return cached;
    }

    try {
      logger.info({ slug }, 'Scraping episode downloads and saving servers to DB');
      const scraped = await episodeScraper.scrape(slug);
      const downloads = scraped.downloads || [];

      // Cache downloads for 7 days
      await cacheService.set(cacheKey, downloads, 86400 * 7);

      // Also persist servers to DB if episode exists
      const episode = await prisma.episode.findUnique({ where: { slug } });
      if (episode && scraped.servers && scraped.servers.length > 0) {
        const savedServers = await Promise.all(
          scraped.servers.map(async (s) => {
            const serverKey = s.nume || s.id;
            const existing = await prisma.streamServer.findFirst({
              where: { episodeId: episode.id, serverKey },
            });
            if (existing) {
              return prisma.streamServer.update({
                where: { id: existing.id },
                data: { name: s.name, type: s.type || 'schtml' },
                select: { id: true, name: true, serverKey: true, type: true },
              });
            }
            return prisma.streamServer.create({
              data: {
                episodeId: episode.id,
                name: s.name,
                serverKey,
                type: s.type || 'schtml',
              },
              select: { id: true, name: true, serverKey: true, type: true },
            });
          })
        );
        await cacheService.set(`episode:${slug}:servers`, savedServers, 86400 * 7);
      }

      // Invalidate episode detail cache so it re-generates with new servers and downloads
      await cacheService.del(`episode:${slug}`);

      return downloads;
    } catch (err: any) {
      logger.warn({ slug, error: err.message }, 'Failed to fetch episode downloads');
      return [];
    }
  }

  /**
   * Get live server options for episode.
   * Checks PostgreSQL stream_servers table first, then Redis, and scrapes if missing.
   * Enriches with cross-platform Otakudesu servers as secondary options.
   */
  public async getEpisodeServers(slug: string) {
    const cacheKey = `episode:${slug}:servers:crossplatform`;
    const cached = await cacheService.get<any[]>(cacheKey);
    if (cached && cached.length > 0) {
      logger.debug({ slug }, 'Serving episode server list from Redis cache');
      return cached;
    }

    // 1. Get Samehadaku servers from DB or live scrape
    let samehadakuServers = await prisma.streamServer.findMany({
      where: { episode: { slug } },
      select: {
        id: true,
        name: true,
        serverKey: true,
        type: true,
      },
    });

    if (!samehadakuServers || samehadakuServers.length === 0) {
      logger.info({ slug }, 'Scraping live server options for episode and persisting to DB');
      const scraped = await episodeScraper.scrape(slug);
      const episode = await prisma.episode.findUnique({ where: { slug } });

      samehadakuServers = scraped.servers.map((s) => ({
        id: s.id,
        name: s.name,
        serverKey: s.nume,
        type: s.type,
      }));

      if (episode && scraped.servers.length > 0) {
        samehadakuServers = await Promise.all(
          scraped.servers.map(async (s) => {
            const serverKey = s.nume || s.id;
            const existing = await prisma.streamServer.findFirst({
              where: { episodeId: episode.id, serverKey },
            });
            if (existing) {
              return prisma.streamServer.update({
                where: { id: existing.id },
                data: { name: s.name, type: s.type || 'schtml' },
                select: { id: true, name: true, serverKey: true, type: true },
              });
            }
            return prisma.streamServer.create({
              data: {
                episodeId: episode.id,
                name: s.name,
                serverKey,
                type: s.type || 'schtml',
              },
              select: { id: true, name: true, serverKey: true, type: true },
            });
          })
        );
      }

      if (scraped.downloads && scraped.downloads.length > 0) {
        await cacheService.set(`episode:${slug}:downloads`, scraped.downloads, 86400 * 7);
      }
    }

    // 2. Cross-platform Otakudesu server enrichment
    const ep = await prisma.episode.findUnique({
      where: { slug },
      include: { anime: { select: { title: true } } },
    });

    const finalServers = await this.enrichWithCrossPlatformServers(
      slug,
      ep?.anime?.title,
      ep?.episodeNumber,
      samehadakuServers
    );

    await cacheService.set(cacheKey, finalServers, 86400 * 7);
    return finalServers;
  }

  /**
   * Lazy resolve actual embed URL for a specific server (Rule #28)
   * Redis -> cache? YES -> return; NO -> Lock -> Resolve -> Health-check -> Cache
   *
   * Cross-Platform Support:
   * 1. If Otakudesu server requested: resolves directly via OtakudesuScraper.
   * 2. If Samehadaku server requested: prioritizes Samehadaku.
   * 3. Automatic Fallback: If Samehadaku server is down or fails, automatically
   *    switches to a working stream server from Otakudesu so playback never fails.
   */
  public async resolveServerEmbed(episodeSlug: string, serverKey: string) {
    const cacheKey = `server:${episodeSlug}:${serverKey}`;
    const cached = await cacheService.get<any>(cacheKey);
    if (cached) {
      logger.debug({ episodeSlug, serverKey }, 'Serving resolved stream server from Redis cache');
      return cached;
    }

    // Deduplication via distributed lock (Rule #23, #28)
    const lockToken = await lockService.acquireLock(`server:${episodeSlug}:${serverKey}`, 15);
    if (!lockToken) {
      // Wait a short moment and check cache again
      await new Promise((r) => setTimeout(r, 1500));
      const doubleCheck = await cacheService.get<any>(cacheKey);
      if (doubleCheck) return doubleCheck;
    }

    try {
      const episode = await prisma.episode.findUnique({
        where: { slug: episodeSlug },
        include: { anime: { select: { title: true } } },
      });

      // 1. Direct Otakudesu server resolution
      if (serverKey.startsWith('otakudesu_')) {
        logger.info({ episodeSlug, serverKey }, 'Resolving Otakudesu stream server');
        if (episode?.anime?.title && episode.episodeNumber !== null) {
          const otakuServers = await otakudesuScraper.getEpisodeServers(
            episode.anime.title,
            episode.episodeNumber
          );
          const target = otakuServers.find(
            (s) => s.serverKey === serverKey || s.id === serverKey
          );
          if (target) {
            const otakuResolved = await otakudesuScraper.resolveServer(target);
            const responsePayload = {
              serverKey: otakuResolved.serverKey,
              name: otakuResolved.name,
              embedUrl: otakuResolved.embedUrl,
              serverProvider: otakuResolved.serverProvider,
              isReachable: otakuResolved.isReachable,
              source: 'otakudesu',
              resolvedAt: otakuResolved.resolvedAt,
            };
            const cacheTtl = otakuResolved.isReachable ? 3600 : 90;
            await cacheService.set(cacheKey, responsePayload, cacheTtl);
            return responsePayload;
          }
        }
        throw new Error(`Server ${serverKey} tidak ditemukan di Otakudesu untuk episode ${episodeSlug}`);
      }

      // 2. Primary: Resolve Samehadaku server
      logger.info({ episodeSlug, serverKey }, 'Resolving stream server embed from Samehadaku (Primary)');
      let samehadakuResolved: any = null;
      let samehadakuError: any = null;

      try {
        samehadakuResolved = await episodeScraper.resolveServer(episodeSlug, serverKey);
      } catch (err: any) {
        samehadakuError = err;
        logger.warn({ episodeSlug, serverKey, error: err.message }, 'Samehadaku server resolution failed');
      }

      let isReachable = false;
      let serverProvider: ServerProvider = 'unknown';

      if (samehadakuResolved?.embedUrl) {
        serverProvider = detectServerProvider(samehadakuResolved.embedUrl);
        isReachable = await checkEmbedReachable(samehadakuResolved.embedUrl);
      }

      // 3. Fallback: If Samehadaku is unreachable or failed, fallback to Otakudesu!
      if (!isReachable || samehadakuError) {
        logger.warn(
          { episodeSlug, serverKey, isReachable, error: samehadakuError?.message },
          'Samehadaku server unavailable — initiating automatic cross-platform fallback to Otakudesu'
        );

        if (episode?.anime?.title && episode.episodeNumber !== null) {
          try {
            const otakuServers = await otakudesuScraper.getEpisodeServers(
              episode.anime.title,
              episode.episodeNumber
            );

            for (const otakuOption of otakuServers) {
              try {
                const otakuResolved = await otakudesuScraper.resolveServer(otakuOption);
                if (otakuResolved.isReachable) {
                  logger.info(
                    {
                      episodeSlug,
                      serverKey,
                      otakuServer: otakuResolved.name,
                      embedUrl: otakuResolved.embedUrl,
                    },
                    'Successfully switched to Otakudesu stream server fallback'
                  );

                  const fallbackPayload = {
                    serverKey,
                    name: `${samehadakuResolved?.name || serverKey} (Otakudesu Fallback: ${otakuOption.name})`,
                    embedUrl: otakuResolved.embedUrl,
                    serverProvider: otakuResolved.serverProvider,
                    isReachable: true,
                    isFallback: true,
                    fallbackFrom: 'samehadaku',
                    fallbackTo: 'otakudesu',
                    fallbackServerKey: otakuResolved.serverKey,
                    resolvedAt: new Date().toISOString(),
                  };

                  await cacheService.set(cacheKey, fallbackPayload, 3600);
                  return fallbackPayload;
                }
              } catch (otakuErr: any) {
                logger.debug({ error: otakuErr.message }, 'Failed candidate Otakudesu fallback');
              }
            }
          } catch (fbErr: any) {
            logger.warn({ error: fbErr.message }, 'Failed searching Otakudesu fallback servers');
          }
        }

        // If fallback could not find a working server and Samehadaku had error, rethrow
        if (samehadakuError && !samehadakuResolved) {
          throw samehadakuError;
        }
      }

      // 4. Return Samehadaku payload
      const responsePayload = {
        serverKey: samehadakuResolved.serverKey,
        name: samehadakuResolved.name || serverKey,
        embedUrl: samehadakuResolved.embedUrl,
        serverProvider,
        isReachable,
        source: 'samehadaku',
        resolvedAt: new Date().toISOString(),
      };

      const cacheTtl = isReachable ? 3600 : 90;
      await cacheService.set(cacheKey, responsePayload, cacheTtl);

      // Persist in PostgreSQL stream_servers table (only if episode exists)
      if (episode) {
        await prisma.streamServer.upsert({
          where: {
            id: `${episode.id}_${serverKey}`,
          },
          create: {
            id: `${episode.id}_${serverKey}`,
            episodeId: episode.id,
            name: samehadakuResolved.name || serverKey,
            serverKey: samehadakuResolved.serverKey,
            embedUrl: samehadakuResolved.embedUrl,
            type: 'embed',
            expiresAt: new Date(Date.now() + cacheTtl * 1000),
          },
          update: {
            embedUrl: samehadakuResolved.embedUrl,
            expiresAt: new Date(Date.now() + cacheTtl * 1000),
          },
        });
      }

      return responsePayload;
    } finally {
      if (lockToken) {
        await lockService.releaseLock(`server:${episodeSlug}:${serverKey}`, lockToken);
      }
    }
  }

  /**
   * Sync single episode on demand if missing from database
   */
  private async syncAndGetEpisode(slug: string) {
    try {
      const scraped = await episodeScraper.scrape(slug);
      let animeId: string | null = null;

      if (scraped.animeSlug) {
        const anime = await prisma.anime.findUnique({ where: { slug: scraped.animeSlug } });
        if (anime) animeId = anime.id;
      }

      if (!animeId) {
        throw new EpisodeNotFoundError(slug);
      }

      const ep = await prisma.episode.upsert({
        where: { slug },
        create: {
          animeId,
          slug,
          episodeNumber: scraped.episodeNumber,
          title: scraped.title,
          sourceUrl: `https://v2.samehadaku.how/${slug}/`,
          lastSyncedAt: new Date(),
        },
        update: {
          episodeNumber: scraped.episodeNumber,
          title: scraped.title,
          lastSyncedAt: new Date(),
        },
        include: {
          anime: true,
          servers: true,
        },
      });

      return ep;
    } catch {
      throw new EpisodeNotFoundError(slug);
    }
  }
}

export const episodeService = new EpisodeService();
