'use strict';

const BaseSite              = require('../site-base');
const { rawGet, rawPost, sleep, CookieJar } = require('../http');

/**
 * MultiCloudLinks bypass
 * URL: https://new3.multicloudlinks.com/view/f533404ca2?c=72hb9w&exp=1795012311&token=...
 *
 * Flow:
 *   1. GET /view/{id}?c=...&exp=...&token=... → parse page
 *   2. Extract the hidden form / JS fetch params
 *   3. POST to generate download links
 *   4. Parse JSON response with server URLs
 */
class MultiCloudLinks extends BaseSite {
  constructor() {
    super();
    this.name    = 'MultiCloudLinks';
    this.id      = 'multicloud';
    this.version = '1.0.0';
    this.domains = [
      'multicloudlinks.com',
      'new3.multicloudlinks.com',
      'new2.multicloudlinks.com',
      'new1.multicloudlinks.com',
      'multicloudlinks.net',
    ];
  }

  extract(url) {
    const u     = new URL(url);
    const match = u.pathname.match(/\/view\/([a-zA-Z0-9_-]+)/);
    if (!match) throw new Error('MultiCloudLinks: cannot extract view ID');
    return {
      id    : match[1],
      host  : u.hostname,
      c     : u.searchParams.get('c'),
      exp   : u.searchParams.get('exp'),
      token : u.searchParams.get('token'),
      full  : url,
    };
  }

  validate(html) {
    return {
      valid : html.includes('multicloud') || html.includes('download') || html.length > 500,
      reason: 'Missing MultiCloudLinks structure',
    };
  }

  async bypass(url) {
    const params = this.extract(url);
    const jar    = new CookieJar();

    // ── Stage 1: Load the view page ─────────────────────────────────
    const page = await rawGet(url, {
      referer: `https://${params.host}/`,
      jar,
    });

    if (page.status >= 400) throw new Error(`MultiCloudLinks: HTTP ${page.status}`);

    const meta = _parseMeta(page.body, params.id);

    // ── Stage 2: Extract API params from page ────────────────────────
    const apiParams = _extractApiParams(page.body, params);

    await sleep(1200);

    // ── Stage 3: Try multiple download API patterns ──────────────────
    const baseUrl  = `https://${params.host}`;
    let   servers  = [];

    // Pattern A: JSON API endpoint
    if (apiParams.apiUrl) {
      try {
        const r = await rawGet(apiParams.apiUrl, { referer: url, jar, headers: { 'Accept': 'application/json' } });
        const j = _parseJson(r.body);
        if (j?.links || j?.servers || j?.data) {
          servers = _parseJsonLinks(j);
        }
      } catch (_) {}
    }

    // Pattern B: POST to /api/download or /download/generate
    if (servers.length === 0) {
      const postBody = {
        id   : params.id,
        c    : params.c || '',
        exp  : params.exp || '',
        token: params.token || '',
        ...apiParams.extraFields,
      };
      const postEndpoints = [
        `${baseUrl}/api/download`,
        `${baseUrl}/download/generate`,
        `${baseUrl}/view/download`,
        `${baseUrl}/api/links`,
      ];
      for (const ep of postEndpoints) {
        try {
          const r = await rawPost(ep, postBody, { referer: url, jar, json: true });
          const j = _parseJson(r.body);
          if (j) {
            servers = _parseJsonLinks(j);
            if (servers.length > 0) break;
          }
        } catch (_) {}
      }
    }

    // Pattern C: Parse page buttons directly
    if (servers.length === 0) {
      servers = _parsePageLinks(page.body);
    }

    if (servers.length === 0) {
      console.error('[multicloud] page snippet:', page.body.slice(0, 1500));
      throw new Error('MultiCloudLinks: no download links found');
    }

    return this._result(params.id, meta, servers);
  }
}

function _parseMeta(html, fallbackId) {
  const meta = {};
  const fn   = html.match(/(?:filename|file.name|title)[^>]*["'>]([^<"'\n]{5,200}?)["'<]/i);
  if (fn) meta.filename = fn[1].trim();
  else {
    const h1 = html.match(/<h[1-3][^>]*>([^<]{5,200}?)<\/h[1-3]>/i);
    meta.filename = h1 ? h1[1].trim() : fallbackId;
  }
  const sz = html.match(/(\d+(?:\.\d+)?\s*(?:GB|MB|KB))/i);
  if (sz) meta.size = sz[1];
  return meta;
}

function _extractApiParams(html, urlParams) {
  const result = { apiUrl: null, extraFields: {} };

  // Look for fetch() / axios calls in JS
  const fetchM = html.match(/fetch\(["'`](https?:\/\/[^"'`\s]+)["'`]/);
  if (fetchM) result.apiUrl = fetchM[1];

  // Look for action URL in forms
  const formM = html.match(/<form[^>]*action=["'](https?:\/\/[^"']+)["']/i);
  if (formM) result.apiUrl = formM[1];

  // Hidden input fields
  const inputRe = /<input[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["']/gi;
  let m;
  while ((m = inputRe.exec(html)) !== null) {
    result.extraFields[m[1]] = m[2];
  }

  return result;
}

function _parseJson(raw) {
  try {
    const clean = raw.replace(/^[^{[]*/, '').replace(/[^}\]]*$/, '');
    return JSON.parse(clean);
  } catch (_) { return null; }
}

function _parseJsonLinks(json) {
  const links = [];
  const candidates = [json?.links, json?.servers, json?.data, json?.downloads, json?.urls];
  for (const list of candidates) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const url   = item?.url || item?.link || item?.href || item;
      const label = item?.name || item?.label || item?.server || 'Download Server';
      if (typeof url === 'string' && url.startsWith('http')) {
        links.push({ label, url, server: _guessServer(url) });
      }
    }
    if (links.length > 0) break;
  }
  // Also check direct url field
  if (links.length === 0 && json?.url) {
    links.push({ label: 'Download Server', url: json.url, server: _guessServer(json.url) });
  }
  return links;
}

function _parsePageLinks(html) {
  const links = [], seen = new Set();
  const push  = (label, url, server) => {
    if (!url || !url.startsWith('http') || seen.has(url) || url.length < 20) return;
    seen.add(url); links.push({ label, url, server });
  };

  const bigRe = /href=["'](https?:\/\/[^"']{30,})["']/gi;
  let m;
  while ((m = bigRe.exec(html)) !== null) {
    const u = m[1];
    if (u.includes('google.com/drive') || u.includes('pixeldrain') ||
        u.includes('mega.nz') || u.includes('r2.cloudflare') ||
        u.includes('fuckingfast') || u.includes('1drv.ms') ||
        u.includes('mediafire')) {
      push(_guessLabel(u), u, _guessServer(u));
    }
  }
  return links;
}

function _guessLabel(url) {
  if (url.includes('drive.google'))  return 'Google Drive';
  if (url.includes('pixeldrain'))    return 'PixelDrain';
  if (url.includes('mega.nz'))       return 'Mega';
  if (url.includes('mediafire'))     return 'MediaFire';
  if (url.includes('1drv'))          return 'OneDrive';
  if (url.includes('r2.cloudflare')) return 'Direct Server';
  if (url.includes('fuckingfast'))   return 'Buzz Server';
  return 'Download Server';
}

function _guessServer(url) {
  if (url.includes('drive.google'))  return 'gdrive';
  if (url.includes('pixeldrain'))    return 'pixeldrain';
  if (url.includes('mega.nz'))       return 'mega';
  if (url.includes('mediafire'))     return 'mediafire';
  if (url.includes('1drv'))          return 'onedrive';
  if (url.includes('r2.cloudflare')) return 'r2';
  if (url.includes('fuckingfast'))   return 'buzz';
  return 'other';
}

module.exports = new MultiCloudLinks();
