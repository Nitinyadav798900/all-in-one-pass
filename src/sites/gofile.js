'use strict';

const BaseSite = require('../site-base');
const { rawGet } = require('../http');
const https      = require('https');
const crypto     = require('crypto');

/**
 * GoFile bypass (2026-11-19 fixed)
 * Live verified on https://gofile.io/d/ZMwFn5Yg
 * → returns direct CDN download link (playable)
 */
class GoFile extends BaseSite {
  constructor() {
    super();
    this.name        = 'GoFile';
    this.id          = 'gofile';
    this.version     = '1.1.2';
    this.domains     = ['gofile.io'];
    this._guestToken = null;
    this._tokenTs    = 0;

    this.UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    this.LANG    = 'en-US';
    this.WT_SALT = process.env.GOFILE_WT_SALT || '12af056dacea0b';
  }

  extract(url) {
    const u     = new URL(url);
    const match = u.pathname.match(/\/d\/([a-zA-Z0-9]+)/);
    if (!match) throw new Error('GoFile: cannot extract content ID');
    return { id: match[1] };
  }

  validate() {
    return { valid: true };
  }

  _generateWt(accountToken, windowOffset = 0) {
    const window = Math.floor(Date.now() / 1000 / 14400) + windowOffset;
    const raw    = `${this.UA}::${this.LANG}::${accountToken}::${window}::${this.WT_SALT}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  async bypass(url) {
    const { id } = this.extract(url);
    const token  = await this._getToken();

    let wt   = this._generateWt(token);
    let json = await this._fetchContents(id, token, wt);

    if (json.status === 'error-notPremium') {
      wt   = this._generateWt(token, -1);
      json = await this._fetchContents(id, token, wt);
    }

    if (json.status !== 'ok') {
      if (json.status === 'error-notFound')         throw new Error('GoFile: content not found');
      if (json.status === 'error-passwordRequired') throw new Error('GoFile: password protected');
      if (json.status === 'error-notPremium')       throw new Error('GoFile: API error — error-notPremium (salt rotated? set GOFILE_WT_SALT)');
      if (json.status === 'error-rateLimit')        throw new Error('GoFile: rate limited — wait a few minutes');
      throw new Error(`GoFile: API error — ${json.status}`);
    }

    const data    = json.data;
    const servers = [];
    const meta    = { filename: data.name || id };

    // folder → children, or single file
    const children = data.children && Object.keys(data.children).length
      ? Object.values(data.children)
      : (data.type === 'file' ? [data] : []);

    let totalSize = 0;

    for (const child of children) {
      if (child.type !== 'file') continue;

      // direct CDN link
      let dlUrl = child.link || child.directLink;

      // fallback: build from serverSelected if link missing
      if (!dlUrl && child.id && child.serverSelected) {
        dlUrl = `https://${child.serverSelected}.gofile.io/download/web/${child.id}/${encodeURIComponent(child.name || 'file')}`;
      }

      const fname = child.name || 'file';
      const size  = child.size || 0;
      totalSize  += size;

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

    if (servers.length === 0) {
      throw new Error('GoFile: no downloadable files in this content');
    }

    return this._result(id, meta, servers, {
      folder_name : data.name,
      is_public   : data.public,
      created_at  : data.createTime
        ? new Date(data.createTime * 1000).toISOString()
        : null,
    });
  }

  async _fetchContents(id, token, wt) {
    // IMPORTANT: do NOT send contentFilter=all — it empties children
    // minimal working params (verified live)
    const qs = new URLSearchParams({
      wt,
      cache: 'true',
      page: '1',
      pageSize: '1000',
    }).toString();

    const apiUrl = `https://api.gofile.io/contents/${id}?${qs}`;

    const r = await rawGet(apiUrl, {
      referer: 'https://gofile.io/',
      headers: {
        'Accept'          : 'application/json',
        'Authorization'   : `Bearer ${token}`,
        'User-Agent'      : this.UA,
        'X-BL'            : this.LANG,
        'X-Website-Token' : wt,
        'Origin'          : 'https://gofile.io',
      },
    });

    try {
      return JSON.parse(r.body);
    } catch (_) {
      throw new Error('GoFile: invalid API response');
    }
  }

  async _getToken() {
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
          'User-Agent'    : this.UA,
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
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

module.exports = new GoFile();
