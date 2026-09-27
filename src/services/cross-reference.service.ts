import { logger } from '../config/logger.js';

export interface EnrichedAnimeMetadata {
  rating?: string | null;
  totalEpisodes?: number | null;
  duration?: string | null;
  season?: string | null;
  releaseYear?: number | null;
  studio?: string | null;
  producers?: string | null;
  matchedTitle?: string | null;
  source: 'kitsu' | 'jikan' | null;
}

export class CrossReferenceService {
  /**
   * Derive anime season (e.g. "Fall 2024") from date string.
   * Supports ISO format ("2024-10-20") or text ("Oct 20, 2024", "20 Oktober 2024").
   */
  public deriveSeason(dateStr?: string | null): string | null {
    if (!dateStr || typeof dateStr !== 'string') return null;

    // ISO format: YYYY-MM-DD
    const isoMatch = dateStr.match(/^(\d{4})-(\d{2})/);
    if (isoMatch) {
      const year = parseInt(isoMatch[1], 10);
      const month = parseInt(isoMatch[2], 10);
      return this.formatSeasonByMonth(month, year);
    }

    // Text format containing year
    const yearMatch = dateStr.match(/\b(19\d\d|20\d\d)\b/);
    if (!yearMatch) return null;
    const year = parseInt(yearMatch[1], 10);

    const monthMap: Record<string, number> = {
      jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, may: 5, jun: 6,
      jul: 7, agu: 8, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12
    };

    const lower = dateStr.toLowerCase();
    for (const [key, m] of Object.entries(monthMap)) {
      if (lower.includes(key)) {
        return this.formatSeasonByMonth(m, year);
      }
    }

    return null;
  }

  private formatSeasonByMonth(month: number, year: number): string {
    if (month >= 1 && month <= 3) return `Winter ${year}`;
    if (month >= 4 && month <= 6) return `Spring ${year}`;
    if (month >= 7 && month <= 9) return `Summer ${year}`;
    return `Fall ${year}`;
  }

  /**
   * Format duration minutes into readable string e.g. "24 min." or "1 hr. 50 min."
   */
  public formatDuration(minutes?: number | null): string | null {
    if (!minutes || minutes <= 0) return null;
    if (minutes < 60) return `${minutes} min.`;
    const hrs = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return rem > 0 ? `${hrs} hr. ${rem} min.` : `${hrs} hr.`;
  }

  /**
   * Generate title search variations to maximize match rate
   */
  public generateTitleVariations(title: string): string[] {
    const variations: string[] = [title.trim()];

    // 1. Remove season / part / cour patterns
    const withoutSeason = title
      .replace(/Season\s*\d+/gi, '')
      .replace(/Cour\s*\d+/gi, '')
      .replace(/Part\s*\d+/gi, '')
      .replace(/2nd\s*Season/gi, '')
      .replace(/3rd\s*Season/gi, '')
      .replace(/4th\s*Season/gi, '')
      .replace(/Final\s*Season/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (withoutSeason && withoutSeason !== title.trim()) {
      variations.push(withoutSeason);
    }

    // 2. Remove subtitle after colon
    if (title.includes(':')) {
      const mainTitle = title.split(':')[0].trim();
      if (mainTitle && !variations.includes(mainTitle)) {
        variations.push(mainTitle);
      }
    }

    // 3. Remove subtitle after dash
    if (title.includes(' - ')) {
      const mainTitle = title.split(' - ')[0].trim();
      if (mainTitle && !variations.includes(mainTitle)) {
        variations.push(mainTitle);
      }
    }

    // 4. Remove brackets/parentheses content
    const withoutBrackets = title.replace(/\([^)]*\)|\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
    if (withoutBrackets && !variations.includes(withoutBrackets)) {
      variations.push(withoutBrackets);
    }

    return variations;
  }

  /**
   * Format Kitsu ageRating & ageRatingGuide into standard rating string
   */
  public formatRating(ageRating?: string | null, ageRatingGuide?: string | null): string | null {
    if (!ageRating && !ageRatingGuide) return null;
    const rating = (ageRating || '').trim().toUpperCase();
    const guide = (ageRatingGuide || '').trim();

    if (rating === 'PG' && (/13/i.test(guide) || /teen/i.test(guide))) {
      return 'PG-13 - Teens 13 or older';
    }
    if (rating === 'PG') {
      return guide ? `PG - ${guide}` : 'PG - Children';
    }
    if (rating === 'G') {
      return guide ? `G - ${guide}` : 'G - All Ages';
    }
    if (rating === 'R' || rating === 'R17' || rating === 'R-17') {
      const cleanGuide = guide ? guide.replace(/^17\+?\s*\(?/i, '').replace(/\)$/, '').trim() : 'violence & profanity';
      return `R - 17+ (${cleanGuide})`;
    }
    if (rating === 'R18' || rating === 'R-18' || rating === 'RX') {
      return guide ? `R+ - ${guide}` : 'R+ - Mild Nudity';
    }

    if (rating && guide) return `${rating} - ${guide}`;
    return rating || guide || null;
  }

  /**
   * Fetch rich anime info from Kitsu API
   */
  private async fetchKitsu(query: string): Promise<EnrichedAnimeMetadata | null> {
    const url = `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(query)}&page[limit]=1`;
    try {
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/vnd.api+json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
        signal: AbortSignal.timeout(6000),
      });

      if (!res.ok) return null;
      const data = await res.json();
      const item = data.data?.[0]?.attributes;
      if (!item) return null;

      const rating = this.formatRating(item.ageRating, item.ageRatingGuide);
      const totalEpisodes = typeof item.episodeCount === 'number' && item.episodeCount > 0 ? item.episodeCount : null;
      const duration = this.formatDuration(item.episodeLength);
      const season = this.deriveSeason(item.startDate);
      const releaseYear = item.startDate ? parseInt(item.startDate.substring(0, 4), 10) : null;

      return {
        rating,
        totalEpisodes,
        duration,
        season,
        releaseYear: isNaN(releaseYear as number) ? null : releaseYear,
        matchedTitle: item.canonicalTitle || item.titles?.en || item.titles?.en_jp || query,
        source: 'kitsu',
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetch anime info from Jikan (MyAnimeList) API as fallback
   */
  private async fetchJikan(query: string): Promise<EnrichedAnimeMetadata | null> {
    const url = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=1`;
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
        signal: AbortSignal.timeout(6000),
      });

      if (!res.ok) return null;
      const data = await res.json();
      const item = data.data?.[0];
      if (!item) return null;

      const studios = item.studios?.map((s: any) => s.name).join(', ') || null;
      const producers = item.producers?.map((p: any) => p.name).join(', ') || null;
      const season = item.season && item.year ? `${item.season.charAt(0).toUpperCase() + item.season.slice(1)} ${item.year}` : null;

      return {
        rating: item.rating || null,
        totalEpisodes: item.episodes || null,
        duration: item.duration || null,
        season,
        releaseYear: item.year || null,
        studio: studios,
        producers,
        matchedTitle: item.title,
        source: 'jikan',
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetch studio and producer info from AniList GraphQL API
   */
  public async fetchAniList(query: string): Promise<{ studio: string | null; producers: string | null } | null> {
    const gql = `
      query ($search: String) {
        Media (search: $search, type: ANIME) {
          studios {
            edges {
              isMain
              node {
                name
              }
            }
          }
        }
      }
    `;

    try {
      const res = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
        body: JSON.stringify({ query: gql, variables: { search: query } }),
        signal: AbortSignal.timeout(6000),
      });

      if (!res.ok) return null;
      const data = await res.json();
      const edges = data.data?.Media?.studios?.edges;
      if (!edges || !Array.isArray(edges)) return null;

      const mainStudios = edges.filter((e: any) => e.isMain).map((e: any) => e.node.name).join(', ') || null;
      const producerList = edges.filter((e: any) => !e.isMain).map((e: any) => e.node.name).join(', ') || null;

      return {
        studio: mainStudios,
        producers: producerList || mainStudios,
      };
    } catch {
      return null;
    }
  }

  /**
   * Cross-reference anime to get all enriched metadata (rating, totalEpisodes, duration, season, studio, producers, etc.)
   */
  public async getEnrichedMetadata(
    title: string,
    alternativeTitle?: string | null,
    japaneseTitle?: string | null
  ): Promise<EnrichedAnimeMetadata | null> {
    const queries: string[] = [
      ...this.generateTitleVariations(title),
      ...(alternativeTitle ? this.generateTitleVariations(alternativeTitle) : []),
      ...(japaneseTitle ? [japaneseTitle.trim()] : []),
    ];

    const uniqueQueries = Array.from(new Set(queries.filter(Boolean)));
    let result: EnrichedAnimeMetadata | null = null;

    // 1. Try Kitsu first (fast, rich metadata, highly reliable)
    for (const q of uniqueQueries) {
      result = await this.fetchKitsu(q);
      if (result && (result.rating || result.totalEpisodes || result.duration || result.season)) {
        logger.debug(
          { title, matched: result.matchedTitle, metadata: result, source: 'kitsu' },
          'Enriched metadata found via Kitsu'
        );
        break;
      }
    }

    // 2. Try Jikan as fallback if Kitsu failed
    if (!result) {
      for (const q of uniqueQueries.slice(0, 2)) {
        result = await this.fetchJikan(q);
        if (result && (result.rating || result.totalEpisodes || result.studio)) {
          logger.debug(
            { title, matched: result.matchedTitle, metadata: result, source: 'jikan' },
            'Enriched metadata found via Jikan'
          );
          break;
        }
      }
    }

    // 3. Enrich studio and producers via AniList if missing
    if (!result?.studio || !result?.producers) {
      for (const q of uniqueQueries.slice(0, 2)) {
        const aniListData = await this.fetchAniList(q);
        if (aniListData) {
          if (!result) {
            result = { source: 'kitsu', matchedTitle: q };
          }
          if (!result.studio && aniListData.studio) result.studio = aniListData.studio;
          if (!result.producers && aniListData.producers) result.producers = aniListData.producers;
          break;
        }
      }
    }

    return result;
  }

  /**
   * Backward-compatible rating retriever
   */
  public async getAnimeRating(
    title: string,
    alternativeTitle?: string | null,
    japaneseTitle?: string | null
  ): Promise<string | null> {
    const meta = await this.getEnrichedMetadata(title, alternativeTitle, japaneseTitle);
    return meta?.rating || null;
  }

  /**
   * Fetch episode thumbnail across external platforms (Kitsu -> AniList)
   */
  public async fetchEpisodeThumbnail(animeTitle: string, episodeNumber: number): Promise<string | null> {
    const cleanTitle = animeTitle.trim();
    if (!cleanTitle || episodeNumber == null || isNaN(episodeNumber)) return null;

    // 1. Try Kitsu (fastest & high-res original episode thumbnails)
    try {
      const searchUrl = `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(cleanTitle)}&page[limit]=1`;
      const searchRes = await fetch(searchUrl, {
        headers: { Accept: 'application/vnd.api+json', 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(5000),
      });
      if (searchRes.ok) {
        const searchData = await searchRes.json();
        const kitsuId = searchData.data?.[0]?.id;
        if (kitsuId) {
          const epUrl = `https://kitsu.io/api/edge/episodes?filter[mediaId]=${kitsuId}&filter[number]=${episodeNumber}`;
          const epRes = await fetch(epUrl, {
            headers: { Accept: 'application/vnd.api+json', 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(5000),
          });
          if (epRes.ok) {
            const epData = await epRes.json();
            const thumb = epData.data?.[0]?.attributes?.thumbnail?.original;
            if (thumb) return thumb;
          }
        }
      }
    } catch (err: any) {
      logger.debug({ title: cleanTitle, ep: episodeNumber, error: err.message }, 'Kitsu episode thumbnail lookup failed');
    }

    // 2. Try AniList GraphQL
    try {
      const gql = `
        query ($search: String) {
          Media (search: $search, type: ANIME) {
            streamingEpisodes {
              title
              thumbnail
            }
          }
        }
      `;
      const res = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({ query: gql, variables: { search: cleanTitle } }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        const episodes = data.data?.Media?.streamingEpisodes || [];
        const match = episodes.find((ep: any) => {
          const numMatch = ep.title?.match(/Episode\s*(\d+(\.\d+)?)/i);
          return numMatch && parseFloat(numMatch[1]) === episodeNumber;
        });
        if (match?.thumbnail) return match.thumbnail;
      }
    } catch (err: any) {
      logger.debug({ title: cleanTitle, ep: episodeNumber, error: err.message }, 'AniList episode thumbnail lookup failed');
    }

    return null;
  }

  /**
   * Fetch anime poster from Kitsu
   */
  public async fetchPosterKitsu(query: string): Promise<string | null> {
    try {
      const url = `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(query)}&page[limit]=1`;
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/vnd.api+json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const poster = data.data?.[0]?.attributes?.posterImage;
      return poster?.large || poster?.original || poster?.medium || null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch anime poster from AniList GraphQL
   */
  public async fetchPosterAniList(query: string): Promise<string | null> {
    const gql = `
      query ($search: String) {
        Media (search: $search, type: ANIME) {
          coverImage {
            extraLarge
            large
            medium
          }
        }
      }
    `;
    try {
      const res = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
        body: JSON.stringify({ query: gql, variables: { search: query } }),
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const cover = data.data?.Media?.coverImage;
      return cover?.extraLarge || cover?.large || cover?.medium || null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch anime poster from Jikan (MyAnimeList)
   */
  public async fetchPosterJikan(query: string): Promise<string | null> {
    try {
      const url = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=1`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const images = data.data?.[0]?.images;
      return images?.webp?.large_image_url || images?.jpg?.large_image_url || images?.jpg?.image_url || null;
    } catch {
      return null;
    }
  }

  /**
   * Cross-reference poster lookup across Kitsu -> AniList -> Jikan
   */
  public async fetchPoster(
    title: string,
    alternativeTitle?: string | null,
    japaneseTitle?: string | null
  ): Promise<string | null> {
    const queries = Array.from(
      new Set(
        [
          ...this.generateTitleVariations(title),
          ...(alternativeTitle ? this.generateTitleVariations(alternativeTitle) : []),
          ...(japaneseTitle ? [japaneseTitle.trim()] : []),
        ].filter(Boolean)
      )
    );

    // 1. Try Kitsu
    for (const q of queries) {
      const poster = await this.fetchPosterKitsu(q);
      if (poster) {
        logger.info({ title, query: q, poster, source: 'kitsu' }, 'Found poster via Kitsu');
        return poster;
      }
    }

    // 2. Try AniList
    for (const q of queries.slice(0, 3)) {
      const poster = await this.fetchPosterAniList(q);
      if (poster) {
        logger.info({ title, query: q, poster, source: 'anilist' }, 'Found poster via AniList');
        return poster;
      }
    }

    // 3. Try Jikan
    for (const q of queries.slice(0, 2)) {
      const poster = await this.fetchPosterJikan(q);
      if (poster) {
        logger.info({ title, query: q, poster, source: 'jikan' }, 'Found poster via Jikan');
        return poster;
      }
    }

    return null;
  }
}

export const crossReferenceService = new CrossReferenceService();
