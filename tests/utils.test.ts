import { describe, it, expect } from 'vitest';
import {
  buildHomeUrl,
  buildRecentUrl,
  buildAnimeUrl,
  buildEpisodeUrl,
  buildGenreUrl,
  buildBatchUrl,
  buildScheduleUrl,
  buildCatalogUrl,
  buildSearchUrl,
} from '../src/scraper/utils/url.builder.js';
import { ChangeDetector } from '../src/sync/change.detector.js';
import { CircuitBreaker } from '../src/resilience/circuit-breaker.js';
import { CircuitOpenError } from '../src/resilience/errors.js';

describe('Utility & Resilience Unit Tests', () => {
  describe('URL Builder', () => {
    it('constructs correct URLs for all site sections', () => {
      expect(buildHomeUrl()).toBe('https://v2.samehadaku.how/');
      expect(buildRecentUrl(1)).toBe('https://v2.samehadaku.how/anime-terbaru/');
      expect(buildRecentUrl(2)).toBe('https://v2.samehadaku.how/anime-terbaru/page/2/');
      expect(buildAnimeUrl('one-piece')).toBe('https://v2.samehadaku.how/anime/one-piece/');
      expect(buildEpisodeUrl('one-piece-episode-1179')).toBe('https://v2.samehadaku.how/one-piece-episode-1179/');
      expect(buildGenreUrl('action', 1)).toBe('https://v2.samehadaku.how/genre/action/');
      expect(buildGenreUrl('action', 3)).toBe('https://v2.samehadaku.how/genre/action/page/3/');
      expect(buildBatchUrl(1)).toBe('https://v2.samehadaku.how/daftar-batch/');
      expect(buildScheduleUrl()).toBe('https://v2.samehadaku.how/jadwal-rilis/');
      expect(buildSearchUrl('naruto')).toBe('https://v2.samehadaku.how/?s=naruto');
      expect(buildCatalogUrl({ page: 2, status: 'Ongoing' })).toContain('/daftar-anime-2/page/2/?status=Ongoing');
    });
  });

  describe('Change Detector & Safe Merge (Rule #18 & #41)', () => {
    it('generates consistent hashes for identical data', () => {
      const data = {
        title: 'One Piece',
        latestEpisode: '1179',
        status: 'Ongoing',
        episodeCount: 1179,
        score: 8.73,
      };

      const hash1 = ChangeDetector.computeHash(data);
      const hash2 = ChangeDetector.computeHash(data);
      expect(hash1).toBe(hash2);

      const modified = { ...data, latestEpisode: '1180' };
      const hash3 = ChangeDetector.computeHash(modified);
      expect(hash1).not.toBe(hash3);
    });

    it('preserves existing valid database fields when incoming field is null (Rule #41)', () => {
      const existing = {
        title: 'One Piece',
        score: 8.73,
        poster: 'https://img.test/op.jpg',
        studio: 'Toei Animation',
      };

      const incoming = {
        title: 'One Piece',
        score: null, // Scraper failed or returned null
        poster: null,
      };

      const merged = ChangeDetector.mergeSafe(existing, incoming);
      // Valid score and poster must be preserved!
      expect(merged.score).toBe(8.73);
      expect(merged.poster).toBe('https://img.test/op.jpg');
      expect(merged.studio).toBe('Toei Animation');
    });
  });

  describe('Circuit Breaker (Rule #25)', () => {
    it('opens after threshold failures and cools down', () => {
      const breaker = new CircuitBreaker(3, 1);
      expect(breaker.getState()).toBe('CLOSED');

      breaker.recordFailure(new Error('fail 1'));
      expect(breaker.getState()).toBe('CLOSED');

      breaker.recordFailure(new Error('fail 2'));
      expect(breaker.getState()).toBe('CLOSED');

      breaker.recordFailure(new Error('fail 3'));
      expect(breaker.getState()).toBe('OPEN');

      // Availability check should throw CircuitOpenError
      expect(() => breaker.checkAvailability()).toThrow(CircuitOpenError);

      breaker.recordSuccess();
      expect(breaker.getState()).toBe('CLOSED');
    });
  });
});
