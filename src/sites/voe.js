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

// never return these — placeholder/test URLs
const BLOCKLIST = [
  'test-videos.co.uk',
  'sample-videos.com',
  'filesamples.com',
  'commondatastorage.googleapis.com',
];

function isBlocked(url) {
  return BLOCKLIST.some(d => url.includes(d));
}

function extractM3u8(html) {
  // priority order — most specific to least

  // 1. atob-encoded source (voe's main obfuscation)
  const b64Patterns = [
    /(?:hls2?|source|stream|hlsUrl|hlsSrc)\s*[:=]\s*atob\(\s*['"]([A-Za-z0-9+/=]+)['"]\s*\)/i,
    /atob\(\s*['"]([A-Za-z0-9+/=]{30,})['"]\s*\)/g,
  ];
  for (const pat of b64Patterns) {
    const matches = [...html.matchAll(pat)];
    for (const m of matches) {
      try {
        const decoded = Buffer.from(m[1], 'base64').toString('utf8');
        if (decoded.includes('.m3u8') && !isBlocked(decoded)) return { url: decoded, type: 'hls' };
        if (decoded.includes('.mp4')  && !isBlocked(decoded)) return { url: decoded, type: 'mp4' };
      } catch { continue; }
    }
  }

  // 2. direct m3u8 URL in JS vars (hls, hlsUrl, source, wurl, etc.)
  const hlsVarPatterns = [
    /(?:hls2?|hlsUrl|hlsSrc|hlsSource|m3u8|stream)\s*[:=]\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i,
    /['"]([https?://[^'"]+\.m3u8[^'"]*)['"]/g,
    /wurl\s*[:=]\s*['"]([^'"]+)['"]/i,
  ];
  for (const pat of hlsVarPatterns) {
    const matches = [...html.matchAll(pat)];
    for (const m of matches) {
      if (m[1] && m[1].includes('.m3u8') && !isBlocked(m[1])) return { url: m[1], type: 'hls' };
    }
  }

  // 3. mp4 fallback — explicit var assignment only, NOT bare URL match
  const mp4VarPatterns = [
    /(?:mp4|source|src|videoUrl|directUrl)\s*[:=]\s*['"]([^'"]+\.mp4[^'"]*)['"]/i,
  ];
  for (const pat of mp4VarPatterns) {
    const m = html.match(pat);
    if (m?.[1] && !isBlocked(m[1])) return { url: m[1], type: 'mp4' };
  }

  return null;
}

class VoeSite extends BaseSite {
  constructor() {
    super();
    this.id      = 'voe';
    this.name    = 'VOE.sx';
    this.version = '1.1.0';
    this.domains = VOE_DOMAINS;
  }

  async bypass(url, opts = {}) {
    return this.extract(url);
  }

  async extract(url) {
    const jar = new CookieJar();

    // ── Step 1: Load main page ────────────────────────────────────────────
    const pageRes = await rawGet(url, {
      headers        : BASE_HEADERS,
      jar,
      followRedirects: true,
      timeout        : 15000,
    });

    const html     = pageRes.body;
    const finalUrl = pageRes.url || url;

    // ── Step 2: File ID ───────────────────────────────────────────────────
    const fileId = (
      finalUrl.match(/\/([a-z0-9]{8,20})(?:[?/]|$)/) ||
      url.match(/\/([a-z0-9]{8,20})(?:[?/]|$)/)
    )?.[1] ?? null;

    if (!fileId) throw new Error('voe: could not extract file ID from URL');

    // ── Step 3: Try main page source first ───────────────────────────────
    let found = extractM3u8(html);
    if (found) return this._buildResult(fileId, found);

    // ── Step 4: Embed endpoints ───────────────────────────────────────────
    const baseUrl        = new URL(finalUrl).origin;
    const embedEndpoints = [
      `${baseUrl}/e/${fileId}`,
      `https://voe.sx/e/${fileId}`,
      `https://caseyseemavoid.com/e/${fileId}`,
    ];

    for (const endpoint of embedEndpoints) {
      try {
        const embedRes = await rawGet(endpoint, {
          headers: {
            ...BASE_HEADERS,
            Referer        : url,
            'Sec-Fetch-Dest': 'iframe',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'cross-site',
          },
          jar,
          timeout: 10000,
        });

        found = extractM3u8(embedRes.body);
        if (found) return this._buildResult(fileId, found);
      } catch { continue; }
    }

    // ── Step 5: /api/file/info ────────────────────────────────────────────
    try {
      const apiRes = await rawGet(`https://voe.sx/api/file/info/${fileId}`, {
        headers: BASE_HEADERS,
        jar,
        timeout: 8000,
      });
      // rawGet likely returns body as string — try parse
      const data = typeof apiRes.body === 'string'
        ? JSON.parse(apiRes.body)
        : apiRes.body;

      const hls = data?.file?.hls || data?.file?.stream;
      const mp4 = data?.file?.mp4 || data?.file?.direct;

      if (hls && !isBlocked(hls)) return this._buildResult(fileId, { url: hls, type: 'hls' });
      if (mp4 && !isBlocked(mp4)) return this._buildResult(fileId, { url: mp4, type: 'mp4' });
    } catch { /* 404 or parse fail — continue */ }

    throw new Error('voe: stream URL not found — page structure may have changed or token expired');
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
