import { httpClient } from '../client/http.client.js';
import { fetchPage } from '../client/page.fetcher.js';
import {
  parseCatalogHtml,
  parseGenreListHtml,
  CatalogParseResult,
} from '../parsers/genre.parser.js';
import { buildCatalogUrl, buildGenreUrl } from '../utils/url.builder.js';

export class GenreScraper {
  public async scrapeGenresList(): Promise<Array<{ name: string; slug: string }>> {
    const url = buildCatalogUrl({ page: 1 });
    const { html } = await fetchPage(url);
    return parseGenreListHtml(html);
  }

  public async scrapeAnimeByGenre(genreSlug: string, page = 1): Promise<CatalogParseResult> {
    const url = buildGenreUrl(genreSlug, page);
    const { html } = await fetchPage(url, '.animpost');
    return parseCatalogHtml(html, page);
  }

  public async scrapeCatalog(options: {
    page?: number;
    status?: string;
    type?: string;
    order?: string;
  } = {}): Promise<CatalogParseResult> {
    const url = buildCatalogUrl(options);
    const { html } = await fetchPage(url, '.animpost');
    return parseCatalogHtml(html, options.page || 1);
  }
}

export const genreScraper = new GenreScraper();
