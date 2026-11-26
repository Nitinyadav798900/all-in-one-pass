'use strict';

const BaseSite          = require('../site-base');
const { rawGet, sleep, globalJar } = require('../http');

class MCloud extends BaseSite {
  constructor() {
    super();
    this.name    = 'MCloud';
    this.id      = 'mcloud';
    this.version = '1.0.0';
    this.domains = [
      'mcloud.best',
    ];
  }

  extract(url) {
    const u     = new URL(url);
    // path: /q0f0wkqn9cdf1co  or  /q0f0wkqn9cdf1co?token=...
    const match = u.pathname.match(/\/([a-zA-Z0-9_-]{8,})/);
    if (!match) throw new Error('MCloud: cannot extract file ID from URL');
    return { id: match[1], host: u.hostname };
  }

  validate(html) {
    return {
      valid : html.includes('card-header') || html.includes('Generate Download Link'),
      reason: 'Missing expected MCloud structure',
    };
  }

  async bypass(url) {
    const { id, host } = this.extract(url);

    // ── Step 1: landing page → extract token redirect path ──────────────────
    let html1, url1;
    for (const domain of this.domains) {
      const landingUrl = `https://${domain}/${id}`;
      try {
        const r = await rawGet(landingUrl, { referer: 'https://www.google.com/' });
        if (r.status === 200 && r.body.length > 500) {
          html1 = r.body;
          url1  = r.finalUrl;
          break;
        }
      } catch (_) {}
    }
    if (!html1) throw new Error(`MCloud: landing page not found (${id})`);

    const v = this.validate(html1);
    if (!v.valid) throw new Error(`MCloud: ${v.reason}`);

    // ── Step 2: extract token URL from JS onclick ────────────────────────────
    const tokenUrl = _extractTokenUrl(html1, host);
    if (!tokenUrl) throw new Error('MCloud: token URL not found in landing page');

    // ── Step 3: hit token URL → mirror page ─────────────────────────────────
    const r2      = await rawGet(tokenUrl, { referer: url1 });
    const meta    = _parseMeta(r2.body);
    const servers = _parseServers(r2.body);

    if (servers.length === 0) {
      console.error('[mcloud] token url   :', tokenUrl);
      console.error('[mcloud] final url   :', r2.finalUrl);
      console.error('[mcloud] html snippet:', r2.body.slice(0, 1200));
      throw new Error('MCloud: no download links found — token may have expired');
    }

    return this._result(id, meta, servers, { final_page: r2.finalUrl });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _extractTokenUrl(html, fallbackHost) {
  /*
   * Page 1 JS:
   *   window.location.assign("/q0f0wkqn9cdf1co?token=BASE64=");
   * or inline onclick:
   *   onclick="window.location.assign('...')"
   */
  const patterns = [
    /location\.assign\(["']([^"']+\?token=[^"']+)["']\)/i,
    /location\.href\s*=\s*["']([^"']+\?token=[^"']+)["']/i,
    /["']([^"']*\/[a-zA-Z0-9_-]+\?token=[A-Za-z0-9+/=]+)["']/,
  ];

  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      const path = m[1];
      // already absolute
      if (path.startsWith('http')) return path;
      // relative path → make absolute
      return `https://${fallbackHost}${path.startsWith('/') ? '' : '/'}${path}`;
    }
  }
  return null;
}

function _parseMeta(html) {
  const meta = {};

  // filename from card-header
  const fn = html.match(/<div[^>]*card-header[^>]*>\s*([^<\n]{3,300}?)\s*<\/div>/i);
  if (fn) meta.filename = fn[1].trim();

  // size from list-group-item
  const sz = html.match(/Size[\s\S]{1,120}?<i[^>]*>([\d.,\s]+[KMGT]?B)<\/i>/i);
  if (sz) meta.size = sz[1].trim();

  // mime type
  const tp = html.match(/MimeType[\s\S]{1,120}?<i[^>]*>([^<]+)<\/i>/i);
  if (tp) meta.type = tp[1].trim();

  return meta;
}

function _parseServers(html) {
  const links = [], seen = new Set();

  const push = (label, url, server) => {
    if (!url || !url.startsWith('http') || seen.has(url)) return;
    seen.add(url);
    links.push({ label, url, server });
  };

  // ── FSL / Cloudflare R2 ──────────────────────────────────────────────────
  // Static href
  const r2Re = /href=["'](https:\/\/[a-z0-9-]+\.r2(?:\.dev|\.cloudflarestorage\.com)\/[^"']+)["']/gi;
  let m;
  while ((m = r2Re.exec(html)) !== null) push('FSL Server', m[1], 'r2');

  // Minute-rotated token (data-minute-base-url)
  // <a href="..." data-minute-base-url="https://...?token=BASE&t=" ...>
  const minBase = html.match(/data-minute-base-url=["'](https?:\/\/[^"']+)["']/i);
  if (minBase) {
    // Reproduce JS: base_url + new Date().getMinutes()
    const minute  = new Date().getUTCMinutes();
    const fslUrl  = minBase[1] + String(minute);
    push('FSL Server (timed)', fslUrl, 'r2-timed');
  }

  // ── PixelDrain ───────────────────────────────────────────────────────────
  // JS var
  const pxlJs = html.match(/var\s+pxl\s*=\s*["'](https?:\/\/pixeldrain[^"']+)["']/i);
  if (pxlJs) push('PixelDrain Server', pxlJs[1], 'pixeldrain');

  // href
  const pxlRe = /href=["'](https?:\/\/pixeldrain[^"']+)["']/gi;
  while ((m = pxlRe.exec(html)) !== null) push('PixelDrain Server', m[1], 'pixeldrain');

  // ── Generic fallback: any big CDN href ───────────────────────────────────
  const cdnRe = /href=["'](https?:\/\/(?:pub-[a-z0-9]+\.r2\.dev|cdn\.[^"']+|dl\.[^"']+)\/[^"']{20,})["']/gi;
  while ((m = cdnRe.exec(html)) !== null) push('CDN Server', m[1], 'cdn');

  return links;
}

module.exports = new MCloud();
