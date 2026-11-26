'use strict';

const BaseSite          = require('../site-base');
const { rawGet, sleep, globalJar } = require('../http');

// ── CF bypass strategies ─────────────────────────────────────────────────────
// Priority: 1) FlareSolverr  2) Puppeteer  3) rawGet with stolen cookies
// Check which one your project has available.

let puppeteer = null;
try { puppeteer = require('puppeteer-extra'); } catch (_) {}

let StealthPlugin = null;
try { StealthPlugin = require('puppeteer-extra-plugin-stealth'); } catch (_) {}

// FlareSolverr endpoint — set env or hardcode
const FLARESOLVERR = process.env.FLARESOLVERR_URL || 'http://localhost:8191/v1';

class MCloud extends BaseSite {
  constructor() {
    super();
    this.name    = 'MCloud';
    this.id      = 'mcloud';
    this.version = '2.0.0';
    this.domains = ['mcloud.best'];
  }

  extract(url) {
    const u     = new URL(url);
    const match = u.pathname.match(/\/([a-zA-Z0-9_-]{6,})/);
    if (!match) throw new Error('MCloud: cannot extract file ID from URL');
    return { id: match[1], host: u.hostname };
  }

  validate(html) {
    return {
      valid : html.includes('card-header') || html.includes('Generate Download Link') || html.includes('mCloud'),
      reason: 'Missing expected MCloud structure',
    };
  }

  async bypass(url) {
    const { id, host } = this.extract(url);
    const landingUrl   = `https://${this.domains[0]}/${id}`;

    // ── Try FlareSolverr first (fastest, no browser spawn) ───────────────────
    let html1, url1;
    try {
      ({ html: html1, url: url1 } = await _flaresolverr(landingUrl));
      console.error('[mcloud] ✓ FlareSolverr succeeded');
    } catch (e) {
      console.error('[mcloud] FlareSolverr failed:', e.message);
    }

    // ── Fallback: Puppeteer stealth ───────────────────────────────────────────
    if (!html1 && puppeteer) {
      try {
        ({ html: html1, url: url1 } = await _puppeteer(landingUrl));
        console.error('[mcloud] ✓ Puppeteer succeeded');
      } catch (e) {
        console.error('[mcloud] Puppeteer failed:', e.message);
      }
    }

    if (!html1) throw new Error('MCloud: all CF bypass methods failed for ' + landingUrl);

    const v = this.validate(html1);
    if (!v.valid) {
      console.error('[mcloud] unexpected html:\n', html1.slice(0, 1000));
      throw new Error('MCloud: ' + v.reason);
    }

    // ── Extract token URL ────────────────────────────────────────────────────
    const tokenUrl = _extractTokenUrl(html1, host);
    if (!tokenUrl) {
      console.error('[mcloud] html1 for debug:\n', html1.slice(0, 3000));
      throw new Error('MCloud: token URL not found in landing page');
    }
    console.error('[mcloud] token url:', tokenUrl);

    // ── Fetch mirror page ─────────────────────────────────────────────────────
    // Mirror page is same-origin, CF cookies from step 1 carry over
    let html2, url2;
    try {
      ({ html: html2, url: url2 } = await _flaresolverr(tokenUrl, landingUrl));
    } catch (_) {
      if (puppeteer) {
        ({ html: html2, url: url2 } = await _puppeteer(tokenUrl, landingUrl));
      } else {
        // Last resort: rawGet with globalJar (cookies from flaresolverr may help)
        const r = await rawGet(tokenUrl, { referer: landingUrl });
        html2 = r.body; url2 = r.finalUrl;
      }
    }

    console.error('[mcloud] mirror page bytes:', html2.length);

    const meta    = _parseMeta(html2);
    const servers = _parseServers(html2);

    if (servers.length === 0) {
      console.error('[mcloud] mirror html:\n', html2.slice(0, 3000));
      throw new Error('MCloud: no download links found');
    }

    return this._result(id, meta, servers, { final_page: url2 });
  }
}

// ── FlareSolverr ─────────────────────────────────────────────────────────────
async function _flaresolverr(url, referer = '') {
  const http = require('http');
  const https = require('https');

  const payload = JSON.stringify({
    cmd       : 'request.get',
    url,
    maxTimeout: 60000,
    ...(referer ? { headers: { Referer: referer } } : {}),
  });

  return new Promise((resolve, reject) => {
    const parsed   = new URL(FLARESOLVERR);
    const lib      = parsed.protocol === 'https:' ? https : http;
    const req      = lib.request({
      hostname : parsed.hostname,
      port     : parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path     : parsed.pathname,
      method   : 'POST',
      headers  : {
        'Content-Type'  : 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.status !== 'ok') return reject(new Error('FlareSolverr: ' + (j.message || j.status)));
          const sol = j.solution;
          // Inject cookies into globalJar so rawGet calls also benefit
          if (sol.cookies) {
            for (const c of sol.cookies) {
              try { globalJar.set(c.name, c.value, { domain: c.domain || 'mcloud.best' }); } catch (_) {}
            }
          }
          resolve({ html: sol.response, url: sol.url });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Puppeteer stealth ─────────────────────────────────────────────────────────
async function _puppeteer(url, referer = '') {
  if (!puppeteer) throw new Error('puppeteer-extra not installed');
  if (StealthPlugin) puppeteer.use(StealthPlugin());

  const browser = await puppeteer.launch({
    headless : true,
    args     : [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ ...(referer ? { Referer: referer } : {}) });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for CF to clear (it injects a 5s JS challenge)
    await sleep(6000);

    // If still on CF challenge, wait more
    const title = await page.title();
    if (title.includes('Just a moment') || title.includes('Attention Required')) {
      await sleep(8000);
    }

    const html    = await page.content();
    const finalUrl = page.url();

    // Steal cookies into globalJar
    const cookies = await page.cookies();
    for (const c of cookies) {
      try { globalJar.set(c.name, c.value, { domain: c.domain }); } catch (_) {}
    }

    return { html, url: finalUrl };
  } finally {
    await browser.close();
  }
}

// ── Token extractor ───────────────────────────────────────────────────────────
function _extractTokenUrl(html, fallbackHost) {
  const patterns = [
    /location\.assign\(["']([^"']+\?token=[^"']+)["']\)/i,
    /location\.href\s*=\s*["']([^"']+\?token=[^"']+)["']/i,
    /window\.location\s*=\s*["']([^"']+\?token=[^"']+)["']/i,
    /["']([^"']*\/[a-zA-Z0-9_-]+\?token=[A-Za-z0-9+/=]{10,})["']/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      const path = m[1];
      if (path.startsWith('http')) return path;
      return `https://${fallbackHost}${path.startsWith('/') ? '' : '/'}${path}`;
    }
  }
  return null;
}

// ── Meta parser ───────────────────────────────────────────────────────────────
function _parseMeta(html) {
  const meta = {};
  const fn = html.match(/<div[^>]*card-header[^>]*>\s*([^<\n]{3,300}?)\s*<\/div>/i);
  if (fn) meta.filename = fn[1].trim();
  const sz = html.match(/Size[\s\S]{1,120}?<i[^>]*>([\d.,\s]+[KMGT]?B)<\/i>/i);
  if (sz) meta.size = sz[1].trim();
  const tp = html.match(/MimeType[\s\S]{1,120}?<i[^>]*>([^<]+)<\/i>/i);
  if (tp) meta.type = tp[1].trim();
  return meta;
}

// ── Server parser ─────────────────────────────────────────────────────────────
function _parseServers(html) {
  const links = [], seen = new Set();
  const push  = (label, url, server) => {
    if (!url || !url.startsWith('http') || seen.has(url)) return;
    seen.add(url); links.push({ label, url, server });
  };

  let m;

  // R2 static href
  const r2Re = /href=["'](https:\/\/[a-z0-9-]+\.r2(?:\.dev|\.cloudflarestorage\.com)\/[^"']+)["']/gi;
  while ((m = r2Re.exec(html)) !== null) push('FSL Server', m[1], 'r2');

  // Minute-rotated data-minute-base-url
  const minBase = html.match(/data-minute-base-url=["'](https?:\/\/[^"']+)["']/i);
  if (minBase) {
    const fslUrl = minBase[1] + String(new Date().getUTCMinutes());
    push('FSL Server (timed)', fslUrl, 'r2-timed');
  }

  // PixelDrain JS var
  const pxlJs = html.match(/var\s+pxl\s*=\s*["'](https?:\/\/pixeldrain[^"']+)["']/i);
  if (pxlJs) push('PixelDrain Server', pxlJs[1], 'pixeldrain');

  // PixelDrain href
  const pxlRe = /href=["'](https?:\/\/pixeldrain[^"']+)["']/gi;
  while ((m = pxlRe.exec(html)) !== null) push('PixelDrain Server', m[1], 'pixeldrain');

  // Generic CDN fallback
  const cdnRe = /href=["'](https?:\/\/pub-[a-z0-9]+\.r2\.dev\/[^"']+)["']/gi;
  while ((m = cdnRe.exec(html)) !== null) push('CDN Server', m[1], 'cdn');

  return links;
}

module.exports = new MCloud();
