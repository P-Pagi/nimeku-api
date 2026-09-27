import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseHomeHtml } from '../src/scraper/parsers/home.parser.js';
import { parseAnimeHtml } from '../src/scraper/parsers/anime.parser.js';
import { parseEpisodeHtml } from '../src/scraper/parsers/episode.parser.js';
import { parseStreamServerEmbed } from '../src/scraper/parsers/server.parser.js';
import { parseCatalogHtml, parseGenreListHtml } from '../src/scraper/parsers/genre.parser.js';
import { parseScheduleHtml, parseScheduleJson } from '../src/scraper/parsers/schedule.parser.js';
import { parseBatchListHtml } from '../src/scraper/parsers/batch.parser.js';

const fixturesDir = path.resolve(__dirname, 'fixtures');

function loadFixture(filename: string): string {
  return fs.readFileSync(path.join(fixturesDir, filename), 'utf-8');
}

describe('Offline HTML Parsers Unit Tests', () => {
  it('Home Parser parses top10 and recent episodes without internet', () => {
    const html = loadFixture('home.html');
    const result = parseHomeHtml(html);

    expect(result.isDegraded).toBe(false);
    expect(result.top10.length).toBeGreaterThan(0);
    expect(result.top10[0]?.title).toBeTruthy();
    expect(result.top10[0]?.slug).toBeTruthy();

    expect(result.recentEpisodes.length).toBeGreaterThan(0);
    const firstRecent = result.recentEpisodes[0];
    expect(firstRecent?.title).toBeTruthy();
    expect(firstRecent?.animeSlug).toBeTruthy();
    expect(firstRecent?.episodeNumber).toBeTruthy();
  });

  it('Anime Detail Parser extracts metadata and episode list', () => {
    const html = loadFixture('anime-detail.html');
    const result = parseAnimeHtml(html, 'one-piece', 'https://v2.samehadaku.how/anime/one-piece/');

    expect(result.isDegraded).toBe(false);
    expect(result.title).toBe('One Piece');
    expect(result.status).toBe('Ongoing');
    expect(result.type).toBe('TV');
    expect(result.studio).toBe('Toei Animation');
    expect(result.score).toBeGreaterThan(8);
    expect(result.genres.length).toBeGreaterThan(0);
    expect(result.genres.some((g) => g.name === 'Action')).toBe(true);

    expect(result.episodes.length).toBeGreaterThan(100);
    const latestEp = result.episodes[0];
    expect(latestEp?.slug).toContain('one-piece-episode');
    expect(latestEp?.episodeNumber).toBeGreaterThan(1000);
  });

  it('Episode Detail Parser extracts servers and download links', () => {
    const html = loadFixture('episode.html');
    const result = parseEpisodeHtml(html, 'one-piece-episode-1179');

    expect(result.isDegraded).toBe(false);
    expect(result.title).toContain('One Piece Episode 1179');
    expect(result.episodeNumber).toBe(1179);
    expect(result.animeSlug).toBe('one-piece');
    expect(result.previousEpisodeSlug).toContain('1178');

    expect(result.servers.length).toBeGreaterThan(0);
    const firstServer = result.servers[0];
    expect(firstServer?.post).toBeTruthy();
    expect(firstServer?.nume).toBeTruthy();

    expect(result.downloads.length).toBeGreaterThan(0);
  });

  it('Stream Server Parser extracts iframe embed url from raw html', () => {
    const rawHtml = '<iframe src="https://www.blogger.com/video.g?token=AD6v5dxd2soq" frameborder="0"></iframe>';
    const result = parseStreamServerEmbed(rawHtml, 'player-option-1');

    expect(result.serverKey).toBe('player-option-1');
    expect(result.embedUrl).toBe('https://www.blogger.com/video.g?token=AD6v5dxd2soq');
  });

  it('Catalog & Genre Parser extracts anime cards and pagination', () => {
    const html = loadFixture('catalog.html');
    const result = parseCatalogHtml(html, 1);

    expect(result.isDegraded).toBe(false);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0]?.title).toBeTruthy();
    expect(result.items[0]?.slug).toBeTruthy();
    expect(result.pagination.totalPages).toBeGreaterThanOrEqual(1);

    const genres = parseGenreListHtml(html);
    expect(genres.length).toBeGreaterThan(5);
    expect(genres.some((g) => g.slug === 'action')).toBe(true);
  });

  it('Schedule Parser parses JSON and HTML formats', () => {
    const jsonSample = [
      {
        id: 49433,
        slug: 'mao',
        title: 'Mao',
        url: 'https://v2.samehadaku.how/anime/mao/',
        featured_img_src: 'https://img.test/mao.jpg',
        genre: 'Historical, Mystery',
        east_score: '7.1',
        east_type: 'TV',
        east_schedule: 'Sunday',
        east_time: '02:30',
      },
    ];

    const jsonItems = parseScheduleJson(jsonSample, 'sunday');
    expect(jsonItems.length).toBe(1);
    expect(jsonItems[0]?.animeSlug).toBe('mao');
    expect(jsonItems[0]?.day).toBe('Sunday');
    expect(jsonItems[0]?.score).toBe(7.1);

    const html = loadFixture('schedule.html');
    const htmlItems = parseScheduleHtml(html);
    expect(htmlItems.length).toBeGreaterThan(0);
  });

  it('Batch Parser extracts batch download cards', () => {
    const html = loadFixture('batch.html');
    const result = parseBatchListHtml(html, 1);

    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0]?.title).toBeTruthy();
    expect(result.items[0]?.slug).toBeTruthy();
  });
});
