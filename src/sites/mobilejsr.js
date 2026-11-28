'use strict';

const BaseSite = require('../site-base');
const { rawGet, CookieJar } = require('../http');

class MobileJSR extends BaseSite {
  constructor() {
    super();
    this.name    = 'MobileJSR';
    this.id      = 'mobilejsr';
    this.version = '1.0.0';
    this.domains = [
      'mobilejsr.best',
      'mobilejsr.com',
      'mobilejsr.in',
    ];
  }

  extract(url) {
    const u     = new URL(url);
    const match = u.pathname.match(/\/([a-zA-Z0-9_-]+)\/?$/);
    if (!match) throw new Error('MobileJSR: cannot extract post slug');
    return { slug: match[1], host: u.hostname };
  }

  validate(html) {
    return {
      valid : html.includes('encoded') || html.includes('base64') || html.includes('fastdl') || html.includes('hidden-content'),
      reason: 'Missing MobileJSR structure',
    };
  }

  async bypass(url) {
    const { slug, host } = this.extract(url);
    const jar = new CookieJar();

    const page = await rawGet(url, {
      jar,
      referer: `https://${host}/`,
      headers: {
        'Accept'                   : 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1',
      },
      timeout: 15000,
    });

    if (page.status === 404) throw new Error(`MobileJSR: post not found (${slug})`);
    if (page.status >= 400) throw new Error(`MobileJSR: HTTP ${page.status}`);

    const html = page.body || '';

    // ── Method 1: base64 encoded HTML (most common) ───────────────────
    const servers = _extractFromBase64(html) || _extractDirect(html);

    if (!servers || servers.length === 0) {
      console.error('[mobilejsr] snippet:', html.slice(0, 2000));
      throw new Error('MobileJSR: no download links found');
    }

    const meta = _parseMeta(html, slug);
    return this._result(slug, meta, servers);
  }
}

// ── Extract links from base64 encoded block ───────────────────────────────

function _extractFromBase64(html) {
  // const encoded = "BASE64STRING";
  const b64Match = html.match(/const\s+encoded\s*=\s*["']([A-Za-z0-9+/=]{50,})["']/);
  if (!b64Match) return null;

  let decoded;
  try {
    decoded = Buffer.from(b64Match[1], 'base64').toString('utf-8');
  } catch (_) {
    return null;
  }

  return _parseLinks(decoded);
}

// ── Extract links directly from HTML ─────────────────────────────────────

function _extractDirect(html) {
  return _parseLinks(html);
}

// ── Parse all download links from HTML ───────────────────────────────────

function _parseLinks(html) {
  const links = [], seen = new Set();
  const push  = (label, url, server) => {
    if (!url || !url.startsWith('http') || seen.has(url)) return;
    seen.add(url);
    links.push({ label, url, server });
  };

  let m;

  // fastdl.rest
  const fdRe = /href=["'](https?:\/\/fastdl\.[a-z]+\/[^"']+)["']/gi;
  while ((m = fdRe.exec(html)) !== null) push('G-Direct [Instant]', m[1], 'fastdl');

  // mcloud.best
  const mcRe = /href=["'](https?:\/\/mcloud\.best\/[^"']+)["']/gi;
  while ((m = mcRe.exec(html)) !== null) push('M-Cloud [Resumable]', m[1], 'mcloud');

  // m-drive.lol
  const mdRe = /href=["'](https?:\/\/m-drive\.[a-z]+\/[^"']+)["']/gi;
  while ((m = mdRe.exec(html)) !== null) push('M-Drive [Multi]', m[1], 'mdrive');

  // filebee.live
  const fbRe = /href=["'](https?:\/\/filebee\.live\/[^"']+)["']/gi;
  while ((m = fbRe.exec(html)) !== null) push('FileBee [G-Drive]', m[1], 'filebee');

  // gofile.io
  const gfRe = /href=["'](https?:\/\/gofile\.io\/d\/[^"']+)["']/gi;
  while ((m = gfRe.exec(html)) !== null) push('GoFile [Instant]', m[1], 'gofile');

  // pixeldrain
  const pxRe = /href=["'](https?:\/\/pixeldrain[^"']+)["']/gi;
  while ((m = pxRe.exec(html)) !== null) push('PixelDrain', m[1], 'pixeldrain');

  // hubcloud
  const hcRe = /href=["'](https?:\/\/hubcloud\.[a-z]+\/[^"']+)["']/gi;
  while ((m = hcRe.exec(html)) !== null) push('HubCloud', m[1], 'hubcloud');

  // gdflix
  const gxRe = /href=["'](https?:\/\/gdflix\.[^"']+)["']/gi;
  while ((m = gxRe.exec(html)) !== null) push('GDFlix', m[1], 'gdflix');

  // 1fichier
  const ofRe = /href=["'](https?:\/\/1fichier\.com\/[^"']+)["']/gi;
  while ((m = ofRe.exec(html)) !== null) push('1Fichier [Direct]', m[1], '1fichier');

  // vikingfile
  const vfRe = /href=["'](https?:\/\/vikingfile\.com\/[^"']+)["']/gi;
  while ((m = vfRe.exec(html)) !== null) push('VikingFile [Fast]', m[1], 'vikingfile');

  // mega.nz
  const mgRe = /href=["'](https?:\/\/mega\.nz\/[^"']+)["']/gi;
  while ((m = mgRe.exec(html)) !== null) push('Mega', m[1], 'mega');

  // google drive
  const gdRe = /href=["'](https?:\/\/drive\.google\.com\/[^"']+)["']/gi;
  while ((m = gdRe.exec(html)) !== null) push('Google Drive', m[1], 'gdrive');

  // r2 direct
  const r2Re = /href=["'](https?:\/\/[^"']*\.r2\.cloudflarestorage[^"']+)["']/gi;
  while ((m = r2Re.exec(html)) !== null) push('Direct Server', m[1], 'r2');

  // buzzheavier
  const bzRe = /href=["'](https?:\/\/[^"']*buzzheavier[^"']+)["']/gi;
  while ((m = bzRe.exec(html)) !== null) push('BuzzHeavier', m[1], 'buzzheavier');

  // fuckingfast
  const ffRe = /href=["'](https?:\/\/fuckingfast\.net\/[^"']+)["']/gi;
  while ((m = ffRe.exec(html)) !== null) push('FuckingFast', m[1], 'fuckingfast');

  // vegadrive buttons (data-server-name attribute)
  const vgRe = /<a[^>]+class=["'][^"']*vegadrive-destination-button[^"']*["'][^>]+href=["']([^"']+)["'][^>]*data-server-name=["']([^"']+)["']/gi;
  while ((m = vgRe.exec(html)) !== null) {
    push(_guessLabel(m[2]), m[1], m[2]);
  }
  // also reversed attr order
  const vgRe2 = /data-server-name=["']([^"']+)["'][^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*vegadrive-destination-button[^"']*["']/gi;
  while ((m = vgRe2.exec(html)) !== null) {
    push(_guessLabel(m[1]), m[2], m[1]);
  }

  return links;
}

function _guessLabel(server) {
  const map = {
    pixeldrain : 'PixelDrain',
    telegram   : 'Telegram',
    skydrop    : 'SkyDrop',
    one_click  : 'One Click',
    transferit : 'TransferIt',
    vikingfile : 'VikingFile [Fast]',
    buzzheavier: 'BuzzHeavier',
    gofile     : 'GoFile [Instant]',
  };
  return map[server] || server;
}

function _parseMeta(html, fallbackId) {
  const meta  = { filename: fallbackId };
  const title = html.match(/<h1[^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>([^<]{5,300})<\/h1>/i)
             || html.match(/<title[^>]*>([^<]{5,200})<\/title>/i);
  if (title) meta.title = title[1].trim().replace(/\s*[-|]\s*[^-|]+$/, '');
  return meta;
}

module.exports = new MobileJSR();
