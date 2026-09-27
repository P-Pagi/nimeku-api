import { logger } from '../config/logger.js';

/**
 * Classifies a streaming server by its embed URL hostname.
 */
export type ServerProvider =
  | 'wibufile'
  | 'mega'
  | 'filedon'
  | 'pixeldrain'
  | 'blogger'
  | 'streamtape'
  | 'doodstream'
  | 'okru'
  | 'desustream'
  | 'vidhide'
  | 'otakudesu'
  | 'unknown';

const HOSTNAME_TO_PROVIDER: Array<[string, ServerProvider]> = [
  ['wibufile.com', 'wibufile'],
  ['mega.nz', 'mega'],
  ['mega.co.nz', 'mega'],
  ['filedon.co', 'filedon'],
  ['filedon.me', 'filedon'],
  ['pixeldrain.com', 'pixeldrain'],
  ['blogger.com', 'blogger'],
  ['blogspot.com', 'blogger'],
  ['streamtape.com', 'streamtape'],
  ['streamtape.net', 'streamtape'],
  ['doodstream.com', 'doodstream'],
  ['dood.pm', 'doodstream'],
  ['ok.ru', 'okru'],
  ['desustream.com', 'desustream'],
  ['desustream.net', 'desustream'],
  ['odvidhide.com', 'vidhide'],
  ['vidhide.com', 'vidhide'],
  ['vidhidepro.com', 'vidhide'],
  ['vidhideplus.com', 'vidhide'],
  ['otakudesu.blog', 'otakudesu'],
  ['otakudesu.cloud', 'otakudesu'],
  ['otakudesu.io', 'otakudesu'],
];

/**
 * Detect provider from embed URL.
 */
export function detectServerProvider(embedUrl: string): ServerProvider {
  try {
    const { hostname } = new URL(embedUrl);
    for (const [pattern, provider] of HOSTNAME_TO_PROVIDER) {
      if (hostname === pattern || hostname.endsWith(`.${pattern}`)) {
        return provider;
      }
    }
  } catch {
    // invalid URL
  }
  return 'unknown';
}

/**
 * Per-domain reachability cache to avoid flooding the same host.
 * Key: hostname, Value: { reachable, expiresAt }
 * TTL: 3 minutes for unreachable, 10 minutes for reachable
 */
const domainHealthCache = new Map<string, { reachable: boolean; expiresAt: number }>();

const REACHABLE_TTL_MS = 10 * 60 * 1000;
const UNREACHABLE_TTL_MS = 3 * 60 * 1000;
const HEAD_CHECK_TIMEOUT_MS = 6000;

/**
 * Providers that reject HEAD requests — we use a GET+abort-on-headers instead.
 * For these, we initiate a GET and immediately abort after reading headers
 * (before reading the body), so it stays very fast.
 */
const GET_ONLY_PROVIDERS: ServerProvider[] = ['mega', 'pixeldrain', 'blogger'];

/**
 * Perform a quick HEAD (or GET+abort) check on an embed URL to verify the host is up.
 * Results are cached per-hostname to avoid hammering the same domain.
 * Returns true if reachable, false if down/timeout/523.
 */
export async function checkEmbedReachable(embedUrl: string): Promise<boolean> {
  let hostname: string;
  try {
    hostname = new URL(embedUrl).hostname;
  } catch {
    return false;
  }

  // Check domain cache first
  const cached = domainHealthCache.get(hostname);
  if (cached && Date.now() < cached.expiresAt) {
    logger.debug({ hostname, reachable: cached.reachable }, 'Embed health check: domain cache hit');
    return cached.reachable;
  }

  // Determine which method to use
  const provider = detectServerProvider(embedUrl);
  const useGet = GET_ONLY_PROVIDERS.includes(provider);

  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), HEAD_CHECK_TIMEOUT_MS);

    const res = await fetch(embedUrl, {
      method: useGet ? 'GET' : 'HEAD',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        Referer: 'https://v2.samehadaku.how/',
      },
      signal: controller.signal,
    });

    // For GET requests: abort immediately after reading headers (before body)
    if (useGet) {
      controller.abort();
    }
    clearTimeout(tid);

    // 523 = Cloudflare "Origin Unreachable", treat as down
    // 5xx = server error = down (except 403/405 which may just be method-restricted)
    const reachable = res.status !== 523 && (res.status < 500 || res.status === 403 || res.status === 405);
    const ttl = reachable ? REACHABLE_TTL_MS : UNREACHABLE_TTL_MS;

    logger.debug(
      { hostname, status: res.status, reachable },
      'Embed health check: HEAD result'
    );

    domainHealthCache.set(hostname, { reachable, expiresAt: Date.now() + ttl });
    return reachable;
  } catch (err: any) {
    // Timeout, ECONNREFUSED, ETIMEDOUT, etc. — all = unreachable
    logger.debug({ hostname, error: err.message }, 'Embed health check: connection failed');
    domainHealthCache.set(hostname, { reachable: false, expiresAt: Date.now() + UNREACHABLE_TTL_MS });
    return false;
  }
}

/**
 * Invalidate the cached health state for a specific hostname.
 * Used when user explicitly retries a server.
 */
export function invalidateDomainHealth(embedUrl: string): void {
  try {
    const hostname = new URL(embedUrl).hostname;
    domainHealthCache.delete(hostname);
  } catch {
    // ignore
  }
}
