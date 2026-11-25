'use strict';

const { rawGet, rawPost, sleep, CookieJar } = require('../http');
const https = require('https');

class GDFlix {
  constructor() {
    this.name    = 'GDFlix';
    this.id      = 'gdflix';
    this.version = '2.0.0';
    this.domains = [
      'gdflix.io',
      'new10.gdflix.io',
      'new9.gdflix.io',
      'new8.gdflix.io',
      'new7.gdflix.io',
      'new6.gdflix.io',
      'gdflix.lol',
      'gdflix.mom',
    ];
  }

  // ── URL se file ID nikalo ────────────────────────────────────────────
  extract(url) {
    const u     = new URL(url);
    const match = u.pathname.match(/\/file\/([a-zA-Z0-9_-]+)/);
    if (!match) throw new Error('GDFlix: URL se ID nahi mila');
    return { id: match[1], host: u.hostname };
  }

  // ── Main bypass entry point ──────────────────────────────────────────
  async bypass(url) {
    const { id, host } = this.extract(url);
    const jar = new CookieJar();
    const UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    // ── Stage 1: Page load ───────────────────────────────────────────
    const page = await rawGet(url, {
      jar,
      headers: {
        'User-Agent': UA,
        'Accept'    : 'text/html,application/xhtml+xml,*/*;q=0.9',
        'Referer'   : `https://${host}/`,
      },
      followRedirects: true,
      timeout        : 20000,
    });

    if (page.status >= 400) throw new Error(`GDFlix: HTTP ${page.status}`);

    const html = _decodeHtml(page.body || '');
    const meta = _parseMeta(html, id);

    console.log(`[gdflix] page loaded, length: ${html.length}`);

    // ── Stage 2: Sab links ek page se nikalo ────────────────────────
    const serverLinks = _extractAllLinks(html, `https://${host}`);
    console.log(`[gdflix] found ${serverLinks.length} server links`);
    serverLinks.forEach(l => console.log(`  → [${l.type}] ${l.label} :: ${l.url.slice(0, 80)}`));

    if (serverLinks.length === 0) {
      console.error('[gdflix] HTML snippet:', html.slice(0, 3000));
      throw new Error('GDFlix: koi link nahi mila page pe');
    }

    // ── Stage 3: Har link ko chain se process karo ──────────────────
    const finalServers = [];

    for (const link of serverLinks) {
      console.log(`[gdflix] processing [${link.type}]: ${link.url.slice(0, 70)}`);
      try {
        const servers = await _processLink(link, jar, UA, host);
        finalServers.push(...servers);
      } catch (e) {
        console.warn(`[gdflix] ${link.type} chain failed: ${e.message}`);
        // fallback — original link as-is
        finalServers.push({
          label : link.label,
          url   : link.url,
          server: link.type,
          via   : 'direct-fallback',
        });
      }
    }

    if (finalServers.length === 0) throw new Error('GDFlix: sab chains fail ho gayi');

    // Deduplicate
    const seen   = new Set();
    const unique = finalServers.filter(s => {
      if (!s.url || seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });

    console.log(`[gdflix] final servers: ${unique.length}`);
    unique.forEach(s => console.log(`  ✓ [${s.server}] ${s.label} :: ${s.url.slice(0, 80)}`));

    return _buildResult(id, meta, unique);
  }
}

// ── HTML entity decode ────────────────────────────────────────────────────
function _decodeHtml(html) {
  return html
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'");
}

// ── Dispatch: link type ke hisaab se chain ────────────────────────────────
async function _processLink(link, jar, UA, gdflixHost) {
  switch (link.type) {

    // ── GDFlix ke apne internal servers ─────────────────────────────
    case 'instant':        return _chainInstantDL(link.url, jar, UA, gdflixHost);
    case 'r2':             return _chainR2(link.url, jar, UA, gdflixHost);
    case 'cloud':          return _chainCloud(link.url, jar, UA, gdflixHost);
    case 'pixeldrain':     return _chainPixelDrain(link.url);
    case 'telegram':       return [{ label: 'Telegram File', url: link.url, server: 'telegram', via: 'direct' }];

    // ── External chains ──────────────────────────────────────────────
    case 'hubcloud':       return _chainHubCloud(link.url, jar, UA);
    case 'gofile':         return _chainGoFile(link.url);
    case 'pixeldrain_ext': return _chainPixelDrain(link.url);
    case 'gdrive':         return [{ label: 'Google Drive', url: link.url, server: 'gdrive', via: 'direct' }];
    case 'mega':           return [{ label: 'Mega.nz',      url: link.url, server: 'mega',   via: 'direct' }];
    case 'mediafire':      return [{ label: 'MediaFire',    url: link.url, server: 'mediafire', via: 'direct' }];
    case 'buzzheavier':    return [{ label: 'BuzzHeavier',  url: link.url, server: 'buzzheavier', via: 'direct' }];
    case 'fuckingfast':    return [{ label: 'FuckingFast',  url: link.url, server: 'fuckingfast', via: 'direct' }];
    case 'terabox':        return [{ label: 'TeraBox',      url: link.url, server: 'terabox',  via: 'direct' }];
    case 'onedrive':       return [{ label: 'OneDrive',     url: link.url, server: 'onedrive', via: 'direct' }];
    case '1fichier':       return [{ label: '1Fichier',     url: link.url, server: '1fichier', via: 'direct' }];
    case 'dropbox':        return [{ label: 'Dropbox',      url: link.url, server: 'dropbox',  via: 'direct' }];
    case 'mgt':            return _chainMGT(link.url, jar, UA, gdflixHost);

    default:
      return [{
        label : link.label,
        url   : link.url,
        server: link.type,
        via   : 'direct',
      }];
  }
}

// ── CHAIN: BusyCDN / Instant DL [10GBPS] ─────────────────────────────────
// URL: https://busycdn.instadl.rest/...
async function _chainInstantDL(url, jar, UA, gdflixHost) {
  const res = await rawGet(url, {
    jar,
    headers: {
      'User-Agent': UA,
      'Referer'   : `https://${gdflixHost}/`,
    },
    followRedirects: true,
    timeout        : 20000,
  });

  const finalUrl = res.finalUrl || url;

  // Direct CDN redirect mila
  if (
    finalUrl !== url &&
    (finalUrl.includes('.r2.dev') || finalUrl.includes('cdn') ||
     finalUrl.includes('download') || finalUrl.includes('.mkv') || finalUrl.includes('.mp4'))
  ) {
    return [{ label: 'Instant DL [10GBPS]', url: finalUrl, server: 'busycdn', via: 'instadl-redirect' }];
  }

  // Page parse karo
  const html  = _decodeHtml(res.body || '');
  const links = _extractAllLinks(html, `https://${gdflixHost}`);
  if (links.length > 0) {
    return links.map(l => ({ label: l.label, url: l.url, server: l.type, via: 'instadl-page' }));
  }

  // Fallback: original URL de do, client redirect follow karega
  return [{ label: 'Instant DL [10GBPS]', url, server: 'busycdn', via: 'instadl-direct' }];
}

// ── CHAIN: Cloudflare R2 ──────────────────────────────────────────────────
// URL: https://pub-*.r2.dev/HASH?token=...
async function _chainR2(url, jar, UA, gdflixHost) {
  // R2 URLs direct download hain — sirf token validate karo
  const res = await rawGet(url, {
    jar,
    headers: {
      'User-Agent': UA,
      'Referer'   : `https://${gdflixHost}/`,
    },
    followRedirects: false,  // redirect nahi chahiye — URL hi final hai
    timeout        : 10000,
  });

  if (res.status === 200 || res.status === 206) {
    return [{ label: 'Cloud Download [R2]', url, server: 'r2', via: 'r2-direct' }];
  }

  // Token expire ho gaya — POST se naya token maango
  try {
    const freshUrl = await _refreshR2Token(url, gdflixHost, jar, UA);
    return [{ label: 'Cloud Download [R2]', url: freshUrl, server: 'r2', via: 'r2-refreshed' }];
  } catch (e) {
    console.warn('[gdflix/r2] token refresh failed:', e.message);
    return [{ label: 'Cloud Download [R2]', url, server: 'r2', via: 'r2-fallback' }];
  }
}

async function _refreshR2Token(originalUrl, gdflixHost, jar, UA) {
  // GDFlix file page se fresh POST action se naya URL nikalo
  const fileId = originalUrl.match(/\/([a-f0-9]{32})\?/)?.[1];
  if (!fileId) throw new Error('R2: file ID not parseable');

  const formData = new URLSearchParams();
  formData.append('action', 'original');
  formData.append('key', '0ae13449dc27736320b4b05d1d9adb1d8d8d3694');  // GDFlix static key

  // Yeh key page source mein hardcoded hai — sab GDFlix instances pe same hai
  // Agar change ho to page HTML se extract karo:
  //   html.match(/formData\.append\(["']key["'],\s*["']([a-f0-9]+)["']\)/)?.[1]

  const res  = await rawPost(`https://${gdflixHost}/file/FILEID`, {
    jar,
    headers: {
      'User-Agent'  : UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-token'     : gdflixHost,
      'Referer'     : `https://${gdflixHost}/`,
    },
    body   : formData.toString(),
    timeout: 10000,
  });

  const json = JSON.parse(res.body);
  if (json.url)       return json.url;
  if (json.visit_url) return json.visit_url;
  throw new Error('R2 refresh: no URL in response');
}

// ── CHAIN: GDFlix Cloud / ZipDisk ────────────────────────────────────────
// URL: https://new10.gdflix.io/cloud/TOKEN/FILEID
async function _chainCloud(url, jar, UA, gdflixHost) {
  const res = await rawGet(url, {
    jar,
    headers: {
      'User-Agent': UA,
      'Referer'   : `https://${gdflixHost}/`,
    },
    followRedirects: true,
    timeout        : 20000,
  });

  const finalUrl = res.finalUrl || url;
  const html     = _decodeHtml(res.body || '');

  // Redirect to CDN
  if (finalUrl !== url && !finalUrl.includes(gdflixHost)) {
    return [{ label: 'Fast Cloud / ZipDisk', url: finalUrl, server: 'cloud', via: 'cloud-redirect' }];
  }

  // Page mein links dhundo
  const dlLink = html.match(/href=["'](https?:\/\/[^"']*(?:\.r2\.dev|cdn|download|\.mkv|\.mp4|\.zip)[^"']*)["']/i)?.[1];
  if (dlLink) return [{ label: 'Fast Cloud / ZipDisk', url: dlLink, server: 'cloud', via: 'cloud-page' }];

  // iframe src dhundo (zipdisk style)
  const iframe = html.match(/<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/i)?.[1];
  if (iframe) return [{ label: 'Fast Cloud / ZipDisk', url: iframe, server: 'cloud', via: 'cloud-iframe' }];

  return [{ label: 'Fast Cloud / ZipDisk', url, server: 'cloud', via: 'cloud-direct' }];
}

// ── CHAIN: MGT Direct Server ──────────────────────────────────────────────
// URL: https://speed-dl.mxgserver.workers.dev/HASH::HASH/filename.mkv
async function _chainMGT(url, jar, UA, gdflixHost) {
  const res = await rawGet(url, {
    jar,
    headers: {
      'User-Agent': UA,
      'Referer'   : `https://${gdflixHost}/`,
    },
    followRedirects: true,
    timeout        : 15000,
  });

  const finalUrl = res.finalUrl || url;

  if (finalUrl !== url) {
    return [{ label: 'Direct Server [MGT]', url: finalUrl, server: 'mgt', via: 'mgt-redirect' }];
  }

  // Worker page se download link parse karo
  const html   = _decodeHtml(res.body || '');
  const dlLink = html.match(/href=["'](https?:\/\/[^"']*(?:download|\.mkv|\.mp4|\.r2)[^"']*)["']/i)?.[1];
  if (dlLink) return [{ label: 'Direct Server [MGT]', url: dlLink, server: 'mgt', via: 'mgt-page' }];

  return [{ label: 'Direct Server [MGT]', url, server: 'mgt', via: 'mgt-direct' }];
}

// ── CHAIN: PixelDrain ─────────────────────────────────────────────────────
async function _chainPixelDrain(url) {
  // pixeldrain.com/u/ID -> direct download: pixeldrain.com/api/file/ID
  const id = url.match(/\/u\/([a-zA-Z0-9]+)/)?.[1];
  if (!id) return [{ label: 'PixelDrain', url, server: 'pixeldrain', via: 'direct' }];

  const directUrl = `https://pixeldrain.com/api/file/${id}?download`;
  return [{ label: 'PixelDrain [Direct]', url: directUrl, server: 'pixeldrain', via: 'pixeldrain-api' }];
}

// ── CHAIN: HubCloud ───────────────────────────────────────────────────────
async function _chainHubCloud(url, jar, UA) {
  let id = null;
  for (const p of [/\/(?:drive|d)\/([a-zA-Z0-9_-]+)/, /\/file\/([a-zA-Z0-9_-]+)/]) {
    const m = url.match(p);
    if (m) { id = m[1]; break; }
  }
  if (!id) throw new Error('HubCloud: ID not found');

  const HOSTS = ['hubcloud.mov', 'hubcloud.cx', 'hubcloud.in', 'hubcloud.pw', 'hubcloud.fans'];
  let html1, url1;

  for (const h of HOSTS) {
    try {
      const r = await rawGet(`https://${h}/drive/${id}`, {
        headers: { 'User-Agent': UA, 'Referer': 'https://www.google.com/' },
        timeout: 12000,
      });
      if (r.status === 200 && r.body.length > 500) {
        html1 = _decodeHtml(r.body);
        url1  = r.finalUrl;
        break;
      }
    } catch {}
  }
  if (!html1) throw new Error('HubCloud: page not reachable');

  const tokenUrl = html1.match(/href=["'](https:\/\/gamerxyt\.com[^"']+)["']/i)?.[1]
                || html1.match(/(https?:\/\/gamerxyt\.com\/[^\s"'<>]+)/i)?.[1];
  if (!tokenUrl) throw new Error('HubCloud: token URL not found');

  await sleep(2600);

  const r2      = await rawGet(tokenUrl, {
    headers: { 'User-Agent': UA, 'Referer': url1 },
    timeout: 15000,
  });
  const servers = _parseHubCloudFinalPage(_decodeHtml(r2.body));
  if (servers.length === 0) throw new Error('HubCloud: no links in final page');
  return servers.map(s => ({ ...s, label: `[HC] ${s.label}`, via: 'hubcloud' }));
}

function _parseHubCloudFinalPage(html) {
  const links = [], seen = new Set();
  const push  = (label, url, server) => {
    if (!url || !url.startsWith('http') || seen.has(url)) return;
    seen.add(url); links.push({ label, url, server });
  };
  let m;

  const r2Re = /href=["'](https:\/\/[a-z0-9]+\.r2\.cloudflarestorage\.com\/[^"']+)["']/gi;
  while ((m = r2Re.exec(html))  !== null) push('Direct Server', m[1], 'r2');

  const gpRe = /href=["'](https:\/\/gpdl\.hubcloud[^"']+)["']/gi;
  while ((m = gpRe.exec(html))  !== null) push('10Gbps Server', m[1], '10gbps');

  const pxJs = html.match(/var\s+pxl\s*=\s*["'](https?:\/\/pixeldrain[^"']+)["']/);
  if (pxJs) push('PixelDrain', pxJs[1], 'pixeldrain');

  const pxRe = /href=["'](https?:\/\/pixeldrain[^"']+)["']/gi;
  while ((m = pxRe.exec(html))  !== null) push('PixelDrain', m[1], 'pixeldrain');

  const ffRe = /href=["'](https:\/\/fuckingfast\.net\/[^"']+)["']/gi;
  while ((m = ffRe.exec(html))  !== null) push('Buzz Server', m[1], 'buzz');

  return links;
}

// ── CHAIN: GoFile ─────────────────────────────────────────────────────────
async function _chainGoFile(url) {
  const id = url.match(/\/d\/([a-zA-Z0-9]+)/)?.[1];
  if (!id) throw new Error('GoFile: ID not found');

  const tokenRaw = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname      : 'api.gofile.io',
      path          : '/accounts',
      method        : 'POST',
      headers       : {
        'Content-Type'  : 'application/json',
        'Content-Length': '2',
        'Origin'        : 'https://gofile.io',
        'Referer'       : 'https://gofile.io/',
      },
      timeout: 12000,
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve(raw));
    });
    req.on('error', reject);
    req.write('{}');
    req.end();
  });

  const tokenJson = JSON.parse(tokenRaw);
  if (tokenJson.status !== 'ok') throw new Error('GoFile: token request failed');
  const token = tokenJson.data.token;

  const r    = await rawGet(
    `https://api.gofile.io/contents/${id}?wt=4fd6sg89d7s6&cache=true&token=${token}`,
    { headers: { 'Referer': 'https://gofile.io/', 'Accept': 'application/json' }, timeout: 12000 }
  );
  const json = JSON.parse(r.body);
  if (json.status !== 'ok') throw new Error(`GoFile: API returned ${json.status}`);

  const servers  = [];
  const children = json.data?.children ? Object.values(json.data.children) : [json.data];

  for (const child of children) {
    if (child.type !== 'file') continue;
    const dlUrl = child.link || child.directLink;
    if (dlUrl) {
      servers.push({
        label : `[GF] ${child.name || 'GoFile CDN'}`,
        url   : dlUrl,
        server: 'gofile',
        size  : child.size ? _fmtSize(child.size) : undefined,
        via   : 'gofile-api',
      });
    }
  }

  if (servers.length === 0) throw new Error('GoFile: no files in content');
  return servers;
}

// ── POST action bypass (Login-wala button ke liye) ────────────────────────
// GDFlix ka apna AJAX endpoint — "Login To DL" button actually POST karta hai
async function _gdflixPostBypass(fileId, gdflixHost, jar, UA, action = 'original') {
  const KEY = '0ae13449dc27736320b4b05d1d9adb1d8d8d3694';

  const form = new URLSearchParams();
  form.append('action',       action);
  form.append('key',          KEY);
  form.append('action_token', '');   // Turnstile token (blank works for some instances)

  const res  = await rawPost(`https://${gdflixHost}/file/${fileId}`, {
    jar,
    headers: {
      'User-Agent'  : UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-token'     : gdflixHost,
      'Referer'     : `https://${gdflixHost}/file/${fileId}`,
      'Accept'      : 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body   : form.toString(),
    timeout: 15000,
  });

  const json = JSON.parse(res.body);
  if (json.url)       return json.url;
  if (json.visit_url) return json.visit_url;
  throw new Error(`GDFlix POST: no URL — ${JSON.stringify(json)}`);
}

// ── Extract ALL link types from HTML ─────────────────────────────────────
function _extractAllLinks(html, baseOrigin = '') {
  const links = [], seen = new Set();
  const push  = (type, url, label) => {
    if (!url || !url.startsWith('http') || seen.has(url)) return;
    seen.add(url);
    links.push({ type, url, label });
  };
  let m;

  // ── GDFlix internal: BusyCDN Instant DL ─────────────────────────
  const busyRe = /href=["'](https?:\/\/busycdn\.[^\s"'<>]+)["']/gi;
  while ((m = busyRe.exec(html)) !== null) push('instant', m[1], 'Instant DL [10GBPS]');

  // Also in a href string directly
  const instadlRe = /href=["'](https?:\/\/[a-z0-9]+\.instadl\.[^\s"'<>]+)["']/gi;
  while ((m = instadlRe.exec(html)) !== null) push('instant', m[1], 'Instant DL [10GBPS]');

  // ── GDFlix internal: Cloudflare R2 ──────────────────────────────
  const r2PublicRe = /href=["'](https?:\/\/pub-[a-f0-9]+\.r2\.dev\/[^\s"'<>]+)["']/gi;
  while ((m = r2PublicRe.exec(html)) !== null) push('r2', m[1], 'Cloud Download [R2]');

  // R2 embedded in JS (not in href)
  const r2JsRe = /(https?:\/\/pub-[a-f0-9]+\.r2\.dev\/[a-f0-9]+\?token=[0-9]+)/g;
  while ((m = r2JsRe.exec(html)) !== null) push('r2', m[1], 'Cloud Download [R2]');

  // ── GDFlix internal: /cloud/ endpoint (ZipDisk) ──────────────────
  const cloudRe = /href=["'](https?:\/\/[^\s"'<>]+\/cloud\/[^\s"'<>]+)["']/gi;
  while ((m = cloudRe.exec(html)) !== null) push('cloud', m[1], 'Fast Cloud / ZipDisk');

  // ── GDFlix internal: /cflare/ endpoint ──────────────────────────
  const cflareRe = /href=["'](https?:\/\/[^\s"'<>]+\/cflare\/[^\s"'<>]+)["']/gi;
  while ((m = cflareRe.exec(html)) !== null) push('cloud', m[1], 'Fast Cloud / Cflare');

  // ── GDFlix internal: MGT direct server ──────────────────────────
  const mgtRe = /href=["'](https?:\/\/speed-dl\.[^\s"'<>]+)["']/gi;
  while ((m = mgtRe.exec(html)) !== null) push('mgt', m[1], 'Direct Server [MGT]');

  // Also mxgserver workers
  const mxgRe = /href=["'](https?:\/\/[a-z0-9-]+\.mxgserver\.workers\.dev\/[^\s"'<>]+)["']/gi;
  while ((m = mxgRe.exec(html)) !== null) push('mgt', m[1], 'Direct Server [MGT]');

  // ── GDFlix internal: PixelDrain (proxied via gdflix) ────────────
  const pdGdRe = /href=["'](https?:\/\/pixeldrain(?:\.dev|\.com)\/u\/[a-zA-Z0-9]+)["']/gi;
  while ((m = pdGdRe.exec(html)) !== null) push('pixeldrain', m[1], 'PixelDrain DL');

  // ── GDFlix internal: Telegram / FileGram ────────────────────────
  const tgRe = /href=["'](https?:\/\/filesgram\.xyz\/[^\s"'<>]+)["']/gi;
  while ((m = tgRe.exec(html)) !== null) push('telegram', m[1], 'Telegram File');

  // ── External: GoFile ─────────────────────────────────────────────
  const gfRe = /href=["'](https?:\/\/gofile\.io\/d\/[a-zA-Z0-9]+)["']/gi;
  while ((m = gfRe.exec(html)) !== null) push('gofile', m[1], 'GoFile Server');

  // Also goflix.sbs (multiup redirect to gofile)
  const gfxRe = /href=["'](https?:\/\/goflix\.sbs\/[^\s"'<>]+)["']/gi;
  while ((m = gfxRe.exec(html)) !== null) push('gofile', m[1], 'GoFile [Multiup]');

  // ── External: HubCloud ───────────────────────────────────────────
  const hcRe = /href=["'](https?:\/\/hubcloud\.[a-z]+\/(?:drive|d|file)\/[a-zA-Z0-9_-]+)["']/gi;
  while ((m = hcRe.exec(html)) !== null) push('hubcloud', m[1], 'HubCloud Server');

  // ── External: Google Drive ───────────────────────────────────────
  const gdRe = /href=["'](https?:\/\/drive\.google\.com\/[^\s"'<>]+)["']/gi;
  while ((m = gdRe.exec(html)) !== null) push('gdrive', m[1], 'Google Drive');

  // ── External: Mega ───────────────────────────────────────────────
  const mgRe = /href=["'](https?:\/\/mega\.nz\/[^\s"'<>]+)["']/gi;
  while ((m = mgRe.exec(html)) !== null) push('mega', m[1], 'Mega.nz');

  // ── External: MediaFire ──────────────────────────────────────────
  const mfRe = /href=["'](https?:\/\/[^\s"'<>]*mediafire[^\s"'<>]+)["']/gi;
  while ((m = mfRe.exec(html)) !== null) push('mediafire', m[1], 'MediaFire');

  // ── External: BuzzHeavier ────────────────────────────────────────
  const bzRe = /href=["'](https?:\/\/[^\s"'<>]*buzzheavier[^\s"'<>]+)["']/gi;
  while ((m = bzRe.exec(html)) !== null) push('buzzheavier', m[1], 'BuzzHeavier');

  // ── External: FuckingFast ────────────────────────────────────────
  const ffRe = /href=["'](https?:\/\/fuckingfast\.net\/[^\s"'<>]+)["']/gi;
  while ((m = ffRe.exec(html)) !== null) push('fuckingfast', m[1], 'FuckingFast');

  // ── External: TeraBox ────────────────────────────────────────────
  const tbRe = /href=["'](https?:\/\/[^\s"'<>]*terabox[^\s"'<>]+)["']/gi;
  while ((m = tbRe.exec(html)) !== null) push('terabox', m[1], 'TeraBox');

  // ── External: 1Fichier ───────────────────────────────────────────
  const ofRe = /href=["'](https?:\/\/1fichier\.com\/[^\s"'<>]+)["']/gi;
  while ((m = ofRe.exec(html)) !== null) push('1fichier', m[1], '1Fichier');

  // ── External: OneDrive ───────────────────────────────────────────
  const odRe = /href=["'](https?:\/\/1drv\.ms\/[^\s"'<>]+|https?:\/\/onedrive\.live[^\s"'<>]+)["']/gi;
  while ((m = odRe.exec(html)) !== null) push('onedrive', m[1], 'OneDrive');

  // ── External: Dropbox ────────────────────────────────────────────
  const dboxRe = /href=["'](https?:\/\/[^\s"'<>]*dropbox\.com[^\s"'<>]+)["']/gi;
  while ((m = dboxRe.exec(html)) !== null) push('dropbox', m[1], 'Dropbox');

  return links;
}

// ── Meta extract ──────────────────────────────────────────────────────────
function _parseMeta(html, fallbackId) {
  const meta = {};
  const h    = html.match(/<li[^>]*>Name\s*:\s*([^<]{5,300}?)<\/li>/i);
  meta.filename = h ? h[1].trim().replace(/\s+/g, ' ') : fallbackId;
  const sz      = html.match(/Size\s*:\s*(\d+(?:\.\d+)?\s*(?:GB|MB|KB|TB))/i);
  if (sz) meta.size = sz[1];
  const fmt     = html.match(/Format\s*:\s*([a-z0-9]+)/i);
  if (fmt) meta.format = fmt[1];
  return meta;
}

function _fmtSize(bytes) {
  if (!bytes) return undefined;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < 4) { bytes /= 1024; i++; }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

function _buildResult(id, meta, servers) {
  return {
    id,
    filename: meta.filename || id,
    size    : meta.size,
    format  : meta.format,
    servers,
  };
}

module.exports = new GDFlix();
