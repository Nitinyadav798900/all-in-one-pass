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
  res.setHeader('X-Powered-By', 'multisite-bypass/7.0');
  next();
});

// Simple rate limit — IP based, no key needed
const rateMap = new Map();
function rateLimit(max = 60, windowMs = 60_000) {
  return (req, res, next) => {
    const ip  = (req.headers['x-forwarded-for'] || req.ip || 'x').split(',')[0].trim();
    const now = Date.now();
    const rec = rateMap.get(ip) || { n: 0, t: now };
    if (now - rec.t > windowMs) { rateMap.set(ip, { n: 1, t: now }); return next(); }
    if (++rec.n > max) return res.status(429).json({ success: false, error: `Rate limit: ${max} req/min` });
    rateMap.set(ip, rec);
    next();
  };
}

// Master key check — only for admin routes
const requireMaster = (req, res, next) => {
  const k = req.headers['x-api-key'] || req.query.key;
  const masterKey = process.env.MASTER_API_KEY || 'changeme-master-key-set-in-env';
  if (k !== masterKey) return res.status(403).json({ success: false, error: 'Master key required' });
  next();
};

// ══════════════════════════════════════════════════════════════════════════
// PUBLIC ENDPOINTS — NO AUTH NEEDED
// ══════════════════════════════════════════════════════════════════════════

// Main bypass endpoint — no key needed
app.get('/bypass', rateLimit(60), async (req, res) => {
  const { url, nocache } = req.query;
  if (!url) {
    return res.status(400).json({
      success : false,
      error   : 'Missing ?url= parameter',
      examples: [
        '/bypass?url=https://hubcloud.pw/drive/ABC123',
        '/bypass?url=https://gofile.io/d/pVawQzDG',
        '/bypass?url=https://hubdrive.blog/file/3002211248',
        '/bypass?url=https://new3.multicloudlinks.com/view/f533404ca2',
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

// Batch — no key needed
app.post('/batch', rateLimit(10), async (req, res) => {
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

// Prefetch — no key needed
app.get('/prefetch', rateLimit(10), (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  bypass(url, { skipCache: true }).catch(e => console.warn(`[prefetch] ${e.message}`));
  res.json({ success: true, queued: url });
});

// Sites list — no key needed
app.get('/sites', (_, res) => {
  res.json(registry.list());
});

// Stats — no key needed
app.get('/stats', async (_, res) => {
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

// Health — no key needed
app.get('/health', (_, res) => res.json({
  status: 'up',
  sites : registry.list().length,
  ts    : Date.now(),
}));

// ══════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS — MASTER KEY REQUIRED
// ══════════════════════════════════════════════════════════════════════════

app.get('/admin/keys', requireMaster, (_, res) => res.json({ keys: auth.list() }));

app.post('/admin/keys', requireMaster, (req, res) => {
  const { label = 'unnamed', rateLimit = 30 } = req.body;
  res.json({ success: true, key: auth.create(label, rateLimit) });
});

app.delete('/admin/keys/:key', requireMaster, (req, res) => {
  res.json({ success: auth.remove(req.params.key) });
});

app.delete('/cache', requireMaster, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  const plugin = registry.match(url);
  if (!plugin) return res.status(400).json({ error: 'Unknown site' });
  await cache.del(`${plugin.id}:${url}`);
  res.json({ success: true, cleared: url });
});

app.post('/sites/:id/reload', requireMaster, (req, res) => {
  const result = registry.reload(req.params.id);
  res.json(result);
});

// 404
app.use((req, res) => res.status(404).json({
  error    : 'Route not found',
  endpoints: ['/bypass', '/batch', '/prefetch', '/sites', '/stats', '/health'],
}));

app.listen(PORT, () => {
  console.log(`\n[multisite-bypass v7] :${PORT}`);
  console.log(`[sites] ${registry.list().map(s => s.id).join(', ')}`);
});
