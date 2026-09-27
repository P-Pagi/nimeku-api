import { episodeScraper } from '../scraper/scrapers/episode.scraper.js';

async function test() {
  const slug = 'one-piece-episode-1179';
  console.log(`Scraping episode: ${slug}...`);
  const ep = await episodeScraper.scrape(slug);
  console.log('Title:', ep.title);
  console.log('Episode number:', ep.episodeNumber);
  console.log('Servers count:', ep.servers.length);
  console.log('Servers:', ep.servers);
  console.log('Downloads count:', ep.downloads.length);
  console.log('Is Degraded:', ep.isDegraded);
}

test().catch(console.error);
