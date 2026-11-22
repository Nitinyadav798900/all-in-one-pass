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

class VoeSite extends BaseSite {
  constructor() {
    super();
    this.id      = 'voe';
    this.name    = 'VOE.sx';
    this.version = '3.0.0';
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

    // ── Step 2: voe.sx → caseyseemavoid redirect ─────────────────────────
    // voe.sx does JS redirect to caseyseemavoid.com
    // caseyseemavoid.com/{fileId}/download redirects to real CDN mp4

    const downloadEndpoints = [
      `https://caseyseemavoid.com/${fileId}/download`,
      `https://caseyseemavoid.com/file/${fileId}/download`,
      `https://voe.sx/${fileId}/download`,
    ];

    let mp4Url  = null;
    let m3u8Url = null;

    for (const endpoint of downloadEndpoints) {
      try {
        const res = await rawGet(endpoint, {
          headers        : { ...BASE_HEADERS, Referer: 'https://voe.sx/' },
          jar,
          followRedirects: true,
          timeout        : 15000,
        });

        const finalUrl = res.url || endpoint;

        // redirect landed on actual CDN URL
        if (
          finalUrl !== endpoint &&
          !isBlocked(finalUrl) &&
          (finalUrl.includes('.mp4') || finalUrl.includes('.m3u8'))
        ) {
          if (finalUrl.includes('.m3u8')) m3u8Url = finalUrl;
          else mp4Url = finalUrl;
          break;
        }

        // also check response body for redirect or meta-refresh
        const html = res.body || '';
        if (html.length < 50000) {
          // look for direct URL in small page
          const urlMatch = html.match(/https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8)[^\s"'<>]*/);
          if (urlMatch && !isBlocked(urlMatch[0])) {
            if (urlMatch[0].includes('.m3u8')) m3u8Url = urlMatch[0];
            else mp4Url = urlMatch[0];
            break;
          }
        }
      } catch { continue; }
    }

    // ── Step 3: try /e/ embed page for HLS ───────────────────────────────
    if (!mp4Url && !m3u8Url) {
      try {
        const embedRes = await rawGet(`https://caseyseemavoid.com/e/${fileId}`, {
          headers: { ...BASE_HEADERS, Referer: 'https://voe.sx/' },
          jar,
          followRedirects: true,
          timeout        : 15000,
        });

        const html = embedRes.body || '';

        // try to find direct stream link in page
        const hlsMatch = html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/);
        if (hlsMatch && !isBlocked(hlsMatch[0])) m3u8Url = hlsMatch[0];

        const mp4Match = html.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/);
        if (!m3u8Url && mp4Match && !isBlocked(mp4Match[0])) mp4Url = mp4Match[0];
      } catch { /* continue */ }
    }

    if (!mp4Url && !m3u8Url)
      throw new Error('voe: stream URL not found');

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
