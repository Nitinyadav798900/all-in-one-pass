'use strict';

const express    = require('express');
const { bypass } = require('./src/orchestrator');
const registry   = require('./src/registry');
const circuit    = require('./src/circuit');
const cache      = require('./src/cache');
const auth       = require('./src/auth');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.setHeader('X-Powered-By',                 'multisite-bypass/7.0');
  next();
});

// ── Auth ─────────────────────────────────────────────────────────────────
const requireKey = (req, res, next) => {
  const k = req.headers['x-api-key'] || req.query.key;
  const r = auth.validate(k);
  if (!r.valid) return res.status(401).json({ success: false, error: r.reason });
  next();
};
const requireMaster = (req, res, next) => {
  if (!auth.isMaster(req.headers['x-api-key'] || req.query.key))
    return res.status(403).json({ success: false, error: 'Master key required' });
  next();
};

// ══════════════════════════════════════════════════════════════════════════
// CORE ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /bypass?url=...
 * Universal bypass — works for ALL supported sites
 */
app.get('/bypass', requireKey, async (req, res) => {
  const { url, nocache } = req.query;
  if (!url) {
    return res.status(400).json({
      success : false,
      error   : 'Missing ?url= parameter',
      examples: [
        '/bypass?url=https://hubcloud.pw/drive/ABC123',
        '/bypass?url=https://gofile.io/d/pVawQzDG',
        '/bypass?url=https://hubdrive.blog/file/3002211248',
        '/bypass?url=https://new3.multicloudlinks.com/view/f533404ca2?...',
        '/bypass?url=https://new2.drivehub.dad/file/4346143',
      ],
    });
  }

  try {
    const result = await bypass(url, { skipCache: nocache === '1' });
    res.json(result);
  } catch (e) {
    console.error(`[/bypass] ${e.message}`);
    const code = e.message.includes('Invalid URL') || e.message.includes('Unsupported') || e.message.includes('not found') ? 400 : 502;
    res.status(code).json({ success: false, error: e.message, url });
  }
});

// Keep /hubcloud alias for backward compat
app.get('/hubcloud', requireKey, async (req, res) => {
  req.url = '/bypass' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?') - 1) : '');
  res.redirect(307, `/bypass?url=${encodeURIComponent(req.query.url || '')}&key=${req.query.key || ''}`);
});

/**
 * POST /batch
 * Process multiple URLs — any mix of supported sites
 * Body: { urls: ["https://..."], nocache: false }
 */
app.post('/batch', requireKey, async (req, res) => {
  const { urls, nocache = false } = req.body;
  if (!Array.isArray(urls) || !urls.length) return res.status(400).json({ error: '{ urls: ["..."] }' });
  if (urls.length > 10) return res.status(400).json({ error: 'Max 10 URLs per batch' });

  const results = await Promise.allSettled(
    urls.map(url => bypass(url, { skipCache: nocache }))
  );

  res.json({
    success: true,
    total  : urls.length,
    results: results.map((r, i) => ({
      url: urls[i],
      ...(r.status === 'fulfilled'
        ? { success: true,  data: r.value }
        : { success: false, error: r.reason?.message }),
    })),
  });
});

/**
 * GET /prefetch?url=...
 * Warm the cache in background — returns immediately
 */
app.get('/prefetch', requireKey, (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  bypass(url, { skipCache: true }).catch(e => console.warn(`[prefetch] ${e.message}`));
  res.json({ success: true, queued: url });
});

/**
 * DELETE /cache?url=...
 * Clear a specific URL from cache
 */
app.delete('/cache', requireMaster, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  const plugin = registry.match(url);
  if (!plugin) return res.status(400).json({ error: 'Unknown site' });
  await cache.del(`${plugin.id}:${url}`);
  res.json({ success: true, cleared: url });
});

// ══════════════════════════════════════════════════════════════════════════
// PLUGIN MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /sites
 * List all loaded site plugins
 */
app.get('/sites', (_, res) => {
  res.json(registry.list());
});

/**
 * POST /sites/:id/reload
 * Hot-reload a plugin without restarting server
 * Useful when you update a site parser
 */
app.post('/sites/:id/reload', requireMaster, (req, res) => {
  const result = registry.reload(req.params.id);
  res.json(result);
});

// ══════════════════════════════════════════════════════════════════════════
// OBSERVABILITY
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /stats
 * Full system stats — cache, circuits, registry, change alerts
 */
app.get('/stats', requireKey, async (_, res) => {
  const stats = await cache.getStats();
  res.json({
    cache    : stats,
    circuits : circuit.status(),
    registry : registry.status(),
    uptime_s : Math.round(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    node     : process.version,
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN
// ══════════════════════════════════════════════════════════════════════════

app.get('/admin/keys',          requireMaster, (_, res) => res.json({ keys: auth.list() }));
app.post('/admin/keys',         requireMaster, (req, res) => {
  const { label = 'unnamed', rateLimit = 30 } = req.body;
  res.json({ success: true, key: auth.create(label, rateLimit) });
});
app.delete('/admin/keys/:key',  requireMaster, (req, res) => {
  res.json({ success: auth.remove(req.params.key) });
});

// ── Health ───────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({
  status  : 'up',
  sites   : registry.list().length,
  ts      : Date.now(),
}));

// ── 404 ──────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({
  error    : 'Route not found',
  endpoints: ['/bypass', '/batch', '/prefetch', '/sites', '/stats', '/health'],
}));

app.listen(PORT, () => {
  console.log(`\n[multisite-bypass v7] :${PORT}`);
  console.log(`[sites] ${registry.list().map(s => s.id).join(', ')}`);
});
