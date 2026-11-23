'use strict';

const BaseSite              = require('../site-base');
const { rawGet, CookieJar } = require('../http');

class PixelDrain extends BaseSite {
  constructor() {
    super();
    this.name    = 'PixelDrain';
    this.id      = 'pixeldrain';
    this.version = '1.1.0';
    this.domains = [
      'pixeldrain.com',
      'pixeldrain.dev',
      'cdn.pixeldrain.eu.cc',
      'pixeldrain.eu.cc',
    ];
  }

  async bypass(url, opts = {}) {
    const u    = new URL(url);
    const host = u.hostname;

    // ── CDN direct link ───────────────────────────────────────────────
    // https://cdn.pixeldrain.eu.cc/uhCDQYe6?download
    // already a direct URL — just return it
    if (host.startsWith('cdn.')) {
      const fileId = u.pathname.replace('/', '') || 'unknown';
      const type   = url.includes('.m3u8') ? 'hls'
                   : url.includes('.mp4')  ? 'mp4' : 'direct';
      return this._result(fileId, { title: fileId }, [
        { url, type, headers: {} },
      ]);
    }

    // ── /u/ or /l/ page ───────────────────────────────────────────────
    // https://pixeldrain.dev/u/hNpELhd9
    const fileId = u.pathname.match(/\/(?:u|l|d|f)\/([A-Za-z0-9]+)/)?.[1]
                || u.pathname.split('/').filter(Boolean).pop();
    if (!fileId) throw new Error('pixeldrain: could not extract file ID');

    // ── API — try both domains ────────────────────────────────────────
    const apiHosts = ['pixeldrain.com', 'pixeldrain.dev', 'pixeldrain.eu.cc'];
    let   meta     = {};

    for (const apiHost of apiHosts) {
      try {
        const apiRes = await rawGet(`https://${apiHost}/api/file/${fileId}/info`, {
          timeout: 10000,
        });
        meta = JSON.parse(apiRes.body);
        if (meta.id) break;
      } catch { continue; }
    }

    // ── Build download URLs ────────────────────────────────────────────
    const servers = [];

    // primary: api/file/{id} direct stream
    servers.push({
      url  : `https://${host}/api/file/${fileId}`,
      type : 'direct',
      label: 'PixelDrain Direct',
    });

    // cdn subdomain if available
    servers.push({
      url  : `https://cdn.pixeldrain.eu.cc/${fileId}?download`,
      type : 'direct',
      label: 'PixelDrain CDN',
    });

    return this._result(
      fileId,
      {
        title    : meta.name || fileId,
        size     : meta.size || null,
        mime     : meta.mime_type || null,
        views    : meta.views || null,
      },
      servers,
    );
  }
}

module.exports = new PixelDrain();
