'use strict';

const registry      = require('./registry');
const cache         = require('./cache');
const circuit       = require('./circuit');
const { withRetry } = require('./retry');

async function bypass(url, opts = {}) {
  const { skipCache = false, attempts = 3, userIp = null } = opts;

  let parsed;
  try { parsed = new URL(url); } catch (_) { throw new Error(`Invalid URL: ${url}`); }

  const plugin = registry.match(url);
  if (!plugin) {
    throw new Error(
      `Unsupported site: ${parsed.hostname}\n` +
      `Supported: ${registry.supportedDomains().join(', ')}`
    );
  }

  const cacheKey = `${plugin.id}:${url}`;

  // Cache hit
  if (!skipCache) {
    const cached = await cache.get(cacheKey);
    if (cached) {
      await cache.incrStat('cache_hits');
      const ageS = Math.round((Date.now() - new Date(cached.extracted_at).getTime()) / 1000);
      return { ...cached, cached: true, cache_age_s: ageS };
    }
  }
  await cache.incrStat('cache_misses');

  // Circuit check
  if (circuit.isOpen(plugin.id)) {
    throw new Error(`${plugin.name} circuit OPEN — retry in 60s`);
  }

  // Bypass with retry
  const result = await withRetry(
    async (attempt) => {
      if (attempt > 0) console.log(`[orchestrator] retry ${attempt} for ${plugin.id}`);

      // Pass opts to plugin — each plugin decides what to use
      // Safe: older plugins ignore extra opts
      let r;
      try {
        r = await plugin.bypass(url, { userIp });
      } catch(e) {
        // If plugin doesn't accept opts, try without
        if (e.message && e.message.includes('opts')) {
          r = await plugin.bypass(url);
        } else {
          throw e;
        }
      }

      circuit.onSuccess(plugin.id);
      return r;
    },
    { attempts }
  );

  result.cached = false;

  // Don't cache streamtape — tokens expire fast and are IP-bound
  if (plugin.id !== 'streamtape') {
    await cache.set(cacheKey, result);
  }
  await cache.incrStat('total_bypassed');

  return result;
}

module.exports = { bypass };
