import dotenv from 'dotenv';
dotenv.config();

const userDataDir = process.env.PLAYWRIGHT_USER_DATA_DIR || 'D:/NextJs/crawl/.chrome-profile';
const targetUrl = process.env.SOURCE_BASE_URL || 'https://v2.samehadaku.how';

async function testSolve() {
  console.log('Testing visible Chromium Turnstile resolution:');
  const { chromium } = await import('playwright-extra');
  const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
  chromium.use(StealthPlugin());

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    locale: 'id-ID',
    timezoneId: 'Asia/Jakarta',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const page = await context.newPage();
  const url = `${targetUrl}/daftar-anime-2/page/2/`;
  console.log('Navigating to', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log('Waiting for challenge to solve (max 25s)...');
  for (let i = 0; i < 8; i++) {
    const title = await page.title();
    console.log(`[${i * 3}s] Page Title:`, title);
    if (!title.includes('Just a moment') && !title.includes('Tunggu sebentar') && !title.includes('Checking')) {
      console.log('🎉 SUCCESS! Challenge resolved!');
      break;
    }

    // Try finding turnstile iframe & clicking
    for (const frame of page.frames()) {
      try {
        const checkbox = await frame.$('input[type="checkbox"], .ctp-checkbox-label, #challenge-stage');
        if (checkbox) {
          console.log('Found checkbox in frame, clicking...');
          await checkbox.click();
        }
      } catch {}
    }
    await page.waitForTimeout(3000);
  }

  const finalTitle = await page.title();
  console.log('Final Title:', finalTitle);
  const cookies = await context.cookies();
  const cf = cookies.find((c: any) => c.name === 'cf_clearance');
  if (cf) {
    console.log('✅ cf_clearance saved in profile:', cf.value.slice(0, 40) + '...');
    console.log('   Expires:', new Date(cf.expires * 1000).toLocaleString());
  }

  await context.close();
}

testSolve().catch(console.error);
