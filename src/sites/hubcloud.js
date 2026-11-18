'use strict';

const BaseSite          = require('../site-base');
const { rawGet, sleep, globalJar } = require('../http');

class HubCloud extends BaseSite {
  constructor() {
    super();
    this.name    = 'HubCloud';
    this.id      = 'hubcloud';
    this.version = '2.0.0';
    this.domains = [
      'hubcloud.pw', 'hubcloud.cx', 'hubcloud.mov',
      'hubcloud.in', 'hubcloud.fans', 'hubcloud.club',
    ];
  }

  extract(url) {
    const u     = new URL(url);
    const match = u.pathname.match(/\/(?:drive|d)\/([a-zA-Z0-9_-]+)/);
    if (!match) throw new Error('HubCloud: cannot extract file ID from URL');
    return { id: match[1], host: u.hostname };
  }

  validate(html) {
    return {
      valid : html.includes('card-header') || html.includes('gamerxyt'),
      reason: 'Missing expected HubCloud structure',
    };
  }

  async bypass(url) {
    const { id } = this.extract(url);

    // Try all drive hosts
    let html1, url1;
    for (const host of this.domains) {
      const driveUrl = `https://${host}/drive/${id}`;
      try {
        const r = await rawGet(driveUrl, { referer: 'https://www.google.com/' });
        if (r.status === 200 && r.body.length > 500) {
          html1 = r.body; url1 = r.finalUrl;
          break;
        }
      } catch (_) {}
    }
    if (!html1) throw new Error(`HubCloud: file not found (${id})`);

    // Parse meta
    const meta = _parseMeta(html1);

    // Extract token URL
    const tokenUrl = _extractToken(html1);
    if (!tokenUrl) throw new Error('HubCloud: token URL not found');

    // Seed cookies
    globalJar.set('xla', 's4t');
    globalJar.set('xyt', '1');

    // Wait for gamerxyt timer
    await sleep(2600);

    // Hit token
    const r2 = await rawGet(tokenUrl, { referer: url1 });
    const servers = _parseServers(r2.body);

    if (servers.length === 0) {
      console.error('[hubcloud] final url:', r2.finalUrl);
      console.error('[hubcloud] html snippet:', r2.body.slice(0, 1000));
      throw new Error('HubCloud: no download links found — token expired');
    }

    return this._result(id, meta, servers, { final_page: r2.finalUrl });
  }
}

function _parseMeta(html) {
  const meta = {};
  const fn   = html.match(/<div[^>]*card-header[^>]*>\s*([^<\n]{3,200}?)\s*<\/div>/i);
  if (fn)  meta.filename = fn[1].trim();
  const sz = html.match(/File Size[\s\S]{1,80}?<i[^>]*>([\d.\s]+[KMGT]?B)<\/i>/i);
  if (sz)  meta.size = sz[1].trim();
  const tp = html.match(/File Type[\s\S]{1,80}?<i[^>]*>([^<]+)<\/i>/i);
  if (tp)  meta.type = tp[1].trim();
  const dt = html.match(/Share Date[\s\S]{1,80}?<i[^>]*>([^<]+)<\/i>/i);
  if (dt)  meta.date = dt[1].trim();
  return meta;
}

function _extractToken(html) {
  const patterns = [
    /href=["'](https:\/\/gamerxyt\.com[^"']+)["']/i,
    /var\s+url\s*=\s*["'](https?:\/\/[^"']*gamerxyt[^"']+)["']/,
    /(https?:\/\/gamerxyt\.com\/[^\s"'<>]+)/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1];
  }
  return null;
}

function _parseServers(html) {
  const links = [], seen = new Set();
  const push  = (label, url, server) => {
    if (!url || !url.startsWith('http') || seen.has(url)) return;
    seen.add(url); links.push({ label, url, server });
  };

  const r2Re = /href=["'](https:\/\/[a-z0-9]+\.r2\.cloudflarestorage\.com\/[^"']+)["']/gi;
  let m;
  while ((m = r2Re.exec(html)) !== null) push('Direct Server', m[1], 'r2');

  const gpdlRe = /href=["'](https:\/\/gpdl\.hubcloud[^"']+)["']/gi;
  while ((m = gpdlRe.exec(html)) !== null) push('10Gbps Server', m[1], '10gbps');

  const pxlJs = html.match(/var\s+pxl\s*=\s*["'](https?:\/\/pixeldrain[^"']+)["']/);
  if (pxlJs) push('PixelDrain Server', pxlJs[1], 'pixeldrain');

  const pxlRe = /href=["'](https?:\/\/pixeldrain[^"']+)["']/gi;
  while ((m = pxlRe.exec(html)) !== null) push('PixelDrain Server', m[1], 'pixeldrain');

  const ffRe = /href=["'](https:\/\/fuckingfast\.net\/[^"']+)["']/gi;
  while ((m = ffRe.exec(html)) !== null) push('Buzz Server', m[1], 'buzz');

  const tgRe = /href=["'](https:\/\/hubcloud\.[a-z]+\/tg\/go[^"']+)["']/gi;
  while ((m = tgRe.exec(html)) !== null) push('Telegram', m[1], 'telegram');

  const hbRe = /href=["'](https:\/\/hbplay[^"']+)["']/gi;
  while ((m = hbRe.exec(html)) !== null) push('Watch Online', m[1], 'stream');

  return links;
}

module.exports = new HubCloud();
