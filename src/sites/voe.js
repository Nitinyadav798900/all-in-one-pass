'use strict';

const axios    = require('axios');
const BaseSite = require('./base');

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

const HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept'         : '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer'        : 'https://voe.sx/',
  'Origin'         : 'https://voe.sx',
};

const EMBED_HEADERS = {
  ...HEADERS,
  'Sec-Fetch-Dest': 'iframe',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'cross-site',
};

class VoeSite extends BaseSite {
  constructor() {
    super();
    this.id      = 'voe';
    this.name    = 'VOE.sx';
    this.version = '1.0.0';
    this.domains = VOE_DOMAINS;
  }

  // BaseSite.match() already handles domain check via this.domains
  // override only needed if custom logic required — not needed here

  async bypass(url, opts = {}) {
    return this.extract(url);
  }

  async extract(url) {
    const session = axios.create({ headers: HEADERS });

    // ── Step 1: Load page, follow redirects ──────────────────────────────
    const pageRes = await session.get(url, {
      maxRedirects : 5,
      timeout      : 15000,
      validateStatus: s => s < 400,
    });

    const html     = pageRes.data;
    const finalUrl = pageRes.request?.res?.responseUrl || url;

    // ── Step 2: Extract file ID ───────────────────────────────────────────
    const fileId = (
      finalUrl.match(/\/([a-z0-9]{8,20})(?:[?/]|$)/) ||
      url.match(/\/([a-z0-9]{8,20})(?:[?/]|$)/)
    )?.[1] ?? null;

    if (!fileId) throw new Error('voe: could not extract file ID from URL');

    // ── Step 3: Try embed endpoints ───────────────────────────────────────
    const baseUrl        = new URL(finalUrl).origin;
    const embedEndpoints = [
      `${baseUrl}/e/${fileId}`,
      `https://voe.sx/e/${fileId}`,
      `https://caseyseemavoid.com/e/${fileId}`,
    ];

    let m3u8Url = null;
    let mp4Url  = null;

    for (const endpoint of embedEndpoints) {
      try {
        const { data: embedHtml } = await session.get(endpoint, {
          timeout: 10000,
          headers: { ...EMBED_HEADERS, Referer: url },
        });

        m3u8Url = embedHtml.match(/["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)['"]/)?.[1] ?? null;
        if (m3u8Url) break;

        mp4Url = embedHtml.match(/["'](https?:\/\/[^"'<>\s]+\.mp4[^"'<>\s]*)['"]/)?.[1] ?? null;
        if (mp4Url) break;

        // voe sometimes base64-encodes the HLS url in a JS var
        const b64 = embedHtml.match(/(?:hls|source|stream)\s*[:=]\s*atob\(['"]([A-Za-z0-9+/=]+)['"]\)/)?.[1];
        if (b64) {
          const decoded = Buffer.from(b64, 'base64').toString('utf8');
          if (decoded.includes('.m3u8'))      { m3u8Url = decoded; break; }
          if (decoded.includes('.mp4'))       { mp4Url  = decoded; break; }
        }
      } catch { continue; }
    }

    // ── Step 4: Try undocumented API ─────────────────────────────────────
    if (!m3u8Url && !mp4Url) {
      try {
        const { data: api } = await session.get(
          `https://voe.sx/api/file/info/${fileId}`,
          { timeout: 8000 }
        );
        m3u8Url = api?.file?.hls    || api?.file?.stream || null;
        mp4Url  = api?.file?.mp4    || api?.file?.direct || null;
      } catch { /* endpoint may 404 */ }
    }

    // ── Step 5: Fallback — scrape page source vars ────────────────────────
    if (!m3u8Url && !mp4Url) {
      const src = html.match(/var\s+source\s*=\s*['"]([^'"]+)['"]/)?.[1];
      if (src && !src.includes('test-videos.co.uk')) {
        if (src.includes('.m3u8'))      m3u8Url = src;
        else if (src.includes('.mp4')) mp4Url  = src;
      }

      const wurl = html.match(/wurl\s*[:=]\s*['"]([^'"]+)['"]/)?.[1];
      if (wurl) m3u8Url = wurl;
    }

    if (!m3u8Url && !mp4Url)
      throw new Error('voe: stream URL not found — token may be expired or geo-blocked');

    // ── Build result via BaseSite._result() ───────────────────────────────
    const streamUrl = m3u8Url || mp4Url;
    const type      = m3u8Url ? 'hls' : 'mp4';

    return this._result(
      fileId,
      { title: `VOE/${fileId}`, type },
      [{ url: streamUrl, type, headers: { Referer: 'https://voe.sx/', Origin: 'https://voe.sx' } }],
    );
  }
}

module.exports = new VoeSite();
