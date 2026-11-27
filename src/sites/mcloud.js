
'use strict';

const BaseSite = require('../site-base');
const https = require('https');
const http = require('http');
const zlib = require('zlib');

// --------------------------------------------------
// STAGE 1: Extract token and metadata
// --------------------------------------------------

function parseStage1(html, baseUrl = 'https://mcloud.best', fallbackId = null) {
  const meta = {};

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) meta.filename = title[1].replace(/<[^>]+>/g, '').trim();

  const size = html.match(/Size[\s\S]{0,100}?([\d.]+\s*[KMGT]?B)/i);
  if (size) meta.size = size[1].trim();

  const mime = html.match(
    /MimeType[\s\S]{0,100}?(video\/[a-z0-9.+-]+|application\/[a-z0-9.+-]+)/i
  );
  if (mime) meta.type = mime[1];

  let tokenUrl = null;

  const patterns = [
    /(?:window\.)?location\.assign\(\s*["']([^"']+\?token=[^"']+)["']\s*\)/i,
    /location\.href\s*=\s*["']([^"']+\?token=[^"']+)["']/i,
    /["'](https?:\/\/mcloud\.best\/[^"']+\?token=[^"']+)["']/i,
    /href=["']([^"']+\?token=[^"']+)["']/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      try {
        tokenUrl = new URL(match[1], baseUrl).href;
        break;
      } catch (_) {}
    }
  }

  // Token value fallback
  if (!tokenUrl) {
    const token = html.match(/[?&]token=([A-Za-z0-9+/_=-]{20,})/i);

    if (token) {
      const idMatch =
        html.match(/\/([a-zA-Z0-9_-]{6,})\?token=/i);

      const id = idMatch ? idMatch[1] : fallbackId;

      if (id) {
        tokenUrl = new URL(
          `/${id}?token=${encodeURIComponent(token[1])}`,
          baseUrl
        ).href;
      }
    }
  }

  if (!tokenUrl) {
    throw new Error('MCloud: token URL not found in landing HTML');
  }

  return { tokenUrl, meta };
}

// --------------------------------------------------
// STAGE 2: Extract download servers
// --------------------------------------------------

function parseStage2(html) {
  const links = [];
  const seen = new Set();

  function push(label, url, server) {
    if (!url) return;

    try {
      const parsed = new URL(url);

      if (!['http:', 'https:'].includes(parsed.protocol)) return;
      if (seen.has(parsed.href)) return;

      seen.add(parsed.href);
      links.push({
        label,
        url: parsed.href,
        server
      });
    } catch (_) {}
  }

  let m;

  // Cloudflare R2
  const r2Patterns = [
    /href=["'](https:\/\/[^"']+\.r2\.dev\/[^"']+)["']/gi,
    /href=["'](https:\/\/[^"']+\.r2\.cloudflarestorage\.com\/[^"']+)["']/gi,
    /data-minute-base-url=["'](https:\/\/[^"']+)["']/gi
  ];

  for (const regex of r2Patterns) {
    while ((m = regex.exec(html)) !== null) {
      push('FSL / R2 Server', m[1], 'r2');
    }
  }

  // PixelDrain
  const pixelPatterns = [
    /href=["'](https:\/\/(?:pixeldrain\.(?:dev|com|net)|pd\.[^"']+))["']/gi,
    /var\s+pxl\s*=\s*["'](https:\/\/[^"']+)["']/gi
  ];

  for (const regex of pixelPatterns) {
    while ((m = regex.exec(html)) !== null) {
      push('PixelDrain Server', m[1], 'pixeldrain');
    }
  }

  // Other download buttons
  const buttonRegex =
    /<(?:a|button)\b[^>]*?(?:href=["'](https?:\/\/[^"']+)["'])?[^>]*class=["'][^"']*btn(?:-success|-danger|-primary)[^"']*["'][^>]*>/gi;

  while ((m = buttonRegex.exec(html)) !== null) {
    if (m[1]) {
      push('Download Server', m[1], 'other');
    }
  }

  // Direct file links
  const directRegex =
    /href=["'](https:\/\/[^"']+\.(?:mkv|mp4|avi|zip|rar|7z|iso)(?:\?[^"']*)?)["']/gi;

  while ((m = directRegex.exec(html)) !== null) {
    push('Direct File', m[1], 'direct');
  }

  return links;
}

// --------------------------------------------------
// METADATA
// --------------------------------------------------

function parseMeta(html) {
  const meta = {};

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) meta.filename = title[1].trim();

  const size = html.match(/Size[\s\S]{0,100}?([\d.]+\s*[KMGT]?B)/i);
  if (size) meta.size = size[1].trim();

  const mime = html.match(
    /MimeType[\s\S]{0,100}?(video\/[a-z0-9.+-]+|application\/[a-z0-9.+-]+)/i
  );
  if (mime) meta.type = mime[1];

  return meta;
}

// --------------------------------------------------
// FETCH HTML
// --------------------------------------------------

function fetchPage(url, referer = '', redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) {
      return reject(new Error('MCloud: too many redirects'));
    }

    let parsed;

    try {
      parsed = new URL(url);
    } catch (_) {
      return reject(new Error('Invalid URL'));
    }

    const lib = parsed.protocol === 'https:' ? https : http;

    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br'
    };

    if (referer) headers.Referer = referer;

    const req = lib.get({
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      headers,
      timeout: 30000
    }, res => {

      if ([301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location) {

        const next = new URL(res.headers.location, parsed).href;
        res.resume();

        return resolve(
          fetchPage(next, referer, redirects + 1)
        );
      }

      const chunks = [];

      res.on('data', chunk => chunks.push(chunk));

      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const encoding = (res.headers['content-encoding'] || '')
          .toLowerCase();

        const finish = (err, data) => {
          if (err) return reject(err);

          resolve({
            status: res.statusCode,
            body: data.toString('utf8'),
            finalUrl: url
          });
        };

        if (encoding.includes('br')) {
          zlib.brotliDecompress(raw, finish);
        } else if (encoding.includes('gzip')) {
          zlib.gunzip(raw, finish);
        } else if (encoding.includes('deflate')) {
          zlib.inflate(raw, finish);
        } else {
          finish(null, raw);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
  });
}

// --------------------------------------------------
// MCLOUD PLUGIN
// --------------------------------------------------

class MCloud extends BaseSite {

  constructor() {
    super();

    this.name = 'MCloud';
    this.id = 'mcloud';
    this.version = '9.0.0';
    this.domains = ['mcloud.best'];
  }

  extract(url) {
    const u = new URL(url);

    if (!this.match(url)) {
      throw new Error('Invalid MCloud domain');
    }

    const match = u.pathname.match(/^\/([a-zA-Z0-9_-]{6,})\/?$/);

    if (!match) {
      throw new Error('MCloud: cannot extract file ID');
    }

    return {
      id: match[1],
      host: u.hostname,
      token: u.searchParams.get('token')
    };
  }

  validate(html) {
    return {
      valid:
        html.includes('mirrors-container') ||
        html.includes('Download Links Ready') ||
        html.includes('pixeldrain') ||
        html.includes('r2.dev') ||
        html.includes('data-minute-base-url'),
      reason: 'Not a recognized MCloud mirror page'
    };
  }

  async bypass(url, opts = {}) {
    const { id, token } = this.extract(url);

    const landingUrl = `https://mcloud.best/${id}`;

    let tokenUrl;
    let metadata = {};

    // Stage 1: Get landing HTML
    if (token) {
      tokenUrl = url;
    } else {
      const page = await fetchPage(landingUrl);

      if (page.status !== 200) {
        throw new Error(`MCloud landing page HTTP ${page.status}`);
      }

      const stage1 = parseStage1(
        page.body,
        landingUrl,
        id
      );

      tokenUrl = stage1.tokenUrl;
      metadata = stage1.meta;
    }

    // Stage 2: Get mirror HTML
    const mirror = await fetchPage(tokenUrl, landingUrl);

    if (mirror.status !== 200) {
      throw new Error(
        `MCloud mirror HTTP ${mirror.status}`
      );
    }

    if (!this.validate(mirror.body).valid) {
      throw new Error('MCloud: invalid mirror page');
    }

    // Stage 3: Parse all servers
    const servers = parseStage2(mirror.body);

    if (!servers.length) {
      throw new Error(
        'MCloud: no supported download links found'
      );
    }

    metadata = {
      ...metadata,
      ...parseMeta(mirror.body)
    };

    this.onSuccess();

    return this._result(
      id,
      metadata,
      servers,
      {
        final_page: mirror.finalUrl,
        token_page: tokenUrl,
        server_count: servers.length
      }
    );
  }
}

module.exports = new MCloud();
