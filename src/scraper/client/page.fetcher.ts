/**
 * PageFetcher — Unified abstraction for fetching page HTML.
 *
 * Strategy per URL type:
 * - Listing pages (/daftar-anime-2/, /genre/*, /jadwal-rilis/) → fetch() [no JS needed]
 * - Detail pages (/anime/*, /episode/*, /batch/*) → Playwright primary if enabled,
 *   fallback to fetch (returns 403 behind Cloudflare)
 * - JSON API endpoints (/wp-json/*) → fetch() always (bypass circuit breaker for 4xx)
 *
 * This separation keeps scraping costs minimal:
 * - Playwright (slow, ~2-4s/page) only for pages that truly need a real browser
 * - fetch (fast, ~200-400ms) for all listing/API pages
 */
import { httpClient } from './http.client.js';
import { playwrightClient } from './playwright.client.js';
import { config } from '../../config/env.js';
import { logger } from '../../config/logger.js';

// URL patterns that require a real browser (Cloudflare protected)
const BROWSER_REQUIRED_PATTERNS = [
  /\/anime\/[^/]+\/?$/,      // /anime/{slug}/
  /\/episode\/[^/]+\/?$/,    // /episode/{slug}/
  /\/batch\/[^/]+\/?$/,      // /batch/{slug}/
];

function requiresBrowser(url: string): boolean {
  // If CF_CLEARANCE_TOKEN is available, curl.exe bypasses Cloudflare directly without browser overhead
  if (config.CF_CLEARANCE_TOKEN) return false;
  if (!config.ENABLE_PLAYWRIGHT_FALLBACK) return false;
  return BROWSER_REQUIRED_PATTERNS.some((pattern) => pattern.test(url));
}

export interface FetchResult {
  html: string;
  status: number;
  usedPlaywright: boolean;
}

export async function fetchPage(url: string, waitSelector?: string): Promise<FetchResult> {
  // If URL explicitly requires browser (detail pages: anime, episode, batch)
  if (requiresBrowser(url)) {
    const html = await playwrightClient.fetchRenderedHtml(url, waitSelector);
    if (html) {
      return { html, status: 200, usedPlaywright: true };
    }
    logger.warn({ url }, 'Playwright render unsuccessful for detail page');
    return { html: '', status: 403, usedPlaywright: true };
  }

  // For listing and other pages: try fast native fetch first
  const res = await httpClient.fetch(url);

  // If native fetch hit Cloudflare 403 or challenge, fallback to Playwright once
  const isBlocked =
    res.status === 403 ||
    res.data.includes('Just a moment') ||
    res.data.includes('Tunggu sebentar') ||
    res.data.includes('Attention Required');

  if (isBlocked && config.ENABLE_PLAYWRIGHT_FALLBACK) {
    logger.info({ url }, 'Fetch hit Cloudflare 403 — automatically falling back to Playwright');
    const html = await playwrightClient.fetchRenderedHtml(url, waitSelector);
    if (html) {
      return { html, status: 200, usedPlaywright: true };
    }
  }

  return { html: res.data, status: res.status, usedPlaywright: false };
}

/**
 * Fetch page with explicit Playwright (ignore flag — for direct use in scrapers)
 */
export async function fetchWithPlaywright(url: string, waitSelector?: string): Promise<string | null> {
  return playwrightClient.fetchRenderedHtml(url, waitSelector);
}
