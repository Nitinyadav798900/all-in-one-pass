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
// DEBUG ENDPOINTS — REMOVE AFTER VOE FIX
// ══════════════════════════════════════════════════════════════════════════

app.get('/debug-voe', rateLimit(10), async (req, res) => {
  const { rawGet, CookieJar } = require('./src/http');
  const targetUrl = req.query.url || 'https://voe.sx/m3ev6b5kiypu';
  const fileId    = (targetUrl.match(/\/([a-z0-9]{8,20})(?:[?/]|$)/) || [])[1] || 'm3ev6b5kiypu';

  const HEADERS = {
    'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer'        : 'https://voe.sx/',
    'Origin'         : 'https://voe.sx',
  };

  try {
    const jar = new CookieJar();

    const pageRes = await rawGet(targetUrl, {
      headers: HEADERS, jar, followRedirects: true, timeout: 15000,
    });

    let embedBody = '';
    let embedErr  = null;
    try {
      const embedRes = await rawGet(`https://voe.sx/e/${fileId}`, {
        headers: { ...HEADERS, Referer: targetUrl }, jar, timeout: 10000,
      });
      embedBody = embedRes.body;
    } catch (e) { embedErr = e.message; }

    let altEmbedBody = '';
    let altEmbedErr  = null;
    try {
      const altRes = await rawGet(`https://caseyseemavoid.com/e/${fileId}`, {
        headers: { ...HEADERS, Referer: targetUrl }, jar, timeout: 10000,
      });
      altEmbedBody = altRes.body;
    } catch (e) { altEmbedErr = e.message; }

    res.json({
      file_id: fileId,
      page: {
        url        : pageRes.url,
        length     : pageRes.body.length,
        snippet    : pageRes.body.slice(0, 6000),
        m3u8_hits  : (pageRes.body.match(/m3u8/gi)        || []).length,
        atob_hits  : (pageRes.body.match(/atob/gi)        || []).length,
        wurl_hits  : (pageRes.body.match(/wurl/gi)        || []).length,
        hls_hits   : (pageRes.body.match(/['"]hls['"]/gi) || []).length,
        source_hits: (pageRes.body.match(/var\s+source/gi)|| []).length,
      },
      embed_voe: {
        error      : embedErr,
        length     : embedBody.length,
        snippet    : embedBody.slice(0, 6000),
        m3u8_hits  : (embedBody.match(/m3u8/gi)        || []).length,
        atob_hits  : (embedBody.match(/atob/gi)        || []).length,
        wurl_hits  : (embedBody.match(/wurl/gi)        || []).length,
        hls_hits   : (embedBody.match(/['"]hls['"]/gi) || []).length,
      },
      embed_casey: {
        error      : altEmbedErr,
        length     : altEmbedBody.length,
        snippet    : altEmbedBody.slice(0, 50000),
        m3u8_hits  : (altEmbedBody.match(/m3u8/gi)  || []).length,
        atob_hits  : (altEmbedBody.match(/atob/gi)  || []).length,
        wurl_hits  : (altEmbedBody.match(/wurl/gi)  || []).length,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

app.get('/debug-voe2', rateLimit(10), async (req, res) => {
  const { rawGet, CookieJar } = require('./src/http');
  const fileId = req.query.id || 'm3ev6b5kiypu';

  const HEADERS = {
    'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept'         : '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer'        : `https://caseyseemavoid.com/e/${fileId}`,
    'Origin'         : 'https://caseyseemavoid.com',
  };

  try {
    const jar = new CookieJar();

    // 1. fetch loader.js — decode logic is here
    let loaderJs  = '';
    let loaderErr = null;
    try {
      const loaderRes = await rawGet('https://caseyseemavoid.com/js/loader.a40897e.js', {
        headers: HEADERS, jar, timeout: 10000,
      });
      loaderJs = loaderRes.body;
    } catch (e) { loaderErr = e.message; }

    // 2. fetch casey embed page
    const pageRes = await rawGet(`https://caseyseemavoid.com/e/${fileId}`, {
      headers: { ...HEADERS, Referer: 'https://voe.sx/' }, jar, timeout: 15000,
    });
    const html = pageRes.body;

    // 3. extract application/json script tag — encoded payload lives here
    const jsonMatch    = html.match(/<script type="application\/json">\s*(\[[\s\S]*?\])\s*<\/script>/);
    const encodedPayload = jsonMatch ? jsonMatch[1] : null;

    // 4. decode attempt — split on known separators
    let decodedAttempt = null;
    if (encodedPayload) {
      try {
        const arr = JSON.parse(encodedPayload);
        const str = arr[0];

        const tokens = str
          .split(/\^\^|!!|~@|#&|@\$|\*~|%\?/g)
          .filter(t => t.length > 0);

        // each token is likely a 2-char encoded char — map A-Z0-9 → char
        // try simple base conversion: each token = row+col in charset
        const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
        const separators = ['^^', '!!', '~@', '#&', '@$', '*~', '%?'];

        // attempt: each token is 2-4 chars, try treating as index pairs
        const decoded = tokens.map(t => {
          // try: first char = row (A=0,B=1..Z=25,a=26..z=51,0=52..9=61)
          // second char = col offset
          const c1 = t.charCodeAt(0);
          const c2 = t.charCodeAt(1);
          // simple XOR attempt
          return String.fromCharCode(c1 ^ c2);
        }).join('');

        res.json({
          loader_js_length : loaderJs.length,
          loader_js_err    : loaderErr,
          loader_js_snippet: loaderJs.slice(0, 5000),
          payload_length   : encodedPayload.length,
          payload_snippet  : encodedPayload.slice(0, 300),
          total_tokens     : tokens.length,
          first_30_tokens  : tokens.slice(0, 30),
          xor_decoded_peek : decoded.slice(0, 200),
          script_srcs      : [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]),
        });
      } catch (e) {
        res.json({
          loader_js_length : loaderJs.length,
          loader_js_err    : loaderErr,
          loader_js_snippet: loaderJs.slice(0, 5000),
          parse_error      : e.message,
          script_srcs      : [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]),
        });
      }
    } else {
      res.json({
        loader_js_length : loaderJs.length,
        loader_js_err    : loaderErr,
        loader_js_snippet: loaderJs.slice(0, 5000),
        encoded_payload  : null,
        note             : 'application/json script tag not found in casey embed',
        script_srcs      : [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]),
      });
    }
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

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
  endpoints: ['/bypass', '/batch', '/prefetch', '/sites', '/stats', '/health'],
}));

app.listen(PORT, () => {
  console.log(`\n[multisite-bypass v7] :${PORT}`);
  console.log(`[sites] ${registry.list().map(s => s.id).join(', ')}`);
});
