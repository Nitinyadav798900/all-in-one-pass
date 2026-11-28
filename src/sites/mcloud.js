// src/sites/mcloud.js — full rewrite
'use strict';

const BaseSite = require('../site-base');
const { rawGet, sleep, CookieJar } = require('../http');

// --------------------------------------------------
// STAGE 1: Extract token URL and metadata
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
    /href=["']([^"']+\?token=[^"']+)["']/i,
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

  // token value fallback
  if (!tokenUrl) {
    const token = html.match(/[?&]token=([A-Za-z0-9+/_=-]{20,})/i);
    if (token) {
      const idMatch = html.match(/\/([a-zA-Z0-9_-]{6,})\?token=/i);
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
  const seen  = new Set();

  function push(label, url, server) {
    if (!url) return;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return;
      if (seen.has(parsed.href)) return;
      seen.add(parsed.href);
      links.push({ label, url: parsed.href, server });
    } catch (_) {}
  }

  let m;

  // Cloudflare R2
  const r2Patterns = [
    /href=["'](https:\/\/[^"']+\.r2\.dev\/[^"']+)["']/gi,
    /href=["'](https:\/\/[^"']+\.r2\.cloudflarestorage\.com\/[^"']+)["']/gi,
    /data-minute-base-url=["'](https:\/\/[^"']+)["']/gi,
  ];
  for (const regex of r2Patterns) {
    while ((m = regex.exec(html)) !== null) push('FSL / R2 Server', m[1], 'r2');
  }

  // PixelDrain
  const pixelPatterns = [
    /href=["'](https:\/\/(?:pixeldrain\.(?:dev|com|net)|pd\.[^"']+))["']/gi,
    /var\s+pxl\s*=\s*["'](https:\/\/[^"']+)["']/gi,
  ];
  for (const regex of pixelPatterns) {
    while ((m = regex.exec(html)) !== null) push('PixelDrain Server', m[1], 'pixeldrain');
  }

  // Generic download buttons
  const buttonRegex =
    /<(?:a|button)\b[^>]*?(?:href=["'](https?:\/\/[^"']+)["'])?[^>]*class=["'][^"']*btn(?:-success|-danger|-primary)[^"']*["'][^>]*>/gi;
  while ((m = buttonRegex.exec(html)) !== null) {
    if (m[1]) push('Download Server', m[1], 'other');
  }

  // Direct file links
  const directRegex =
    /href=["'](https:\/\/[^"']+\.(?:mkv|mp4|avi|zip|rar|7z|iso)(?:\?[^"']*)?)["']/gi;
  while ((m = directRegex.exec(html)) !== null) push('Direct File', m[1], 'direct');

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
// MCLOUD PLUGIN
// --------------------------------------------------

class MCloud extends BaseSite {
  constructor() {
    super();
    this.name    = 'MCloud';
    this.id      = 'mcloud';
    this.version = '10.0.0';
    this.domains = ['mcloud.best'];
  }

  extract(url) {
    const u = new URL(url);
    if (!this.match(url)) throw new Error('Invalid MCloud domain');
    const match = u.pathname.match(/^\/([a-zA-Z0-9_-]{6,})\/?$/);
    if (!match) throw new Error('MCloud: cannot extract file ID');
    return {
      id   : match[1],
      host : u.hostname,
      token: u.searchParams.get('token'),
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
      reason: 'Not a recognized MCloud mirror page',
    };
  }

  async bypass(url, opts = {}) {
    const { id, token } = this.extract(url);
    const landingUrl    = `https://mcloud.best/${id}`;
    const jar           = new CookieJar();

    let tokenUrl;
    let metadata = {};

    if (token) {
      // already have token — skip stage 1
      tokenUrl = url;
    } else {
      // ── Stage 1: landing page ──────────────────────────────────────
      // warm root first — picks up CF cookies
      try {
        await rawGet('https://mcloud.best/', {
          jar,
          referer: 'https://www.google.com/',
          headers: {
            'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          },
          timeout: 15000,
        });
        await sleep(500 + Math.random() * 400);
      } catch (_) {}

      const page = await rawGet(landingUrl, {
        jar,
        referer: 'https://mcloud.best/',
        headers: {
          'Accept'                   : 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest'           : 'document',
          'Sec-Fetch-Mode'           : 'navigate',
          'Sec-Fetch-Site'           : 'same-origin',
          'Sec-Fetch-User'           : '?1',
        },
        timeout: 20000,
      });

      if (page.status === 403) throw new Error('MCloud: 403 — Cloudflare blocking server IP. Try a residential proxy.');
      if (page.status !== 200) throw new Error(`MCloud landing page HTTP ${page.status}`);

      const stage1 = parseStage1(page.body, landingUrl, id);
      tokenUrl     = stage1.tokenUrl;
      metadata     = stage1.meta;
    }

    // ── Stage 2: mirror/token page ──────────────────────────────────
    await sleep(600 + Math.random() * 400);

    const mirror = await rawGet(tokenUrl, {
      jar,
      referer: landingUrl,
      headers: {
        'Accept'        : 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
      },
      timeout: 20000,
    });

    if (mirror.status !== 200) throw new Error(`MCloud mirror HTTP ${mirror.status}`);

    if (!this.validate(mirror.body).valid) {
      console.error('[mcloud] mirror snippet:', mirror.body.slice(0, 1000));
      throw new Error('MCloud: invalid mirror page — structure changed?');
    }

    // ── Stage 3: parse servers ──────────────────────────────────────
    const servers = parseStage2(mirror.body);

    if (!servers.length) throw new Error('MCloud: no supported download links found');

    metadata = { ...metadata, ...parseMeta(mirror.body) };

    this.onSuccess();

    return this._result(id, metadata, servers, {
      final_page  : mirror.finalUrl,
      token_page  : tokenUrl,
      server_count: servers.length,
    });
  }
}

module.exports = new MCloud();
