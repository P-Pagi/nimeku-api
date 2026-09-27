/**
 * cf-warmup.ts — One-time Cloudflare session warmer.
 *
 * Opens a VISIBLE (non-headless) Chromium window with the persistent profile.
 * You manually solve the Cloudflare Turnstile challenge once.
 * After solving, press Enter in this terminal — the cf_clearance cookie is saved to disk.
 * All subsequent headless sync runs will reuse it automatically.
 *
 * Usage: npx tsx src/scripts/cf-warmup.ts
 */
import dotenv from 'dotenv';
dotenv.config();

const userDataDir = process.env.PLAYWRIGHT_USER_DATA_DIR || 'D:/NextJs/crawl/.chrome-profile';
const targetUrl = process.env.SOURCE_BASE_URL || 'https://v2.samehadaku.how';

async function warmup() {
  // @ts-ignore
  const { chromium } = await import('playwright');

  console.log('');
  console.log('==========================================================');
  console.log('  CLOUDFLARE SESSION WARMER');
  console.log('==========================================================');
  console.log('');
  console.log(`  Profile dir : ${userDataDir}`);
  console.log(`  Target URL  : ${targetUrl}/anime/one-piece/`);
  console.log('');
  console.log('  Opening browser...');

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,   // VISIBLE — so you can interact with Turnstile
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'Asia/Jakarta',
    slowMo: 50,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
      '--start-maximized',
    ],
  });

  // Open several pages to maximize chance of getting cf_clearance cookie
  const page = await context.newPage();
  console.log('  Browser opened! Opening multiple tabs...');

  // Tab 1: Catalog listing
  page.goto(`${targetUrl}/daftar-anime-2/page/2/`).catch(() => {});

  // Tab 2: Anime detail (most likely to trigger Cloudflare)
  const page2 = await context.newPage();
  page2.goto(`${targetUrl}/anime/ao-no-orchestra/`).catch(() => {});

  // Tab 3: Another detail page
  const page3 = await context.newPage();
  page3.goto(`${targetUrl}/anime/one-piece/`).catch(() => {});

  console.log('');
  console.log('  Instructions:');
  console.log('  1. Look at the browser window that just opened.');
  console.log('  2. If Cloudflare challenge appears → wait for it to solve automatically,');
  console.log('     or click the checkbox if shown.');
  console.log('  3. Once the anime page loads normally → come back here.');
  console.log('  4. Press ENTER to save cookies and close the browser.');
  console.log('');
  console.log('  Waiting for you to press ENTER...');

  // Wait for user input
  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    process.stdin.once('data', () => resolve());
  });

  // List saved cookies
  const cookies = await context.cookies();
  const cfCookie = cookies.find((c: any) => c.name === 'cf_clearance');
  if (cfCookie) {
    console.log('');
    console.log('  ✅ cf_clearance cookie saved!');
    console.log(`     Value  : ${cfCookie.value.substring(0, 40)}...`);
    console.log(`     Expires: ${new Date(cfCookie.expires * 1000).toLocaleString()}`);
    console.log('');
    console.log('  You can now run: npm run sync');
    console.log('  Headless browser will reuse this cookie automatically.');
  } else {
    console.log('');
    console.log('  ⚠️  No cf_clearance cookie found. Challenge may not have been solved.');
    console.log('     Try running this script again and make sure the anime page fully loaded.');
    console.log('');
    console.log('  All cookies found:');
    cookies.forEach((c: any) => console.log(`     - ${c.name}: ${c.value.substring(0, 30)}...`));
  }

  await context.close();
  process.exit(0);
}

warmup().catch((err) => {
  console.error('Warmup failed:', err.message);
  process.exit(1);
});
