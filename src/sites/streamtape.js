'use strict';

const BaseSite        = require('../site-base');
const { rawGet, CookieJar } = require('../http');

/**
 * Streamtape bypass
 * URL: https://streamtape.to/v/zwJ0wBLy8AIYqpV
 *      https://streamtape.com/v/zwJ0wBLy8AIYqpV
 *      https://streamtape.to/e/zwJ0wBLy8AIYqpV  (embed)
 *
 * Flow:
 *   1. GET /v/{id} → page HTML
 *   2. Find getElementById('norobotlink').innerHTML assignment in JS
 *   3. Reconstruct get_video?... URL using substring logic
 *   4. Return direct stream URL
 */
class Streamtape extends BaseSite {
  constructor() {
    super();
    this.name    = 'Streamtape';
    this.id      = 'streamtape';
    this.version = '1.0.0';
    this.domains = [
      'streamtape.to',
      'streamtape.com',
      'streamtape.net',
      'streamtape.xyz',
      'streamtape.site',
      'streamtape.cc',
      'streamtape.ca',
      'streamtape.space',
    ];
  }

  extract(url) {
    const u     = new URL(url);
    const match = u.pathname.match(/\/(?:v|e)\/([A-Za-z0-9_-]+)/i);
    if (!match) throw new Error('Streamtape: invalid URL — expected /v/{id} or /e/{id}');
    return { id: match[1], host: u.hostname };
  }

  validate(html) {
    return {
      valid : html.includes('streamtape') && html.length > 500,
      reason: 'Streamtape: page structure not found',
    };
  }

  async bypass(url) {
    const { id, host } = this.extract(url);
    const jar = new CookieJar();

    // ── Stage 1: Fetch page ──────────────────────────────────────────
    const page = await rawGet(url, {
      referer: `https://${host}/`,
      jar,
      headers: { 'Accept': 'text/html,application/xhtml+xml,*/*' },
    });

    if (page.status === 404) throw new Error(`Streamtape: video not found (${id})`);
    if (page.status >= 400) throw new Error(`Streamtape: HTTP ${page.status}`);

    const html = page.body;

    // ── Stage 2: Extract direct stream URL ──────────────────────────
    const streamUrl = _extractStreamUrl(html, host);
    if (!streamUrl) {
      console.error('[streamtape] HTML snippet:', html.slice(0, 2000));
      throw new Error('Streamtape: stream URL not found — page layout may have changed');
    }

    // ── Stage 3: Extract metadata ────────────────────────────────────
    const meta = _parseMeta(html, id);

    return this._result(id, meta, [{
      label : 'Streamtape Direct',
      url   : streamUrl,
      server: 'streamtape',
      via   : 'direct',
    }]);
  }
}

// ── Core extraction logic ─────────────────────────────────────────────────
function _extractStreamUrl(html, host) {
  let path = null;

  // Pattern 1: innerHTML assignment with substring chain
  // getElementById('norobotlink').innerHTML = '//...' + ('xxxyyy').substring(A).substring(B)
  const assignRe = /getElementById\(['"](?:norobotlink|captchalink|ideoooolink|robotlink)['"]\)\.innerHTML\s*=\s*([\s\S]{0,300}?);/i;
  const assignM  = html.match(assignRe);

  if (assignM) {
    path = _parseInnerHtmlAssignment(assignM[1]);
  }

  // Pattern 2: newer format — variable assignment then append
  // var robotlink = '//...' + ...
  if (!path) {
    const varRe = /(?:var|let|const)\s+robotlink\s*=\s*([\s\S]{0,300}?);/i;
    const varM  = html.match(varRe);
    if (varM) path = _parseInnerHtmlAssignment(varM[1]);
  }

  // Pattern 3: direct get_video URL already in page (sometimes unobfuscated)
  if (!path) {
    const directRe = /\/get_video\?id=([A-Za-z0-9_-]+)&expires=(\d+)&ip=([^&"'\s]+)&token=([A-Za-z0-9_-]+)/;
    const directM  = html.match(directRe);
    if (directM) {
      path = `/get_video?id=${directM[1]}&expires=${directM[2]}&ip=${directM[3]}&token=${directM[4]}`;
    }
  }

  // Pattern 4: data-src or src with get_video
  if (!path) {
    const srcRe = /(?:data-src|src)=["']((?:https?:)?\/\/[^"']*get_video[^"']+)["']/i;
    const srcM  = html.match(srcRe);
    if (srcM) {
      const u = srcM[1].startsWith('//') ? 'https:' + srcM[1] : srcM[1];
      return _finalizeUrl(u);
    }
  }

  if (!path) return null;

  // Clean dummy token prefixes Streamtape sometimes injects
  path = path
    .replace(/token=[A-Za-z0-9_-]*?(defg|xcdd|xcd|abcd)/i, (m, g) => m.replace(g, ''))
    .replace(/&&[^&]+/g, '');

  if (!path.includes('stream=1')) path += '&stream=1';

  // Normalize host
  const base = `https://${host}`;
  if (path.startsWith('//')) return _finalizeUrl('https:' + path);
  if (path.startsWith('/'))  return _finalizeUrl(base + path);
  if (path.startsWith('http')) return _finalizeUrl(path);
  return _finalizeUrl(base + '/' + path);
}

function _parseInnerHtmlAssignment(expr) {
  // Collect all string parts concatenated with +
  // e.g. '//streamtape.to/get_video?id=abc' + ('tokenXXXYYY').substring(1).substring(2)
  const stringRe = /['"`]([^'"`]+)['"`]/g;
  const parts    = [];
  let m;

  // Find all string literals
  while ((m = stringRe.exec(expr)) !== null) parts.push(m[1]);

  if (parts.length === 0) return null;

  // Find substring calls: .substring(N)
  const subRe   = /\.substring\(\s*(\d+)\s*\)/g;
  const subs    = [];
  while ((m = subRe.exec(expr)) !== null) subs.push(parseInt(m[1], 10));

  // Last string literal is usually the token; apply substrings to it
  let base = parts[0];

  // If there's a second part (the token string), apply substrings
  if (parts.length > 1) {
    let token = parts[parts.length - 1];
    for (const n of subs) token = token.substring(n);
    base = base + token;
  } else if (subs.length > 0) {
    // Single string with substrings applied
    for (const n of subs) base = base.substring(n);
  }

  return base.startsWith('/') ? base : null;
}

function _finalizeUrl(url) {
  if (!url.includes('stream=1')) url += (url.includes('?') ? '&' : '?') + 'stream=1';
  return url;
}

function _parseMeta(html, fallbackId) {
  const meta = {};
  const title = html.match(/<title>([^<]+)<\/title>/i);
  if (title) meta.filename = title[1].replace(/\s*[-|]\s*streamtape.*/i, '').trim();
  else        meta.filename = fallbackId;
  return meta;
}

module.exports = new Streamtape();
