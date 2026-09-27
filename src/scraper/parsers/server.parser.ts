import * as cheerio from 'cheerio';
import { ParsingError } from '../../resilience/errors.js';

export interface ResolvedStreamServer {
  serverKey: string;
  name?: string;
  embedUrl: string;
  rawHtml?: string;
}

export function parseStreamServerEmbed(rawHtml: string, serverKey: string): ResolvedStreamServer {
  if (!rawHtml || typeof rawHtml !== 'string') {
    throw new ParsingError(`Response embed server kosong untuk serverKey: ${serverKey}`);
  }

  const $ = cheerio.load(rawHtml);
  const iframeSrc = $('iframe').attr('src') || $('iframe').attr('data-src');

  if (iframeSrc) {
    return {
      serverKey,
      embedUrl: iframeSrc,
      rawHtml,
    };
  }

  // If embed is inside a link or video element
  const videoSrc = $('video source').attr('src') || $('video').attr('src');
  if (videoSrc) {
    return {
      serverKey,
      embedUrl: videoSrc,
      rawHtml,
    };
  }

  // Fallback: check regex in raw string
  const match = rawHtml.match(/src=["']([^"']+)["']/i);
  if (match && match[1]) {
    return {
      serverKey,
      embedUrl: match[1],
      rawHtml,
    };
  }

  throw new ParsingError(`Gagal mengekstrak iframe embed URL dari response server ${serverKey}`);
}
