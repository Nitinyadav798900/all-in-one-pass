'use strict';

const BaseSite = require('../site-base');
const { rawGet, CookieJar } = require('../http');

class FastDL extends BaseSite {
  constructor() {
    super();
    this.name    = 'FastDL';
    this.id      = 'fastdl';
    this.version = '1.0.0';
    this.domains = [
      'fastdl.rest',
      'fastdl.icu',
      'fastdl.top',
      'fastdl.lol',
    ];
  }

  extract(url) {
    const u = new URL(url);
    // /embed.php?download=TOKEN  or  /TOKEN  or  /file/TOKEN
    const token =
      u.searchParams.get('download') ||
      u.searchParams.get('id')       ||
      u.pathname.match(/\/(?:file\/|embed\.php\/)?([A-Za-z0-9_-]{8,})/)?.[1];

    if (!token) throw new Error('FastDL: cannot extract token from URL');
    return { token, host: u.hostname };
  }

  validate(html) {
    return {
      valid : html.includes('vd') || html.includes('Download Now'),
      reason: 'Missing FastDL download structure',
    };
  }

  async bypass(url) {
    const { token, host } = this.extract(url);

    // normalise to embed URL
    const embedUrl = `https://${host}/embed.php?download=${token}`;
    const jar      = new CookieJar();

    const page = await rawGet(embedUrl, {
      jar,
      referer: `https://${host}/`,
      headers: {
        'Accept'                   : 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1',
      },
      timeout: 15000,
    });

    if (page.status === 404) throw new Error(`FastDL: file not found (${token})`);
    if (page.status >= 400) throw new Error(`FastDL: HTTP ${page.status}`);

    const html = page.body || '';

    // primary: <a id="vd" href="DIRECT_URL">
    const direct = _extractDirect(html);
    if (!direct) {
      console.error('[fastdl] snippet:', html.slice(0, 1500));
      throw new Error('FastDL: download URL not found in page');
    }

    const meta    = _parseMeta(html, token);
    const servers = [{
      label : 'FastDL 10Gbps',
      url   : direct,
      server: _guessServer(direct),
    }];

    return this._result(token, meta, servers, { embed_url: embedUrl });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function _extractDirect(html) {
  // <a id="vd" href="URL">
  const vdHref = html.match(/<a[^>]+id=["']vd["'][^>]+href=["']([^"']+)["']/i)
              || html.match(/href=["']([^"']+)["'][^>]*id=["']vd["']/i);
  if (vdHref) return vdHref[1];

  // googleusercontent direct
  const guc = html.match(/href=["'](https:\/\/video-downloads\.googleusercontent\.com\/[^"']+)["']/i);
  if (guc) return guc[1];

  // any googleusercontent URL in page
  const gucRaw = html.match(/(https:\/\/video-downloads\.googleusercontent\.com\/[^\s"'<>]+)/);
  if (gucRaw) return gucRaw[1];

  // generic direct file link
  const gen = html.match(/href=["'](https?:\/\/[^"']+\.(?:mp4|mkv|avi|zip|rar|7z|pdf)(?:\?[^"']*)?)["']/i);
  if (gen) return gen[1];

  return null;
}

function _parseMeta(html, fallbackId) {
  const meta = { filename: fallbackId };
  const title = html.match(/<title[^>]*>([^<]{3,200})<\/title>/i);
  if (title) meta.title = title[1].trim();
  return meta;
}

function _guessServer(url) {
  if (url.includes('googleusercontent'))  return 'gdrive-cdn';
  if (url.includes('drive.google'))       return 'gdrive';
  if (url.includes('pixeldrain'))         return 'pixeldrain';
  if (url.includes('r2.cloudflarestorage') || url.includes('r2.dev')) return 'r2';
  return 'direct';
}

module.exports = new FastDL();
