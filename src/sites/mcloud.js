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
    this.version = '7.0.0';
    this.domains = ['mcloud.best'];
  }

  extract(url) {
    const u     = new URL(url);
    const match = u.pathname.match(/\/([a-zA-Z0-9_-]{6,})/);
    if (!match) throw new Error('MCloud: cannot extract file ID');
    return {
      id      : match[1],
      host    : u.hostname,
      // if token already in URL, use it directly
      token   : u.searchParams.get('token') || null,
    };
  }

  validate(html) {
    return {
      valid : html.includes('mirrors-container') ||
              html.includes('Download Links Ready') ||
              html.includes('pixeldrain') ||
              html.includes('r2.dev') ||
              html.includes('FSL') ||
              html.includes('data-minute-base-url'),
      reason: 'Not a mirror page',
    };
  }

  /**
   * Main entry — two modes:
   *
   * Mode A (normal): url = "https://mcloud.best/FILEID"
   *   → needs html1 passed via options.html (page 1 HTML from browser)
   *   → extracts token → hits page 2
   *
   * Mode B (token url): url = "https://mcloud.best/FILEID?token=XXX"
   *   → hits page 2 directly, no html1 needed
   */
  async bypass(url, options = {}) {
    const { id, host, token: tokenInUrl } = this.extract(url);
    const domain  = this.domains[0];

    // ── Mode B: token already in URL ─────────────────────────────────────────
    if (tokenInUrl) {
      console.error('[mcloud] Mode B: token in URL, hitting mirror page directly');
      const r = await _fetch(url, `https://${domain}/${id}`);
      console.error(`[mcloud] mirror → ${r.status} (${r.body.length}b)`);

      if (r.status === 200) {
        const servers = _parseServers(r.body);
        if (servers.length > 0) {
          return this._result(id, _parseMeta(r.body), servers, { final_page: r.finalUrl });
        }
        console.error('[mcloud] mirror html:\n', r.body.slice(0, 3000));
        throw new Error('MCloud: mirror page hit but no links found');
      }
      throw new Error(`MCloud: mirror page failed status=${r.status}`);
    }

    // ── Mode A: extract token from page 1 HTML ────────────────────────────────
    // html1 must be provided — browser fetches page 1 (CF passes for real browsers)
    // then sends it to our API
    const html1 = options.html || null;

    if (!html1) {
      throw new Error(
        'MCloud: page 1 HTML required.\n' +
        'Send page source via options.html, OR pass token URL directly.\n' +
        'See integration guide below.'
      );
    }

    console.error('[mcloud] Mode A: extracting token from provided HTML');

    const tokenUrl = _extractTokenUrl(html1, host);
    if (!tokenUrl) {
      console.error('[mcloud] html1:\n', html1.slice(0, 3000));
      throw new Error('MCloud: token not found in provided HTML');
    }
    console.error('[mcloud] token url:', tokenUrl);

    // hit page 2
    const landingUrl = `https://${domain}/${id}`;
    const r2         = await _fetch(tokenUrl, landingUrl);
    console.error(`[mcloud] mirror → ${r2.status} (${r2.body.length}b)`);

    if (r2.status !== 200) {
      throw new Error(`MCloud: mirror page failed status=${r2.status}`);
    }

    const meta    = _parseMeta(r2.body);
    const servers = _parseServers(r2.body);

    if (servers.length === 0) {
      console.error('[mcloud] mirror html:\n', r2.body.slice(0, 4000));
      throw new Error('MCloud: no download links found in mirror page');
    }

    return this._result(id, meta, servers, { final_page: r2.finalUrl });
  }
}

// ── Token extractor from page 1 HTML ─────────────────────────────────────────
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

// ── Bare fetch — no CF needed for page 2 ─────────────────────────────────────
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
      hostname : parsed.hostname,
      port     : parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path     : parsed.pathname + parsed.search,
      method   : 'GET',
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
          ? b => new Promise((r,e) => zlib.brotliDecompress(b, (err,d) => err?e(err):r(d.toString())))
          : enc.includes('gzip')
            ? b => new Promise((r,e) => zlib.gunzip(b, (err,d) => err?e(err):r(d.toString())))
            : enc.includes('deflate')
              ? b => new Promise((r,e) => zlib.inflate(b, (err,d) => err?e(err):r(d.toString())))
              : b => Promise.resolve(b.toString('utf8'));
        dec(raw)
          .then(body => resolve({ status: res.statusCode, body, finalUrl: url }))
          .catch(reject);
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
