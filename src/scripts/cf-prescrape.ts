/**
 * cf-prescrape.ts — Pre-scraper menggunakan visible Chrome untuk bypass Cloudflare.
 *
 * Strategi:
 * 1. Buka visible Chrome (non-headless) — Cloudflare tidak memblokir ini
 * 2. Crawl semua 26 halaman katalog → extract slug + metadata dasar
 * 3. Crawl setiap detail anime → extract synopsis, genres, episodes
 * 4. Simpan semua ke file JSON lokal (cache/)
 * 5. Jalankan: npm run sync:cache untuk import dari file JSON ke DB
 *
 * Tidak perlu Playwright headless, tidak perlu cf_clearance cookie.
 *
 * Usage: npx tsx src/scripts/cf-prescrape.ts
 *   Options:
 *     --catalog-only   Hanya scrape halaman katalog (cepat, ~2 menit)
 *     --from-page=N    Mulai dari halaman katalog ke-N (resume)
 *     --max-pages=N    Maksimal N halaman katalog
 */
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import * as cheerio from 'cheerio';

dotenv.config();

const BASE_URL = process.env.SOURCE_BASE_URL || 'https://v2.samehadaku.how';
const USER_DATA_DIR = process.env.PLAYWRIGHT_USER_DATA_DIR || 'D:/NextJs/crawl/.chrome-profile';
const CACHE_DIR = path.resolve('cache');
const CATALOG_CACHE = path.join(CACHE_DIR, 'catalog.json');
const DETAILS_CACHE = path.join(CACHE_DIR, 'details.json');

const args = process.argv.slice(2);
const catalogOnly = args.includes('--catalog-only');
const fromPage = parseInt(args.find(a => a.startsWith('--from-page='))?.split('=')[1] || '1');
const maxPages = parseInt(args.find(a => a.startsWith('--max-pages='))?.split('=')[1] || '26');

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

interface CatalogItem {
  slug: string;
  title: string;
  poster: string | null;
  type: string | null;
  score: number | null;
  status: string | null;
  url: string;
}

interface DetailItem {
  slug: string;
  title: string;
  alternativeTitle: string | null;
  japaneseTitle: string | null;
  poster: string | null;
  synopsis: string | null;
  status: string | null;
  type: string | null;
  score: number | null;
  rating: string | null;
  duration: string | null;
  totalEpisodes: number | null;
  season: string | null;
  releaseYear: number | null;
  studio: string | null;
  producers: string | null;
  releasedAt: string | null;
  sourceUrl: string;
  genres: Array<{ name: string; slug: string }>;
  episodes: Array<{ slug: string; episodeNumber: number | null; title: string; url: string; releasedAt: string | null }>;
}

function parseCatalogHtml(html: string): CatalogItem[] {
  const $ = cheerio.load(html);
  const items: CatalogItem[] = [];

  $('.listupd .bs, .listupd .bsx, .animpost').each((_, el) => {
    const a = $(el).find('a').first();
    const href = a.attr('href') || '';
    const slugMatch = href.match(/\/anime\/([^/]+)/);
    if (!slugMatch) return;
    const slug = slugMatch[1];

    const title = $(el).find('h2, .tt, .animposting h4').first().text().trim()
      || a.attr('title') || '';
    const poster = $(el).find('img').first().attr('src')
      || $(el).find('img').first().attr('data-src') || null;
    const typeText = $(el).find('.typez, .tipo').text().trim() || null;
    const scoreText = $(el).find('.numscore, .score').text().trim();
    const score = parseFloat(scoreText) || null;
    const statusText = $(el).find('.status').text().trim() || null;

    if (slug && title) {
      items.push({ slug, title, poster, type: typeText, score, status: statusText, url: href });
    }
  });

  return items;
}

function parseDetailHtml(html: string, slug: string): DetailItem | null {
  const $ = cheerio.load(html);

  const rawTitle = $('h1.entry-title, .animando h1, h1.title').first().text().trim();
  const cleanTitle = rawTitle.replace(/\s*Sub\s*Indo.*$/i, '').trim();
  if (!cleanTitle) return null;

  const posterImg = $('.thumb img, .anime-img img').first();
  const poster = posterImg.attr('src') || posterImg.attr('data-src') || null;

  // Synopsis
  $('.desc, .sinopsis').find('script, style, ins, .ads, [hidden]').remove();
  const synopsisParagraphs: string[] = [];
  $('.desc p, .sinopsis p').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text && !/^nonton streaming/i.test(text) && !/^download/i.test(text)) {
      synopsisParagraphs.push(text);
    }
  });
  let synopsis: string | null = synopsisParagraphs.join('\n\n') || null;
  if (!synopsis) {
    const raw = $('.desc, .sinopsis').text().replace(/\s+/g, ' ').trim();
    synopsis = raw.replace(/^Nonton Streaming anime[\s\S]*?(terbaru di Samehadaku!?|Samehadaku!)\s*/i, '').trim() || null;
  }

  // Score
  const scoreText = $('.score, .rating span').first().text().trim();
  const score = parseFloat(scoreText.match(/(\d+\.?\d*)/)?.[1] || '') || null;

  // Genres
  const genres: Array<{ name: string; slug: string }> = [];
  $('.genre-info a, .genres a, [itemprop="genre"] a').each((_, el) => {
    const name = $(el).text().trim();
    const href = $(el).attr('href') || '';
    const genreSlug = href.match(/\/genre\/([^/]+)/)?.[1] || name.toLowerCase().replace(/\s+/g, '-');
    if (name && genreSlug) genres.push({ name, slug: genreSlug });
  });

  // Metadata
  const meta: Record<string, string | null> = {};
  let totalEpisodes: number | null = null;

  $('.spe span, .infox span').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (/^Japanese/i.test(text)) meta.japaneseTitle = text.replace(/^Japanese\s*:?\s*/i, '').trim();
    else if (/^(English|Synonyms)/i.test(text)) meta.alternativeTitle = text.replace(/^(English|Synonyms)\s*:?\s*/i, '').trim();
    else if (/^Status/i.test(text)) meta.status = text.replace(/^Status\s*:?\s*/i, '').trim();
    else if (/^Type/i.test(text)) meta.type = text.replace(/^Type\s*:?\s*/i, '').trim();
    else if (/^Duration/i.test(text)) meta.duration = text.replace(/^Duration\s*:?\s*/i, '').trim();
    else if (/^Total\s*Episode/i.test(text)) {
      totalEpisodes = parseInt(text.replace(/^Total\s*Episode\s*:?\s*/i, '')) || null;
    } else if (/^Season/i.test(text)) meta.season = text.replace(/^Season\s*:?\s*/i, '').trim();
    else if (/^Studio/i.test(text)) meta.studio = text.replace(/^Studio\s*:?\s*/i, '').trim();
    else if (/^Producers/i.test(text)) meta.producers = text.replace(/^Producers\s*:?\s*/i, '').trim();
    else if (/^Released/i.test(text)) meta.releasedAt = text.replace(/^Released\s*:?\s*/i, '').trim();
    else if (/^Rating/i.test(text)) meta.rating = text.replace(/^Rating\s*:?\s*/i, '').trim();
  });

  let releaseYear: number | null = null;
  if (meta.season) { const m = meta.season.match(/\b(19\d\d|20\d\d)\b/); if (m) releaseYear = parseInt(m[1]); }
  if (!releaseYear && meta.releasedAt) { const m = meta.releasedAt?.match(/\b(19\d\d|20\d\d)\b/); if (m) releaseYear = parseInt(m[1]); }

  // Episodes
  const episodes: DetailItem['episodes'] = [];
  $('.episodelist li, #episodelist li').each((_, el) => {
    const linkEl = $(el).find('a').first();
    const href = linkEl.attr('href') || '';
    const epSlug = href.match(/\/([^/]+?)\/?$/)?.[1] || '';
    const rawTitle = linkEl.text().trim();
    const numMatch = rawTitle.match(/Episode\s*(\d+(\.\d+)?)/i) || href.match(/episode-(\d+(\.\d+)?)/i);
    const episodeNumber = numMatch ? parseFloat(numMatch[1]) : null;
    const dateText = $(el).find('.date, .epsdate').text().trim() || null;
    if (epSlug && href) {
      episodes.push({ slug: epSlug, episodeNumber, title: rawTitle || `Episode ${episodeNumber ?? ''}`, url: href, releasedAt: dateText });
    }
  });

  return {
    slug,
    title: cleanTitle,
    alternativeTitle: meta.alternativeTitle || null,
    japaneseTitle: meta.japaneseTitle || null,
    poster,
    synopsis,
    status: meta.status || null,
    type: meta.type || null,
    score,
    rating: meta.rating || null,
    duration: meta.duration || null,
    totalEpisodes,
    season: meta.season || null,
    releaseYear,
    studio: meta.studio || null,
    producers: meta.producers || null,
    releasedAt: meta.releasedAt || null,
    sourceUrl: `${BASE_URL}/anime/${slug}/`,
    genres,
    episodes,
  };
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  // @ts-ignore
  const { chromium } = await import('playwright');

  console.log('');
  console.log('==========================================================');
  console.log('  SAMEHADAKU PRE-SCRAPER (Visible Chrome)');
  console.log('==========================================================');
  console.log(`  Base URL     : ${BASE_URL}`);
  console.log(`  Profile Dir  : ${USER_DATA_DIR}`);
  console.log(`  Catalog only : ${catalogOnly}`);
  console.log(`  From page    : ${fromPage}`);
  console.log(`  Max pages    : ${maxPages}`);
  console.log(`  Cache dir    : ${CACHE_DIR}`);
  console.log('');

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'Asia/Jakarta',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const page = await context.newPage();

  async function fetchPageHtml(url: string): Promise<string> {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for Cloudflare challenge if present
    let title = await page.title().catch(() => '');
    if (title.includes('Just a moment') || title.includes('Tunggu sebentar') || title.includes('Checking')) {
      console.log(`  ⏳ Cloudflare challenge detected — waiting up to 30s...`);
      await page.waitForFunction(
        () => !document.title.includes('Just a moment') && !document.title.includes('Tunggu sebentar'),
        { timeout: 30000 }
      ).catch(() => {});
      await sleep(2000);
    }

    return page.content();
  }

  // ==========================================
  // STEP 1: Scrape all catalog pages
  // ==========================================
  let catalogItems: CatalogItem[] = [];

  // Load existing catalog cache if resuming
  if (fs.existsSync(CATALOG_CACHE) && fromPage > 1) {
    catalogItems = JSON.parse(fs.readFileSync(CATALOG_CACHE, 'utf-8'));
    console.log(`  📂 Loaded ${catalogItems.length} items from existing catalog cache`);
  }

  for (let p = fromPage; p <= maxPages; p++) {
    const url = p === 1 ? `${BASE_URL}/daftar-anime-2/` : `${BASE_URL}/daftar-anime-2/page/${p}/`;
    process.stdout.write(`  📋 Catalog page ${p}/${maxPages}... `);

    try {
      const html = await fetchPageHtml(url);
      const items = parseCatalogHtml(html);

      if (items.length === 0) {
        console.log(`⚠️  No items found (page may not exist)`);
        break;
      }

      // Merge (avoid duplicates by slug)
      const existingSlugs = new Set(catalogItems.map(i => i.slug));
      const newItems = items.filter(i => !existingSlugs.has(i.slug));
      catalogItems.push(...newItems);

      // Persist after each page
      fs.writeFileSync(CATALOG_CACHE, JSON.stringify(catalogItems, null, 2));
      console.log(`✅ ${items.length} anime (total: ${catalogItems.length})`);

      await sleep(1000 + Math.random() * 1000);
    } catch (err: any) {
      console.log(`❌ Error: ${err.message}`);
    }
  }

  console.log('');
  console.log(`  ✅ Catalog scraping done: ${catalogItems.length} anime total`);
  console.log(`  💾 Saved to: ${CATALOG_CACHE}`);

  if (catalogOnly) {
    await context.close();
    console.log('');
    console.log('  --catalog-only flag set, skipping detail pages.');
    console.log('  Run without flag to scrape detail pages.');
    process.exit(0);
  }

  // ==========================================
  // STEP 2: Scrape each anime detail page
  // ==========================================
  console.log('');
  console.log(`  Starting detail scraping for ${catalogItems.length} anime...`);
  console.log('  (Close this terminal at any time — progress is auto-saved)');
  console.log('');

  // Load existing detail cache
  const detailsMap: Record<string, DetailItem> = {};
  if (fs.existsSync(DETAILS_CACHE)) {
    const existing: DetailItem[] = JSON.parse(fs.readFileSync(DETAILS_CACHE, 'utf-8'));
    for (const d of existing) {
      detailsMap[d.slug] = d;
    }
    console.log(`  📂 Loaded ${Object.keys(detailsMap).length} existing detail records from cache`);
  }

  let done = 0;
  let skipped = 0;
  let failed = 0;
  const total = catalogItems.length;

  for (const item of catalogItems) {
    // Skip if already cached and has synopsis
    if (detailsMap[item.slug]?.synopsis && detailsMap[item.slug]?.genres?.length > 0) {
      skipped++;
      continue;
    }

    done++;
    const url = `${BASE_URL}/anime/${item.slug}/`;
    process.stdout.write(`  [${done + skipped}/${total}] ${item.title.substring(0, 40).padEnd(40)} ... `);

    try {
      const html = await fetchPageHtml(url);
      const detail = parseDetailHtml(html, item.slug);

      if (detail && (detail.synopsis || detail.episodes.length > 0)) {
        detailsMap[item.slug] = detail;
        console.log(`✅ (${detail.episodes.length} eps, ${detail.genres.length} genres)`);
      } else {
        console.log(`⚠️  No detail data extracted`);
        failed++;
      }

      // Auto-save every 10 anime
      if (done % 10 === 0) {
        fs.writeFileSync(DETAILS_CACHE, JSON.stringify(Object.values(detailsMap), null, 2));
      }

      await sleep(800 + Math.random() * 1200);
    } catch (err: any) {
      console.log(`❌ ${err.message.substring(0, 50)}`);
      failed++;
    }
  }

  // Final save
  fs.writeFileSync(DETAILS_CACHE, JSON.stringify(Object.values(detailsMap), null, 2));

  console.log('');
  console.log('==========================================================');
  console.log('  PRE-SCRAPING COMPLETE!');
  console.log(`  Done    : ${done}`);
  console.log(`  Skipped : ${skipped} (already cached)`);
  console.log(`  Failed  : ${failed}`);
  console.log(`  Cache   : ${DETAILS_CACHE}`);
  console.log('');
  console.log('  Next step: npm run sync:cache');
  console.log('  (imports all cached data into PostgreSQL)');
  console.log('==========================================================');

  await context.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Pre-scraper error:', err.message);
  process.exit(1);
});
