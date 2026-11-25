'use strict';

const https = require('https');
const http  = require('http');
const zlib  = require('zlib');

// ── Persistent agents — TCP reuse, no handshake per request ─────────────
const HTTPS_AGENT = new https.Agent({
  keepAlive           : true,
  keepAliveMsecs      : 10000,
  maxSockets          : 64,
  maxFreeSockets      : 16,
  timeout             : 20000,
  rejectUnauthorized  : false,   // skip SSL verify — faster
});

const HTTP_AGENT = new http.Agent({
  keepAlive     : true,
  keepAliveMsecs: 10000,
  maxSockets    : 64,
  maxFreeSockets: 16,
});

// ── UA pool ──────────────────────────────────────────────────────────────
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

const SEC_CH = {
  'Chrome/124': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Chrome/123': '"Chromium";v="123", "Google Chrome";v="123", "Not-A.Brand";v="8"',
};

function pickUA() {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

function buildHeaders(ua, referer, extraHeaders = {}) {
  const verM = ua.match(/Chrome\/([\d]+)/);
  const key  = verM ? `Chrome/${verM[1]}` : 'Chrome/124';
  const plat = ua.includes('Macintosh') ? '"macOS"' : ua.includes('X11') ? '"Linux"' : '"Windows"';
  return {
    'User-Agent'               : ua,
    'Accept'                   : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language'          : 'en-US,en;q=0.9',
    'Accept-Encoding'          : 'gzip, deflate, br',
    'Cache-Control'            : 'max-age=0',
    'Connection'               : 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-CH-UA'                : SEC_CH[key] || SEC_CH['Chrome/124'],
    'Sec-CH-UA-Mobile'         : '?0',
    'Sec-CH-UA-Platform'       : plat,
    'Sec-Fetch-Dest'           : 'document',
    'Sec-Fetch-Mode'           : 'navigate',
    'Sec-Fetch-User'           : '?1',
    'Referer'                  : referer || 'https://www.google.com/',
    ...extraHeaders,
  };
}

// ── Cookie jar ───────────────────────────────────────────────────────────
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
  header()  { return [...this._m.entries()].map(([k,v]) => `${k}=${v}`).join('; '); }
  clear()   { this._m.clear(); }
}

const globalJar = new CookieJar();

// ── Blocked domains ──────────────────────────────────────────────────────
const BLOCKED = [
  'bonuscaf.com', 'bonusca.com', 'winexch.com', 'acscdn.com',
  'cleverwebserver.com', 'adsboosters', 'googletagmanager',
  'google-analytics', 'd33f51dyacx7bd', 'cloudfront.net/aydfd',
  'sads.adsboosters', 'aclib.js',
];

function isBlocked(url) {
  return BLOCKED.some(d => url.includes(d));
}

// ── Core GET — keepAlive agent, fast timeout ─────────────────────────────
function rawGet(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const {
      referer      = 'https://www.google.com/',
      maxRedirects = 8,          // 15 → 8, kam hops = fast
      timeout      = 12000,      // 25s → 12s
      headers      : extraHeaders = {},
      jar          = globalJar,
      ua           = pickUA(),
    } = opts;

    let hops = maxRedirects;

    function doReq(cur) {
      if (isBlocked(cur)) return reject(new Error(`Blocked: ${cur}`));

      let parsed;
      try { parsed = new URL(cur); } catch (e) { return reject(new Error(`Bad URL: ${cur}`)); }

      const isHttps = parsed.protocol === 'https:';
      const lib     = isHttps ? https : http;
      const agent   = isHttps ? HTTPS_AGENT : HTTP_AGENT;

      const headers = {
        ...buildHeaders(ua, referer, extraHeaders),
        'Cookie': jar.header(),
      };

      const req = lib.request({
        hostname: parsed.hostname,
        port    : parsed.port || (isHttps ? 443 : 80),
        path    : parsed.pathname + parsed.search,
        method  : 'GET',
        agent,              // ← persistent TCP
        timeout,
        headers,
      }, (res) => {
        // Cookies
        const sc = res.headers['set-cookie'];
        if (sc) jar.ingest(sc);

        // Redirects
        const loc = res.headers['location'];
        if ([301,302,303,307,308].includes(res.statusCode) && loc) {
          if (hops-- <= 0) return reject(new Error('Too many redirects'));
          const next = loc.startsWith('http') ? loc : new URL(loc, cur).href;
          if (isBlocked(next)) return reject(new Error(`Blocked redirect: ${next}`));
          // consume response body before next hop
          res.resume();
          return doReq(next);
        }

        // Body — decompress
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

// ── Core POST ────────────────────────────────────────────────────────────
function rawPost(url, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const {
      referer = url,
      timeout = 10000,      // 20s → 10s
      json    = false,
      jar     = globalJar,
      ua      = pickUA(),
      headers : extraHeaders = {},
    } = opts;

    const parsed  = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const agent   = isHttps ? HTTPS_AGENT : HTTP_AGENT;
    const data    = json ? JSON.stringify(body) : new URLSearchParams(body).toString();
    const ct      = json ? 'application/json' : 'application/x-www-form-urlencoded';

    const headers = {
      ...buildHeaders(ua, referer, extraHeaders),
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
      headers,
    }, (res) => {
      const sc = res.headers['set-cookie'];
      if (sc) jar.ingest(sc);

      const loc = res.headers['location'];
      if ([301,302,303].includes(res.statusCode) && loc) {
        res.resume();
        const next = loc.startsWith('http') ? loc : new URL(loc, url).href;
        return rawGet(next, { referer: url, jar, ua }).then(resolve).catch(reject);
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

module.exports = { rawGet, rawPost, sleep, globalJar, CookieJar, pickUA, isBlocked };
