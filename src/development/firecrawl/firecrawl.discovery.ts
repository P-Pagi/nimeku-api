import { config } from '../../config/env.js';
import { logger } from '../../config/logger.js';

export interface FirecrawlScrapeResult {
  markdown?: string;
  html?: string;
  metadata?: Record<string, any>;
}

/**
 * Firecrawl Discovery Utility
 * Strictly intended for development inspection and schema discovery.
 * Production will never depend on this service.
 */
export class FirecrawlDiscoveryClient {
  private readonly apiKey?: string;

  constructor() {
    this.apiKey = config.FIRECRAWL_API_KEY;
  }

  public isConfigured(): boolean {
    return !!this.apiKey && this.apiKey.trim().length > 0;
  }

  public async inspectPage(targetUrl: string): Promise<FirecrawlScrapeResult | null> {
    if (!this.isConfigured()) {
      logger.info('Firecrawl API key is not set. Discovery tool inactive.');
      return null;
    }

    try {
      logger.info({ targetUrl }, 'Running Firecrawl discovery scrape');
      const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          url: targetUrl,
          formats: ['markdown', 'html'],
        }),
      });

      if (!response.ok) {
        throw new Error(`Firecrawl API error: ${response.status} ${response.statusText}`);
      }

      const result = (await response.json()) as any;
      return result.data as FirecrawlScrapeResult;
    } catch (err: any) {
      logger.error({ error: err.message, targetUrl }, 'Firecrawl discovery failed');
      return null;
    }
  }
}

export const firecrawlDiscovery = new FirecrawlDiscoveryClient();
