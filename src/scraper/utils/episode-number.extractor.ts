/**
 * Robust episode number extraction that tolerates:
 * - Common typos from fansubs/sources: "epsiode-3", "eisode-8", "episod-12", "episodee-3"
 * - Shortened prefixes: "eps-5", "ep-5"
 * - Pure numeric or ending titles: "13 END", "12", "1"
 * - Movie and Special types
 */
export function extractEpisodeNumber(
  slug: string,
  title: string = '',
  animeType?: string | null
): number | null {
  const cleanTitle = (title || '').trim();
  const cleanSlug = (slug || '').trim();

  // 1. Check title for pure episode number: "13 END", "12", "1", "12 End"
  const pureNumMatch = cleanTitle.match(/^(\d+(\.\d+)?)(\s+(end|tamat))?$/i);
  if (pureNumMatch) {
    return parseFloat(pureNumMatch[1]);
  }

  // 2. Check title for "Episode 12", "Eps 12", "Ep 12"
  const titleEpMatch = cleanTitle.match(/(?:Episode|Eps|Ep|Eps\.|Ep\.)\s*(\d+(\.\d+)?)/i);
  if (titleEpMatch) {
    return parseFloat(titleEpMatch[1]);
  }

  // 3. Check title for "OVA 1", "OVA 2"
  const titleOvaMatch = cleanTitle.match(/OVA\s*(\d+(\.\d+)?)/i);
  if (titleOvaMatch) {
    return parseFloat(titleOvaMatch[1]);
  }

  // 4. Check slug with common typos: "episode-", "epsiode-", "eisode-", "episod-", "episodee-", "eps-"
  const slugMatch = cleanSlug.match(/(?:episode|epsiode|eisode|episod|episodee|eps|ep)-(\d+(\.\d+)?)/i);
  if (slugMatch) {
    return parseFloat(slugMatch[1]);
  }

  // 5. Slug ending in number: "-(\d+)$" or "-(\d+)-end$" or "-(\d+)-tamat$"
  const slugEndMatch = cleanSlug.match(/-(\d+(\.\d+)?)(?:-(?:end|tamat|\d+))?$/i);
  if (slugEndMatch) {
    return parseFloat(slugEndMatch[1]);
  }

  // 6. Movie / Special / OVA single episodes
  const isMovie =
    animeType === 'Movie' ||
    cleanTitle.toLowerCase() === 'movie' ||
    cleanSlug.includes('movie');
  if (isMovie) return 1;

  const isSpecial =
    animeType === 'Special' ||
    cleanTitle.toLowerCase().includes('spesial') ||
    cleanSlug.includes('spesial');
  if (isSpecial) return 1;

  if (cleanTitle.toLowerCase() === 'ova') return 1;

  return null;
}
