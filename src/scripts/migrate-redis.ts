/**
 * migrate-redis.ts
 * ─────────────────────────────────────────────────────────────
 * One-shot script: copy all keys from Upstash → local Memurai
 *
 * Usage:
 *   npx tsx src/scripts/migrate-redis.ts [--dry-run] [--filter <pattern>]
 *
 * Options:
 *   --dry-run          List what WOULD be migrated, without writing
 *   --filter <glob>    Only migrate keys matching pattern (e.g. "anime:*")
 *   --skip-bull        Skip BullMQ internal keys (bull:* and lock:*)
 *
 * Examples:
 *   npx tsx src/scripts/migrate-redis.ts
 *   npx tsx src/scripts/migrate-redis.ts --dry-run
 *   npx tsx src/scripts/migrate-redis.ts --filter "anime:*"
 *   npx tsx src/scripts/migrate-redis.ts --skip-bull
 */

import { Redis } from 'ioredis';
import { config } from '../config/env.js';

// ── Parse CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const skipBull = args.includes('--skip-bull');
const filterIdx = args.indexOf('--filter');
const filterPattern = filterIdx !== -1 ? args[filterIdx + 1] : null;

const UPSTASH_URL =
  'rediss://default:gQAAAAAABIvtAAIgcDI1ZjQ3MmFkNmFiYjU0YTlhODYzYWY0ZjhhYTE2ZDI0NQ@current-loon-297965.upstash.io:6379';
const LOCAL_URL = 'redis://localhost:6379';

// ── Stats tracker ─────────────────────────────────────────────────────────────
const stats = {
  total: 0,
  migrated: 0,
  skipped: 0,
  failed: 0,
  alreadyExpired: 0,
};

async function getAllKeys(src: Redis, pattern = '*'): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';

  do {
    const [nextCursor, batch] = await src.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');

  return keys;
}

async function migrateKey(src: Redis, dst: Redis, key: string): Promise<'migrated' | 'skipped' | 'expired' | 'failed'> {
  try {
    const type = await src.type(key);
    const ttl = await src.pttl(key); // TTL in milliseconds

    // Key already expired (pttl returns -2)
    if (ttl === -2) {
      return 'expired';
    }

    // Set TTL — if -1 (no expiry), use 0 to indicate permanent
    const expireMs = ttl > 0 ? ttl : 0;

    if (type === 'string') {
      const val = await src.get(key);
      if (val === null) return 'expired';
      if (isDryRun) return 'migrated';
      if (expireMs > 0) {
        await dst.set(key, val, 'PX', expireMs);
      } else {
        await dst.set(key, val);
      }
      return 'migrated';
    }

    if (type === 'hash') {
      const val = await src.hgetall(key);
      if (Object.keys(val).length === 0) return 'skipped';
      if (isDryRun) return 'migrated';
      await dst.hset(key, val);
      if (expireMs > 0) await dst.pexpire(key, expireMs);
      return 'migrated';
    }

    if (type === 'list') {
      const val = await src.lrange(key, 0, -1);
      if (val.length === 0) return 'skipped';
      if (isDryRun) return 'migrated';
      // Delete first to avoid duplicates
      await dst.del(key);
      await dst.rpush(key, ...val);
      if (expireMs > 0) await dst.pexpire(key, expireMs);
      return 'migrated';
    }

    if (type === 'set') {
      const val = await src.smembers(key);
      if (val.length === 0) return 'skipped';
      if (isDryRun) return 'migrated';
      await dst.del(key);
      await dst.sadd(key, ...val);
      if (expireMs > 0) await dst.pexpire(key, expireMs);
      return 'migrated';
    }

    if (type === 'zset') {
      const val = await src.zrange(key, 0, -1, 'WITHSCORES');
      if (val.length === 0) return 'skipped';
      if (isDryRun) return 'migrated';
      await dst.del(key);
      // val is [member, score, member, score, ...]
      for (let i = 0; i < val.length; i += 2) {
        await dst.zadd(key, parseFloat(val[i + 1]), val[i]);
      }
      if (expireMs > 0) await dst.pexpire(key, expireMs);
      return 'migrated';
    }

    // Unknown type (e.g. streams) — skip
    console.warn(`  ⚠ Unknown type "${type}" for key: ${key} — skipping`);
    return 'skipped';
  } catch (err: any) {
    console.error(`  ✗ Failed: ${key} — ${err.message}`);
    return 'failed';
  }
}

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║      Redis Migration: Upstash → Memurai      ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
  console.log(`Mode       : ${isDryRun ? '🔍 DRY RUN (no writes)' : '🚀 LIVE MIGRATION'}`);
  console.log(`Skip Bull  : ${skipBull ? 'Yes' : 'No'}`);
  console.log(`Filter     : ${filterPattern ?? '* (all keys)'}`);
  console.log(`Source     : ${UPSTASH_URL.split('@')[1]}`);
  console.log(`Dest       : ${LOCAL_URL}`);
  console.log('');

  const src = new Redis(UPSTASH_URL, { maxRetriesPerRequest: null });
  const dst = new Redis(LOCAL_URL, { maxRetriesPerRequest: null });

  try {
    // Verify connections
    await src.ping();
    console.log('✅ Connected to Upstash');
    await dst.ping();
    console.log('✅ Connected to Memurai (local)');
    console.log('');

    // Scan all keys
    const pattern = filterPattern ?? '*';
    console.log(`🔍 Scanning keys matching: ${pattern}`);
    let keys = await getAllKeys(src, pattern);

    // Apply --skip-bull filter
    if (skipBull) {
      const before = keys.length;
      keys = keys.filter(k => !k.startsWith('bull:') && !k.startsWith('lock:'));
      console.log(`  Filtered out ${before - keys.length} BullMQ/lock keys`);
    }

    stats.total = keys.length;
    console.log(`  Found ${keys.length} keys to process\n`);

    if (keys.length === 0) {
      console.log('Nothing to migrate.');
      return;
    }

    // Migrate key by key
    for (const key of keys) {
      const result = await migrateKey(src, dst, key);
      if (result === 'migrated') {
        stats.migrated++;
        console.log(`  ✓ ${key}`);
      } else if (result === 'skipped') {
        stats.skipped++;
        console.log(`  - skipped (empty): ${key}`);
      } else if (result === 'expired') {
        stats.alreadyExpired++;
        console.log(`  ~ expired: ${key}`);
      } else {
        stats.failed++;
      }
    }

    // Summary
    console.log('');
    console.log('══════════════════════════════════════════');
    console.log('                 SUMMARY                  ');
    console.log('══════════════════════════════════════════');
    console.log(`  Total scanned  : ${stats.total}`);
    console.log(`  Migrated       : ${stats.migrated} ✓`);
    console.log(`  Skipped (empty): ${stats.skipped}`);
    console.log(`  Already expired: ${stats.alreadyExpired}`);
    console.log(`  Failed         : ${stats.failed}${stats.failed > 0 ? ' ⚠' : ''}`);
    if (isDryRun) {
      console.log('');
      console.log('  ℹ DRY RUN — no data was written.');
      console.log('  Run without --dry-run to apply.');
    }
    console.log('══════════════════════════════════════════');
  } finally {
    await src.quit();
    await dst.quit();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
