'use strict';

const BaseSite          = require('../site-base');
const { rawGet, sleep, globalJar } = require('../http');

class MCloud extends BaseSite {
  constructor() {
    super();
    this.name    = 'MCloud';
    this.id      = 'mcloud';
    this.version = '1.1.0';
    this.domains = ['mcloud.best'];

    // Full browser header set — CF needs these or it 403s
    this._cfHeaders = {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-Fetch-Dest':  'document',
      'Sec-Fetch-Mode':  'navigate',
      'Sec-Fetch-Site':  'none',
      'Sec-Fetch-User':  '?1',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control':   'max-age=0',
      'Connection':      'keep-alive',
    };
  }

  extract(url) {
    const u     = new URL(url);
    const match = u.pathname.match(/\/([a-zA-Z0-9_-]{6,})/);
    if (!match) throw new Error('MCloud: cannot extract file ID from URL');
    return { id: match[1], host: u.hostname };
  }

  validate(html) {
    return {
      valid : html.includes('card-header') || html.includes('Generate Download Link') || html.includes('mCloud'),
      reason: 'Missing expected MCloud structure',
    };
  }

  async bypass(url) {
    const { id, host } = this.extract(url);

    // ── Step 1: landing page ─────────────────────────────────────────────────
    let html1, url1, status1;
    for (const domain of this.domains) {
      const landingUrl = `https://${domain}/${id}`;
      try {
        const r = await rawGet(landingUrl, {
          referer : 'https://www.google.com/',
          headers : this._cfHeaders,
          followRedirects: true,
        });

        status1 = r.status;

        // Debug: log what we got
        console.error(`[mcloud] GET ${landingUrl} → ${r.status} (${r.body.length} bytes)`);
        console.error(`[mcloud] final url: ${r.finalUrl}`);
        console.error(`[mcloud] body head: ${r.body.slice(0, 400)}`);

        if (r.status === 200 && r.body.length > 200) {
          html1 = r.body;
          url1  = r.finalUrl;
          break;
        }

        // CF challenge page — need clearance
        if (r.status === 403 || r.body.includes('cf-browser-verification') || r.body.includes('Just a moment')) {
          throw new Error(`MCloud: Cloudflare challenge on ${domain} — cf_clearance cookie required`);
        }

      } catch (e) {
        console.error(`[mcloud] domain ${domain} failed:`, e.message);
      }
    }

    if (!html1) {
      throw new Error(
        `MCloud: landing page not reachable (id=${id}, last_status=${status1})\n` +
        `Likely Cloudflare bot protection. Pass cf_clearance cookie via globalJar.`
      );
    }

    // ── Step 2: extract token URL ────────────────────────────────────────────
    const tokenUrl = _extractTokenUrl(html1, host);
    if (!tokenUrl) {
      console.error('[mcloud] html1 snippet for debug:\n', html1.slice(0, 2000));
      throw new Error('MCloud: token URL not found in landing page');
    }
    console.error('[mcloud] token url:', tokenUrl);

    // ── Step 3: mirror page ──────────────────────────────────────────────────
    const r2 = await rawGet(tokenUrl, {
      referer : url1,
      headers : {
        ...this._cfHeaders,
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': undefined,
      },
      followRedirects: true,
    });

    console.error(`[mcloud] mirror page → ${r2.status} (${r2.body.length} bytes)`);
    console.error(`[mcloud] mirror head: ${r2.body.slice(0, 600)}`);

    const meta    = _parseMeta(r2.body);
    const servers = _parseServers(r2.body);

    if (servers.length === 0) {
      console.error('[mcloud] full mirror html:\n', r2.body.slice(0, 3000));
      throw new Error('MCloud: no download links found');
    }

    return this._result(id, meta, servers, { final_page: r2.finalUrl });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _extractTokenUrl(html, fallbackHost) {
  const patterns = [
    /location\.assign\(["']([^"']+\?token=[^"']+)["']\)/i,
    /location\.href\s*=\s*["']([^"']+\?token=[^"']+)["']/i,
    /window\.location\s*=\s*["']([^"']+\?token=[^"']+)["']/i,
    /["']([^"']*\/[a-zA-Z0-9_-]+\?token=[A-Za-z0-9+/=]+)["']/,
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

  // R2 static
  const r2Re = /href=["'](https:\/\/[a-z0-9-]+\.r2(?:\.dev|\.cloudflarestorage\.com)\/[^"']+)["']/gi;
  while ((m = r2Re.exec(html)) !== null) push('FSL Server', m[1], 'r2');

  // Minute-rotated
  const minBase = html.match(/data-minute-base-url=["'](https?:\/\/[^"']+)["']/i);
  if (minBase) {
    const fslUrl = minBase[1] + String(new Date().getUTCMinutes());
    push('FSL Server (timed)', fslUrl, 'r2-timed');
  }

  // PixelDrain JS var
  const pxlJs = html.match(/var\s+pxl\s*=\s*["'](https?:\/\/pixeldrain[^"']+)["']/i);
  if (pxlJs) push('PixelDrain Server', pxlJs[1], 'pixeldrain');

  // PixelDrain href
  const pxlRe = /href=["'](https?:\/\/pixeldrain[^"']+)["']/gi;
  while ((m = pxlRe.exec(html)) !== null) push('PixelDrain Server', m[1], 'pixeldrain');

  // Generic CDN
  const cdnRe = /href=["'](https?:\/\/(?:pub-[a-z0-9]+\.r2\.dev|cdn\.[^"']+|dl\.[^"']+)\/[^"']{20,})["']/gi;
  while ((m = cdnRe.exec(html)) !== null) push('CDN Server', m[1], 'cdn');

  return links;
}

module.exports = new MCloud();
