'use strict';

const BaseSite        = require('../site-base');
const { rawGet, CookieJar } = require('../http');

class Streamtape extends BaseSite {
  constructor() {
    super();
    this.name    = 'Streamtape';
    this.id      = 'streamtape';
    this.version = '2.0.0';
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
    return { valid: html.includes('streamtape') && html.length > 500 };
  }

  async bypass(url) {
    const { id, host } = this.extract(url);
    const jar = new CookieJar();

    const page = await rawGet(url, {
      referer: `https://${host}/`,
      jar,
    });

    if (page.status === 404) throw new Error(`Streamtape: video not found (${id})`);
    if (page.status >= 400) throw new Error(`Streamtape: HTTP ${page.status}`);

    const streamUrl = _extractStreamUrl(page.body, host);

    if (!streamUrl) {
      // Log snippet for debugging
      const snip = page.body.match(/ideoooolink|norobotlink|captchalink|get_video/gi);
      console.error('[streamtape] keywords found:', snip);
      console.error('[streamtape] snippet:', page.body.slice(0, 3000));
      throw new Error('Streamtape: stream URL not found — page layout may have changed');
    }

    const meta = _parseMeta(page.body, id);

    return this._result(id, meta, [{
      label : 'Streamtape Direct',
      url   : streamUrl,
      server: 'streamtape',
      via   : 'direct',
    }]);
  }
}

// ── Main extractor ────────────────────────────────────────────────────────
function _extractStreamUrl(html, host) {

  // ── Method 1: innerHTML assignment (primary — most common) ────────────
  // Looks like:
  //   document.getElementById('ideoooolink').innerHTML = ''
  //     + ('/get_video?id=ID&expires=EXP&ip=IP&token=PARTIAL_TOKEN')
  //     + ('DUMMY_PARTIAL_TOKEN'.substring(OFFSET))
  // OR:
  //   .innerHTML = '//streamtape.to/get_video?...&token=PARTIAL'
  //              + ('PARTIAL_EXTRA'.substring(N))

  const innerHtmlRe = /getElementById\(['"](norobotlink|captchalink|ideoooolink|robotlink|tapelinkx)['"]\)\s*\.innerHTML\s*=\s*([\s\S]+?);[\s\n]/i;
  const innerM      = html.match(innerHtmlRe);

  if (innerM) {
    const expr    = innerM[2];
    const result  = _evalConcatExpr(expr);
    if (result) return _buildFinalUrl(result, host);
  }

  // ── Method 2: var/let/const assignment ────────────────────────────────
  // var robotlink = '...' + ('...').substring(N)
  const varRe = /(?:var|let|const)\s+(?:robotlink|tapelinkx|videolink|streamlink)\s*=\s*([\s\S]+?);[\s\n]/i;
  const varM  = html.match(varRe);
  if (varM) {
    const result = _evalConcatExpr(varM[1]);
    if (result) return _buildFinalUrl(result, host);
  }

  // ── Method 3: direct get_video URL in page ────────────────────────────
  const directRe = /\/get_video\?id=[A-Za-z0-9_-]+&expires=\d+&ip=[^&"'\s]+&token=[A-Za-z0-9_-]+/;
  const directM  = html.match(directRe);
  if (directM) return _buildFinalUrl(directM[0], host);

  // ── Method 4: data-src or src with get_video ──────────────────────────
  const srcRe = /(?:data-src|src)=["']((?:https?:)?\/\/[^"']*get_video[^"']+)["']/i;
  const srcM  = html.match(srcRe);
  if (srcM) return _buildFinalUrl(srcM[1], host);

  return null;
}

// ── Evaluate a JS string concatenation expression ─────────────────────────
// Handles: '' + ('string1') + ('string2'.substring(N).substring(M))
function _evalConcatExpr(expr) {
  // Extract all string literals in order
  const stringRe = /['"`]([^'"`]*)['"`]/g;
  const strings  = [];
  let m;
  while ((m = stringRe.exec(expr)) !== null) {
    strings.push({ val: m[1], index: m.index });
  }

  if (strings.length === 0) return null;

  // Find substring calls that appear AFTER each string literal
  // .substring(N) right after a string's closing quote
  const subRe = /\.substring\(\s*(\d+)\s*\)/g;

  // Build result by processing each string + its following substrings
  let result = '';

  for (let i = 0; i < strings.length; i++) {
    let val     = strings[i].val;
    const start = strings[i].index + strings[i].val.length + 2; // after closing quote
    const end   = i + 1 < strings.length ? strings[i + 1].index : expr.length;
    const after = expr.slice(start, end);

    // Apply all .substring(N) calls that follow this string
    subRe.lastIndex = 0;
    let sm;
    while ((sm = subRe.exec(after)) !== null) {
      const n = parseInt(sm[1], 10);
      if (!isNaN(n)) val = val.substring(n);
    }

    result += val;
  }

  // Must contain get_video to be valid
  if (!result.includes('get_video')) return null;
  return result;
}

// ── Build final URL from extracted path ───────────────────────────────────
function _buildFinalUrl(raw, host) {
  let path = raw;

  // ── Step 1: Strip any corrupted/extra domain prefix ──────────────────
  // e.g. 'stredamtape.to/get_video?...'  or  'streamtape.to/get_video?...'
  // These appear when the JS concat picks up part of a domain string
  path = path.replace(/^[a-z0-9.-]+\.[a-z]{2,6}(\/get_video)/i, '$1');

  // ── Step 2: Normalize to absolute URL ────────────────────────────────
  let url;
  if (path.startsWith('https://') || path.startsWith('http://')) {
    url = path;
  } else if (path.startsWith('//')) {
    // Protocol-relative — use https
    url = 'https:' + path;
    // But ensure host is streamtape — not a corrupted subdomain
    try {
      const u = new URL(url);
      if (!u.hostname.includes('streamtape')) {
        // Host got corrupted — replace with correct host
        url = `https://${host}${u.pathname}${u.search}`;
      }
    } catch (_) {}
  } else if (path.startsWith('/')) {
    url = `https://${host}${path}`;
  } else {
    // Bare path like 'get_video?...' — prefix host
    url = `https://${host}/${path}`;
  }

  // ── Step 3: Ensure get_video is in path, not nested ──────────────────
  // Fix double-domain: https://streamtape.to/streamtape.to/get_video → fix
  url = url.replace(
    /(https:\/\/[^/]+)\/[a-z0-9.-]+\.[a-z]{2,6}(\/get_video)/i,
    '$1$2'
  );

  // ── Step 4: Clean dummy token suffixes ───────────────────────────────
  url = url
    .replace(/token=([A-Za-z0-9_-]*?)(defg|xcdd|xcd|abcd)([A-Za-z0-9_-]*)/i, 'token=$1$3')
    .replace(/&&[^&]+/g, '')
    .replace(/&{2,}/g, '&');

  // ── Step 5: Add stream=1 ─────────────────────────────────────────────
  if (!url.includes('stream=1')) {
    url += (url.includes('?') ? '&' : '?') + 'stream=1';
  }

  return url;
}

function _parseMeta(html, fallbackId) {
  const meta  = {};
  const title = html.match(/<title>([^<]+)<\/title>/i);
  if (title) {
    meta.filename = title[1]
      .replace(/\s*[-|]\s*streamtape.*/i, '')
      .replace(/\s*at\s+streamtape.*/i, '')
      .trim();
  } else {
    meta.filename = fallbackId;
  }
  return meta;
}

module.exports = new Streamtape();
