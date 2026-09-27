import dotenv from 'dotenv';
dotenv.config();

const userDataDir = process.env.PLAYWRIGHT_USER_DATA_DIR || 'D:/NextJs/crawl/.chrome-profile';
const targetUrl = process.env.SOURCE_BASE_URL || 'https://v2.samehadaku.how';

async function solveChallenge() {
  console.log('');
  console.log('================================================================');
  console.log('  CLOUDFLARE TURNSTILE SOLVER');
  console.log('================================================================');
  console.log('');
  console.log('  Membuka browser Chromium...');

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
      '--start-maximized',
    ],
  });

  const page = await context.newPage();
  const url = `${targetUrl}/daftar-anime-2/page/2/`;
  console.log(`  Navigasi ke: ${url}`);
  console.log('');
  console.log('  👉 SILAKAN KLIK CHECKBOX "Verifikasi bahwa Anda adalah manusia" di jendela browser!');
  console.log('  Menunggu verifikasi selesai...');
  console.log('');

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Loop checking if title changed from challenge
  let solved = false;
  for (let i = 1; i <= 60; i++) {
    await page.waitForTimeout(2000);
    const title = await page.title().catch(() => '');
    const isChallenge =
      title.includes('Tunggu sebentar') ||
      title.includes('Just a moment') ||
      title.includes('Checking') ||
      title.includes('Memeriksa');

    if (!isChallenge && title.length > 0) {
      console.log(`  🎉 VERIFIKASI BERHASIL! Judul halaman: "${title}"`);
      solved = true;
      break;
    }

    if (i % 5 === 0) {
      console.log(`  [${i * 2}s] Masih menunggu verifikasi... (Judul: "${title}")`);
    }
  }

  if (solved) {
    // Wait an extra 3s to ensure cookies are written to profile
    await page.waitForTimeout(3000);
    const cookies = await context.cookies();
    const cf = cookies.find((c: any) => c.name === 'cf_clearance');
    if (cf) {
      console.log('');
      console.log('  ✅ Cookie cf_clearance berhasil diperbarui:');
      console.log(`     Token  : ${cf.value.substring(0, 45)}...`);
      console.log(`     Berlaku: ${new Date(cf.expires * 1000).toLocaleString()}`);
    }
    console.log('');
    console.log('  Semua halaman katalog sekarang bisa di-sync tanpa terblokir!');
  } else {
    console.log('  ⚠️ Waktu habis (120s). Verifikasi belum selesai.');
  }

  await context.close();
  process.exit(solved ? 0 : 1);
}

solveChallenge().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
