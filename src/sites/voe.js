'use strict';

const BaseSite              = require('../site-base');
const { rawGet, rawPost, CookieJar } = require('../http');

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

function extractCsrf(html) {
  // meta tag
  const meta = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/i);
  if (meta) return meta[1];
  // input field
  const input = html.match(/<input[^>]+name="_token"[^>]+value="([^"]+)"/i);
  if (input) return input[1];
  return null;
}

function extractCdnUrl(text) {
  // cloudwindow CDN URLs
  const cdn = text.match(/https?:\/\/[^\s"'<>]*cloudwindow[^\s"'<>]+/);
  if (cdn && !isBlocked(cdn[0])) return cdn[0];
  // any mp4
  const mp4 = text.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/);
  if (mp4 && !isBlocked(mp4[0])) return mp4[0];
  // any m3u8
  const m3u = text.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/);
  if (m3u && !isBlocked(m3u[0])) return { url: m3u[0], type: 'hls' };
  return null;
}

class VoeSite extends BaseSite {
  constructor() {
    super();
    this.id      = 'voe';
    this.name    = 'VOE.sx';
    this.version = '4.0.0';
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

    // ── Step 2: load casey page — get session cookies + CSRF token ────────
    const pageRes = await rawGet(`https://caseyseemavoid.com/${fileId}`, {
      headers        : { ...BASE_HEADERS, Referer: 'https://voe.sx/' },
      jar,
      followRedirects: true,
      timeout        : 15000,
    });

    const html  = pageRes.body || '';
    const csrf  = extractCsrf(html);

    // ── Step 3: POST to download endpoint with CSRF ───────────────────────
    if (csrf) {
      try {
        const postRes = await rawPost(
          `https://caseyseemavoid.com/${fileId}/download`,
          { _token: csrf },
          {
            headers: {
              ...BASE_HEADERS,
              'Referer'         : `https://caseyseemavoid.com/${fileId}`,
              'Origin'          : 'https://caseyseemavoid.com',
              'Accept'          : 'application/json, text/plain, */*',
              'X-Requested-With': 'XMLHttpRequest',
              'Content-Type'    : 'application/x-www-form-urlencoded',
              'X-CSRF-TOKEN'    : csrf,
            },
            jar,
            followRedirects: true,
            timeout        : 15000,
          }
        );

        const postBody = postRes.body || '';
        const finalUrl = postRes.finalUrl || '';

        // check redirect URL
        if (finalUrl && finalUrl !== `https://caseyseemavoid.com/${fileId}/download`) {
          if (!isBlocked(finalUrl) && (finalUrl.includes('.mp4') || finalUrl.includes('.m3u8'))) {
            const type = finalUrl.includes('.m3u8') ? 'hls' : 'mp4';
            return this._buildResult(fileId, { url: finalUrl, type });
          }
        }

        // check response body for CDN URL
        const found = extractCdnUrl(postBody);
        if (found) {
          if (typeof found === 'string') return this._buildResult(fileId, { url: found, type: 'mp4' });
          return this._buildResult(fileId, found);
        }

        // try parse JSON response
        try {
          const json = JSON.parse(postBody);
          const cdnUrl = json.url || json.download_url || json.link || json.mp4 || json.stream;
          if (cdnUrl && !isBlocked(cdnUrl)) {
            const type = cdnUrl.includes('.m3u8') ? 'hls' : 'mp4';
            return this._buildResult(fileId, { url: cdnUrl, type });
          }
        } catch { /* not JSON */ }

      } catch (e) {
        console.warn(`[voe] POST download failed: ${e.message}`);
      }
    }

    // ── Step 4: GET download with session cookies (no redirect block) ─────
    try {
      const dlRes = await rawGet(`https://caseyseemavoid.com/${fileId}/download`, {
        headers: {
          ...BASE_HEADERS,
          'Referer': `https://caseyseemavoid.com/${fileId}`,
          'Accept' : 'application/json, */*',
        },
        jar,
        followRedirects: true,
        timeout        : 15000,
      });

      const dlBody   = dlRes.body    || '';
      const dlFinal  = dlRes.finalUrl || '';

      if (dlFinal && !isBlocked(dlFinal) && (dlFinal.includes('.mp4') || dlFinal.includes('.m3u8'))) {
        const type = dlFinal.includes('.m3u8') ? 'hls' : 'mp4';
        return this._buildResult(fileId, { url: dlFinal, type });
      }

      const found = extractCdnUrl(dlBody);
      if (found) {
        if (typeof found === 'string') return this._buildResult(fileId, { url: found, type: 'mp4' });
        return this._buildResult(fileId, found);
      }
    } catch (e) {
      console.warn(`[voe] GET download failed: ${e.message}`);
    }

    // ── Step 5: embed page HLS fallback ───────────────────────────────────
    try {
      const embedRes = await rawGet(`https://caseyseemavoid.com/e/${fileId}`, {
        headers        : { ...BASE_HEADERS, Referer: `https://caseyseemavoid.com/${fileId}` },
        jar,
        followRedirects: true,
        timeout        : 15000,
      });
      const embedHtml = embedRes.body || '';
      const found     = extractCdnUrl(embedHtml);
      if (found) {
        if (typeof found === 'string') return this._buildResult(fileId, { url: found, type: 'mp4' });
        return this._buildResult(fileId, found);
      }
    } catch { /* ignore */ }

    throw new Error('voe: stream URL not found — site may require browser-side JS execution');
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
