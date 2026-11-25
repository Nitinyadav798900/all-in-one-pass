'use strict';

const BaseSite = require('../site-base');  // <-- BaseSite extend karo
const { rawGet, rawPost, sleep, CookieJar } = require('../http');
const https = require('https');

class GDFlix extends BaseSite {  // <-- extend BaseSite, plain class nahi
  constructor() {
    super();
    this.name    = 'GDFlix';
    this.id      = 'gdflix';
    this.version = '2.0.0';
    this.domains = [
      // ── Active GDFlix instances (ye sab register honge) ──
      'gdflix.io',
      'new1.gdflix.io',
      'new2.gdflix.io',
      'new3.gdflix.io',
      'new4.gdflix.io',
      'new5.gdflix.io',
      'new6.gdflix.io',
      'new7.gdflix.io',
      'new8.gdflix.io',
      'new9.gdflix.io',
      'new10.gdflix.io',   // <-- ye wala missing tha
      'new11.gdflix.io',
      'new12.gdflix.io',
      'new13.gdflix.io',
      'new14.gdflix.io',
      'new15.gdflix.io',
      'gdflix.lol',
      'gdflix.mom',
      'gdflix.dad',
      'gdflix.sbs',
    ];
  }

  // ── BaseSite ko batao URL valid hai ya nahi ──────────────────────────
  extract(url) {
    const u     = new URL(url);
    const match = u.pathname.match(/\/file\/([a-zA-Z0-9_-]+)/);
    if (!match) throw new Error(`GDFlix: URL se ID nahi mila — ${url}`);
    return { id: match[1], host: u.hostname };
  }

  validate(html) {
    return { valid: html.includes('gdflix') || html.includes('GDFlix') || html.length > 500 };
  }

  // ── Main bypass ──────────────────────────────────────────────────────
  async bypass(url) {
    const { id, host } = this.extract(url);
    const jar = new CookieJar();
    const UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    // Stage 1: Page load
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

    // Stage 2: Static key page se extract karo (agar change ho)
    const staticKey = html.match(/formData\.append\(["']key["'],\s*["']([a-f0-9]{40})["']\)/)?.[1]
                   || '0ae13449dc27736320b4b05d1d9adb1d8d8d3694';

    console.log(`[gdflix] page loaded host=${host} id=${id} key=${staticKey}`);

    // Stage 3: Visible links extract karo (R2, cloud, mgt, pixeldrain, etc.)
    const serverLinks = _extractAllLinks(html, `https://${host}`);
    console.log(`[gdflix] visible links: ${serverLinks.length}`);
    serverLinks.forEach(l => console.log(`  → [${l.type}] ${l.label}`));

    // Stage 4: POST se hidden/login-wale links bhi nikalo
    let postServers = [];
    try {
      postServers = await _gdflixPostBypass(id, host, jar, UA, staticKey, 'original');
      console.log(`[gdflix] POST bypass returned ${postServers.length} links`);
    } catch (e) {
      console.warn(`[gdflix] POST bypass failed: ${e.message}`);
    }

    // Stage 5: Sab links chain se process karo
    const allLinks   = serverLinks;
    const finalServers = [...postServers];

    for (const link of allLinks) {
      try {
        const servers = await _processLink(link, jar, UA, host, staticKey);
        finalServers.push(...servers);
      } catch (e) {
        console.warn(`[gdflix] ${link.type} chain failed: ${e.message}`);
        finalServers.push({ label: link.label, url: link.url, server: link.type, via: 'direct-fallback' });
      }
    }

    if (finalServers.length === 0) throw new Error('GDFlix: sab chains fail — koi link nahi mila');

    // Deduplicate
    const seen   = new Set();
    const unique = finalServers.filter(s => {
      if (!s.url || seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });

    console.log(`[gdflix] final: ${unique.length} unique servers`);
    return this._result(id, meta, unique);
  }
}

// ── POST bypass: GDFlix ka AJAX endpoint ─────────────────────────────────
async function _gdflixPostBypass(fileId, host, jar, UA, key, action = 'original') {
  const form = new URLSearchParams();
  form.append('action',       action);
  form.append('key',          key);
  form.append('action_token', '');   // Turnstile — blank, server side mostly skip karta hai

  const res = await rawPost(`https://${host}/file/${fileId}`, {
    jar,
    headers: {
      'User-Agent'       : UA,
      'Content-Type'     : 'application/x-www-form-urlencoded',
      'x-token'          : host,
      'Referer'          : `https://${host}/file/${fileId}`,
      'Accept'           : 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With' : 'XMLHttpRequest',
    },
    body   : form.toString(),
    timeout: 15000,
  });

  let json;
  try { json = JSON.parse(res.body); } catch { return []; }

  const servers = [];

  if (json.url) {
    servers.push({ label: 'POST Direct URL', url: json.url, server: 'post-direct', via: 'gdflix-post' });
  }
  if (json.visit_url) {
    // visit_url ek aur redirect site ho sakta hai — usse bhi chain karo
    servers.push({ label: 'POST Visit URL', url: json.visit_url, server: 'post-visit', via: 'gdflix-post' });
  }

  return servers;
}

// ── Dispatch ──────────────────────────────────────────────────────────────
async function _processLink(link, jar, UA, gdflixHost, key) {
  switch (link.type) {
    case 'instant':        return _chainInstantDL(link.url, jar, UA, gdflixHost);
    case 'r2':             return [{ label: link.label, url: link.url, server: 'r2',         via: 'direct' }];
    case 'cloud':          return _chainCloud(link.url, jar, UA, gdflixHost);
    case 'mgt':            return _chainMGT(link.url, jar, UA, gdflixHost);
    case 'pixeldrain':     return _chainPixelDrain(link.url);
    case 'telegram':       return [{ label: link.label, url: link.url, server: 'telegram',   via: 'direct' }];
    case 'gofile':         return _chainGoFile(link.url);
    case 'hubcloud':       return _chainHubCloud(link.url, jar, UA);
    case 'gdrive':         return [{ label: link.label, url: link.url, server: 'gdrive',     via: 'direct' }];
    case 'mega':           return [{ label: link.label, url: link.url, server: 'mega',       via: 'direct' }];
    case 'mediafire':      return [{ label: link.label, url: link.url, server: 'mediafire',  via: 'direct' }];
    case 'buzzheavier':    return [{ label: link.label, url: link.url, server: 'buzzheavier',via: 'direct' }];
    case 'fuckingfast':    return [{ label: link.label, url: link.url, server: 'fuckingfast',via: 'direct' }];
    case 'terabox':        return [{ label: link.label, url: link.url, server: 'terabox',    via: 'direct' }];
    case 'onedrive':       return [{ label: link.label, url: link.url, server: 'onedrive',   via: 'direct' }];
    case '1fichier':       return [{ label: link.label, url: link.url, server: '1fichier',   via: 'direct' }];
    case 'dropbox':        return [{ label: link.label, url: link.url, server: 'dropbox',    via: 'direct' }];
    default:
      return [{ label: link.label, url: link.url, server: link.type, via: 'direct' }];
  }
}

// ── CHAIN: BusyCDN / Instant DL ──────────────────────────────────────────
async function _chainInstantDL(url, jar, UA, gdflixHost) {
  const res = await rawGet(url, {
    jar,
    headers: { 'User-Agent': UA, 'Referer': `https://${gdflixHost}/` },
    followRedirects: true,
    timeout        : 20000,
  });

  const finalUrl = res.finalUrl || url;
  if (finalUrl !== url && !finalUrl.includes('instadl')) {
    return [{ label: 'Instant DL [10GBPS]', url: finalUrl, server: 'busycdn', via: 'instadl-redirect' }];
  }

  const html  = _decodeHtml(res.body || '');
  const links = _extractAllLinks(html, `https://${gdflixHost}`);
  if (links.length > 0) return links.map(l => ({ label: l.label, url: l.url, server: l.type, via: 'instadl-page' }));

  return [{ label: 'Instant DL [10GBPS]', url, server: 'busycdn', via: 'instadl-direct' }];
}

// ── CHAIN: Cloud / ZipDisk ───────────────────────────────────────────────
async function _chainCloud(url, jar, UA, gdflixHost) {
  const res = await rawGet(url, {
    jar,
    headers: { 'User-Agent': UA, 'Referer': `https://${gdflixHost}/` },
    followRedirects: true,
    timeout        : 20000,
  });

  const finalUrl = res.finalUrl || url;
  if (finalUrl !== url && !finalUrl.includes(gdflixHost)) {
    return [{ label: 'Fast Cloud / ZipDisk', url: finalUrl, server: 'cloud', via: 'cloud-redirect' }];
  }

  const html    = _decodeHtml(res.body || '');
  const dlLink  = html.match(/href=["'](https?:\/\/[^"']*(?:\.r2\.dev|cdn|\.mkv|\.mp4|\.zip)[^"']*)["']/i)?.[1];
  if (dlLink) return [{ label: 'Fast Cloud / ZipDisk', url: dlLink, server: 'cloud', via: 'cloud-page' }];

  const iframe = html.match(/<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/i)?.[1];
  if (iframe) return [{ label: 'Fast Cloud / ZipDisk', url: iframe, server: 'cloud', via: 'cloud-iframe' }];

  return [{ label: 'Fast Cloud / ZipDisk', url, server: 'cloud', via: 'cloud-direct' }];
}

// ── CHAIN: MGT Workers ───────────────────────────────────────────────────
async function _chainMGT(url, jar, UA, gdflixHost) {
  const res = await rawGet(url, {
    jar,
    headers: { 'User-Agent': UA, 'Referer': `https://${gdflixHost}/` },
    followRedirects: true,
    timeout        : 15000,
  });

  const finalUrl = res.finalUrl || url;
  if (finalUrl !== url) return [{ label: 'Direct Server [MGT]', url: finalUrl, server: 'mgt', via: 'mgt-redirect' }];

  const html   = _decodeHtml(res.body || '');
  const dlLink = html.match(/href=["'](https?:\/\/[^"']*(?:\.mkv|\.mp4|\.r2\.dev|download)[^"']*)["']/i)?.[1];
  if (dlLink) return [{ label: 'Direct Server [MGT]', url: dlLink, server: 'mgt', via: 'mgt-page' }];

  return [{ label: 'Direct Server [MGT]', url, server: 'mgt', via: 'mgt-direct' }];
}

// ── CHAIN: PixelDrain ────────────────────────────────────────────────────
async function _chainPixelDrain(url) {
  const id = url.match(/\/u\/([a-zA-Z0-9]+)/)?.[1];
  if (!id) return [{ label: 'PixelDrain', url, server: 'pixeldrain', via: 'direct' }];
  return [{ label: 'PixelDrain [Direct]', url: `https://pixeldrain.com/api/file/${id}?download`, server: 'pixeldrain', via: 'pixeldrain-api' }];
}

// ── CHAIN: GoFile ────────────────────────────────────────────────────────
async function _chainGoFile(url) {
  // goflix.sbs -> actual gofile.io ID nikalo
  let id = url.match(/\/d\/([a-zA-Z0-9]+)/)?.[1];

  if (!id) {
    // goflix.sbs mirror pe fetch karo aur gofile ID dhundo
    try {
      const res  = await rawGet(url, { followRedirects: true, timeout: 10000 });
      const html = res.body || '';
      id = html.match(/gofile\.io\/d\/([a-zA-Z0-9]+)/)?.[1]
        || (res.finalUrl || '').match(/\/d\/([a-zA-Z0-9]+)/)?.[1];
    } catch {}
  }

  if (!id) throw new Error(`GoFile: ID not found in ${url}`);

  const tokenRaw = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname      : 'api.gofile.io',
      path          : '/accounts',
      method        : 'POST',
      headers       : { 'Content-Type': 'application/json', 'Content-Length': '2', 'Origin': 'https://gofile.io', 'Referer': 'https://gofile.io/' },
      timeout       : 12000,
    }, (res) => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve(raw)); });
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
  if (json.status !== 'ok') throw new Error(`GoFile: API ${json.status}`);

  const servers  = [];
  const children = json.data?.children ? Object.values(json.data.children) : [json.data];
  for (const child of children) {
    if (child.type !== 'file') continue;
    const dlUrl = child.link || child.directLink;
    if (dlUrl) servers.push({ label: `[GF] ${child.name || 'GoFile'}`, url: dlUrl, server: 'gofile', size: child.size ? _fmtSize(child.size) : undefined, via: 'gofile-api' });
  }
  if (servers.length === 0) throw new Error('GoFile: no files found');
  return servers;
}

// ── CHAIN: HubCloud ──────────────────────────────────────────────────────
async function _chainHubCloud(url, jar, UA) {
  let id = null;
  for (const p of [/\/(?:drive|d)\/([a-zA-Z0-9_-]+)/, /\/file\/([a-zA-Z0-9_-]+)/]) {
    const m = url.match(p);
    if (m) { id = m[1]; break; }
  }
  if (!id) throw new Error('HubCloud: ID not found');

  const HOSTS = ['hubcloud.mov','hubcloud.cx','hubcloud.in','hubcloud.pw','hubcloud.fans'];
  let html1, url1;
  for (const h of HOSTS) {
    try {
      const r = await rawGet(`https://${h}/drive/${id}`, {
        headers: { 'User-Agent': UA, 'Referer': 'https://www.google.com/' }, timeout: 12000,
      });
      if (r.status === 200 && r.body.length > 500) { html1 = _decodeHtml(r.body); url1 = r.finalUrl; break; }
    } catch {}
  }
  if (!html1) throw new Error('HubCloud: page not reachable');

  const tokenUrl = html1.match(/href=["'](https:\/\/gamerxyt\.com[^"']+)["']/i)?.[1]
                || html1.match(/(https?:\/\/gamerxyt\.com\/[^\s"'<>]+)/i)?.[1];
  if (!tokenUrl) throw new Error('HubCloud: token URL not found');

  await sleep(2600);

  const r2      = await rawGet(tokenUrl, { headers: { 'User-Agent': UA, 'Referer': url1 }, timeout: 15000 });
  const servers = _parseHubCloudFinalPage(_decodeHtml(r2.body));
  if (servers.length === 0) throw new Error('HubCloud: no links found');
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

// ── Extract all links from HTML ───────────────────────────────────────────
function _extractAllLinks(html, baseOrigin) {
  const links = [], seen = new Set();
  const push  = (type, url, label) => {
    if (!url || !url.startsWith('http') || seen.has(url)) return;
    seen.add(url); links.push({ type, url, label });
  };
  let m;

  const busyRe    = /href=["'](https?:\/\/busycdn\.[^\s"'<>]+)["']/gi;
  while ((m = busyRe.exec(html))    !== null) push('instant',    m[1], 'Instant DL [10GBPS]');

  const instadlRe = /href=["'](https?:\/\/[a-z0-9-]+\.instadl\.[^\s"'<>]+)["']/gi;
  while ((m = instadlRe.exec(html)) !== null) push('instant',    m[1], 'Instant DL [10GBPS]');

  const r2Re      = /href=["'](https?:\/\/pub-[a-f0-9]+\.r2\.dev\/[^\s"'<>]+)["']/gi;
  while ((m = r2Re.exec(html))      !== null) push('r2',         m[1], 'Cloud Download [R2]');

  const r2JsRe    = /(https?:\/\/pub-[a-f0-9]+\.r2\.dev\/[a-f0-9]+\?token=[0-9]+)/g;
  while ((m = r2JsRe.exec(html))    !== null) push('r2',         m[1], 'Cloud Download [R2]');

  const cloudRe   = /href=["'](https?:\/\/[^\s"'<>]+\/cloud\/[^\s"'<>]+)["']/gi;
  while ((m = cloudRe.exec(html))   !== null) push('cloud',      m[1], 'Fast Cloud / ZipDisk');

  const mgtRe     = /href=["'](https?:\/\/speed-dl\.[^\s"'<>]+)["']/gi;
  while ((m = mgtRe.exec(html))     !== null) push('mgt',        m[1], 'Direct Server [MGT]');

  const mxgRe     = /href=["'](https?:\/\/[a-z0-9-]+\.mxgserver\.workers\.dev\/[^\s"'<>]+)["']/gi;
  while ((m = mxgRe.exec(html))     !== null) push('mgt',        m[1], 'Direct Server [MGT]');

  const pdRe      = /href=["'](https?:\/\/pixeldrain(?:\.dev|\.com)\/u\/[a-zA-Z0-9]+)["']/gi;
  while ((m = pdRe.exec(html))      !== null) push('pixeldrain', m[1], 'PixelDrain DL');

  const tgRe      = /href=["'](https?:\/\/filesgram\.xyz\/[^\s"'<>]+)["']/gi;
  while ((m = tgRe.exec(html))      !== null) push('telegram',   m[1], 'Telegram File');

  const gfRe      = /href=["'](https?:\/\/gofile\.io\/d\/[a-zA-Z0-9]+)["']/gi;
  while ((m = gfRe.exec(html))      !== null) push('gofile',     m[1], 'GoFile Server');

  const gfxRe     = /href=["'](https?:\/\/goflix\.sbs\/[^\s"'<>]+)["']/gi;
  while ((m = gfxRe.exec(html))     !== null) push('gofile',     m[1], 'GoFile [Multiup]');

  const hcRe      = /href=["'](https?:\/\/hubcloud\.[a-z]+\/(?:drive|d|file)\/[a-zA-Z0-9_-]+)["']/gi;
  while ((m = hcRe.exec(html))      !== null) push('hubcloud',   m[1], 'HubCloud Server');

  const gdRe      = /href=["'](https?:\/\/drive\.google\.com\/[^\s"'<>]+)["']/gi;
  while ((m = gdRe.exec(html))      !== null) push('gdrive',     m[1], 'Google Drive');

  const mgRe      = /href=["'](https?:\/\/mega\.nz\/[^\s"'<>]+)["']/gi;
  while ((m = mgRe.exec(html))      !== null) push('mega',       m[1], 'Mega.nz');

  const mfRe      = /href=["'](https?:\/\/[^\s"'<>]*mediafire[^\s"'<>]+)["']/gi;
  while ((m = mfRe.exec(html))      !== null) push('mediafire',  m[1], 'MediaFire');

  const bzRe      = /href=["'](https?:\/\/[^\s"'<>]*buzzheavier[^\s"'<>]+)["']/gi;
  while ((m = bzRe.exec(html))      !== null) push('buzzheavier',m[1], 'BuzzHeavier');

  const ffRe      = /href=["'](https?:\/\/fuckingfast\.net\/[^\s"'<>]+)["']/gi;
  while ((m = ffRe.exec(html))      !== null) push('fuckingfast',m[1], 'FuckingFast');

  const tbRe      = /href=["'](https?:\/\/[^\s"'<>]*terabox[^\s"'<>]+)["']/gi;
  while ((m = tbRe.exec(html))      !== null) push('terabox',    m[1], 'TeraBox');

  const ofRe      = /href=["'](https?:\/\/1fichier\.com\/[^\s"'<>]+)["']/gi;
  while ((m = ofRe.exec(html))      !== null) push('1fichier',   m[1], '1Fichier');

  const odRe      = /href=["'](https?:\/\/1drv\.ms\/[^\s"'<>]+|https?:\/\/onedrive\.live[^\s"'<>]+)["']/gi;
  while ((m = odRe.exec(html))      !== null) push('onedrive',   m[1], 'OneDrive');

  const dboxRe    = /href=["'](https?:\/\/[^\s"'<>]*dropbox\.com[^\s"'<>]+)["']/gi;
  while ((m = dboxRe.exec(html))    !== null) push('dropbox',    m[1], 'Dropbox');

  return links;
}

function _parseMeta(html, fallbackId) {
  const meta     = {};
  const nameMatch = html.match(/Name\s*:\s*([^<]{5,300}?)(?:<\/li>|<\/td>)/i);
  meta.filename  = nameMatch ? nameMatch[1].trim().replace(/\s+/g, ' ') : fallbackId;
  const szMatch  = html.match(/Size\s*:\s*(\d+(?:\.\d+)?\s*(?:GB|MB|KB|TB))/i);
  if (szMatch) meta.size = szMatch[1];
  const fmtMatch = html.match(/Format\s*:\s*([a-z0-9]+)/i);
  if (fmtMatch) meta.format = fmtMatch[1];
  return meta;
}

function _fmtSize(bytes) {
  if (!bytes) return undefined;
  const units = ['B','KB','MB','GB','TB'];
  let i = 0;
  while (bytes >= 1024 && i < 4) { bytes /= 1024; i++; }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

function _decodeHtml(html) {
  return html
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'");
}

module.exports = new GDFlix();
