'use strict';

const express    = require('express');
const { bypass } = require('./src/orchestrator');
const registry   = require('./src/registry');
const circuit    = require('./src/circuit');
const cache      = require('./src/cache');
const auth       = require('./src/auth');
const monitor    = require('./src/monitor');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.setHeader('X-Powered-By', 'multisite-bypass/8.0');
  next();
});

// ── Auth middleware ──────────────────────────────────────────────────────
const requireKey = (req, res, next) => {
  const k = req.headers['x-api-key'] || req.query.key;
  const r = auth.validate(k);
  if (!r.valid) return res.status(401).json({ success: false, error: r.reason });
  req.apiKey = r.rec;
  next();
};

const requireMaster = (req, res, next) => {
  const k = req.headers['x-api-key'] || req.query.key;
  if (!auth.isMaster(k)) return res.status(403).json({ success: false, error: 'Master key required' });
  next();
};

// ── Rate limit ───────────────────────────────────────────────────────────
const rateMap = new Map();
function rateLimit(max = 60) {
  return (req, res, next) => {
    const ip  = (req.headers['x-forwarded-for'] || req.ip || 'x').split(',')[0].trim();
    const now = Date.now();
    const rec = rateMap.get(ip) || { n: 0, t: now };
    if (now - rec.t > 60_000) { rateMap.set(ip, { n: 1, t: now }); return next(); }
    if (++rec.n > max) return res.status(429).json({ success: false, error: `Rate limit: ${max} req/min` });
    rateMap.set(ip, rec);
    next();
  };
}

// ════════════════════════════════════════════════════════════════════════
// PUBLIC ENDPOINTS
// ════════════════════════════════════════════════════════════════════════

app.get('/bypass', requireKey, rateLimit(60), async (req, res) => {
  const start            = Date.now();
  const { url, nocache } = req.query;

  if (!url) return res.status(400).json({
    success : false,
    error   : 'Missing ?url=',
    examples: [
      '/bypass?url=https://hubcloud.pw/drive/ABC',
      '/bypass?url=https://gofile.io/d/ABC',
      '/bypass?url=https://hubdrive.blog/file/123',
      '/bypass?url=https://new3.multicloudlinks.com/view/ABC',
      '/bypass?url=https://new2.drivehub.dad/file/123',
      '/bypass?url=https://streamtape.to/v/ABC',
    ],
  });

  // Get user's real IP — critical for streamtape CDN token binding
  const userIp = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || '')
    .split(',')[0]
    .trim();

  try {
    const result = await bypass(url, { skipCache: nocache === '1', userIp });
    monitor.recordRequest(result.site, true, Date.now() - start);
    res.json({ ...result, response_ms: Date.now() - start });
  } catch (e) {
    const siteId = _guessSiteId(url);
    monitor.recordRequest(siteId, false, Date.now() - start, e.message);
    console.error(`[/bypass] ${e.message}`);
    const code = e.message.includes('Invalid') || e.message.includes('Unsupported') || e.message.includes('not found') ? 400 : 502;
    res.status(code).json({ success: false, error: e.message, url, response_ms: Date.now() - start });
  }
});

app.post('/batch', requireKey, rateLimit(10), async (req, res) => {
  const start = Date.now();
  const { urls, nocache = false } = req.body;
  if (!Array.isArray(urls) || !urls.length) return res.status(400).json({ error: '{ urls: ["..."] }' });
  if (urls.length > 10) return res.status(400).json({ error: 'Max 10 URLs' });
  const results = await Promise.allSettled(urls.map(url => bypass(url, { skipCache: nocache })));
  res.json({
    success    : true,
    total      : urls.length,
    response_ms: Date.now() - start,
    results    : results.map((r, i) => ({
      url: urls[i],
      ...(r.status === 'fulfilled'
        ? { success: true,  data: r.value }
        : { success: false, error: r.reason?.message }),
    })),
  });
});

app.get('/prefetch', requireKey, (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  bypass(url, { skipCache: true }).catch(() => {});
  res.json({ success: true, queued: url });
});

app.get('/sites', requireKey, (_, res) => {
  res.json({
    success: true,
    sites  : registry.list(),
    health : monitor.siteHealth(),
  });
});

app.get('/stats', requireKey, async (_, res) => {
  const cacheStats = await cache.getStats();
  res.json({
    success  : true,
    cache    : cacheStats,
    circuits : circuit.status(),
    registry : registry.status(),
    monitor  : monitor.fullReport(),
    uptime_s : Math.round(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    node     : process.version,
  });
});

app.get('/health', (_, res) => res.json({
  status: 'up',
  sites : registry.list().length,
  ts    : Date.now(),
}));

// ════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS — MASTER KEY
// ════════════════════════════════════════════════════════════════════════

// API Key management
app.get('/admin/keys',          requireMaster, (_, res) => res.json({ success: true, keys: auth.list() }));
app.post('/admin/keys',         requireMaster, (req, res) => {
  const { label = 'unnamed', rateLimit = 60 } = req.body;
  const key = auth.create(label, rateLimit);
  res.json({ success: true, key, label, rateLimit });
});
app.delete('/admin/keys/:key',  requireMaster, (req, res) => {
  res.json({ success: auth.remove(req.params.key) });
});

// Cache management
app.delete('/admin/cache',      requireMaster, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  const plugin = registry.match(url);
  if (!plugin) return res.status(400).json({ error: 'Unknown site' });
  await cache.del(`${plugin.id}:${url}`);
  res.json({ success: true, cleared: url });
});
app.delete('/admin/cache/all',  requireMaster, async (_, res) => {
  await cache.flush();
  res.json({ success: true, message: 'All cache cleared' });
});

// Site management
app.get('/admin/sites',         requireMaster, (_, res) => {
  res.json({ success: true, sites: registry.list(), health: monitor.siteHealth() });
});
app.post('/admin/sites/:id/reload', requireMaster, (req, res) => {
  const result = registry.reload(req.params.id);
  res.json(result);
});
app.post('/admin/sites/:id/test',   requireMaster, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Provide test URL in body: { url: "..." }' });
  const start = Date.now();
  try {
    const result = await bypass(url, { skipCache: true });
    res.json({ success: true, site: result.site, servers: result.servers.length, ms: Date.now() - start });
  } catch (e) {
    res.json({ success: false, error: e.message, ms: Date.now() - start });
  }
});

// Circuit breaker control
app.post('/admin/circuit/:id/reset', requireMaster, (req, res) => {
  circuit.reset(req.params.id);
  res.json({ success: true, message: `Circuit reset for ${req.params.id}` });
});

// Monitor reset
app.delete('/admin/monitor',    requireMaster, (_, res) => {
  monitor.reset();
  res.json({ success: true, message: 'Monitor stats reset' });
});

// Admin Dashboard UI
app.get('/admin', requireMaster, (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(_adminDashboard());
});

// 404
app.use((req, res) => res.status(404).json({
  error    : 'Route not found',
  endpoints: ['/bypass', '/batch', '/sites', '/stats', '/health', '/admin'],
}));

function _guessSiteId(url) {
  try {
    const h = new URL(url).hostname;
    if (h.includes('hubcloud'))    return 'hubcloud';
    if (h.includes('hubdrive'))    return 'hubdrive';
    if (h.includes('gofile'))      return 'gofile';
    if (h.includes('drivehub'))    return 'drivehub';
    if (h.includes('multicloud'))  return 'multicloud';
    return 'unknown';
  } catch (_) { return 'unknown'; }
}

function _adminDashboard() {
  const masterKey = process.env.MASTER_API_KEY || 'changeme-master-key-set-in-env';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bypass API — Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0a0a;--surface:#111;--border:#222;--text:#e0e0e0;--muted:#666;--green:#22c55e;--red:#ef4444;--yellow:#eab308;--blue:#3b82f6;--purple:#a855f7}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:20px}
h1{font-size:18px;font-weight:700;margin-bottom:20px;color:#fff;display:flex;align-items:center;gap:8px}
h2{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:24px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px}
.card .val{font-size:28px;font-weight:700;color:#fff;margin-top:4px}
.card .lbl{font-size:11px;color:var(--muted)}
.section{margin-bottom:28px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:6px 10px;color:var(--muted);font-weight:500;border-bottom:1px solid var(--border)}
td{padding:8px 10px;border-bottom:1px solid #1a1a1a;vertical-align:middle}
.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600}
.ok{background:#052e16;color:var(--green)}
.warn{background:#1c1917;color:var(--yellow)}
.err{background:#1c0a0a;color:var(--red)}
input,select{background:#1a1a1a;border:1px solid var(--border);color:var(--text);padding:7px 10px;border-radius:6px;font-size:12px;font-family:inherit;outline:none}
input:focus,select:focus{border-color:#444}
button{background:var(--blue);color:#fff;border:none;padding:7px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;font-family:inherit}
button:hover{opacity:.85}
button.red{background:var(--red)}
button.green{background:#15803d}
button.purple{background:var(--purple)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
pre{background:#0d0d0d;border:1px solid var(--border);border-radius:6px;padding:10px;font-size:11px;overflow-x:auto;color:#a0aec0;max-height:200px;overflow-y:auto}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}
.dot.ok{background:var(--green)}
.dot.err{background:var(--red)}
.dot.warn{background:var(--yellow)}
#toast{position:fixed;bottom:20px;right:20px;background:#1a1a1a;border:1px solid var(--border);color:var(--text);padding:10px 16px;border-radius:8px;font-size:12px;display:none;z-index:999}
</style>
</head>
<body>
<h1>⚡ Bypass API Admin <span style="font-size:12px;color:var(--muted);font-weight:400">v8.0</span></h1>

<div class="section">
<h2>Live stats</h2>
<div class="grid">
  <div class="card"><div class="lbl">Total Bypassed</div><div class="val" id="s-total">—</div></div>
  <div class="card"><div class="lbl">Cache Hits</div><div class="val" id="s-hits">—</div></div>
  <div class="card"><div class="lbl">Success Rate</div><div class="val" id="s-rate">—</div></div>
  <div class="card"><div class="lbl">Avg Speed</div><div class="val" id="s-speed">—</div></div>
  <div class="card"><div class="lbl">Memory</div><div class="val" id="s-mem">—</div></div>
  <div class="card"><div class="lbl">Uptime</div><div class="val" id="s-up">—</div></div>
</div>
</div>

<div class="section">
<h2>Site Health</h2>
<table>
<thead><tr><th>Site</th><th>Status</th><th>Requests</th><th>Errors</th><th>Avg ms</th><th>Last Error</th><th>Circuit</th><th>Actions</th></tr></thead>
<tbody id="site-tbody"></tbody>
</table>
</div>

<div class="section">
<h2>API Keys</h2>
<div class="row">
  <input id="key-label" placeholder="Label (e.g. myapp)" style="width:140px">
  <input id="key-rl" placeholder="Rate/min" style="width:80px" value="60">
  <button onclick="createKey()">+ Create Key</button>
</div>
<div id="new-key-out" style="font-size:11px;color:var(--green);margin-bottom:8px;word-break:break-all"></div>
<table>
<thead><tr><th>Label</th><th>Key</th><th>Rate Limit</th><th>Calls (this min)</th><th>Created</th><th></th></tr></thead>
<tbody id="key-tbody"></tbody>
</table>
</div>

<div class="section">
<h2>Test Bypass</h2>
<div class="row">
  <input id="test-url" placeholder="https://hubdrive.blog/file/..." style="flex:1;min-width:200px">
  <select id="test-site">
    <option value="">Auto-detect</option>
    <option value="hubcloud">HubCloud</option>
    <option value="hubdrive">HubDrive</option>
    <option value="multicloud">MultiCloud</option>
    <option value="drivehub">DriveHub</option>
    <option value="gofile">GoFile</option>
  </select>
  <button onclick="testBypass()">▶ Run</button>
  <button class="red" onclick="testBypass(true)">↺ Force Fresh</button>
</div>
<pre id="test-out" style="display:none"></pre>
</div>

<div class="section">
<h2>Cache Management</h2>
<div class="row">
  <input id="cache-url" placeholder="URL to clear from cache" style="flex:1;min-width:200px">
  <button class="red" onclick="clearCache()">Clear URL</button>
  <button class="red" onclick="clearAllCache()">Clear All Cache</button>
</div>
</div>

<div id="toast"></div>

<script>
const MASTER = '${masterKey}';

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'X-API-Key': MASTER, 'Content-Type': 'application/json', ...opts.headers },
  });
  return r.json();
}

function toast(msg, ok = true) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  t.style.borderColor = ok ? '#22c55e' : '#ef4444';
  setTimeout(() => t.style.display = 'none', 3000);
}

async function loadStats() {
  try {
    const d = await api('/stats');
    const m = d.monitor || {};
    document.getElementById('s-total').textContent = m.total_requests || '0';
    document.getElementById('s-hits').textContent  = d.cache?.cache_hits || '0';
    const rate = m.total_requests > 0 ? Math.round((m.total_success / m.total_requests) * 100) : 100;
    document.getElementById('s-rate').textContent  = rate + '%';
    document.getElementById('s-speed').textContent = (m.avg_ms || 0) + 'ms';
    document.getElementById('s-mem').textContent   = (d.memory_mb || 0) + 'MB';
    const up = d.uptime_s || 0;
    document.getElementById('s-up').textContent    = up > 3600 ? Math.floor(up/3600) + 'h' : Math.floor(up/60) + 'm';

    // Site health table
    const sites    = d.monitor?.sites || {};
    const circuits = d.circuits || {};
    const tbody    = document.getElementById('site-tbody');
    tbody.innerHTML = Object.entries(sites).map(([id, s]) => {
      const circuit  = circuits[id] || 'CLOSED';
      const statusOk = s.errors === 0 && circuit === 'CLOSED';
      const statusCl = statusOk ? 'ok' : circuit === 'OPEN' ? 'err' : 'warn';
      const statusTx = statusOk ? 'Healthy' : circuit === 'OPEN' ? 'Circuit Open' : 'Degraded';
      return \`<tr>
        <td><strong>\${id}</strong></td>
        <td><span class="badge \${statusCl}">\${statusTx}</span></td>
        <td>\${s.requests || 0}</td>
        <td style="color:\${s.errors > 0 ? '#ef4444' : '#22c55e'}">\${s.errors || 0}</td>
        <td>\${s.avg_ms || 0}ms</td>
        <td style="font-size:10px;color:#666;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${s.last_error || '—'}</td>
        <td><span class="badge \${circuit === 'CLOSED' ? 'ok' : 'err'}">\${circuit}</span></td>
        <td style="display:flex;gap:4px">
          <button class="green" style="padding:3px 8px;font-size:11px" onclick="reloadSite('\${id}')">Reload</button>
          <button style="padding:3px 8px;font-size:11px" onclick="resetCircuit('\${id}')">Reset CB</button>
        </td>
      </tr>\`;
    }).join('') || '<tr><td colspan="8" style="color:#666;text-align:center">No data yet — make some requests</td></tr>';
  } catch(e) { console.error(e); }
}

async function loadKeys() {
  try {
    const d     = await api('/admin/keys');
    const tbody = document.getElementById('key-tbody');
    tbody.innerHTML = (d.keys || []).map(k => \`<tr>
      <td>\${k.label}</td>
      <td><code style="font-size:11px;color:#a855f7">\${k.key}</code></td>
      <td>\${k.rateLimit}/min</td>
      <td>\${k.calls || 0}</td>
      <td style="color:#666">\${new Date(k.created).toLocaleDateString()}</td>
      <td><button class="red" style="padding:3px 8px;font-size:11px" onclick="deleteKey('\${k.fullKey}')">Delete</button></td>
    </tr>\`).join('') || '<tr><td colspan="6" style="color:#666;text-align:center">No custom keys</td></tr>';
  } catch(e) {}
}

async function createKey() {
  const label = document.getElementById('key-label').value.trim() || 'unnamed';
  const rl    = parseInt(document.getElementById('key-rl').value) || 60;
  const d     = await api('/admin/keys', { method: 'POST', body: JSON.stringify({ label, rateLimit: rl }) });
  if (d.key) {
    document.getElementById('new-key-out').textContent = '✓ New key: ' + d.key;
    toast('Key created: ' + d.key);
    loadKeys();
  }
}

async function deleteKey(key) {
  if (!confirm('Delete this key?')) return;
  await api('/admin/keys/' + encodeURIComponent(key), { method: 'DELETE' });
  toast('Key deleted');
  loadKeys();
}

async function testBypass(fresh = false) {
  const url = document.getElementById('test-url').value.trim();
  if (!url) { toast('Enter a URL first', false); return; }
  const out = document.getElementById('test-out');
  out.style.display = 'block';
  out.textContent   = 'Running bypass...';
  const params = fresh ? '&nocache=1' : '';
  try {
    const d = await api('/bypass?url=' + encodeURIComponent(url) + params);
    out.textContent = JSON.stringify(d, null, 2);
    toast(d.success ? \`✓ \${d.servers?.length} servers found in \${d.response_ms}ms\` : '✗ ' + d.error, d.success);
  } catch(e) { out.textContent = 'Error: ' + e.message; toast(e.message, false); }
}

async function reloadSite(id) {
  const d = await api('/admin/sites/' + id + '/reload', { method: 'POST' });
  toast(d.success ? id + ' reloaded' : d.error, d.success);
  loadStats();
}

async function resetCircuit(id) {
  const d = await api('/admin/circuit/' + id + '/reset', { method: 'POST' });
  toast(d.success ? id + ' circuit reset' : d.error, d.success);
  loadStats();
}

async function clearCache() {
  const url = document.getElementById('cache-url').value.trim();
  if (!url) { toast('Enter URL to clear', false); return; }
  await api('/admin/cache?url=' + encodeURIComponent(url), { method: 'DELETE' });
  toast('Cache cleared for URL');
}

async function clearAllCache() {
  if (!confirm('Clear ALL cache?')) return;
  await api('/admin/cache/all', { method: 'DELETE' });
  toast('All cache cleared');
}

// Load on start
loadStats();
loadKeys();
// Auto-refresh every 15s
setInterval(loadStats, 15000);
</script>
</body>
</html>`;
}

app.listen(PORT, () => {
  console.log('\n[multisite-bypass v8] :' + PORT);
  console.log('[sites] ' + registry.list().map(s => s.id).join(', '));
});
