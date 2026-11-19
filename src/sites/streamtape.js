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

  async bypass(url, opts = {}) {
    const { id, host } = this.extract(url);
    const jar          = new CookieJar();
    const userIp       = opts.userIp || null;

    // Pass user's real IP so streamtape token binds to user's IP
    // Without this, CDN URL is locked to our server IP → 403 for user
    const extraHeaders = {};
    if (userIp) {
      extraHeaders['X-Forwarded-For'] = userIp;
      extraHeaders['X-Real-IP']       = userIp;
      console.log(`[streamtape] using user IP: ${userIp}`);
    }

    const page = await rawGet(url, {
      referer: `https://${host}/`,
      jar,
      headers: extraHeaders,
    });

    if (page.status === 404) throw new Error(`Streamtape: video not found (${id})`);
    if (page.status >= 400) throw new Error(`Streamtape: HTTP ${page.status}`);

    const streamUrl = _extractStreamUrl(page.body, host);

    if (!streamUrl) {
      const snip = page.body.match(/ideoooolink|norobotlink|captchalink|get_video/gi);
      console.error('[streamtape] keywords found:', snip);
      console.error('[streamtape] snippet:', page.body.slice(0, 3000));
      throw new Error('Streamtape: stream URL not found — page layout may have changed');
    }

    const meta    = _parseMeta(page.body, id);
    const servers = [];

    // ── Follow get_video → tapecontent.net CDN ──────────────────────────
    // CRITICAL: pass userIp so CDN URL binds to user's IP, not server's
    try {
      const cdnUrl = await _followToCdn(streamUrl, host, jar, userIp);
      if (cdnUrl && cdnUrl !== streamUrl) {
        // CDN link — playable by anyone, not IP-locked
        servers.push({
          label : 'Streamtape CDN Direct',
          url   : cdnUrl,
          server: 'streamtape-cdn',
          via   : 'cdn',
        });
        console.log('[streamtape] CDN link found:', cdnUrl.slice(0, 60) + '...');
      } else {
        // CDN redirect not found — fallback to stream URL
        servers.push({
          label : 'Streamtape Stream',
          url   : streamUrl,
          server: 'streamtape',
          via   : 'stream',
        });
      }
    } catch (e) {
      console.warn('[streamtape] CDN follow failed:', e.message);
      // Fallback — return get_video URL
      servers.push({
        label : 'Streamtape Stream',
        url   : streamUrl,
        server: 'streamtape',
        via   : 'stream',
      });
    }

    return this._result(id, meta, servers);
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

  // Trim any leading garbage chars before the first /
  // e.g. 'd/get_video' → '/get_video'
  const slashIdx = result.indexOf('/get_video');
  if (slashIdx > 0) result = result.slice(slashIdx);

  return result;
}

// ── Build final URL from extracted path ───────────────────────────────────
function _buildFinalUrl(raw, host) {
  let path = String(raw).trim();

  // ── Step 1: Extract only the get_video part ───────────────────────────
  // Whatever garbage is before /get_video — strip it all
  // Handles: 'streamtape.to/get_video', 'dget_video', 'stredamtape.to/dget_video'
  const getVideoMatch = path.match(/(\/get_video\?[^\s"'<>]+)/i);
  if (getVideoMatch) {
    path = getVideoMatch[1];
  } else {
    // Try to find get_video without leading slash
    const bare = path.match(/get_video\?[^\s"'<>]+/i);
    if (bare) path = '/' + bare[0];
  }

  // ── Step 2: Clean the path ────────────────────────────────────────────
  // Remove any extra chars before 'get_video' (like the 'd' from innerHTML)
  path = path.replace(/^\/+[^/]*?(get_video)/i, '/$1');

  // ── Step 3: Build absolute URL ───────────────────────────────────────
  let url;
  if (path.startsWith('http://') || path.startsWith('https://')) {
    url = path;
  } else if (path.startsWith('//')) {
    url = 'https:' + path;
    try {
      const u = new URL(url);
      if (!u.hostname.includes('streamtape')) {
        url = `https://${host}${u.pathname}${u.search}`;
      }
    } catch (_) {}
  } else {
    // /get_video?... — just prepend host
    url = `https://${host}${path.startsWith('/') ? path : '/' + path}`;
  }

  // ── Step 4: Final sanity — fix any remaining double domain ───────────
  // https://streamtape.to/streamtape.to/get_video → https://streamtape.to/get_video
  url = url.replace(
    /(https:\/\/[^/]+)\/.+?(\/get_video\?)/i,
    '$1$2'
  );

  // ── Step 5: Clean dummy token suffixes ───────────────────────────────
  url = url
    .replace(/token=([A-Za-z0-9_-]*?)(defg|xcdd|xcd|abcd)([A-Za-z0-9_-]*)/i, 'token=$1$3')
    .replace(/&&[^&]+/g, '')
    .replace(/&{2,}/g, '&')
    .replace(/\s/g, '');

  // ── Step 6: Add stream=1 ─────────────────────────────────────────────
  if (!url.includes('stream=1')) {
    url += (url.includes('?') ? '&' : '?') + 'stream=1';
  }

  console.log('[streamtape] built URL:', url);
  return url;
}

// ── Follow get_video → tapecontent.net CDN URL ───────────────────────────
// get_video redirects (302) to tapecontent.net — that URL is NOT IP-locked
// Max 5 hops to handle any intermediate redirects
async function _followToCdn(streamUrl, host, jar, userIp = null) {
  const https = require('https');
  const http  = require('http');

  function hop(url, hopsLeft) {
    return new Promise((resolve, reject) => {
      if (hopsLeft <= 0) return reject(new Error('Too many redirects'));

      let parsed;
      try { parsed = new URL(url); } catch (e) { return reject(e); }

      const isHttps = parsed.protocol === 'https:';
      const lib     = isHttps ? https : http;

      const headers = {
        'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Referer'         : `https://${host}/`,
        'Cookie'          : jar.header(),
        'Accept'          : '*/*',
        'Accept-Encoding' : 'identity',
      };

      // Pass user IP so CDN URL binds to user's IP
      if (userIp) {
        headers['X-Forwarded-For'] = userIp;
        headers['X-Real-IP']       = userIp;
      }

      const req = lib.request({
        hostname: parsed.hostname,
        port    : parsed.port || (isHttps ? 443 : 80),
        path    : parsed.pathname + parsed.search,
        method  : 'GET',
        timeout : 12000,
        headers,
      }, (res) => {
        const sc  = res.headers['set-cookie'];
        if (sc) jar.ingest(sc);

        const loc = res.headers['location'];
        res.destroy(); // only need headers

        if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc) {
          const next = loc.startsWith('http') ? loc : new URL(loc, url).href;
          console.log(`[streamtape] redirect ${res.statusCode} → ${next.slice(0, 70)}...`);

          // If we hit tapecontent.net — this is the CDN URL we want
          if (next.includes('tapecontent.net') || next.includes('.net/radosgw')) {
            return resolve(next);
          }

          // Keep following
          hop(next, hopsLeft - 1).then(resolve).catch(reject);
        } else if (res.statusCode === 200) {
          // No more redirects — if we're on tapecontent.net, great
          if (parsed.hostname.includes('tapecontent') || url.includes('tapecontent')) {
            resolve(url);
          } else {
            // 200 on streamtape itself — CDN not found
            reject(new Error('No CDN redirect found'));
          }
        } else {
          reject(new Error(`Unexpected status ${res.statusCode} from ${parsed.hostname}`));
        }
      });

      req.on('error',   reject);
      req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url.slice(0, 50)}`)); });
      req.end();
    });
  }

  return hop(streamUrl, 5);
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
