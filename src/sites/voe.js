'use strict';

const BaseSite              = require('../site-base');
const { rawGet, CookieJar } = require('../http');

const VOE_DOMAINS = [
  'voe.sx',
  'caseyseemavoid.com',
  'voe-unblock.com',
  'voeunblock.com',
  'voeunblock1.com',
  'voeunblock2.com',
  'voeunblock3.com',
  'voeun.com',
];

const BASE_HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer'        : 'https://voe.sx/',
  'Origin'         : 'https://voe.sx',
};

const BLOCKLIST = [
  'test-videos.co.uk',
  'sample-videos.com',
  'filesamples.com',
  'commondatastorage.googleapis.com',
];

function isBlocked(u) {
  return BLOCKLIST.some(d => u.includes(d));
}

function extractM3u8(html) {
  // 1. atob decode — voe's main obfuscation
  const atobPats = [
    /(?:hls2?|source|stream|hlsUrl|hlsSrc|wurl)\s*[:=]\s*atob\(\s*['"]([A-Za-z0-9+/=]+)['"]\s*\)/gi,
    /atob\(\s*['"]([A-Za-z0-9+/=]{40,})['"]\s*\)/g,
  ];
  for (const pat of atobPats) {
    for (const m of html.matchAll(pat)) {
      try {
        const dec = Buffer.from(m[1], 'base64').toString('utf8');
        if (dec.startsWith('http') && dec.includes('.m3u8') && !isBlocked(dec)) return { url: dec, type: 'hls' };
        if (dec.startsWith('http') && dec.includes('.mp4')  && !isBlocked(dec)) return { url: dec, type: 'mp4' };
      } catch { continue; }
    }
  }

  // 2. direct m3u8 URL anywhere in JS
  for (const m of html.matchAll(/["'`](https?:\/\/[^"'`\s]{10,}\.m3u8[^"'`\s]*?)["'`]/g)) {
    if (!isBlocked(m[1])) return { url: m[1], type: 'hls' };
  }

  // 3. wurl / hlsUrl / stream var
  for (const m of html.matchAll(/(?:wurl|hlsUrl|hlsSrc|hls2?|stream)\s*[:=]\s*["'`]([^"'`\s]{10,})["'`]/gi)) {
    const v = m[1];
    if (v.startsWith('http') && !isBlocked(v)) {
      if (v.includes('.m3u8')) return { url: v, type: 'hls' };
      if (v.includes('.mp4'))  return { url: v, type: 'mp4' };
    }
  }

  // 4. mp4 explicit var only
  for (const m of html.matchAll(/(?:mp4|source|src|videoUrl|directUrl)\s*[:=]\s*["'`](https?:\/\/[^"'`\s]{10,}\.mp4[^"'`\s]*)["'`]/gi)) {
    if (!isBlocked(m[1])) return { url: m[1], type: 'mp4' };
  }

  return null;
}

class VoeSite extends BaseSite {
  constructor() {
    super();
    this.id      = 'voe';
    this.name    = 'VOE.sx';
    this.version = '1.2.0';
    this.domains = VOE_DOMAINS;
  }

  async bypass(url, opts = {}) {
    return this.extract(url);
  }

  async extract(url) {
    const jar = new CookieJar();

    // ── Step 1: file ID ───────────────────────────────────────────────────
    const fileId = (
      url.match(/\/([a-z0-9]{8,20})(?:[?/]|$)/) ||
      url.match(/([a-z0-9]{8,20})$/)
    )?.[1] ?? null;

    if (!fileId) throw new Error('voe: could not extract file ID from URL');

    // ── Step 2: voe.sx JS-redirects to caseyseemavoid via localStorage ───
    // localStorage unavailable server-side — hit casey directly
    const targets = [
      `https://caseyseemavoid.com/e/${fileId}`,
      `https://caseyseemavoid.com/${fileId}`,
      `https://voe.sx/e/${fileId}`,
      `https://voe.sx/${fileId}`,
    ];

    let html = '';

    for (const target of targets) {
      try {
        const res = await rawGet(target, {
          headers        : { ...BASE_HEADERS, Referer: 'https://voe.sx/' },
          jar,
          followRedirects: true,
          timeout        : 15000,
        });
        // redirect stubs ~700 bytes — real player page >10KB
        if (res.body && res.body.length > 10000) {
          html = res.body;
          break;
        }
      } catch { continue; }
    }

    if (!html) throw new Error('voe: could not load player page from any endpoint');

    // ── Step 3: extract stream ────────────────────────────────────────────
    const found = extractM3u8(html);
    if (found) return this._buildResult(fileId, found);

    throw new Error('voe: stream URL not found — token may be expired or geo-blocked');
  }

  _buildResult(fileId, { url, type }) {
    return this._result(
      fileId,
      { title: `VOE/${fileId}`, type },
      [{ url, type, headers: { Referer: 'https://voe.sx/', Origin: 'https://voe.sx' } }],
    );
  }
}

module.exports = new VoeSite();
