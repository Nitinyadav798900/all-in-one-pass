'use strict';

const BaseSite = require('../site-base');
const https    = require('https');
const http     = require('http');
const zlib     = require('zlib');

class MCloud extends BaseSite {
  constructor() {
    super();
    this.name    = 'MCloud';
    this.id      = 'mcloud';
    this.version = '8.0.0';
    this.domains = ['mcloud.best'];
  }

  extract(url) {
    const u     = new URL(url);
    const match = u.pathname.match(/\/([a-zA-Z0-9_-]{6,})/);
    if (!match) throw new Error('MCloud: cannot extract file ID');
    return {
      id    : match[1],
      host  : u.hostname,
      token : u.searchParams.get('token') || null,
    };
  }

  validate(html) {
    return {
      valid : html.includes('mirrors-container') ||
              html.includes('Download Links Ready') ||
              html.includes('pixeldrain') ||
              html.includes('r2.dev') ||
              html.includes('data-minute-base-url') ||
              html.includes('FSL'),
      reason: 'Not a mirror page',
    };
  }

  async bypass(url) {
    const { id, host, token } = this.extract(url);
    const domain              = this.domains[0];
    const landingUrl          = `https://${domain}/${id}`;

    // ── Mode A: token already in URL — seedha page 2 ─────────────────────────
    if (token) {
      console.error('[mcloud] token in URL → direct mirror hit');
      return await this._hitMirror(url, landingUrl, id);
    }

    // ── Mode B: try hitting page 1 without CF (sometimes works) ──────────────
    console.error('[mcloud] trying page 1 direct...');
    try {
      const r1 = await _fetch(landingUrl, 'https://www.google.com/');
      console.error(`[mcloud] page1 → ${r1.status} (${r1.body.length}b)`);

      if (r1.status === 200 && r1.body.length > 500) {
        const tokenUrl = _extractToken(r1.body, host);
        if (tokenUrl) {
          console.error('[mcloud] got token from page1:', tokenUrl);
          return await this._hitMirror(tokenUrl, landingUrl, id);
        }
      }
    } catch (e) {
      console.error('[mcloud] page1 direct failed:', e.message);
    }

    // ── Mode C: construct token URL from known token in page HTML ─────────────
    // This token was hardcoded in page HTML tune paste kiya tha
    // Token = base64(signed_payload) — server side verify karta hai
    // Hum directly token URL hit kar sakte hain agar token fresh hai
    const knownToken = 'K2s0Z1pBeER2enpqQ2VuOEJGVHVNSFl4TmdKMnlSUHNENUp3dS95NzJQYz0=';
    const tryUrl     = `${landingUrl}?token=${encodeURIComponent(knownToken)}`;
    
    console.error('[mcloud] trying known token...');
    try {
      const rt = await _fetch(tryUrl, landingUrl);
      if (rt.status === 200 && _parseServers(rt.body).length > 0) {
        console.error('[mcloud] known token worked!');
        return this._result(id, _parseMeta(rt.body), _parseServers(rt.body), { final_page: rt.finalUrl });
      }
      console.error('[mcloud] known token expired, body:', rt.body.slice(0, 300));
    } catch (e) {
      console.error('[mcloud] known token try failed:', e.message);
    }

    // ── Mode D: tell caller exactly what to send ──────────────────────────────
    throw new Error(
      JSON.stringify({
        code   : 'MCLOUD_NEED_TOKEN',
        message: 'MCloud CF bypass failed. Send token URL directly.',
        fix    : 'Pass this URL to bypass: https://mcloud.best/' + id + '?token=TOKEN',
        howto  : [
          '1. Open https://mcloud.best/' + id + ' in browser',
          '2. Right click Generate Download Link button → Inspect',
          '3. Find onclick value: location.assign("/...?token=XXX")',
          '4. Call API with: { url: "https://mcloud.best/' + id + '?token=XXX" }',
        ],
      })
    );
  }

  async _hitMirror(tokenUrl, referer, id) {
    const r = await _fetch(tokenUrl, referer);
    console.error(`[mcloud] mirror → ${r.status} (${r.body.length}b)`);

    if (r.status !== 200) {
      console.error('[mcloud] mirror body:', r.body.slice(0, 500));
      throw new Error(`MCloud: mirror page ${r.status} — token may be expired`);
    }

    const servers = _parseServers(r.body);
    if (servers.length === 0) {
      console.error('[mcloud] mirror html:\n', r.body.slice(0, 4000));
      throw new Error('MCloud: mirror page ok but no links found');
    }

    return this._result(id, _parseMeta(r.body), servers, { final_page: r.finalUrl });
  }
}

// ── Token extractor ───────────────────────────────────────────────────────────
function _extractToken(html, host) {
  const patterns = [
    /location\.assign\(["']([^"']+\?token=[^"']+)["']\)/i,
    /location\.href\s*=\s*["']([^"']+\?token=[^"']+)["']/i,
    /["']([^"']*\/[a-zA-Z0-9_-]{6,}\?token=[A-Za-z0-9+/=]{10,})["']/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      const path = m[1];
      if (path.startsWith('http')) return path;
      return `https://${host}${path.startsWith('/') ? '' : '/'}${path}`;
    }
  }
  return null;
}

// ── Fetch ─────────────────────────────────────────────────────────────────────
function _fetch(url, referer = '', redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('too many redirects'));
    const parsed = new URL(url);
    const lib    = parsed.protocol === 'https:' ? https : http;

    const headers = {
      'User-Agent':                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language':           'en-US,en;q=0.9',
      'Accept-Encoding':           'gzip, deflate, br',
      'Cache-Control':             'max-age=0',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest':            'document',
      'Sec-Fetch-Mode':            'navigate',
      'Sec-Fetch-Site':            referer ? 'same-origin' : 'none',
      'Sec-Fetch-User':            '?1',
      'Connection':                'keep-alive',
    };
    if (referer) headers['Referer'] = referer;

    const req = lib.request({
      hostname: parsed.hostname,
      port    : parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path    : parsed.pathname + parsed.search,
      method  : 'GET',
      headers,
    }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
        res.resume();
        return resolve(_fetch(next, referer, redirects + 1));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const enc = res.headers['content-encoding'] || '';
        const dec = enc.includes('br')
          ? b => new Promise((r,e) => zlib.brotliDecompress(b,(err,d) => err?e(err):r(d.toString())))
          : enc.includes('gzip')
            ? b => new Promise((r,e) => zlib.gunzip(b,(err,d) => err?e(err):r(d.toString())))
            : enc.includes('deflate')
              ? b => new Promise((r,e) => zlib.inflate(b,(err,d) => err?e(err):r(d.toString())))
              : b => Promise.resolve(b.toString('utf8'));
        dec(raw).then(body => resolve({ status: res.statusCode, body, finalUrl: url })).catch(reject);
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function _parseMeta(html) {
  const meta = {};
  const fn = html.match(/<div[^>]*card-header[^>]*>\s*([^<\n]{3,300}?)\s*<\/div>/i);
  if (fn) meta.filename = fn[1].trim();
  const sz = html.match(/Size[\s\S]{1,120}?<i[^>]*>([\d.,\s]+[KMGT]?B)<\/i>/i);
  if (sz) meta.size = sz[1].trim();
  const tp = html.match(/MimeType[\s\S]{1,120}?<i[^>]*>([^<]+)<\/i>/i);
  if (tp) meta.type = tp[1].trim();
  return meta;
}

function _parseServers(html) {
  const links = [], seen = new Set();
  const push  = (label, url, server) => {
    if (!url || !url.startsWith('http') || seen.has(url)) return;
    seen.add(url); links.push({ label, url, server });
  };
  let m;

  const r2Re = /href=["'](https:\/\/[a-z0-9-]+\.r2(?:\.dev|\.cloudflarestorage\.com)\/[^"']+)["']/gi;
  while ((m = r2Re.exec(html)) !== null) push('FSL Server', m[1], 'r2');

  const minBase = html.match(/data-minute-base-url=["'](https?:\/\/[^"']+)["']/i);
  if (minBase) push('FSL Server (timed)', minBase[1] + String(new Date().getUTCMinutes()), 'r2-timed');

  const pxlJs = html.match(/var\s+pxl\s*=\s*["'](https?:\/\/pixeldrain[^"']+)["']/i);
  if (pxlJs) push('PixelDrain Server', pxlJs[1], 'pixeldrain');

  const pxlRe = /href=["'](https?:\/\/pixeldrain[^"']+)["']/gi;
  while ((m = pxlRe.exec(html)) !== null) push('PixelDrain Server', m[1], 'pixeldrain');

  const cdnRe = /href=["'](https?:\/\/pub-[a-z0-9]+\.r2\.dev\/[^"']+)["']/gi;
  while ((m = cdnRe.exec(html)) !== null) push('CDN Server', m[1], 'cdn');

  return links;
}

module.exports = new MCloud();
