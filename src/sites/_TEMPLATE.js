'use strict';

/**
 * ═══════════════════════════════════════════════════════════
 * HOW TO ADD A NEW SITE — COPY THIS FILE
 * ═══════════════════════════════════════════════════════════
 *
 * Step 1: Copy this file → src/sites/yoursite.js
 * Step 2: Fill in the 4 required sections below
 * Step 3: Add 'yoursite.js' to SITE_FILES in src/registry.js
 * Step 4: npm start — plugin auto-loads
 *
 * No other files need to change. Ever.
 * ═══════════════════════════════════════════════════════════
 */

const BaseSite              = require('../site-base');
const { rawGet, rawPost, sleep, CookieJar } = require('../http');

class YourSite extends BaseSite {
  constructor() {
    super();

    // ── SECTION 1: Identity ─────────────────────────────────────────
    this.name    = 'YourSite';        // human-readable name
    this.id      = 'yoursite';        // unique slug — used in API responses + cache keys
    this.version = '1.0.0';
    this.domains = [
      'yoursite.com',                 // all domains this plugin handles
      'www.yoursite.com',
      'sub.yoursite.com',
    ];
  }

  // ── SECTION 2: URL parser ─────────────────────────────────────────────
  // Extract file ID and any other params from the URL
  extract(url) {
    const u     = new URL(url);
    // Change this regex to match your site's URL pattern
    const match = u.pathname.match(/\/(?:file|d|view|download)\/([a-zA-Z0-9_-]+)/);
    if (!match) throw new Error(`${this.name}: cannot extract file ID from URL`);
    return {
      id  : match[1],
      host: u.hostname,
      // Add any query params you need:
      // token: u.searchParams.get('token'),
    };
  }

  // ── SECTION 3: Validation ─────────────────────────────────────────────
  // Quick sanity check on the fetched HTML
  // Return { valid: false } if the page looks wrong (site changed structure)
  validate(html) {
    return {
      valid : html.includes('download') && html.length > 300,
      reason: `Missing expected ${this.name} structure`,
    };
  }

  // ── SECTION 4: Bypass logic ───────────────────────────────────────────
  // The actual bypass. Must return this._result(id, meta, servers)
  async bypass(url) {
    const { id, host } = this.extract(url);
    const jar = new CookieJar();

    // ── Step 1: Load the page ──────────────────────────────────────
    const page = await rawGet(url, {
      referer: `https://${host}/`,
      jar,
    });

    if (page.status === 404) throw new Error(`${this.name}: file not found`);
    if (page.status >= 400) throw new Error(`${this.name}: HTTP ${page.status}`);

    // ── Step 2: Validate structure ─────────────────────────────────
    const v = this.validate(page.body);
    if (!v.valid) throw new Error(`${this.name}: ${v.reason}`);

    // ── Step 3: Extract metadata ───────────────────────────────────
    const meta = _parseMeta(page.body, id);

    // ── Step 4: Try to find download links in page directly ────────
    let servers = _parseLinks(page.body);
    if (servers.length > 0) return this._result(id, meta, servers);

    // ── Step 5: If not found, try POST to get download links ───────
    // (Remove this if your site doesn't need a POST)
    await sleep(1500);

    const postBody = {
      id,
      // add CSRF token if needed: _token: _extractCsrf(page.body),
    };

    const r2 = await rawPost(`https://${host}/download`, postBody, {
      referer: url,
      jar,
    });

    servers = _parseLinks(r2.body);
    if (servers.length === 0) throw new Error(`${this.name}: no download links found`);

    return this._result(id, meta, servers);
  }
}

// ── Helpers (customize per site) ─────────────────────────────────────────

function _parseMeta(html, fallbackId) {
  const meta = {};

  // Try to find filename in <h1>, <h2>, <title> etc.
  const h = html.match(/<(?:h[1-3]|title)[^>]*>([^<]{5,200}?)<\/(?:h[1-3]|title)>/i);
  meta.filename = h ? h[1].trim() : fallbackId;

  // File size
  const s = html.match(/(\d+(?:\.\d+)?\s*(?:GB|MB|KB|TB))/i);
  if (s) meta.size = s[1];

  return meta;
}

function _parseLinks(html) {
  const links = [], seen = new Set();
  const push  = (label, url, server) => {
    if (!url || !url.startsWith('http') || seen.has(url)) return;
    seen.add(url); links.push({ label, url, server });
  };

  // Add all patterns that match your site's download buttons
  // Examples:

  // Google Drive
  const gdRe = /href=["'](https?:\/\/drive\.google\.com\/[^"']+)["']/gi;
  let m;
  while ((m = gdRe.exec(html)) !== null) push('Google Drive', m[1], 'gdrive');

  // PixelDrain
  const pxRe = /href=["'](https?:\/\/pixeldrain[^"']+)["']/gi;
  while ((m = pxRe.exec(html)) !== null) push('PixelDrain', m[1], 'pixeldrain');

  // Mega
  const mgRe = /href=["'](https?:\/\/mega\.nz\/[^"']+)["']/gi;
  while ((m = mgRe.exec(html)) !== null) push('Mega', m[1], 'mega');

  // Direct R2/S3
  const r2Re = /href=["'](https?:\/\/[^"']*\.r2\.cloudflarestorage[^"']+)["']/gi;
  while ((m = r2Re.exec(html)) !== null) push('Direct Server', m[1], 'r2');

  // Add more patterns here as needed...

  return links;
}

module.exports = new YourSite();
