// src/sites/mcloud.js
const BaseSite = require('../site-base');
const { get } = require('../http');
const cheerio  = require('cheerio');

class McloudSite extends BaseSite {
  constructor() {
    super({
      id:      'mcloud',
      name:    'MCloud',
      version: '1.0.0',
      domains: ['mcloud.to', 'mcloud.bz'],
    });
  }

  extract(url) {
    const m = url.match(/mcloud\.[a-z]+\/(?:e|v)\/([A-Za-z0-9]+)/);
    return m ? { file_id: m[1] } : null;
  }

  async validate(url) {
    const r = await get(url);
    return r.data.includes('m3u8') || r.data.includes('file:');
  }

  async bypass(url) {
    const r  = await get(url, { Referer: url });
    const $  = cheerio.load(r.data);
    const sc = $('script').map((_, el) => $(el).html()).get().join('\n');

    const m = sc.match(/file\s*:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/);
    if (!m) throw new Error('mcloud: HLS source not found');

    return {
      filename: null,
      servers:  [{ label: 'HLS Stream', url: m[1], server: 'hls' }],
    };
  }
}

module.exports = new McloudSite();
