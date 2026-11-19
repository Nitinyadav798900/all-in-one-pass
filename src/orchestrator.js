'use strict';

const registry      = require('./registry');
const cache         = require('./cache');
const circuit       = require('./circuit');
const { withRetry } = require('./retry');

/**
 * Main bypass orchestrator — chain bypass support
 * HubDrive → HubCloud → actual download links
 */
async function bypass(url, opts = {}) {
  const { skipCache = false, attempts = 3, _chainDepth = 0 } = opts;

  // Max chain depth — infinite loop se bachao
  if (_chainDepth > 3) throw new Error('Chain bypass: max depth reached');

  // Validate URL
  let parsed;
  try { parsed = new URL(url); } catch (_) { throw new Error(`Invalid URL: ${url}`); }

  // Find plugin
  const plugin = registry.match(url);
  if (!plugin) {
    throw new Error(
      `Unsupported site: ${parsed.hostname}\n` +
      `Supported: ${registry.supportedDomains().join(', ')}`
    );
  }

  const cacheKey = `${plugin.id}:${url}`;

  // ── Cache hit ────────────────────────────────────────────────────────
  if (!skipCache) {
    const cached = await cache.get(cacheKey);
    if (cached) {
      await cache.incrStat('cache_hits');
      const ageS = Math.round((Date.now() - new Date(cached.extracted_at).getTime()) / 1000);
      return { ...cached, cached: true, cache_age_s: ageS };
    }
  }
  await cache.incrStat('cache_misses');

  // ── Circuit check ────────────────────────────────────────────────────
  if (circuit.isOpen(plugin.id)) {
    throw new Error(`${plugin.name} circuit OPEN — retry in 60s`);
  }

  // ── Bypass with retry ────────────────────────────────────────────────
  const result = await withRetry(
    async (attempt) => {
      if (attempt > 0) console.log(`[orchestrator] retry ${attempt} for ${plugin.id}`);
      const r = await plugin.bypass(url);
      circuit.onSuccess(plugin.id);
      return r;
    },
    { attempts }
  );

  result.cached = false;

  // ── Cache store ──────────────────────────────────────────────────────
  await cache.set(cacheKey, result);
  await cache.incrStat('total_bypassed');

  return result;
}

module.exports = { bypass };
