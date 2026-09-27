import dotenv from 'dotenv';
dotenv.config();

const CF_CLEARANCE = process.env.CF_CLEARANCE_TOKEN || '';
const BASE_URL = process.env.SOURCE_BASE_URL || 'https://v2.samehadaku.how';

async function testWithUA(ua: string, label: string) {
  const url = `${BASE_URL}/daftar-anime-2/page/2/`;
  const headers: Record<string, string> = {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cookie': `cf_clearance=${CF_CLEARANCE}`,
    'Referer': `${BASE_URL}/`,
  };

  try {
    const res = await fetch(url, { headers });
    const text = await res.text();
    const isBlocked = res.status === 403 || text.includes('Just a moment');
    console.log(`[${res.status}] ${label}: ${isBlocked ? 'BLOCKED' : 'SUCCESS (' + text.length + ' bytes)'}`);
    if (res.status === 200) {
      console.log('   FOUND WORKING UA:', ua);
    }
  } catch (err: any) {
    console.log(`[ERR] ${label}:`, err.message);
  }
}

async function main() {
  console.log('Testing cf_clearance with various User-Agents:');
  const userAgents = [
    { label: 'Chrome 128 (hardcoded)', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' },
    { label: 'Chrome 133', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36' },
    { label: 'Chrome 134', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36' },
    { label: 'Chrome 153 (installed version)', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36' },
    { label: 'Chrome 153 exact', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.53 Safari/537.36' },
  ];

  for (const item of userAgents) {
    await testWithUA(item.ua, item.label);
  }
}

main().catch(console.error);
