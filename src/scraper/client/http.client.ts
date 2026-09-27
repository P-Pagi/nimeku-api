import { execFile } from 'child_process';
import { config } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { sourceCircuitBreaker } from '../../resilience/circuit-breaker.js';
import { scraperRateLimiter } from '../../resilience/rate-limiter.js';
import { RateLimitError, SourceUnavailableError } from '../../resilience/errors.js';

export interface HttpResponse {
  status: number;
  data: string;
  isNotModified: boolean;
  etag?: string | null;
  lastModified?: string | null;
}

export interface HttpRequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  useCacheHeaders?: boolean;
  /** Skip circuit breaker check — use for optional probing endpoints that may return 4xx */
  bypassCircuitBreaker?: boolean;
}

// Memory store for ETags and Last-Modified headers per URL
const cacheHeadersStore = new Map<string, { etag?: string; lastModified?: string; data?: string }>();

export class HttpClient {
  private readonly defaultHeaders: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'max-age=0',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Sec-CH-UA': '"Chromium";v="133", "Google Chrome";v="133", "Not-A.Brand";v="99"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    Referer: 'https://v2.samehadaku.how/',
    Origin: 'https://v2.samehadaku.how',
    // Inject cf_clearance cookie if provided via env — bypasses Cloudflare without Playwright
    ...(config.CF_CLEARANCE_TOKEN
      ? { Cookie: `cf_clearance=${config.CF_CLEARANCE_TOKEN}` }
      : {}),
  };

  /**
   * SSRF protection: validate that target URL belongs to trusted source domain
   */
  private validateUrl(targetUrl: string): void {
    const parsed = new URL(targetUrl);
    const sourceBase = new URL(config.SOURCE_BASE_URL);

    // Whitelist target hostname matching or subdomain of source base
    const allowed =
      parsed.hostname === sourceBase.hostname ||
      parsed.hostname.endsWith(`.${sourceBase.hostname}`) ||
      parsed.hostname === 'samehadaku.how' ||
      parsed.hostname.endsWith('.samehadaku.how');

    if (!allowed) {
      throw new Error(`SSRF Prevention: Target URL ${targetUrl} is not permitted.`);
    }
  }

  public async fetch(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    this.validateUrl(url);

    // Check circuit breaker state first (unless caller explicitly bypasses it)
    if (!options.bypassCircuitBreaker) {
      sourceCircuitBreaker.checkAvailability();
    }

    // Acquire rate limit slot (controls concurrency and enforces delay + jitter)
    await scraperRateLimiter.acquire();

    try {
      return await this.executeWithRetry(url, options);
    } finally {
      scraperRateLimiter.release();
    }
  }

  private async executeWithRetry(
    url: string,
    options: HttpRequestOptions,
    attempt = 1
  ): Promise<HttpResponse> {
    const startTime = Date.now();
    const method = options.method || 'GET';
    const reqHeaders: Record<string, string> = {
      ...this.defaultHeaders,
      ...options.headers,
    };

    // Conditional HTTP headers (If-None-Match / If-Modified-Since)
    if (options.useCacheHeaders !== false && method === 'GET') {
      const cached = cacheHeadersStore.get(url);
      if (cached?.etag) reqHeaders['If-None-Match'] = cached.etag;
      if (cached?.lastModified) reqHeaders['If-Modified-Since'] = cached.lastModified;
    }

    try {
      logger.debug({ url, method, attempt }, 'Initiating scraper HTTP request');

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), config.SCRAPER_TIMEOUT_MS);

      const response = await fetch(url, {
        method,
        headers: reqHeaders,
        body: options.body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const duration = Date.now() - startTime;

      logger.info(
        { url, status: response.status, duration, attempt },
        'Scraper HTTP request finished'
      );

      // 304 Not Modified
      if (response.status === 304) {
        sourceCircuitBreaker.recordSuccess();
        const cached = cacheHeadersStore.get(url);
        return {
          status: 304,
          data: cached?.data || '',
          isNotModified: true,
          etag: cached?.etag,
          lastModified: cached?.lastModified,
        };
      }

      // Handle 429 Too Many Requests
      if (response.status === 429) {
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;
        logger.warn({ url, retryAfterSeconds, attempt }, 'Source returned 429 Too Many Requests');

        if (attempt <= config.SCRAPER_MAX_RETRIES) {
          const backoffMs = this.calculateBackoff(attempt, retryAfterSeconds);
          logger.warn({ url, backoffMs, attempt }, 'Backing off after 429');
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          return this.executeWithRetry(url, options, attempt + 1);
        }

        sourceCircuitBreaker.recordFailure(new RateLimitError('Rate limited by source', retryAfterSeconds));
        throw new RateLimitError('Source website rate limit exceeded', retryAfterSeconds);
      }

      // Handle server errors (500, 502, 503, 504)
      if (response.status >= 500) {
        logger.warn({ url, status: response.status, attempt }, 'Source returned server error');
        if (attempt <= config.SCRAPER_MAX_RETRIES) {
          const backoffMs = this.calculateBackoff(attempt);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          return this.executeWithRetry(url, options, attempt + 1);
        }

        const err = new SourceUnavailableError(`Source server error ${response.status} for ${url}`);
        sourceCircuitBreaker.recordFailure(err);
        throw err;
      }

      // Client errors (403, 404, etc.)
      // Note: 403/404 mean the endpoint policy rejected us — NOT a site outage.
      // Do NOT record these to the global circuit breaker.
      if (!response.ok) {
        const text = await response.text();
        if (response.status === 403 && config.CF_CLEARANCE_TOKEN) {
          logger.info({ url, method }, 'Native fetch hit 403, attempting transparent bypass via curl.exe + cf_clearance...');
          try {
            const curlRes = await this.fetchViaCurl(url, reqHeaders, method, options.body);
            if (
              curlRes.status === 200 &&
              !curlRes.data.includes('Just a moment') &&
              !curlRes.data.includes('Tunggu sebentar')
            ) {
              logger.info({ url, method, duration: Date.now() - startTime }, 'curl.exe successfully bypassed Cloudflare!');
              sourceCircuitBreaker.recordSuccess();
              return curlRes;
            }
          } catch (curlErr: any) {
            logger.warn({ url, error: curlErr.message }, 'curl.exe fallback error');
          }
        }

        if (response.status === 404) {
          logger.debug({ url, status: 404 }, 'Source returned 404 (not found)');
        } else if (response.status === 403) {
          logger.warn({ url }, 'Source returned 403 (endpoint protected, not a site outage)');
        } else {
          logger.warn({ url, status: response.status }, 'Source returned unexpected client error');
        }
        return {
          status: response.status,
          data: text,
          isNotModified: false,
        };
      }

      let bodyText = await response.text();
      if (
        config.CF_CLEARANCE_TOKEN &&
        (bodyText.includes('Just a moment') || bodyText.includes('Tunggu sebentar'))
      ) {
        logger.info({ url, method }, 'Response contains Cloudflare challenge page, retrying via curl.exe...');
        try {
          const curlRes = await this.fetchViaCurl(url, reqHeaders, method, options.body);
          if (
            curlRes.status === 200 &&
            !curlRes.data.includes('Just a moment') &&
            !curlRes.data.includes('Tunggu sebentar')
          ) {
            logger.info({ url, method, duration: Date.now() - startTime }, 'curl.exe successfully bypassed Cloudflare!');
            sourceCircuitBreaker.recordSuccess();
            return curlRes;
          }
        } catch (curlErr: any) {
          logger.warn({ url, error: curlErr.message }, 'curl.exe fallback error');
        }
      }

      const etag = response.headers.get('etag');
      const lastModified = response.headers.get('last-modified');

      // Store in memory for conditional requests
      if (method === 'GET' && (etag || lastModified)) {
        cacheHeadersStore.set(url, {
          etag: etag || undefined,
          lastModified: lastModified || undefined,
          data: bodyText,
        });
      }

      sourceCircuitBreaker.recordSuccess();

      return {
        status: response.status,
        data: bodyText,
        isNotModified: false,
        etag,
        lastModified,
      };
    } catch (error: any) {
      const duration = Date.now() - startTime;
      logger.error(
        { url, error: error.message, name: error.name, duration, attempt },
        'Scraper HTTP request failed'
      );

      if (attempt <= config.SCRAPER_MAX_RETRIES && error.name === 'AbortError') {
        logger.warn({ url, attempt }, 'Timeout reached, retrying with backoff');
        const backoffMs = this.calculateBackoff(attempt);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        return this.executeWithRetry(url, options, attempt + 1);
      }

      sourceCircuitBreaker.recordFailure(error);
      throw error instanceof RateLimitError || error instanceof SourceUnavailableError
        ? error
        : new SourceUnavailableError(`Failed to fetch ${url}: ${error.message}`);
    }
  }

  /**
   * Exponential backoff: 5s, 15s, 30s, 60s
   */
  private calculateBackoff(attempt: number, retryAfterSec?: number): number {
    if (retryAfterSec && !isNaN(retryAfterSec)) {
      return retryAfterSec * 1000;
    }
    const backoffs = [5000, 15000, 30000, 60000];
    return backoffs[attempt - 1] || 60000;
  }

  /**
   * Transparently fetch via Windows curl.exe.
   * curl.exe uses Windows native Schannel/TLS stack, matching real Chrome TLS fingerprints
   * and successfully passing Cloudflare Turnstile with cf_clearance cookie.
   */
  private fetchViaCurl(
    url: string,
    headers: Record<string, string>,
    method: string = 'GET',
    body?: string
  ): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const timeoutSec = Math.round(config.SCRAPER_TIMEOUT_MS / 1000) || 15;
      const args = ['-s', '-L', '-i', '--max-time', `${timeoutSec}`];

      // Set request method
      if (method === 'POST') {
        args.push('-X', 'POST');
        if (body) {
          args.push('--data-raw', body);
        }
      }

      args.push(url);

      for (const [k, v] of Object.entries(headers)) {
        const lower = k.toLowerCase();
        // Skip sec-ch-ua (quotes issue on Windows) and accept-encoding (prevents Brotli binary output)
        if (lower.startsWith('sec-ch-ua') || lower === 'accept-encoding') continue;
        args.push('-H', `${k}: ${v}`);
      }

      execFile('curl.exe', args, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);

        // Find the last HTTP status line in output (in case of 301/302 redirects)
        const statusMatches = stdout.match(/HTTP\/[\d.]+ (\d+)/g);
        const lastStatus = statusMatches
          ? parseInt(statusMatches[statusMatches.length - 1].split(' ')[1], 10)
          : 200;

        // Find the start of the body: the first blank line AFTER the last HTTP header block
        const lastHttpIndex = stdout.lastIndexOf('HTTP/');
        const doubleCrlf = stdout.indexOf('\r\n\r\n', lastHttpIndex >= 0 ? lastHttpIndex : 0);
        const doubleLf = stdout.indexOf('\n\n', lastHttpIndex >= 0 ? lastHttpIndex : 0);

        let bodyStartIndex = -1;
        if (doubleCrlf !== -1) {
          bodyStartIndex = doubleCrlf + 4;
        } else if (doubleLf !== -1) {
          bodyStartIndex = doubleLf + 2;
        }

        const body = bodyStartIndex !== -1 ? stdout.slice(bodyStartIndex) : stdout;

        resolve({
          status: lastStatus,
          data: body,
          isNotModified: lastStatus === 304,
        });
      });
    });
  }
}

export const httpClient = new HttpClient();
