import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { prisma } from '../db/prisma.js';
import { logger } from '../config/logger.js';
import { crossReferenceService } from './cross-reference.service.js';
import { cacheService } from '../cache/cache.service.js';

const execFileAsync = promisify(execFile);

export class PosterService {
  private posterDir: string;

  constructor() {
    this.posterDir = path.resolve(process.cwd(), 'public', 'posters');
    if (!fs.existsSync(this.posterDir)) {
      fs.mkdirSync(this.posterDir, { recursive: true });
    }
  }

  /**
   * Check if file exists and has valid image magic bytes (not HTML/text/corrupt)
   */
  public isRealImageFile(filePath: string): boolean {
    if (!fs.existsSync(filePath)) return false;
    try {
      const stats = fs.statSync(filePath);
      if (stats.size < 500) return false;

      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(16);
      fs.readSync(fd, buf, 0, 16, 0);
      fs.closeSync(fd);

      // JPEG: FF D8 FF
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
      // PNG: 89 50 4E 47
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
      // GIF: GIF87a / GIF89a
      if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
      // WEBP: RIFF....WEBP
      if (
        buf[0] === 0x52 &&
        buf[1] === 0x49 &&
        buf[2] === 0x46 &&
        buf[3] === 0x46 &&
        buf.toString('ascii', 8, 12) === 'WEBP'
      ) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Sanitize slug for safe filename across all operating systems
   */
  public getSafeFilename(slug: string, remoteUrl: string): string {
    const cleanSlug = slug.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    
    // Extract extension
    let ext = 'jpg';
    try {
      const pathname = new URL(remoteUrl).pathname;
      const match = pathname.match(/\.(jpg|jpeg|png|webp|gif)$/i);
      if (match) {
        ext = match[1].toLowerCase();
      }
    } catch {
      // Use default jpg
    }

    return `${cleanSlug}.${ext}`;
  }

  /**
   * Get the served local URL path (e.g. /public/posters/one-piece.jpg)
   */
  public getLocalUrl(filename: string): string {
    return `/public/posters/${filename}`;
  }

  /**
   * Download a single poster by URL and anime slug
   * Returns the local served URL (/public/posters/{slug}.{ext}) or null on failure
   */
  public async downloadPoster(remoteUrl: string, slug: string): Promise<string | null> {
    if (!remoteUrl || !remoteUrl.startsWith('http')) {
      return null;
    }

    const filename = this.getSafeFilename(slug, remoteUrl);
    const destinationPath = path.join(this.posterDir, filename);
    const localUrl = this.getLocalUrl(filename);

    // If file already exists and is a valid image, return localUrl
    if (fs.existsSync(destinationPath)) {
      if (this.isRealImageFile(destinationPath)) {
        return localUrl;
      }
      try {
        fs.unlinkSync(destinationPath);
      } catch {}
    }

    // Try downloading via standard fetch
    try {
      const response = await fetch(remoteUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
          Referer: 'https://v2.samehadaku.how/',
        },
      });

      if (response.ok && response.body) {
        const fileStream = fs.createWriteStream(destinationPath);
        // @ts-ignore - ReadableStream conversion
        await pipeline(response.body, fileStream);

        // Verify written file is a real image
        if (this.isRealImageFile(destinationPath)) {
          logger.debug({ slug, localUrl }, 'Poster downloaded successfully via fetch');
          return localUrl;
        }
        try {
          fs.unlinkSync(destinationPath);
        } catch {}
      }
    } catch (err: any) {
      logger.warn({ slug, error: err.message }, 'Fetch failed for poster download, trying curl fallback');
    }

    // Fallback: curl.exe
    try {
      await execFileAsync('curl.exe', [
        '-s',
        '-L',
        '-A',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        '-e',
        'https://v2.samehadaku.how/',
        '-o',
        destinationPath,
        remoteUrl,
      ]);

      if (this.isRealImageFile(destinationPath)) {
        logger.debug({ slug, localUrl }, 'Poster downloaded successfully via curl');
        return localUrl;
      }
      // Cleanup 0 byte, corrupt, or HTML file
      if (fs.existsSync(destinationPath)) {
        fs.unlinkSync(destinationPath);
      }
    } catch (err: any) {
      logger.error({ slug, remoteUrl, error: err.message }, 'Failed to download poster');
    }

    return null;
  }

  /**
   * Ensure an anime has its poster downloaded and posterLocal updated in DB.
   * If local poster is missing/corrupted or poster URL is null, searches cross-platform (Kitsu, AniList, Jikan).
   */
  public async ensurePoster(anime: {
    id: string;
    slug: string;
    title?: string;
    alternativeTitle?: string | null;
    japaneseTitle?: string | null;
    poster?: string | null;
    posterLocal?: string | null;
  }): Promise<string | null> {
    // 1. Check if posterLocal file already exists on disk and is a real image
    if (anime.posterLocal) {
      const filename = path.basename(anime.posterLocal);
      const filePath = path.join(this.posterDir, filename);
      if (this.isRealImageFile(filePath)) {
        if (anime.poster !== anime.posterLocal) {
          await prisma.anime.update({
            where: { id: anime.id },
            data: { poster: anime.posterLocal } as any,
          });
        }
        return anime.posterLocal;
      } else {
        // File exists but is corrupt/HTML
        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch {}
        }
      }
    }

    let localUrl: string | null = null;

    // 2. Try downloading existing remote poster if it starts with http
    if (anime.poster && anime.poster.startsWith('http')) {
      localUrl = await this.downloadPoster(anime.poster, anime.slug);
    }

    // 3. If no poster or download failed, search cross-platform (Kitsu, AniList, Jikan)
    if (!localUrl) {
      logger.info({ slug: anime.slug, title: anime.title }, 'Searching cross-platform for anime poster');
      const searchTitle = anime.title || anime.slug.replace(/-/g, ' ');
      const crossUrl = await crossReferenceService.fetchPoster(
        searchTitle,
        anime.alternativeTitle,
        anime.japaneseTitle
      );

      if (crossUrl) {
        logger.info({ slug: anime.slug, crossUrl }, 'Found cross-platform poster URL, downloading');
        localUrl = await this.downloadPoster(crossUrl, anime.slug);
      }
    }

    // 4. If successfully downloaded, update database and invalidate cache
    if (localUrl) {
      await prisma.anime.update({
        where: { id: anime.id },
        data: {
          poster: localUrl,
          posterLocal: localUrl,
        } as any,
      });
      await cacheService.invalidateAnime(anime.slug);
      return localUrl;
    }

    return null;
  }
}

export const posterService = new PosterService();
