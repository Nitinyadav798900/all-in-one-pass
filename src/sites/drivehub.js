'use strict';

const BaseSite              = require('../site-base');
const { rawGet, rawPost, sleep, CookieJar } = require('../http');

/**
 * DriveHub bypass
 * URL: https://new2.drivehub.dad/file/4346143
 *
 * Flow:
 *   1. GET /file/{id} → parse page, extract CSRF + file token
 *   2. POST /file/{id} or /dl/{id} with token → redirect or JSON
 *   3. Follow final link
 */
class DriveHub extends BaseSite {
  constructor() {
    super();
    this.name    = 'DriveHub';
    this.id      = 'drivehub';
    this.version = '1.0.0';
    this.domains = [
      'drivehub.dad',
      'new2.drivehub.dad',
      'new3.drivehub.dad',
      'new1.drivehub.dad',
      'drivehub.ws',
      'drivehub.in',
    ];
  }

  extract(url) {
    const u     = new URL(url);
    const match = u.pathname.match(/\/file\/([a-zA-Z0-9_-]+)/);
    if (!match) throw new Error('DriveHub: cannot extract file ID');
    return { id: match[1], host: u.hostname };
  }

  validate(html) {
    return {
      valid : html.includes('drivehub') || html.includes('download') || html.length > 300,
      reason: 'Missing DriveHub structure',
    };
  }

  async bypass(url) {
    const { id, host } = this.extract(url);
    const jar = new CookieJar();

    // ── Stage 1: Load file page ──────────────────────────────────────
    const page = await rawGet(url, {
      referer: `https://${host}/`,
      jar,
    });

    if (page.status >= 400) throw new Error(`DriveHub: HTTP ${page.status}`);

    const meta   = _parseMeta(page.body, id);
    const params = _extractParams(page.body);

    // Check for immediate download links
    let servers = _parseLinks(page.body);
    if (servers.length > 0) return this._result(id, meta, servers);

    await sleep(1500);

    // ── Stage 2: Try POST endpoints ──────────────────────────────────
    const baseUrl  = `https://${host}`;
    const postBody = {
      _token: params.csrf || '',
      action: 'download',
      id,
      ...params.extra,
    };

    const endpoints = [
      url,
      `${baseUrl}/file/${id}/download`,
      `${baseUrl}/dl/${id}`,
      `${baseUrl}/download/${id}`,
      `${baseUrl}/file/dl`,
    ];

    for (const ep of endpoints) {
      try {
        const r = await rawPost(ep, postBody, { referer: url, jar });
        // Check for JSON
        const json = _tryJson(r.body);
        if (json) {
          servers = _fromJson(json);
          if (servers.length > 0) return this._result(id, meta, servers);
        }
        // Parse HTML
        servers = _parseLinks(r.body);
        if (servers.length > 0) return this._result(id, meta, servers);
      } catch (_) {}
    }

    // ── Stage 3: GET download page variants ──────────────────────────
    const getTargets = [
      `${baseUrl}/file/${id}?action=download`,
      `${baseUrl}/view/${id}`,
    ];
    for (const t of getTargets) {
      try {
        const r = await rawGet(t, { referer: url, jar });
        servers = _parseLinks(r.body);
        if (servers.length > 0) return this._result(id, meta, servers);
      } catch (_) {}
    }

    throw new Error('DriveHub: no download links found');
  }
}

function _parseMeta(html, fallbackId) {
  const meta = {};
  const h    = html.match(/<h[1-4][^>]*>([^<]{5,200}?)<\/h[1-4]>/i);
  if (h) meta.filename = h[1].trim();
  else   meta.filename = fallbackId;
  const sz = html.match(/(\d+(?:\.\d+)?\s*(?:GB|MB|KB))/i);
  if (sz) meta.size = sz[1];
  return meta;
}

function _extractParams(html) {
  const result = { csrf: null, extra: {} };
  const csrf   = html.match(/<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i)
               || html.match(/name=["']_token["'][^>]*value=["']([^"']+)["']/i);
  if (csrf) result.csrf = csrf[1];

  const hiddenRe = /<input[^>]*type=["']hidden["'][^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["']/gi;
  let m;
  while ((m = hiddenRe.exec(html)) !== null) result.extra[m[1]] = m[2];

  return result;
}

function _tryJson(raw) {
  try { return JSON.parse(raw.trim()); } catch (_) { return null; }
}

function _fromJson(json) {
  const links = [];
  const url   = json?.url || json?.link || json?.download_url || json?.href;
  if (typeof url === 'string' && url.startsWith('http')) {
    links.push({ label: _guessLabel(url), url, server: _guessServer(url) });
  }
  if (Array.isArray(json?.links)) {
    for (const l of json.links) {
      const u = l?.url || l?.link || l;
      if (typeof u === 'string' && u.startsWith('http'))
        links.push({ label: _guessLabel(u), url: u, server: _guessServer(u) });
    }
  }
  return links;
}

function _parseLinks(html) {
  const links = [], seen = new Set();
  const push  = (label, url, server) => {
    if (!url || !url.startsWith('http') || seen.has(url) || url.length < 25) return;
    seen.add(url); links.push({ label, url, server });
  };

  const patterns = [
    /href=["'](https?:\/\/drive\.google\.com\/[^"']+)["']/gi,
    /href=["'](https?:\/\/[^"']*pixeldrain[^"']+)["']/gi,
    /href=["'](https?:\/\/mega\.nz\/[^"']+)["']/gi,
    /href=["'](https?:\/\/[^"']*mediafire[^"']+)["']/gi,
    /href=["'](https?:\/\/[^"']*\.r2\.cloudflarestorage[^"']+)["']/gi,
    /href=["'](https?:\/\/fuckingfast\.net\/[^"']+)["']/gi,
    /href=["'](https?:\/\/1drv\.ms\/[^"']+)["']/gi,
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) push(_guessLabel(m[1]), m[1], _guessServer(m[1]));
  }
  return links;
}

function _guessLabel(url) {
  if (url.includes('drive.google'))  return 'Google Drive';
  if (url.includes('pixeldrain'))    return 'PixelDrain';
  if (url.includes('mega.nz'))       return 'Mega';
  if (url.includes('mediafire'))     return 'MediaFire';
  if (url.includes('1drv'))          return 'OneDrive';
  if (url.includes('r2.cloudflare')) return 'Direct Server';
  if (url.includes('fuckingfast'))   return 'Buzz Server';
  return 'Download Server';
}

function _guessServer(url) {
  if (url.includes('drive.google'))  return 'gdrive';
  if (url.includes('pixeldrain'))    return 'pixeldrain';
  if (url.includes('mega.nz'))       return 'mega';
  if (url.includes('mediafire'))     return 'mediafire';
  if (url.includes('1drv'))          return 'onedrive';
  if (url.includes('r2.cloudflare')) return 'r2';
  if (url.includes('fuckingfast'))   return 'buzz';
  return 'other';
}

module.exports = new DriveHub();
