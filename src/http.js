'use strict';

const https = require('https');
const http  = require('http');
const zlib  = require('zlib');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

// ── Proxy pool ────────────────────────────────────────────────────────────
// Vercel env vars: PROXY_1, PROXY_2, ... ya PROXY_LIST=url1,url2,...
function _loadProxyPool() {
  const pool = [];
  for (let i = 1; i <= 20; i++) {
    const p = process.env[`PROXY_${i}`];
    if (p) pool.push(p.trim());
  }
  const list = process.env.PROXY_LIST;
  if (list) list.split(',').forEach(p => { const t = p.trim(); if (t) pool.push(t); });

  if (pool.length === 0) console.warn('[http] no proxies configured -- direct connection');
  else console.log(`[http] proxy pool: ${pool.length} proxies loaded`);
  return pool;
}

const PROXY_POOL = _loadProxyPool();
let _proxyIdx   = 0;

function _getProxyAgent() {
  if (!PROXY_POOL.length) return null;
  const proxy = PROXY_POOL[_proxyIdx % PROXY_POOL.length];
  _proxyIdx++;
  try {
    return proxy.startsWith('socks')
      ? new SocksProxyAgent(proxy)
      : new HttpsProxyAgent(proxy);
  } catch (e) {
    console.warn(`[http] bad proxy: ${proxy} -- ${e.message}`);
    return null;
  }
}

// ── Domains that go through proxy ─────────────────────────────────────────
const PROXY_DOMAINS = [
  'multicloudlinks.com',
  'multicloudlinks.net',
  'multicloudlinks.org',
  'multidownload.click',
  'reqinstant.multicloudlinks.com',
  'viking.multicloudlinks.com',
  'pixeldra.multicloudlinks.com',
  'gdbazar.com',
  'filebee.live',
];

function _needsProxy(url) {
  if (!PROXY_POOL.length) return false;
  return PROXY_DOMAINS.some(d => url.includes(d));
}

// ── Persistent direct agents ──────────────────────────────────────────────
const HTTPS_AGENT = new https.Agent({
  keepAlive          : true,
  keepAliveMsecs     : 10000,
  maxSockets         : 64,
  maxFreeSockets     : 16,
  timeout            : 20000,
  rejectUnauthorized : false,
});

const HTTP_AGENT = new http.Agent({
  keepAlive     : true,
  keepAliveMsecs: 10000,
  maxSockets    : 64,
  maxFreeSockets: 16,
});

// ── UA pool ───────────────────────────────────────────────────────────────
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36 Edg/158.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

const SEC_CH_MAP = {
  'Edg/158'   : '"Chromium";v="158", "Not.A/Brand";v="24", "Microsoft Edge";v="158"',
  'Chrome/124': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Chrome/123': '"Chromium";v="123", "Google Chrome";v="123", "Not-A.Brand";v="8"',
};

function pickUA() {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

function buildHeaders(ua, referer, extraHeaders = {}) {
  let secCH = SEC_CH_MAP['Chrome/124'];
  for (const [key, val] of Object.entries(SEC_CH_MAP)) {
    if (ua.includes(key)) { secCH = val; break; }
  }
  const plat = ua.includes('Macintosh') ? '"macOS"' : ua.includes('X11') ? '"Linux"' : '"Windows"';

  const base = {
    'User-Agent'               : ua,
    'Accept'                   : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language'          : 'en-US,en;q=0.9',
    'Accept-Encoding'          : 'gzip, deflate, br',
    'Cache-Control'            : 'max-age=0',
    'Connection'               : 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-CH-UA'                : secCH,
    'Sec-CH-UA-Mobile'         : '?0',
    'Sec-CH-UA-Platform'       : plat,
    'Sec-Fetch-Dest'           : 'document',
    'Sec-Fetch-Mode'           : 'navigate',
    'Sec-Fetch-Site'           : 'none',
    'Sec-Fetch-User'           : '?1',
    'Priority'                 : 'u=0, i',
  };

  if (referer && !referer.includes('google.com')) {
    base['Referer']        = referer;
    base['Sec-Fetch-Site'] = 'same-origin';
  }

  return { ...base, ...extraHeaders };
}

// ── Cookie jar ────────────────────────────────────────────────────────────
class CookieJar {
  constructor() { this._m = new Map(); }
  ingest(arr = []) {
    for (const h of (Array.isArray(arr) ? arr : [arr])) {
      const pair = h.split(';')[0].trim();
      const eq   = pair.indexOf('=');
      if (eq < 1) continue;
      this._m.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  set(k, v) { this._m.set(k, v); }
  get(k)    { return this._m.get(k); }
  header()  { return [...this._m.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  clear()   { this._m.clear(); }
}

const globalJar = new CookieJar();

// ── Blocked domains ───────────────────────────────────────────────────────
const BLOCKED = [
  'bonuscaf.com', 'bonusca.com', 'winexch.com', 'acscdn.com',
  'cleverwebserver.com', 'adsboosters', 'googletagmanager',
  'google-analytics', 'd33f51dyacx7bd', 'cloudfront.net/aydfd',
  'sads.adsboosters', 'aclib.js',
];

function isBlocked(url) {
  return BLOCKED.some(d => url.includes(d));
}

// ── rawGet ────────────────────────────────────────────────────────────────
function rawGet(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const {
      maxRedirects = 8,
      timeout      = 15000,
      headers      : extraHeaders = {},
      jar          = globalJar,
      ua           = pickUA(),
      referer      : initReferer,
      useProxy     : forceProxy = false,
    } = opts;

    let hops           = maxRedirects;
    let currentReferer = initReferer || null;

    function doReq(cur) {
      if (isBlocked(cur)) return reject(new Error(`Blocked: ${cur}`));

      let parsed;
      try { parsed = new URL(cur); }
      catch (e) { return reject(new Error(`Bad URL: ${cur}`)); }

      const isHttps    = parsed.protocol === 'https:';
      const lib        = isHttps ? https : http;
      const useProxyNow = forceProxy || _needsProxy(cur);
      const agent      = useProxyNow
        ? (_getProxyAgent() || (isHttps ? HTTPS_AGENT : HTTP_AGENT))
        : (isHttps ? HTTPS_AGENT : HTTP_AGENT);

      if (useProxyNow) console.log(`[http] proxy→ ${cur.slice(0, 70)}`);

      const hdrs = {
        ...buildHeaders(ua, currentReferer, extraHeaders),
        'Cookie': jar.header(),
      };

      const req = lib.request({
        hostname: parsed.hostname,
        port    : parsed.port || (isHttps ? 443 : 80),
        path    : parsed.pathname + parsed.search,
        method  : 'GET',
        agent,
        timeout,
        headers : hdrs,
      }, (res) => {
        const sc = res.headers['set-cookie'];
        if (sc) jar.ingest(sc);

        const loc = res.headers['location'];
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc) {
          if (hops-- <= 0) return reject(new Error('Too many redirects'));
          const next = loc.startsWith('http') ? loc : new URL(loc, cur).href;
          if (isBlocked(next)) return reject(new Error(`Blocked redirect: ${next}`));
          res.resume();
          currentReferer = cur;
          return doReq(next);
        }

        const chunks = [];
        let stream   = res;
        const enc    = (res.headers['content-encoding'] || '').toLowerCase();
        if      (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
        else if (enc === 'br')      stream = res.pipe(zlib.createBrotliDecompress());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

        stream.on('data',  c => chunks.push(c));
        stream.on('error', reject);
        stream.on('end',   () => resolve({
          body    : Buffer.concat(chunks).toString('utf8'),
          finalUrl: cur,
          status  : res.statusCode,
          headers : res.headers,
        }));
      });

      req.on('error',   reject);
      req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${cur}`)); });
      req.end();
    }

    doReq(url);
  });
}

// ── rawPost ───────────────────────────────────────────────────────────────
function rawPost(url, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const {
      timeout  = 10000,
      json     = false,
      jar      = globalJar,
      ua       = pickUA(),
      headers  : extraHeaders = {},
      referer  : initReferer,
      useProxy : forceProxy = false,
    } = opts;

    const parsed    = new URL(url);
    const isHttps   = parsed.protocol === 'https:';
    const lib       = isHttps ? https : http;
    const useProxyNow = forceProxy || _needsProxy(url);
    const agent     = useProxyNow
      ? (_getProxyAgent() || (isHttps ? HTTPS_AGENT : HTTP_AGENT))
      : (isHttps ? HTTPS_AGENT : HTTP_AGENT);

    const data = json ? JSON.stringify(body) : new URLSearchParams(body).toString();
    const ct   = json ? 'application/json' : 'application/x-www-form-urlencoded';

    const hdrs = {
      ...buildHeaders(ua, initReferer, extraHeaders),
      'Content-Type'  : ct,
      'Content-Length': Buffer.byteLength(data),
      'Cookie'        : jar.header(),
    };

    const req = lib.request({
      hostname: parsed.hostname,
      port    : parsed.port || (isHttps ? 443 : 80),
      path    : parsed.pathname + parsed.search,
      method  : 'POST',
      agent,
      timeout,
      headers : hdrs,
    }, (res) => {
      const sc = res.headers['set-cookie'];
      if (sc) jar.ingest(sc);

      const loc = res.headers['location'];
      if ([301, 302, 303].includes(res.statusCode) && loc) {
        res.resume();
        const next = loc.startsWith('http') ? loc : new URL(loc, url).href;
        return rawGet(next, { referer: url, jar, ua, useProxy: forceProxy }).then(resolve).catch(reject);
      }

      const chunks = [];
      let stream   = res;
      const enc    = (res.headers['content-encoding'] || '').toLowerCase();
      if      (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      else if (enc === 'br')      stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

      stream.on('data',  c => chunks.push(c));
      stream.on('error', reject);
      stream.on('end',   () => resolve({
        body    : Buffer.concat(chunks).toString('utf8'),
        finalUrl: url,
        status  : res.statusCode,
        headers : res.headers,
      }));
    });

    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout POST: ${url}`)); });
    req.write(data);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { rawGet, rawPost, sleep, globalJar, CookieJar, pickUA, isBlocked, _needsProxy };
