import { config } from '../../config/env.js';

const getBaseUrl = (): string => {
  return config.SOURCE_BASE_URL.replace(/\/+$/, '');
};

export function buildHomeUrl(): string {
  return `${getBaseUrl()}/`;
}

export function buildRecentUrl(page = 1): string {
  if (page <= 1) {
    return `${getBaseUrl()}/anime-terbaru/`;
  }
  return `${getBaseUrl()}/anime-terbaru/page/${page}/`;
}

export function buildAnimeUrl(slug: string): string {
  const cleanSlug = slug.replace(/^\/+|\/+$/g, '');
  return `${getBaseUrl()}/anime/${cleanSlug}/`;
}

export function buildEpisodeUrl(slug: string): string {
  const cleanSlug = slug.replace(/^\/+|\/+$/g, '');
  return `${getBaseUrl()}/${cleanSlug}/`;
}

export function buildGenreUrl(genreSlug: string, page = 1): string {
  const cleanSlug = genreSlug.replace(/^\/+|\/+$/g, '');
  if (page <= 1) {
    return `${getBaseUrl()}/genre/${cleanSlug}/`;
  }
  return `${getBaseUrl()}/genre/${cleanSlug}/page/${page}/`;
}

export function buildBatchUrl(page = 1): string {
  if (page <= 1) {
    return `${getBaseUrl()}/daftar-batch/`;
  }
  return `${getBaseUrl()}/daftar-batch/page/${page}/`;
}

export function buildBatchDetailUrl(slug: string): string {
  const cleanSlug = slug.replace(/^\/+|\/+$/g, '');
  return `${getBaseUrl()}/batch/${cleanSlug}/`;
}

export function buildScheduleUrl(): string {
  return `${getBaseUrl()}/jadwal-rilis/`;
}

export function buildScheduleApiUrl(day?: string, perPage = 50): string {
  const url = new URL(`${getBaseUrl()}/wp-json/custom/v1/all-schedule`);
  url.searchParams.set('perpage', perPage.toString());
  if (day) {
    url.searchParams.set('day', day.toLowerCase());
  }
  return url.toString();
}

export function buildCatalogUrl(options: {
  page?: number;
  status?: string;
  type?: string;
  order?: string;
} = {}): string {
  const { page = 1, status, type, order } = options;
  const baseUrl = page <= 1 
    ? `${getBaseUrl()}/daftar-anime-2/`
    : `${getBaseUrl()}/daftar-anime-2/page/${page}/`;

  const url = new URL(baseUrl);
  if (status) {
    let mappedStatus = status;
    const lower = status.toLowerCase();
    if (lower === 'ongoing' || lower === 'currently airing') {
      mappedStatus = 'Currently Airing';
    } else if (lower === 'completed' || lower === 'finished airing') {
      mappedStatus = 'Finished Airing';
    }
    url.searchParams.set('status', mappedStatus);
  }
  if (type) url.searchParams.set('type', type);
  if (order) url.searchParams.set('order', order);

  return url.toString();
}

export function buildSearchUrl(query: string, page = 1): string {
  const encodedQuery = encodeURIComponent(query);
  if (page <= 1) {
    return `${getBaseUrl()}/?s=${encodedQuery}`;
  }
  return `${getBaseUrl()}/page/${page}/?s=${encodedQuery}`;
}

export function buildPlayerAjaxUrl(): string {
  return `${getBaseUrl()}/wp-admin/admin-ajax.php`;
}
