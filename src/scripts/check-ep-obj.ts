import { animeScraper } from '../scraper/scrapers/anime.scraper.js';

async function test() {
  const anime = await animeScraper.scrape('one-piece');
  console.log('Total episodes:', anime.episodes.length);
  console.log('Latest 3 episodes:');
  console.log(anime.episodes.slice(0, 3));
}

test().catch(console.error);
