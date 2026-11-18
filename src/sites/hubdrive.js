'use strict';

const BaseSite        = require('../site-base');
const { rawGet, rawPost, sleep, CookieJar } = require('../http');

/**
 * HubDrive bypass
 * URL pattern: https://hubdrive.blog/file/3002211248
 *
 * Flow:
 *   1. GET /file/{id}  → extract drive_id + token from page JS
 *   2. POST /file/dl   → body: { id, token } → get download page or direct URL
 *   3. Parse all server links from response
 */
class HubDrive extends BaseSite {
  constructor() {
    super();
    this.name    = 'HubDrive';
    this.id      = 'hubdrive';
    this.version = '1.0.0';
    this.domains = [
      'hubdrive.blog',
      'hubdrive.de',
      'hubdrive.mom',
      'hubdrive.pro',
    ];
  }

  extract(url) {
    const u     = new URL(url);
    const match = u.pathname.match(/\/file\/([a-zA-Z0-9_-]+)/);
    if (!match) throw new Error('HubDrive: cannot extract file ID');
    return { id: match[1], host: u.hostname };
  }

  validate(html) {
    return {
      valid : html.includes('hubdrive') || html.includes('file_id') || html.includes('download'),
      reason: 'Missing HubDrive structure',
    };
  }

  async bypass(url) {
    const { id, host } = this.extract(url);
    const jar = new CookieJar();

    // ── Stage 1: Fetch file page ─────────────────────────────────────
    const page = await rawGet(url, {
      referer: `https://${host}/`,
      jar,
    });

    if (page.status === 404) throw new Error(`HubDrive: file not found (${id})`);

    const meta = _parseMeta(page.body, id);

    // ── Stage 2: Extract internal token / drive_id ───────────────────
    const { driveId, token, dlUrl } = _extractParams(page.body, url);

    // Some HubDrive variants redirect directly — check for direct link
    if (dlUrl) {
      const servers = _buildFromUrl(dlUrl);
      return this._result(id, meta, servers);
    }

    if (!driveId && !token) {
      // Try direct link extraction from page buttons
      const servers = _parseButtons(page.body);
      if (servers.length > 0) return this._result(id, meta, servers);
      throw new Error('HubDrive: could not extract download params');
    }

    await sleep(1500);

    // ── Stage 3: POST to download endpoint ──────────────────────────
    const baseUrl = `https://${host}`;
    const postTargets = [
      `${baseUrl}/file/dl`,
      `${baseUrl}/dl`,
      `${baseUrl}/download`,
      `${baseUrl}/file/download`,
    ];

    let dlHtml = null;
    for (const endpoint of postTargets) {
      try {
        const body = {};
        if (driveId) body.id    = driveId;
        if (token)   body.token = token;
        body.file_id = id;

        const r = await rawPost(endpoint, body, {
          referer: url,
          jar,
        });

        if (r.status === 200 && r.body.length > 100) {
          dlHtml = r.body;
          break;
        }
      } catch (_) {}
    }

    // Fallback: try GET with known path patterns
    if (!dlHtml) {
      const getTargets = [
        `${baseUrl}/file/${id}?action=download`,
        `${baseUrl}/download/${id}`,
      ];
      for (const t of getTargets) {
        try {
          const r = await rawGet(t, { referer: url, jar });
          if (r.status === 200 && r.body.length > 100) { dlHtml = r.body; break; }
        } catch (_) {}
      }
    }

    if (!dlHtml) throw new Error('HubDrive: download endpoint unreachable');

    const servers = _parseButtons(dlHtml) || _parseButtons(page.body);
    if (servers.length === 0) throw new Error('HubDrive: no download links found');

    return this._result(id, meta, servers);
  }
}

function _parseMeta(html, fallbackId) {
  const meta = {};
  const fn   = html.match(/<h[1-4][^>]*>([^<]{3,200}?)<\/h[1-4]>/i);
  if (fn) meta.filename = fn[1].trim().replace(/\s+/g,' ');
  else    meta.filename = fallbackId;

  const sz = html.match(/size[^>]*>([^<]*\d+\s*[KMGT]?B[^<]*)/i);
  if (sz) meta.size = sz[1].trim();
  return meta;
}

function _extractParams(html, pageUrl) {
  const result = { driveId: null, token: null, dlUrl: null };

  // drive_id or file_id in JS vars
  const idM = html.match(/(?:drive_id|file_id|fileId)\s*[:=]\s*["']?(\d+)["']?/i);
  if (idM) result.driveId = idM[1];

  // token
  const tkM = html.match(/(?:token|_token|csrf)\s*[:=]\s*["']([^"']{10,})["']/i);
  if (tkM) result.token = tkM[1];

  // direct download URL in page
  const dlM = html.match(/href=["'](https?:\/\/[^"']{30,})["'][^>]*(?:download|btn)/i);
  if (dlM) result.dlUrl = dlM[1];

  return result;
}

function _parseButtons(html) {
  const links = [], seen = new Set();
  const push  = (label, url, server) => {
    if (!url || !url.startsWith('http') || seen.has(url)) return;
    seen.add(url); links.push({ label, url, server });
  };

  // Google Drive links
  const gdRe = /href=["'](https:\/\/drive\.google\.com\/[^"']+)["']/gi;
  let m;
  while ((m = gdRe.exec(html)) !== null) push('Google Drive', m[1], 'gdrive');

  // R2 / S3 direct
  const r2Re = /href=["'](https:\/\/[^"']*\.r2\.cloudflarestorage\.com\/[^"']+)["']/gi;
  while ((m = r2Re.exec(html)) !== null) push('Direct Server', m[1], 'r2');

  // PixelDrain
  const pxRe = /href=["'](https?:\/\/pixeldrain[^"']+)["']/gi;
  while ((m = pxRe.exec(html)) !== null) push('PixelDrain', m[1], 'pixeldrain');

  // Any btn-* links with long URLs
  const btnRe = /class=["'][^"']*btn[^"']*["'][^>]*href=["'](https?:\/\/[^"']{20,})["']|href=["'](https?:\/\/[^"']{20,})["'][^>]*class=["'][^"']*btn[^"']*["']/gi;
  while ((m = btnRe.exec(html)) !== null) {
    const u = m[1] || m[2];
    if (u) push(_guessLabel(u), u, _guessServer(u));
  }

  return links;
}

function _buildFromUrl(url) {
  return [{ label: _guessLabel(url), url, server: _guessServer(url) }];
}

function _guessLabel(url) {
  if (url.includes('drive.google.com')) return 'Google Drive';
  if (url.includes('pixeldrain'))       return 'PixelDrain';
  if (url.includes('r2.cloudflare'))    return 'Direct Server';
  if (url.includes('fuckingfast'))      return 'Buzz Server';
  if (url.includes('mega.nz'))          return 'Mega';
  return 'Download Server';
}

function _guessServer(url) {
  if (url.includes('drive.google.com')) return 'gdrive';
  if (url.includes('pixeldrain'))       return 'pixeldrain';
  if (url.includes('r2.cloudflare'))    return 'r2';
  if (url.includes('fuckingfast'))      return 'buzz';
  if (url.includes('mega.nz'))          return 'mega';
  return 'other';
}

module.exports = new HubDrive();
