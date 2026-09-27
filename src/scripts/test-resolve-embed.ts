import { episodeScraper } from '../scraper/scrapers/episode.scraper.js';

async function testResolve() {
  const slug = 'one-piece-episode-1179';
  console.log(`Resolving embed for ${slug} on player-option-1...`);
  try {
    const resolved = await episodeScraper.resolveServer(slug, 'player-option-1');
    console.log('✅ Resolved stream server embed:');
    console.log(resolved);
  } catch (err: any) {
    console.error('❌ Failed resolving stream server:', err.message);
  }
}

testResolve();
