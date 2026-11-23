'use strict';

const BaseSite              = require('../site-base');
const { rawGet, CookieJar } = require('../http');

class PixelDrain extends BaseSite {
  constructor() {
    super();
    this.name    = 'PixelDrain';
    this.id      = 'pixeldrain';
    this.version = '1.2.0';
    this.domains = [
      'pixeldrain.com',
      'pixeldrain.dev',
      'cdn.pixeldrain.eu.cc',
      'pixeldrain.eu.cc',
      ...Array.from({ length: 30 }, (_, i) => `cdn${i + 1}.pixeldrain.eu.cc`),
    ];
  }

  async bypass(url, opts = {}) {
    const u    = new URL(url);
    const host = u.hostname;

    // ── CDN direct link already ───────────────────────────────────────
    if (host.includes('cdn') && host.includes('pixeldrain')) {
      const fileId = u.pathname.replace(/^\/(?:api\/file\/)?/, '').split('/')[0] || 'unknown';
      return this._result(fileId, { title: fileId }, [
        {
          url    : url,
          type   : 'direct',
          label  : 'PixelDrain CDN',
          headers: {
            'Referer'   : `https://pixeldrain.com/u/${fileId}`,
            'Origin'    : 'https://pixeldrain.com',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          },
        },
      ]);
    }

    // ── Extract file ID ───────────────────────────────────────────────
    const fileId = u.pathname.match(/\/(?:u|l|d|f|api\/file)\/([A-Za-z0-9]+)/)?.[1]
                || u.pathname.split('/').filter(Boolean).pop();
    if (!fileId) throw new Error('pixeldrain: could not extract file ID');

    // ── Load viewer page — extract window.viewer_data ─────────────────
    const jar     = new CookieJar();
    const pageRes = await rawGet(`https://${host}/u/${fileId}`, {
      jar,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept'    : 'text/html,application/xhtml+xml,*/*',
      },
      followRedirects: true,
      timeout        : 15000,
    });

    const html   = pageRes.body || '';
    let   meta   = {};
    let   apiRes = {};

    // extract viewer_data JSON from page
    try {
      const vd = html.match(/window\.viewer_data\s*=\s*(\{[\s\S]+?\});[\s\n]/)?.[1];
      if (vd) {
        const parsed = JSON.parse(vd);
        apiRes = parsed?.api_response || {};
        meta   = {
          title    : apiRes.name    || fileId,
          size     : apiRes.size    || null,
          mime     : apiRes.mime_type || null,
          views    : apiRes.views   || null,
          downloads: apiRes.downloads || null,
          can_download: apiRes.can_download !== false,
        };
      }
    } catch { /* fall through */ }

    // fallback: hit API directly
    if (!meta.title) {
      try {
        const infoRes = await rawGet(`https://${host}/api/file/${fileId}/info`, {
          jar, timeout: 8000,
        });
        apiRes = JSON.parse(infoRes.body);
        meta   = {
          title    : apiRes.name     || fileId,
          size     : apiRes.size     || null,
          mime     : apiRes.mime_type || null,
          can_download: apiRes.can_download !== false,
        };
      } catch { meta = { title: fileId }; }
    }

    // ── Build servers ─────────────────────────────────────────────────
    // correct Referer = key to bypass hotlink detection
    const referer = `https://${host}/u/${fileId}`;

    const servers = [
      {
        url  : `https://${host}/api/file/${fileId}`,
        type : _mimeToType(meta.mime),
        label: 'PixelDrain Direct',
        headers: {
          'Referer'   : referer,
          'Origin'    : `https://${host}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
      },
      {
        url  : `https://${host}/api/file/${fileId}?download`,
        type : 'direct',
        label: 'PixelDrain Download',
        headers: {
          'Referer'   : referer,
          'Origin'    : `https://${host}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
      },
    ];

    return this._result(fileId, meta, servers);
  }
}

function _mimeToType(mime) {
  if (!mime) return 'direct';
  if (mime.includes('video')) return 'mp4';
  if (mime.includes('audio')) return 'mp4';
  return 'direct';
}

module.exports = new PixelDrain();
