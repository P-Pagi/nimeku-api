import { config } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * PlaywrightClient — headless Chromium for pages behind Cloudflare IUAM.
 *
 * Strategy:
 * - ENABLE_PLAYWRIGHT_FALLBACK=false  → always returns null (noop)
 * - ENABLE_PLAYWRIGHT_FALLBACK=true   → use Playwright as primary for detail pages
 *
 * Browser instance is reused across requests for efficiency.
 * Persistent BrowserContext preserves Cloudflare session cookies across requests.
 *
 * IMPORTANT: Use isChallengeTitle() consistently everywhere — never raw string comparisons.
 * Cloudflare shows challenge in many languages (EN, ID, ES, DE, FR) depending on locale.
 */

/**
 * Unified Cloudflare challenge title detector.
 * Covers ALL known language variants to prevent false "passed" detection.
 */
function isChallengeTitle(title: string): boolean {
  return (
    title.includes('Just a moment') ||       // English
    title.includes('Checking your browser') || // English alt
    title.includes('Checking if the site') || // English generic
    title.includes('Please Wait') ||          // English generic 2
    title.includes('Tunggu sebentar') ||      // Indonesian ← was the root cause
    title.includes('Memeriksa browser') ||    // Indonesian alt
    title.includes('Un momento') ||           // Spanish
    title.includes('Einen Moment') ||         // German
    title.includes('Veuillez patienter') ||   // French
    title.includes('Attendez') ||             // French alt
    title.includes('Por favor espere')        // Spanish alt
  );
}

export class PlaywrightClient {
  private browser: any = null;
  private context: any = null;
  private isAvailable: boolean | null = null;
  private launchPromise: Promise<any> | null = null;

  constructor() {
    if (!config.ENABLE_PLAYWRIGHT_FALLBACK) {
      this.isAvailable = false;
    }
  }

  private async checkAvailability(): Promise<boolean> {
    if (this.isAvailable !== null) return this.isAvailable;

    try {
      // @ts-ignore
      await import('playwright');
      this.isAvailable = true;
      return true;
    } catch {
      logger.warn('Playwright package not installed. Install with: npm i playwright && npx playwright install chromium');
      this.isAvailable = false;
      return false;
    }
  }

  /**
   * Get chromium launcher — uses playwright-extra + stealth plugin if available,
   * falls back to plain playwright. Stealth patches Canvas, WebGL, TLS fingerprint,
   * navigator.webdriver, permissions, etc. — all major Cloudflare detection vectors.
   */
  private async getStealthChromium(): Promise<any> {
    try {
      // @ts-ignore
      const { chromium } = await import('playwright-extra');
      // @ts-ignore
      const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
      chromium.use(StealthPlugin());
      logger.info('Using playwright-extra + stealth plugin for Cloudflare bypass');
      return chromium;
    } catch {
      logger.warn('playwright-extra not available, falling back to plain playwright (less stealth)');
      // @ts-ignore
      const { chromium } = await import('playwright');
      return chromium;
    }
  }

  private async getContext(): Promise<any> {
    if (this.context) return this.context;

    // Deduplicate concurrent launch calls
    if (this.launchPromise) return this.launchPromise;

    this.launchPromise = (async () => {
      const chromium = await this.getStealthChromium();

      const userDataDir = config.PLAYWRIGHT_USER_DATA_DIR;
      const contextOptions = {
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',   // Use English to keep challenge titles predictable
        timezoneId: 'Asia/Jakarta',
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
        },
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process',
          '--window-size=1920,1080',
        ],
      };

      if (userDataDir) {
        // Persistent profile: cookies (including cf_clearance) saved to disk.
        // Cloudflare Turnstile only needs solving ONCE manually; reused thereafter.
        logger.info({ userDataDir, headless: config.PLAYWRIGHT_HEADLESS }, 'Playwright using persistent profile (cf_clearance preserved)');
        this.context = await chromium.launchPersistentContext(userDataDir, {
          headless: config.PLAYWRIGHT_HEADLESS,
          ...contextOptions,
        });
        this.browser = null; // launchPersistentContext owns its own browser
      } else {
        // In-memory context: fresh session every restart
        this.browser = await chromium.launch({
          headless: config.PLAYWRIGHT_HEADLESS,
          args: contextOptions.args,
        });
        this.context = await this.browser.newContext({
          userAgent: contextOptions.userAgent,
          viewport: contextOptions.viewport,
          locale: contextOptions.locale,
          timezoneId: contextOptions.timezoneId,
          extraHTTPHeaders: contextOptions.extraHTTPHeaders,
        });
      }

      logger.info('Playwright Chromium persistent session started');
      this.launchPromise = null;
      return this.context;
    })();

    return this.launchPromise;
  }

  /**
   * Fetch rendered HTML using headless Chromium.
   * Reuses the persistent BrowserContext so Cloudflare clearance cookies are kept.
   */
  public async fetchRenderedHtml(
    url: string,
    waitSelector?: string,
    timeoutMs = 30000
  ): Promise<string | null> {
    if (!config.ENABLE_PLAYWRIGHT_FALLBACK) {
      logger.warn({ url }, 'Playwright requested but ENABLE_PLAYWRIGHT_FALLBACK=false');
      return null;
    }

    const available = await this.checkAvailability();
    if (!available) return null;

    const context = await this.getContext();
    const page = await context.newPage();

    // Full stealth init script (bypasses Turnstile bot detection)
    await page.addInitScript(() => {
      // Hide webdriver
      Object.defineProperty(navigator, 'webdriver', { get: () => false });

      // Spoof Chrome runtime
      (window as any).chrome = {
        runtime: {},
        loadTimes: function () {},
        csi: function () {},
        app: {},
      };

      // Spoof plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });

      // Spoof languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['id-ID', 'id', 'en-US', 'en'],
      });

      // Spoof permissions query
      const originalQuery = (window as any).navigator.permissions?.query;
      if (originalQuery) {
        (window as any).navigator.permissions.query = (parameters: any) =>
          parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters);
      }

      // Spoof hardware concurrency & device memory
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

      // WebGL vendor spoof
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (parameter: number) {
        if (parameter === 37445) return 'Intel Inc.';
        if (parameter === 37446) return 'Intel Iris OpenGL Engine';
        return getParameter.call(this, parameter);
      };

      // Prevent automation flag detection
      delete (window as any).__nightmare;
      delete (window as any).callPhantom;
      delete (window as any)._phantom;
    });

    try {
      logger.debug({ url }, 'Playwright navigating to page');

      await page.goto(url, {
        waitUntil: 'commit',
        timeout: timeoutMs,
      });

      // --- CHALLENGE DETECTION using unified isChallengeTitle() ---
      let title = await page.title().catch(() => '');
      if (isChallengeTitle(title)) {
        logger.info({ url, title }, 'Cloudflare challenge detected — attempting Turnstile resolution...');

        // Simulate human-like mouse movement before clicking
        await page.mouse.move(
          300 + Math.floor(Math.random() * 200),
          300 + Math.floor(Math.random() * 200)
        ).catch(() => {});

        // Poll for up to 12 x 3s = 36 seconds total to resolve challenge
        for (let attempt = 0; attempt < 12; attempt++) {
          // Try clicking Turnstile checkbox across ALL frames
          const allFrames = page.frames();
          for (const frame of allFrames) {
            const frameUrl = frame.url();
            if (
              frameUrl.includes('cloudflare.com') ||
              frameUrl.includes('turnstile') ||
              frameUrl.includes('challenge')
            ) {
              const checkbox = await frame.$(
                'input[type="checkbox"], .ctp-checkbox-label, #challenge-stage, span.mark, [id*="checkbox"]'
              ).catch(() => null);
              if (checkbox) {
                logger.info({ url, frameUrl }, 'Clicking Cloudflare Turnstile checkbox');
                await checkbox.click().catch(() => {});
                await page.waitForTimeout(3000);
              }
            }
          }

          // Wait 3s then re-evaluate title using the SAME unified helper
          await page.waitForTimeout(3000);
          title = await page.title().catch(() => '');

          if (!isChallengeTitle(title)) {
            logger.info({ url, title }, 'Cloudflare challenge resolved!');
            break;
          }

          logger.debug({ url, attempt, title }, 'Still on Cloudflare challenge page, waiting...');
        }

        // Secondary wait via waitForFunction — also uses all language variants (up to 30s)
        await page.waitForFunction(
          () => {
            const t = (globalThis as any).document?.title || '';
            return (
              !t.includes('Just a moment') &&
              !t.includes('Tunggu sebentar') &&
              !t.includes('Memeriksa browser') &&
              !t.includes('Checking your browser') &&
              !t.includes('Please Wait') &&
              !t.includes('Un momento') &&
              !t.includes('Einen Moment') &&
              !t.includes('Veuillez patienter')
            );
          },
          { timeout: 30000 }
        ).catch(() => logger.warn({ url }, 'Cloudflare challenge wait timed out after 30s'));

        // Extra buffer time for cf_clearance cookie to settle
        await page.waitForTimeout(2000);
      }

      // Wait for content selector if provided
      if (waitSelector) {
        await page.waitForSelector(waitSelector, { timeout: 10000 }).catch(() => {
          logger.debug({ url, waitSelector }, 'Optional waitSelector timed out, continuing');
        });
      } else {
        await page.waitForTimeout(1500);
      }

      let content = await page.content();
      title = await page.title().catch(() => '');

      // Final guard — MUST use same isChallengeTitle() for consistency
      const isStillChallenged =
        isChallengeTitle(title) ||
        content.includes('cf-browser-verification') ||
        (content.length < 35000 && content.includes('challenges.cloudflare.com'));

      if (isStillChallenged) {
        logger.warn({ url, title, contentLength: content.length }, 'Page still blocked by Cloudflare challenge — rejecting content');
        return null;
      }

      logger.debug({ url, contentLength: content.length }, 'Playwright fetch complete');
      return content;
    } catch (err: any) {
      logger.error({ url, error: err.message }, 'Playwright rendering failed');
      return null;
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * Gracefully close browser — call this on process exit
   */
  public async close(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      logger.info('Playwright browser closed');
    }
  }
}

export const playwrightClient = new PlaywrightClient();
