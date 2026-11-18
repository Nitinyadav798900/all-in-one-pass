'use strict';

const BaseSite        = require('../site-base');
const { rawGet, sleep, CookieJar } = require('../http');
const https           = require('https');

/**
 * GoFile bypass
 * URL: https://gofile.io/d/pVawQzDG
 *
 * Flow:
 *   1. GET guest token from https://api.gofile.io/accounts
 *   2. GET content via https://api.gofile.io/contents/{id}?token=...
 *   3. Parse all file download links from JSON
 *
 * GoFile has an official API — no scraping needed.
 * Token is valid per-session.
 */
class GoFile extends BaseSite {
  constructor() {
    super();
    this.name        = 'GoFile';
    this.id          = 'gofile';
    this.version     = '1.0.0';
    this.domains     = ['gofile.io'];
    this._guestToken = null;
    this._tokenTs    = 0;
  }

  extract(url) {
    const u     = new URL(url);
    const match = u.pathname.match(/\/d\/([a-zA-Z0-9]+)/);
    if (!match) throw new Error('GoFile: cannot extract content ID');
    return { id: match[1] };
  }

  validate(html) {
    return { valid: true }; // API-based, always valid if reachable
  }

  async bypass(url) {
    const { id } = this.extract(url);

    // ── Step 1: Get/reuse guest token ────────────────────────────────
    const token = await this._getToken();

    // ── Step 2: Fetch content metadata ──────────────────────────────
    const apiUrl = `https://api.gofile.io/contents/${id}?wt=4fd6sg89d7s6&cache=true&sortField=createTime&sortDirection=desc&token=${token}`;
    const r      = await rawGet(apiUrl, {
      referer: 'https://gofile.io/',
      headers: { 'Accept': 'application/json' },
    });

    let json;
    try { json = JSON.parse(r.body); } catch (_) {
      throw new Error('GoFile: invalid API response');
    }

    if (json.status !== 'ok') {
      if (json.status === 'error-notFound') throw new Error('GoFile: content not found');
      if (json.status === 'error-passwordRequired') throw new Error('GoFile: password protected');
      throw new Error(`GoFile: API error — ${json.status}`);
    }

    const data     = json.data;
    const servers  = [];
    const meta     = { filename: data.name || id };

    // GoFile returns a folder with children OR a direct file
    const children = data.children
      ? Object.values(data.children)
      : [data];

    let totalSize = 0;

    for (const child of children) {
      if (child.type !== 'file') continue;

      const dlUrl  = child.link || child.directLink;
      const fname  = child.name  || 'file';
      const size   = child.size  || 0;
      totalSize   += size;

      if (dlUrl) {
        servers.push({
          label : `GoFile CDN — ${fname}`,
          url   : dlUrl,
          server: 'gofile',
          size  : _fmtSize(size),
          md5   : child.md5 || null,
          mime  : child.mimetype || null,
        });
      }
    }

    if (totalSize > 0) meta.size = _fmtSize(totalSize);
    meta.files_count = servers.length;

    if (servers.length === 0) throw new Error('GoFile: no downloadable files in this content');

    return this._result(id, meta, servers, {
      folder_name  : data.name,
      is_public    : data.public,
      created_at   : data.createTime ? new Date(data.createTime * 1000).toISOString() : null,
    });
  }

  async _getToken() {
    // Reuse token for 1 hour
    if (this._guestToken && Date.now() - this._tokenTs < 3600_000) {
      return this._guestToken;
    }

    const r = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.gofile.io',
        path    : '/accounts',
        method  : 'POST',
        headers : {
          'Content-Type'  : 'application/json',
          'Content-Length': '2',
          'Origin'        : 'https://gofile.io',
          'Referer'       : 'https://gofile.io/',
        },
        timeout: 10000,
      }, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end',  () => resolve(raw));
      });
      req.on('error', reject);
      req.write('{}');
      req.end();
    });

    let json;
    try { json = JSON.parse(r); } catch (_) {
      throw new Error('GoFile: could not get guest token');
    }

    if (json.status !== 'ok' || !json.data?.token) {
      throw new Error('GoFile: token request failed');
    }

    this._guestToken = json.data.token;
    this._tokenTs    = Date.now();
    return this._guestToken;
  }
}

function _fmtSize(bytes) {
  if (!bytes) return '—';
  const units = ['B','KB','MB','GB','TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

module.exports = new GoFile();
