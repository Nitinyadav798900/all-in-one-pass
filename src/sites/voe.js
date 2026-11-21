'use strict';

const axios    = require('axios');
const BaseSite = require('./base'); // path check karo — same dir mein hoga

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

class VoeSite extends BaseSite {
  constructor() {
    super();
    this.id      = 'voe';
    this.name    = 'VOE.sx';
    this.version = '1.0.0';
    this.domains = VOE_DOMAINS;
  }

  match(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      return VOE_DOMAINS.includes(host);
    } catch {
      return false;
    }
  }

  async bypass(url) {
    return this.extract(url);
  }

  async extract(url) {
    const session = axios.create({ headers: HEADERS });

    const pageRes = await session.get(url, {
      maxRedirects : 5,
      timeout      : 15000,
      validateStatus: s => s < 400,
    });

    const html     = pageRes.data;
    const finalUrl = pageRes.request?.res?.responseUrl || url;

    const fileIdMatch =
      finalUrl.match(/\/([a-z0-9]{8,20})(?:\?|$|\/)/) ||
      url.match(/\/([a-z0-9]{8,20})(?:\?|$|\/)/);
    const fileId = fileIdMatch?.[1] ?? null;

    if (!fileId) throw new Error('Could not extract file ID from URL');

    const baseUrl       = new URL(finalUrl).origin;
    const embedEndpoints = [
      `${baseUrl}/e/${fileId}`,
      `https://voe.sx/e/${fileId}`,
      `https://caseyseemavoid.com/e/${fileId}`,
    ];

    let m3u8Url = null;
    let mp4Url  = null;

    for (const endpoint of embedEndpoints) {
      try {
        const embedRes  = await session.get(endpoint, {
          timeout: 10000,
          headers: { ...HEADERS, Referer: url },
        });
        const embedHtml = embedRes.data;

        const hls = embedHtml.match(/["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)['"]/);
        if (hls) { m3u8Url = hls[1]; break; }

        const mp4 = embedHtml.match(/["'](https?:\/\/[^"'<>\s]+\.mp4[^"'<>\s]*)['"]/);
        if (mp4) { mp4Url = mp4[1]; break; }
      } catch { continue; }
    }

    if (!m3u8Url && !mp4Url) {
      try {
        const apiRes = await session.get(
          `https://voe.sx/api/file/info/${fileId}`,
          { timeout: 8000, headers: HEADERS }
        );
        if (apiRes.data?.file) {
          m3u8Url = apiRes.data.file.hls    || apiRes.data.file.stream || null;
          mp4Url  = apiRes.data.file.mp4    || apiRes.data.file.direct || null;
        }
      } catch { /* endpoint may not exist */ }
    }

    if (!m3u8Url && !mp4Url) {
      const srcMatch = html.match(/var\s+source\s*=\s*['"]([^'"]+)['"]/);
      if (srcMatch && !srcMatch[1].includes('test-videos.co.uk')) {
        const src = srcMatch[1];
        if (src.includes('.m3u8'))      m3u8Url = src;
        else if (src.includes('.mp4')) mp4Url  = src;
      }
      const wurlMatch = html.match(/wurl\s*[:=]\s*['"]([^'"]+)['"]/);
      if (wurlMatch) m3u8Url = wurlMatch[1];
    }

    if (!m3u8Url && !mp4Url)
      throw new Error('Stream URL not found — voe.sx uses dynamic token generation, URL may be expired or geo-blocked');

    return {
      success : true,
      url     : m3u8Url || mp4Url,
      hls     : m3u8Url || null,
      mp4     : mp4Url  || null,
      file_id : fileId,
      headers : { Referer: 'https://voe.sx/', Origin: 'https://voe.sx' },
      servers : [{ url: m3u8Url || mp4Url, type: m3u8Url ? 'hls' : 'mp4' }],
    };
  }
}

module.exports = new VoeSite();
