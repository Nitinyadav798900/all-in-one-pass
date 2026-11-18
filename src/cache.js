'use strict';

// ── In-memory fallback ────────────────────────────────────────────────────
const memCache  = new Map(); // key → { value, exp }
const memStats  = { hits: 0, misses: 0, sets: 0 };

// ── Upstash Redis (optional) ─────────────────────────────────────────────
let redis = null;
function getRedis() {
  if (redis) return redis;
  if (!process.env.UPSTASH_REDIS_REST_URL) return null;
  try {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({
      url  : process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    return redis;
  } catch (_) { return null; }
}

const TTL = 4 * 60 * 60; // 4 hours in seconds

async function get(key) {
  const r = getRedis();
  if (r) {
    try {
      const val = await r.get(`hcb:${key}`);
      if (val) { memStats.hits++; return typeof val === 'string' ? JSON.parse(val) : val; }
    } catch (_) {}
  }
  // Fallback to memory
  const rec = memCache.get(key);
  if (rec && rec.exp > Date.now()) { memStats.hits++; return rec.value; }
  if (rec) memCache.delete(key);
  memStats.misses++;
  return null;
}

async function set(key, value) {
  memStats.sets++;
  const r = getRedis();
  if (r) {
    try { await r.set(`hcb:${key}`, JSON.stringify(value), { ex: TTL }); } catch (_) {}
  }
  // Always write memory too
  memCache.set(key, { value, exp: Date.now() + TTL * 1000 });
}

async function del(key) {
  memCache.delete(key);
  const r = getRedis();
  if (r) { try { await r.del(`hcb:${key}`); } catch (_) {} }
}

async function incrStat(field) {
  const r = getRedis();
  if (r) { try { await r.hincrby('hcb:stats', field, 1); } catch (_) {} }
}

async function getStats() {
  const r = getRedis();
  let redisStats = {};
  if (r) { try { redisStats = await r.hgetall('hcb:stats') || {}; } catch (_) {} }
  return {
    ...redisStats,
    mem_hits  : memStats.hits,
    mem_misses: memStats.misses,
    mem_sets  : memStats.sets,
    mem_keys  : memCache.size,
    redis     : !!r,
  };
}

module.exports = { get, set, del, incrStat, getStats };
