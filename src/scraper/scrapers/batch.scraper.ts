import { httpClient } from '../client/http.client.js';
import { fetchPage } from '../client/page.fetcher.js';
import {
  parseBatchListHtml,
  parseBatchDetailHtml,
  BatchParseResult,
  BatchDetail,
} from '../parsers/batch.parser.js';
import { buildBatchUrl, buildBatchDetailUrl } from '../utils/url.builder.js';

export class BatchScraper {
  public async scrapeList(page = 1): Promise<BatchParseResult> {
    const url = buildBatchUrl(page);
    const res = await httpClient.fetch(url);
    return parseBatchListHtml(res.data, page);
  }

  public async scrapeDetail(slug: string): Promise<BatchDetail> {
    const url = buildBatchDetailUrl(slug);
    const { html } = await fetchPage(url, '.entry-content, .download-eps');
    return parseBatchDetailHtml(html, slug, url);
  }
}

export const batchScraper = new BatchScraper();
