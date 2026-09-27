import { prisma } from '../db/prisma.js';
import { httpClient } from '../scraper/client/http.client.js';
import * as cheerio from 'cheerio';

async function testEpisode() {
  const ep = await prisma.episode.findFirst({
    select: { slug: true, title: true, sourceUrl: true }
  });
  console.log('Sample Episode from DB:', ep);
  if (!ep) return;

  const url = `https://v2.samehadaku.how/${ep.slug}/`;
  console.log('Fetching episode URL:', url);
  const res = await httpClient.fetch(url);
  console.log('Status:', res.status, 'HTML length:', res.data.length);

  const $ = cheerio.load(res.data);
  console.log('Page Title:', $('title').text());

  // Check player selectors
  console.log('.east_player_option count:', $('.east_player_option').length);
  console.log('#server count:', $('#server').length);
  console.log('.server-list count:', $('.server-list').length);
  console.log('[data-post] count:', $('[data-post]').length);
  console.log('[data-nume] count:', $('[data-nume]').length);
  console.log('iframe count:', $('iframe').length);
  console.log('#player count:', $('#player').length);

  // Print all elements containing player or server in class or id
  $('[class*="player"], [id*="player"], [class*="server"], [id*="server"]').each((i, el) => {
    if (i < 15) {
      console.log(`  <${el.tagName} id="${$(el).attr('id') || ''}" class="${$(el).attr('class') || ''}"> text: ${$(el).text().slice(0, 50).trim()}`);
    }
  });

  await prisma.$disconnect();
}

testEpisode().catch(console.error);
