import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default('0.0.0.0'),
  SOURCE_BASE_URL: z.string().url().default('https://v2.samehadaku.how'),
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/samehadaku?schema=public'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  ADMIN_API_KEY: z.string().default('samehadaku-admin-secret-key-32chars'),

  // Internal Scraper Controls
  SCRAPER_MAX_CONCURRENCY: z.coerce.number().default(2),
  SCRAPER_MIN_DELAY_MS: z.coerce.number().default(1000),
  SCRAPER_TIMEOUT_MS: z.coerce.number().default(15000),
  SCRAPER_MAX_RETRIES: z.coerce.number().default(3),

  // Circuit Breaker
  SOURCE_FAILURE_THRESHOLD: z.coerce.number().default(5),
  SOURCE_COOLDOWN_MINUTES: z.coerce.number().default(10),

  // Sync Cron Schedules
  SYNC_RECENT: z.string().default('*/10 * * * *'),
  SYNC_ONGOING: z.string().default('*/30 * * * *'),
  SYNC_POPULAR: z.string().default('0 */6 * * *'),
  SYNC_SCHEDULE: z.string().default('0 * * * *'),
  SYNC_GENRES: z.string().default('0 3 * * *'),

  // Optional Fallbacks & Discovery
  ENABLE_PLAYWRIGHT_FALLBACK: z
    .string()
    .transform((val) => val === 'true')
    .default('false'),
  FIRECRAWL_API_KEY: z.string().optional().default(''),
  // Persistent Chromium profile dir — preserves cf_clearance cookie across restarts
  PLAYWRIGHT_USER_DATA_DIR: z.string().optional().default(''),
  // cf_clearance cookie from a real browser — inject to bypass Cloudflare without Playwright.
  // Get it from Chrome DevTools → Application → Cookies → v2.samehadaku.how → cf_clearance
  CF_CLEARANCE_TOKEN: z.string().optional().default(''),
  // Run Playwright headless or visible (visible bypasses Cloudflare Turnstile much more reliably)
  PLAYWRIGHT_HEADLESS: z
    .string()
    .transform((val) => val === 'true')
    .default('false'),

  // Run background sync worker inside the API process (all-in-one single process mode)
  EMBED_WORKER: z
    .string()
    .transform((val) => val === 'true')
    .default('false'),
});

export type Env = z.infer<typeof envSchema>;

export const config: Env = envSchema.parse(process.env);
