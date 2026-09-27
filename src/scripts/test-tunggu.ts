import { chromium } from 'playwright';

async function testTungguSebentar() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'id-ID',
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const url = 'https://v2.samehadaku.how/anime/ao-no-orchestra/';
  console.log('Navigating to:', url);
  await page.goto(url, { waitUntil: 'commit', timeout: 30000 });

  let title = await page.title();
  console.log('Page Title:', title);

  const frames = page.frames();
  console.log('Frames:', frames.map(f => f.url()));

  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);
    title = await page.title();
    console.log(`[${i+1}s] Title: "${title}"`);
    if (!title.includes('Tunggu sebentar') && !title.includes('Just a moment')) {
      console.log('PASSED! Final title:', title);
      break;
    }
  }

  await browser.close();
}

testTungguSebentar();
