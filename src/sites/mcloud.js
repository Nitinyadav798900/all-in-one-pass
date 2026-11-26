'use strict';

const BaseSite = require('../site-base');
const { rawGet, sleep, globalJar } = require('../http');

const CF_CLEARANCE = process.env.MCLOUD_CF_CLEARANCE ||
  'Ctog45rvOhDSLTZQUngTqrwuUoOyz0hrU3Ny1eseB9yrOXWbgW52uGNk3jQ0z3cc-ZYEpWAgfq4hC9vux3c6V3qugiXjjzx4Jzc-uSz3Bj1qRnbP1kxaWdJKHYrT3It6PgA7q8nJArhEXerbCfybgmeWSyNCQRQpUMuE4wCSTOTcG8pOBpc0cWNXP0LicGbJYXHRXJoDpGKYhvFjVCpKio1RCMkK21Kcjnt3mxqLXm5XHvuqd_H4SnE9h5mn503Px6-ilSayU2KIcnFTcnJKBOt-2MJalOwsesmd3W9s-QtjhtEWEFPnAuFbPp5-n5G7uSyarcEHxog6akacuc949wdtW7eRM8Au5b6g4_Ha1wKH4L5gnrPgwMslGS-MUbhIrfbpbhBlbtuMPZnTuPI';

class MCloud extends BaseSite {
  constructor() {
    super();
    this.name    = 'MCloud';
    this.id      = 'mcloud';
    this.version = '4.0.0';
    this.domains = ['mcloud.best'];
  }

  extract(url) {
    const u     = new URL(url);
    const match = u.pathname.match(/\/([a-zA-Z0-9_-]{6,})/);
    if (!match) throw new Error('MCloud: cannot extract file ID from URL');
    return { id: match[1], host: u.hostname };
  }

  validate(html) {
    return {
      valid : html.includes('card-header') ||
              html.includes('Generate Download Link') ||
              html.includes('list-group') ||
              html.includes('mCloud'),
      reason: 'Missing expected MCloud structure',
    };
  }

  async bypass(url) {
    const { id, host } = this.extract(url);
    const landingUrl   = `https://${this.domains[0]}/${id}`;

    // ── Step 1: landing page — cookie as raw header string ───────────────────
    const r1 = await _fetch(landingUrl, 'https://www.google.com/');

    console.error(`[mcloud] landing → ${r1.status} (${r1.body.length}b)`);
    console.error(`[mcloud] body[:300]: ${r1.body.slice(0, 300)}`);

    if (r1.status !== 200 || r1.body.length < 300) {
      throw new Error(`MCloud: landing failed status=${r1.status} bytes=${r1.body.length}`);
    }

    const v = this.validate(r1.body);
    if (!v.valid) {
      console.error('[mcloud] html[:2000]:\n', r1.body.slice(0, 2000));
      throw new Error('MCloud: ' + v.reason);
    }

    // ── Step 2: extract token URL ────────────────────────────────────────────
    const tokenUrl = _extractTokenUrl(r1.body, host);
    if (!tokenUrl) {
      console.error('[mcloud] full html:\n', r1.body.slice(0, 4000));
      throw new Error('MCloud: token URL not found');
    }
    console.error('[mcloud] token url:', tokenUrl);

    // ── Step 3: mirror page ──────────────────────────────────────────────────
    const r2 = await _fetch(tokenUrl, r1.finalUrl || landingUrl);
    console.error(`[mcloud] mirror → ${r2.status} (${r2.body.length}b)`);

    const meta    = _parseMeta(r2.body);
    const servers = _parseServers(r2.body);

    if (servers.length === 0) {
      console.error('[mcloud] mirror html:\n', r2.body.slice(0, 4000));
      throw new Error('MCloud: no download links found');
    }

    return this._result(id, meta, servers, { final_page: r2.finalUrl });
  }
}

// ── Core fetch — bypasses globalJar, injects Cookie header directly ───────────
async function _fetch(url, referer = '') {
  const https     = require('https');
  const http      = require('http');
  const zlib      = require('zlib');

  const cookieStr = `cf_clearance=${CF_CLEARANCE}`;

  const headers = {
    'User-Agent':                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language':           'en-US,en;q=0.9',
    'Accept-Encoding':           'gzip, deflate, br',
    'Cache-Control':             'max-age=0',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest':            'document',
    'Sec-Fetch-Mode':            'navigate',
    'Sec-Fetch-Site':            referer ? 'same-origin' : 'none',
    'Sec-Fetch-User':            '?1',
    'sec-ch-ua':                 '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile':          '?0',
    'sec-ch-ua-platform':        '"Windows"',
    'Cookie':                    cookieStr,
    'Connection':                'keep-alive',
  };
  if (referer) headers['Referer'] = referer;

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib    = parsed.protocol === 'https:' ? https : http;

    const req = lib.request({
      hostname : parsed.hostname,
      port     : parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path     : parsed.pathname + parsed.search,
      method   : 'GET',
      headers,
    }, (res) => {
      // Handle redirect
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const nextUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
        return resolve(_fetch(nextUrl, url));
      }

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw      = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'] || '';

        const decompress = (buf) => new Promise((res2, rej2) => {
          if (encoding.includes('br')) {
            zlib.brotliDecompress(buf, (e, d) => e ? rej2(e) : res2(d.toString('utf8')));
          } else if (encoding.includes('gzip')) {
            zlib.gunzip(buf, (e, d) => e ? rej2(e) : res2(d.toString('utf8')));
          } else if (encoding.includes('deflate')) {
            zlib.inflate(buf, (e, d) => e ? rej2(e) : res2(d.toString('utf8')));
          } else {
            res2(buf.toString('utf8'));
          }
        });

        decompress(raw)
          .then(body => resolve({ status: res.statusCode, body, finalUrl: url, headers: res.headers }))
          .catch(reject);
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ── Token URL extractor ───────────────────────────────────────────────────────
function _extractTokenUrl(html, fallbackHost) {
  const patterns = [
    /location\.assign\(["']([^"']+\?token=[^"']+)["']\)/i,
    /location\.href\s*=\s*["']([^"']+\?token=[^"']+)["']/i,
    /window\.location\s*=\s*["']([^"']+\?token=[^"']+)["']/i,
    /["']([^"']*\/[a-zA-Z0-9_-]{6,}\?token=[A-Za-z0-9+/=]{10,})["']/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      const path = m[1];
      if (path.startsWith('http')) return path;
      return `https://${fallbackHost}${path.startsWith('/') ? '' : '/'}${path}`;
    }
  }
  return null;
}

// ── Meta parser ───────────────────────────────────────────────────────────────
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

// ── Server parser ─────────────────────────────────────────────────────────────
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
  if (minBase) {
    push('FSL Server (timed)', minBase[1] + String(new Date().getUTCMinutes()), 'r2-timed');
  }

  const pxlJs = html.match(/var\s+pxl\s*=\s*["'](https?:\/\/pixeldrain[^"']+)["']/i);
  if (pxlJs) push('PixelDrain Server', pxlJs[1], 'pixeldrain');

  const pxlRe = /href=["'](https?:\/\/pixeldrain[^"']+)["']/gi;
  while ((m = pxlRe.exec(html)) !== null) push('PixelDrain Server', m[1], 'pixeldrain');

  const cdnRe = /href=["'](https?:\/\/pub-[a-z0-9]+\.r2\.dev\/[^"']+)["']/gi;
  while ((m = cdnRe.exec(html)) !== null) push('CDN Server', m[1], 'cdn');

  return links;
}

module.exports = new MCloud();
