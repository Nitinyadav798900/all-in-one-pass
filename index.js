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

const requireMaster = (req, res, next) => {
  const k = req.headers['x-api-key'] || req.query.key;
  const masterKey = process.env.MASTER_API_KEY || 'changeme-master-key-set-in-env';
  if (k !== masterKey) return res.status(403).json({ success: false, error: 'Master key required' });
  next();
};

// ══════════════════════════════════════════════════════════════════════════
// PUBLIC ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════

app.get('/bypass', rateLimit(60), async (req, res) => {
  const { url, nocache } = req.query;
  if (!url) {
    return res.status(400).json({
      success : false,
      error   : 'Missing ?url= parameter',
      examples: [
        '/bypass?url=https://hubcloud.pw/drive/ABC123',
        '/bypass?url=https://gofile.io/d/pVawQzDG',
        '/bypass?url=https://pixeldrain.dev/u/hNpELhd9',
        '/bypass?url=https://voe.sx/m3ev6b5kiypu',
        '/bypass?url=https://doodstream.com/e/abc123',
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

app.get('/prefetch', rateLimit(10), (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  bypass(url, { skipCache: true }).catch(e => console.warn(`[prefetch] ${e.message}`));
  res.json({ success: true, queued: url });
});

app.get('/sites', (_, res) => res.json(registry.list()));

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

app.get('/health', (_, res) => res.json({
  status: 'up',
  sites : registry.list().length,
  ts    : Date.now(),
}));

// ══════════════════════════════════════════════════════════════════════════
// INFO, FORMATS, PLAYLIST, PROXY
// ══════════════════════════════════════════════════════════════════════════

app.get('/info', rateLimit(60), async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ success: false, error: 'Missing ?url=' });
  try {
    const plugin = registry.match(url);
    if (!plugin) return res.status(400).json({
      success: false,
      error  : `Unsupported site: ${new URL(url).hostname}`,
    });
    const result = await bypass(url, { skipCache: true });
    const server = result.servers?.[0];
    let size = result.metadata?.size || null;
    let mime = null;
    if (server?.url) {
      try {
        const { rawGet, CookieJar } = require('./src/http');
        const headRes = await rawGet(server.url, {
          jar    : new CookieJar(),
          headers: { ...(server.headers || {}), Range: 'bytes=0-0' },
          timeout: 8000,
        });
        size = headRes.headers?.['content-range']
          ? parseInt(headRes.headers['content-range'].split('/')[1]) || size
          : parseInt(headRes.headers?.['content-length']) || size;
        mime = headRes.headers?.['content-type'] || null;
      } catch {}
    }
    res.json({
      success : true,
      site    : plugin.id,
      file_id : result.file_id,
      metadata: {
        title      : result.metadata?.title || result.file_id,
        size_bytes : size,
        size_human : size ? _humanSize(size) : null,
        type       : server?.type || null,
        mime,
        encrypted  : result.metadata?.encrypted || false,
      },
      url,
    });
  } catch (e) {
    res.status(502).json({ success: false, error: e.message, url });
  }
});

app.get('/formats', rateLimit(30), async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ success: false, error: 'Missing ?url=' });
  try {
    const result  = await bypass(url, { skipCache: true });
    const servers = result.servers || [];
    const hlsSrv  = servers.find(s => s.type === 'hls');
    if (hlsSrv) {
      try {
        const { rawGet } = require('./src/http');
        const m3u8Res   = await rawGet(hlsSrv.url, { headers: hlsSrv.headers || {}, timeout: 10000 });
        const formats   = _parseHlsManifest(m3u8Res.body || '', hlsSrv.url);
        return res.json({
          success: true,
          site   : result.site,
          file_id: result.file_id,
          formats: formats.length ? formats : [{ quality: 'auto', url: hlsSrv.url, type: 'hls', bandwidth: null }],
        });
      } catch {}
    }
    res.json({
      success: true,
      site   : result.site,
      file_id: result.file_id,
      formats: servers.map((s, i) => ({
        quality  : s.label || `stream_${i}`,
        url      : s.url,
        type     : s.type,
        bandwidth: null,
      })),
    });
  } catch (e) {
    res.status(502).json({ success: false, error: e.message, url });
  }
});

app.get('/playlist', rateLimit(30), async (req, res) => {
  const { url, quality } = req.query;
  if (!url) return res.status(400).json({ success: false, error: 'Missing ?url=' });
  try {
    const result  = await bypass(url, { skipCache: false });
    const hlsSrv  = (result.servers || []).find(s => s.type === 'hls');
    if (!hlsSrv) return res.status(400).json({
      success: false,
      error  : 'No HLS stream found for this URL',
      servers: result.servers,
    });
    const { rawGet } = require('./src/http');
    const m3u8Res   = await rawGet(hlsSrv.url, { headers: hlsSrv.headers || {}, timeout: 10000 });
    const manifest  = m3u8Res.body || '';
    const formats   = _parseHlsManifest(manifest, hlsSrv.url);
    if (!formats.length) {
      return res.json({
        success : true,
        type    : 'media_playlist',
        url     : hlsSrv.url,
        headers : hlsSrv.headers,
        segments: (manifest.match(/#EXTINF/g) || []).length,
      });
    }
    let selected = formats[0];
    if (quality) {
      const q = quality.toLowerCase().replace('p', '');
      selected = formats.find(f => String(f.height) === q || f.quality === quality) || formats[0];
    }
    res.json({
      success : true,
      type    : 'master_playlist',
      selected,
      all     : formats,
      headers : hlsSrv.headers,
    });
  } catch (e) {
    res.status(502).json({ success: false, error: e.message, url });
  }
});

// ── PROXY — stream proxy with full session warming ─────────────────────
app.get('/proxy', rateLimit(20), async (req, res) => {
  const { url, referer, cookie } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing ?url=' });

  try {
    const { rawGet, CookieJar } = require('./src/http');
    const jar = new CookieJar();

    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    const headers = {
      'User-Agent'     : UA,
      'Accept'         : '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity',
      'Referer'        : referer || new URL(url).origin + '/',
      'Origin'         : new URL(url).origin,
    };
    if (cookie) headers['Cookie'] = cookie;

    // ── PixelDrain: warm session before proxying ──────────────────────
    const isPd = url.includes('pixeldrain');
    if (isPd) {
      const fileId = url.match(/\/file\/([A-Za-z0-9]+)/)?.[1];
      if (fileId) {
        const pdHost = new URL(url).hostname;
        // step 1: load viewer page — sets session cookies
        await rawGet(`https://${pdHost}/u/${fileId}`, {
          jar,
          headers        : { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
          followRedirects: true,
          timeout        : 10000,
        }).catch(() => {});
        // step 2: hit info API — warms CDN session
        await rawGet(`https://${pdHost}/api/file/${fileId}/info`, {
          jar,
          headers: { 'User-Agent': UA, 'Referer': `https://${pdHost}/u/${fileId}` },
          timeout: 5000,
        }).catch(() => {});
        // step 3: set correct headers for final request
        headers['Referer'] = `https://${pdHost}/u/${fileId}`;
        headers['Origin']  = `https://${pdHost}`;
        try { headers['Cookie'] = jar.header(); } catch {}
      }
    }

    // ── Fetch upstream ────────────────────────────────────────────────
    const upstream = await rawGet(url, {
      jar,
      headers,
      followRedirects: true,
      timeout        : 30000,
    });

    if (!upstream || !upstream.body) {
      return res.status(502).json({ error: 'Empty response from upstream' });
    }

    const ct = upstream.headers?.['content-type'] || 'application/octet-stream';
    const cl = upstream.headers?.['content-length'];
    const cr = upstream.headers?.['content-range'];
    const ac = upstream.headers?.['accept-ranges'];

    res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Cache-Control', 'no-cache');
    if (cl) res.setHeader('Content-Length', cl);
    if (cr) res.setHeader('Content-Range', cr);
    if (ac) res.setHeader('Accept-Ranges', ac);

    // ── m3u8 — rewrite segment URLs through proxy ─────────────────────
    if (ct.includes('mpegurl') || url.includes('.m3u8')) {
      const baseUrl   = url.substring(0, url.lastIndexOf('/') + 1);
      const rewritten = (upstream.body || '')
        .split('\n')
        .map(line => {
          line = line.trim();
          if (!line || line.startsWith('#')) return line;
          const absUrl = line.startsWith('http') ? line : baseUrl + line;
          return `/proxy?url=${encodeURIComponent(absUrl)}&referer=${encodeURIComponent(headers['Referer'])}`;
        })
        .join('\n');
      return res.send(rewritten);
    }

    res.send(upstream.body);
  } catch (e) {
    console.error(`[/proxy] ${e.message}`);
    res.status(502).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════

function _humanSize(bytes) {
  if (!bytes) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(2)} ${units[i]}`;
}

function _parseHlsManifest(manifest, baseUrl) {
  const formats = [];
  const base    = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
  const lines   = manifest.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const bw     = line.match(/BANDWIDTH=(\d+)/)?.[1];
      const res    = line.match(/RESOLUTION=(\d+x\d+)/)?.[1];
      const height = res ? parseInt(res.split('x')[1]) : null;
      const next   = lines[i + 1]?.trim();
      if (next && !next.startsWith('#')) {
        formats.push({
          quality  : height ? `${height}p` : 'auto',
          height,
          bandwidth: bw ? parseInt(bw) : null,
          url      : next.startsWith('http') ? next : base + next,
          type     : 'hls',
        });
        i++;
      }
    }
  }
  return formats.sort((a, b) => (b.height || 0) - (a.height || 0));
}

// ══════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS
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
  endpoints: ['/bypass', '/batch', '/prefetch', '/sites', '/stats', '/health', '/info', '/formats', '/playlist', '/proxy'],
}));

app.listen(PORT, () => {
  console.log(`\n[multisite-bypass v7] :${PORT}`);
  console.log(`[sites] ${registry.list().map(s => s.id).join(', ')}`);
});
