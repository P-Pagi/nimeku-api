# Samehadaku Anime REST API

Production-ready anime REST API dengan PostgreSQL, Redis, native Cheerio scraper, BullMQ sync worker, dan Swagger/OpenAPI.

## Arsitektur

```
Frontend
   ↓
REST API (Fastify)
   ↓
Redis Cache  ←→  PostgreSQL
```

```
Scheduler (node-cron)
   ↓
BullMQ Queue
   ↓
Sync Worker
   ↓
Native Scraper (fetch + Cheerio)
   ↓
Samehadaku (https://v2.samehadaku.how)
   ↓
Parser → Normalizer → PostgreSQL → Redis (Invalidation)
```

> **Prinsip utama:** 1.000 user request ≠ 1.000 request ke Samehadaku.
> Traffic user dipisahkan total dari traffic scraping.

---

## Stack

| Komponen | Teknologi |
|---|---|
| Runtime | Node.js 22 LTS |
| Language | TypeScript 5 |
| Framework | Fastify 5 |
| HTTP Scraper | native `fetch` |
| HTML Parser | Cheerio |
| ORM | Prisma |
| Database | PostgreSQL 16 |
| Cache | Redis 7 (ioredis) |
| Job Queue | BullMQ |
| Scheduler | node-cron |
| Validation | Zod |
| Logging | Pino |
| API Docs | @fastify/swagger + swagger-ui |
| Testing | Vitest |
| Container | Docker + Docker Compose |

---

## Instalasi

### 1. Clone & Install

```bash
git clone <repo>
cd crawl
npm install
```

### 2. Konfigurasi Environment

```bash
cp .env.example .env
# Edit .env sesuai kebutuhan
```

Variabel penting:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/samehadaku
REDIS_URL=redis://localhost:6379
ADMIN_API_KEY=ganti-dengan-key-yang-kuat
SOURCE_BASE_URL=https://v2.samehadaku.how
```

### 3. Jalankan PostgreSQL & Redis

**Dengan Docker:**

```bash
docker compose up -d postgres redis
```

**Atau langsung install di lokal.**

### 4. Migrasi Database

```bash
npm run prisma:generate
npm run prisma:migrate      # Development: buat migration baru
# Atau:
npm run prisma:push          # Push schema langsung (tanpa migration history)
```

### 5. Initial Sync (Seed pertama)

Initial sync akan mengambil: Genre → Schedule → Catalog anime (paginated) → Batch.

```bash
npm run sync            # Default 2 halaman catalog
npm run sync -- 5       # Ambil 5 halaman catalog (~450 anime)
```

Proses ini akan membangun database dari nol. Gunakan `SCRAPER_MAX_CONCURRENCY=2` dan `SCRAPER_MIN_DELAY_MS=1000` agar tidak terlalu agresif.

### 6. Jalankan API

```bash
npm run dev:api         # Development mode (hot reload)
npm start               # Production (requires build first)
```

### 7. Jalankan Worker (Proses Terpisah)

```bash
npm run dev:worker      # Development
npm run start:worker    # Production
```

API dan Worker **harus dijalankan sebagai proses terpisah**. Jika Worker crash, API tetap berjalan dari database.

---

## Docker (Production)

```bash
# Start semua service sekaligus
docker compose up -d

# Lakukan initial sync di dalam container
docker compose exec worker node dist/scripts/sync-cli.js

# Lihat log
docker compose logs -f api
docker compose logs -f worker
```

---

## Endpoint API

Dokumentasi lengkap tersedia di [`/docs`](http://localhost:4000/docs) (Swagger UI).

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| GET | `/health` | Status API, database, Redis |
| GET | `/health/source` | Status Samehadaku + circuit breaker |
| GET | `/api/v1/stats` | Statistik global: total anime, episode, genre, server, coverage |
| GET | `/api/v1/home` | Data home: top10, featured (hero), recent, ongoing, newSeason, movies, todaySchedule |
| GET | `/api/v1/anime` | Katalog anime. Filter: `status`, `type`, `genre`, `year`, `season`, `minScore`, `order` |
| GET | `/api/v1/anime/recent` | Anime baru diupdate |
| GET | `/api/v1/anime/ongoing` | Anime sedang tayang |
| GET | `/api/v1/anime/completed` | Anime tamat |
| GET | `/api/v1/anime/popular` | Anime populer (by score) |
| GET | `/api/v1/anime/movies` | Anime tipe Movie |
| GET | `/api/v1/anime/:slug` | Detail anime + navigation (first & latest ep), franchise, related, sameStudio |
| GET | `/api/v1/anime/:slug/episodes` | Daftar episode anime terpaginasi (`page`, `limit`, `order=asc/desc`) |
| GET | `/api/v1/search?q=naruto` | Pencarian anime. Filter opsional: `type`, `status`, `genre`, `minScore` |
| GET | `/api/v1/schedule` | Jadwal rilis mingguan dikelompokkan per hari |
| GET | `/api/v1/genres` | Semua genre + jumlah anime |
| GET | `/api/v1/genres/:slug` | Anime berdasarkan genre |
| GET | `/api/v1/batch` | Daftar batch download |
| GET | `/api/v1/batch/:slug` | Detail batch |
| GET | `/api/v1/episode/:slug` | Detail episode + anime info + navigation (prev/next/all) + episodeList + servers + downloads |
| GET | `/api/v1/episode/:slug/servers` | Server streaming list (live scrape / cache) |
| GET | `/api/v1/episode/:slug/servers/:id` | Resolve embed iframe URL server (player_ajax) |
| GET | `/api/v1/episode/:slug/downloads` | Link download episode per resolusi & hosting |

**Admin Endpoints** (butuh header `x-admin-key`):

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| POST | `/api/v1/admin/sync/recent` | Trigger incremental sync |
| POST | `/api/v1/admin/sync/anime/:slug` | Sync 1 anime |
| POST | `/api/v1/admin/sync/all` | Full sync |
| GET | `/api/v1/admin/sync/status` | Lihat status sync jobs |

---

## Format Response

**Success:**
```json
{ "success": true, "data": {} }
```

**Paginated:**
```json
{
  "success": true,
  "data": [],
  "meta": { "page": 1, "limit": 20, "total": 200, "totalPages": 10, "hasNextPage": true, "hasPreviousPage": false }
}
```

**Error:**
```json
{ "success": false, "error": { "code": "ANIME_NOT_FOUND", "message": "Anime tidak ditemukan" } }
```

---

## Cara Kerja Sistem

### Incremental Sync

Setiap 10 menit, scheduler memicu sync recent:
1. Ambil halaman home → ekstrak recent episodes
2. Cek di PostgreSQL: episode sudah ada? → **SKIP**
3. Episode baru? → Scrape detail anime → Upsert ke DB → Invalidate Redis cache

Hasilnya: hanya anime yang benar-benar baru di-scrape.

### Change Detection (Rule #18)

Setiap kali anime di-scrape, system menghitung hash dari:
```
title | latestEpisode | status | episodeCount | score
```
Jika hash sama dengan database → **skip update**, hemat request.

### Safe Database Update (Rule #41)

Parser gagal mendapatkan `score`? → Sistem **tidak** overwrite nilai `score` yang valid di database dengan `null`.

### Circuit Breaker (Rule #25)

Jika Samehadaku gagal `SOURCE_FAILURE_THRESHOLD` kali (default: 5):
- **OPEN**: Semua scrape request dihentikan selama `SOURCE_COOLDOWN_MINUTES` (default: 10 menit)
- API tetap berjalan dari PostgreSQL + Redis
- Setelah cooldown: **HALF_OPEN** → test 1 request → jika sukses **CLOSED**

### Stream Server Resolution (Rule #28)

Endpoint `/episode/:slug/servers/:id` menggunakan lazy resolution:
1. Redis cache ada? → Return langsung (TTL ~1 jam)
2. Tidak ada? → Acquire distributed lock → POST ke WordPress `player_ajax` → Parse embed URL → Cache Redis → Return

---

## Environment Variables

| Variable | Default | Deskripsi |
|---|---|---|
| `PORT` | `4000` | Port API |
| `SOURCE_BASE_URL` | `https://v2.samehadaku.how` | Domain Samehadaku |
| `DATABASE_URL` | - | PostgreSQL connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `ADMIN_API_KEY` | - | Key untuk endpoint admin |
| `SCRAPER_MAX_CONCURRENCY` | `2` | Max concurrent scrape requests |
| `SCRAPER_MIN_DELAY_MS` | `1000` | Delay minimum antar request (ms) |
| `SCRAPER_TIMEOUT_MS` | `15000` | Timeout per request (ms) |
| `SCRAPER_MAX_RETRIES` | `3` | Max retry jika gagal |
| `SOURCE_FAILURE_THRESHOLD` | `5` | Batas error sebelum circuit open |
| `SOURCE_COOLDOWN_MINUTES` | `10` | Lama circuit open (menit) |
| `SYNC_RECENT` | `*/10 * * * *` | Cron sync recent |
| `SYNC_SCHEDULE` | `0 * * * *` | Cron sync jadwal |
| `SYNC_GENRES` | `0 3 * * *` | Cron sync genre |
| `ENABLE_PLAYWRIGHT_FALLBACK` | `false` | Aktifkan Playwright fallback |
| `FIRECRAWL_API_KEY` | _(optional)_ | Hanya untuk discovery/development |

---

## Struktur Project

```
src/
├── api/
│   ├── routes/          # health, anime, episode, genre, batch, schedule, admin
│   └── server.ts        # Fastify app builder
├── cache/
│   ├── cache.service.ts # Redis cache dengan SWR & invalidation
│   ├── lock.service.ts  # Distributed lock (Redis)
│   └── redis.client.ts  # ioredis instance
├── config/
│   ├── env.ts           # Zod env validation
│   └── logger.ts        # Pino structured logger
├── db/
│   └── prisma.ts        # Prisma client
├── development/
│   └── firecrawl/       # Discovery tool (dev only, tidak wajib)
├── queue/
│   ├── queues.ts        # BullMQ queue setup
│   ├── worker.ts        # BullMQ worker
│   └── scheduler.ts     # node-cron scheduler
├── resilience/
│   ├── circuit-breaker.ts
│   ├── errors.ts        # Custom error classes
│   └── rate-limiter.ts  # Controlled concurrency
├── scraper/
│   ├── client/
│   │   ├── http.client.ts     # fetch + retry + backoff
│   │   └── playwright.client.ts # Optional fallback
│   ├── parsers/
│   │   ├── anime.parser.ts
│   │   ├── batch.parser.ts
│   │   ├── episode.parser.ts
│   │   ├── genre.parser.ts
│   │   ├── home.parser.ts
│   │   ├── schedule.parser.ts
│   │   └── server.parser.ts
│   ├── scrapers/
│   │   ├── anime.scraper.ts
│   │   ├── batch.scraper.ts
│   │   ├── episode.scraper.ts
│   │   ├── genre.scraper.ts
│   │   ├── home.scraper.ts
│   │   └── schedule.scraper.ts
│   └── selectors/
│       └── samehadaku.selectors.ts  # ← Perbaiki di sini jika HTML berubah
├── scripts/
│   └── sync-cli.ts      # npm run sync
├── services/
│   ├── anime.service.ts
│   ├── batch.service.ts
│   ├── episode.service.ts
│   ├── genre.service.ts
│   ├── schedule.service.ts
│   └── sync-state.service.ts
├── sync/
│   ├── change.detector.ts # Hash-based change detection + safe merge
│   └── sync.engine.ts     # Incremental & initial sync logic
├── index.ts             # API entry point
└── worker.ts            # Worker entry point

prisma/
└── schema.prisma        # Database schema

tests/
├── fixtures/            # Real HTML snapshots (offline tests)
│   ├── home.html
│   ├── anime-detail.html
│   ├── episode.html
│   ├── recent.html
│   ├── catalog.html
│   ├── batch.html
│   └── schedule.html
├── api.test.ts          # Integration tests (Fastify inject)
├── parsers.test.ts      # Unit tests (offline, no internet)
└── utils.test.ts        # URL builder, change detector, circuit breaker
```

---

## Maintenance Parser

Jika HTML Samehadaku berubah:
1. Buka [`src/scraper/selectors/samehadaku.selectors.ts`](src/scraper/selectors/samehadaku.selectors.ts)
2. Update selector yang berubah
3. Jalankan `npm test` untuk verifikasi parser masih bekerja

Jika endpoint/URL Samehadaku berubah:
1. Buka [`src/scraper/utils/url.builder.ts`](src/scraper/utils/url.builder.ts)
2. Update fungsi builder yang relevan

---

## Troubleshooting

**API tidak bisa connect ke database:**
```
Error: P1001: Can't reach database server
```
Pastikan PostgreSQL berjalan dan `DATABASE_URL` benar.

**Circuit breaker OPEN:**
```
CircuitOpenError: Source circuit is OPEN
```
Samehadaku sedang down atau merespons error. API tetap berjalan dari database. Tunggu cooldown selesai atau cek `/health/source`.

**Parser degraded warning:**
```
WARN: Anime parser marked DEGRADED!
```
HTML struktur Samehadaku berubah. Update selector di `samehadaku.selectors.ts`.

**Sync tidak berjalan:**
```
GET /api/v1/admin/sync/status
```
Cek `SyncState` table. Pastikan Worker process berjalan.

---

## Firecrawl (Development Only)

Firecrawl **TIDAK** digunakan di production. Hanya untuk discovery saat development:

```typescript
// Hanya di development/discovery scripts
import { firecrawlDiscovery } from './src/development/firecrawl/firecrawl.discovery.js';
const result = await firecrawlDiscovery.inspectPage('https://v2.samehadaku.how/anime/one-piece/');
```

Jika `FIRECRAWL_API_KEY` kosong → semua production features tetap berjalan normal.

## Playwright Fallback (Optional)

Playwright hanya aktif jika:
1. `ENABLE_PLAYWRIGHT_FALLBACK=true` di `.env`  
2. Package `playwright` ter-install (`npm install playwright`)

Sistem akan otomatis fallback ke Playwright hanya jika native fetch + Cheerio parsing dianggap degraded (hasil parsing kosong/tidak lengkap).

---

## Status UNVERIFIED

Beberapa bagian yang masih perlu validasi lanjut di environment production:

- **Batch URL** `/daftar-batch/` sudah verified berfungsi, tapi link `/daftar-batch-2/` di nav mengarah ke v1 yang sedang down — URL `/daftar-batch/` digunakan sebagai primary
- **Ongoing/Completed filter** via `?status=Ongoing` pada halaman `/daftar-anime-2/` tidak menghasilkan filter saat dicek (AJAX filter) — API saat ini mengandalkan PostgreSQL query
- **Pagination total** di recent page menunjukkan angka sangat besar (`7831231`) — kemungkinan artefak, `totalPages` di API dihitung dari DB
- **Stream server embed URL TTL** — beberapa embed URL mungkin expired lebih cepat dari 1 jam tergantung provider
"# nimeku-api" 
