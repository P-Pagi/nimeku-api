/**
 * Centralized selectors repository for Samehadaku (https://v2.samehadaku.how/).
 * If the source website changes its DOM structure, update these selectors here.
 */
export const selectors = {
  home: {
    top10List: '.widget-post li, .topten-animesu li',
    top10Link: 'a[href*="/anime/"]',
    top10Title: '.title, a',
    top10Score: '.score, b',
    top10Poster: 'img',
    
    recentSection: '.post-show ul li, .post-item',
    recentTitle: '.entry-title a, h2 a',
    recentLink: '.entry-title a, .thumb a, a[href*="/anime/"]',
    recentEpisode: 'span:contains("Episode") author, .dtla span:nth-of-type(1) author',
    recentPoster: '.thumb img, img',
    recentPostedBy: '.author author, span:contains("Posted by") author',
    recentReleasedOn: 'span:contains("Released on")',
  },

  anime: {
    title: 'h1.entry-title, .info-anime h1',
    poster: '.thumb img, .poster img',
    synopsis: '.desc, .entry-content, .sinopsis, .entry-content-single',
    ratingScore: '.archivees span[itemprop="ratingValue"], .rating-area, .spe span:contains("Score")',
    genres: '.genre-info a, .info-content .genre-info a, .spe a[href*="/genre/"]',
    infoSpans: '.spe span, .info-content span',
    
    // Episode list inside anime detail
    episodeList: '.lstepsiode ul li, .episodelist ul li',
    episodeItemLink: '.eps a, a[href*="-episode-"], a[href*="/episode/"]',
    episodeItemTitle: '.eps a, .lstep',
    episodeItemDate: '.date, .epsdate',

    // Batch link if present
    batchLink: '.listbatch a, a[href*="/batch/"]',
  },

  episode: {
    title: 'h1.entry-title',
    navLinks: '.naveps a, .nvs a',
    serverButtons: '.east_player_option, #server ul li, [data-post][data-nume]',
    downloadSections: '.download-eps, .download, #download',
    downloadFormat: 'p, b, strong',
    downloadLinks: 'li a, a',
  },

  catalog: {
    items: '.animpost, .animepost, article',
    link: '.animposx a, a[href*="/anime/"]',
    title: '.data .title, .animposx a[title], h2',
    poster: '.content-thumb img, img.anmsa, img',
    type: '.type, .content-thumb .type',
    score: '.score, .content-thumb .score',
    status: '.status, .data .status',
    genres: '.data .type, .genres',
    pagination: '.pagination, .page-numbers, .hpage',
    nextPage: '.pagination a.next, .page-numbers.next, .pagination a:contains("Next")',
  },

  schedule: {
    dayOptions: '.east_days_option',
    resultContainer: '.result-schedule',
    items: '.result-schedule .animepost, .schedule .animepost',
    itemLink: '.animposx a, a',
    itemTitle: '.data .title, .animposx a[title]',
    itemPoster: '.content-thumb img, img',
    itemType: '.type',
    itemScore: '.score',
    itemGenre: '.data .type',
    itemTime: '.ltseps',
  },

  batch: {
    items: '.animpost, .animepost, article, .post-item',
    link: '.animposx a, a[href*="/batch/"]',
    title: '.data .title, .animposx a[title], h2.entry-title',
    poster: '.content-thumb img, img',
    detailTitle: 'h1.entry-title',
    downloadSections: '.download-eps, .download, .bixbox, .dlx',
  },
};
