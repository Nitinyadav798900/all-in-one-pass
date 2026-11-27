'use strict';

const BaseSite = require('../site-base');
const { rawGet, rawPost, sleep, CookieJar } = require('../http');
const https    = require('https');

/**
 * MultiCloudLinks — Full Chain Bypass
 *
 * Page pe jo bhi links hon:
 *   HubCloud  → chain bypass → final direct links
 *   HubDrive  → chain bypass → final direct links
 *   GoFile    → API bypass   → final direct links
 *   DriveHub  → chain bypass → final direct links
 *   GDrive    → direct
 *   PixelDrain→ direct
 *   Mega      → direct
 *   MediaFire → direct
 *   R2/S3     → direct
 *   TeraBox   → direct
 *   1Fichier  → direct
 */
class MultiCloudLinks extends BaseSite {
  constructor() {
    super();
    this.name    = 'MultiCloudLinks';
    this.id      = 'multicloud';
    this.version = '3.0.0';
    this.domains = [
      'multicloudlinks.com',
      'new1.multicloudlinks.com',
      'new2.multicloudlinks.com',
      'new3.multicloudlinks.com',
      'new4.multicloudlinks.com',
      'new5.multicloudlinks.com',
      'multicloudlinks.net',
      'multicloudlinks.org',
    ];
  }

  extract(url) {
    const u = new URL(url);
    // /view/ID or /f/ID or /file/ID
    const match = u.pathname.match(/\/(?:view|f|file)\/([a-zA-Z0-9_-]+)/);
    if (!match) throw new Error('MultiCloudLinks: URL se ID nahi mila');
    return {
      id   : match[1],
      host : u.hostname,
      query: u.search,
    };
  }

  validate(html) {
    return { valid: html.length > 200 };
  }

  async bypass(url) {
    const { id, host } = this.extract(url);
    const jar = new CookieJar();

    // ── Stage 1: Page load ───────────────────────────────────────────
    const page = await rawGet(url, {
      referer: `https://${host}/`,
      jar,
    });

    if (page.status >= 400) throw new Error(`MultiCloudLinks: HTTP ${page.status}`);

    const meta = _parseMeta(page.body, id);
    console.log(`[multicloud] page loaded, length: ${page.body.length}`);

    // ── Stage 2: Extract ALL server links from page ──────────────────
    const serverLinks = _extractAllLinks(page.body);
    console.log(`[multicloud] found ${serverLinks.length} server links`);
    serverLinks.forEach(l => console.log(`  → [${l.type}] ${l.url.slice(0, 80)}`));

    if (serverLinks.length === 0) {
      // Try POST endpoints
      const postServers = await _tryPostEndpoints(url, host, id, jar);
      if (postServers.length > 0) return this._result(id, meta, postServers);
      console.error('[multicloud] HTML snippet:', page.body.slice(0, 2000));
      throw new Error('MultiCloudLinks: koi link nahi mila page pe');
    }

    // ── Stage 3: Chain bypass — har link ko process karo ────────────
    const finalServers = [];

    for (const link of serverLinks) {
      console.log(`[multicloud] processing [${link.type}]: ${link.url.slice(0, 60)}`);
      try {
        const servers = await _processLink(link);
        finalServers.push(...servers);
      } catch (e) {
        console.warn(`[multicloud] ${link.type} chain failed: ${e.message}`);
        // Chain fail ho toh original link add karo fallback mein
        finalServers.push({
          label : `${link.label} (direct)`,
          url   : link.url,
          server: link.type,
          via   : 'direct-fallback',
        });
      }
    }

    if (finalServers.length === 0) throw new Error('MultiCloudLinks: sab chains fail ho gayi');

    // Deduplicate
    const seen    = new Set();
    const unique  = finalServers.filter(s => {
      if (seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });

    return this._result(id, meta, unique);
  }
}

// ── Process each link type ────────────────────────────────────────────────
async function _processLink(link) {
  switch (link.type) {
    case 'hubcloud':   return _chainHubCloud(link.url);
    case 'hubdrive':   return _chainHubDrive(link.url);
    case 'gofile':     return _chainGoFile(link.url);
    case 'drivehub':   return _chainDriveHub(link.url);
    case 'multicloud': return _chainMultiCloud(link.url); // nested multicloud
    default:
      // Direct links — no chain needed
      return [{
        label : link.label,
        url   : link.url,
        server: link.type,
        via   : 'direct',
      }];
  }
}

// ── HubCloud chain ────────────────────────────────────────────────────────
async function _chainHubCloud(url) {
  const { rawGet, sleep, globalJar } = require('../http');

  // Normalize — different hubcloud URL formats
  let id = null;
  const patterns = [
    /\/(?:drive|d)\/([a-zA-Z0-9_-]+)/,
    /\/file\/([a-zA-Z0-9_-]+)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) { id = m[1]; break; }
  }
  if (!id) throw new Error('HubCloud: ID not found in ' + url);

  const HOSTS = ['hubcloud.mov', 'hubcloud.cx', 'hubcloud.in', 'hubcloud.pw', 'hubcloud.fans'];
  let html1, url1;

  for (const h of HOSTS) {
    try {
      const r = await rawGet(`https://${h}/drive/${id}`, { referer: 'https://www.google.com/' });
      if (r.status === 200 && r.body.length > 500) {
        html1 = r.body; url1 = r.finalUrl;
        console.log(`[hubcloud-chain] got page from ${h}`);
        break;
      }
    } catch (_) {}
  }

  if (!html1) throw new Error('HubCloud chain: page not reachable');

  // Token extract
  const tokenPatterns = [
    /href=["'](https:\/\/gamerxyt\.com[^"']+)["']/i,
    /var\s+url\s*=\s*["'](https?:\/\/[^"']*gamerxyt[^"']+)["']/,
    /(https?:\/\/gamerxyt\.com\/[^\s"'<>]+)/i,
  ];
  let tokenUrl = null;
  for (const p of tokenPatterns) {
    const m = html1.match(p);
    if (m) { tokenUrl = m[1]; break; }
  }
  if (!tokenUrl) throw new Error('HubCloud chain: token not found');

  globalJar.set('xla', 's4t');
  globalJar.set('xyt', '1');
  await sleep(2600);

  const r2      = await rawGet(tokenUrl, { referer: url1 });
  const servers = _parseHubCloudFinalPage(r2.body);
  if (servers.length === 0) throw new Error('HubCloud chain: no links in final page');

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
  while ((m = r2Re.exec(html)) !== null) push('Direct Server', m[1], 'r2');
  const gpRe = /href=["'](https:\/\/gpdl\.hubcloud[^"']+)["']/gi;
  while ((m = gpRe.exec(html)) !== null) push('10Gbps Server', m[1], '10gbps');
  const pxJs = html.match(/var\s+pxl\s*=\s*["'](https?:\/\/pixeldrain[^"']+)["']/);
  if (pxJs) push('PixelDrain', pxJs[1], 'pixeldrain');
  const pxRe = /href=["'](https?:\/\/pixeldrain[^"']+)["']/gi;
  while ((m = pxRe.exec(html)) !== null) push('PixelDrain', m[1], 'pixeldrain');
  const ffRe = /href=["'](https:\/\/fuckingfast\.net\/[^"']+)["']/gi;
  while ((m = ffRe.exec(html)) !== null) push('Buzz Server', m[1], 'buzz');
  const tgRe = /href=["'](https:\/\/hubcloud\.[a-z]+\/tg\/go[^"']+)["']/gi;
  while ((m = tgRe.exec(html)) !== null) push('Telegram', m[1], 'telegram');
  return links;
}

// ── HubDrive chain ────────────────────────────────────────────────────────
async function _chainHubDrive(url) {
  const { rawGet, rawPost, sleep, CookieJar } = require('../http');
  const jar  = new CookieJar();
  const page = await rawGet(url, { referer: new URL(url).origin + '/', jar });
  if (page.status >= 400) throw new Error(`HubDrive chain: HTTP ${page.status}`);

  // Check for HubCloud links inside HubDrive page
  const innerLinks = _extractAllLinks(page.body);
  const servers    = [];

  for (const link of innerLinks) {
    try {
      const s = await _processLink(link);
      servers.push(...s.map(x => ({ ...x, label: `[HD→${link.type.toUpperCase()}] ${x.label}`, via: `hubdrive→${link.type}` })));
    } catch (e) {
      servers.push({ label: link.label, url: link.url, server: link.type, via: 'hubdrive-direct' });
    }
  }

  if (servers.length > 0) return servers;

  // Direct links se try karo
  const direct = _parseDirectLinks(page.body);
  if (direct.length > 0) return direct.map(s => ({ ...s, via: 'hubdrive' }));

  throw new Error('HubDrive chain: no links found');
}

// ── GoFile chain ──────────────────────────────────────────────────────────
async function _chainGoFile(url) {
  const id = url.match(/\/d\/([a-zA-Z0-9]+)/)?.[1];
  if (!id) throw new Error('GoFile chain: ID not found');

  // Guest token
  const tokenRaw = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.gofile.io', path: '/accounts', method: 'POST',
      headers: {
        'Content-Type'  : 'application/json',
        'Content-Length': '2',
        'Origin'        : 'https://gofile.io',
        'Referer'       : 'https://gofile.io/',
      },
      timeout: 12000,
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end',  () => resolve(raw));
    });
    req.on('error', reject);
    req.write('{}');
    req.end();
  });

  const tokenJson = JSON.parse(tokenRaw);
  if (tokenJson.status !== 'ok') throw new Error('GoFile chain: token failed');
  const token = tokenJson.data.token;

  // Content
  const { rawGet } = require('../http');
  const r    = await rawGet(
    `https://api.gofile.io/contents/${id}?wt=4fd6sg89d7s6&cache=true&token=${token}`,
    { referer: 'https://gofile.io/', headers: { Accept: 'application/json' } }
  );
  const json = JSON.parse(r.body);
  if (json.status !== 'ok') throw new Error(`GoFile chain: ${json.status}`);

  const servers  = [];
  const children = json.data?.children ? Object.values(json.data.children) : [json.data];
  for (const child of children) {
    if (child.type !== 'file') continue;
    const dlUrl = child.link || child.directLink;
    if (dlUrl) servers.push({
      label : `[GF] ${child.name || 'GoFile CDN'}`,
      url   : dlUrl,
      server: 'gofile',
      size  : child.size ? _fmtSize(child.size) : undefined,
      via   : 'gofile',
    });
  }
  if (servers.length === 0) throw new Error('GoFile chain: no files found');
  return servers;
}

// ── DriveHub chain ────────────────────────────────────────────────────────
async function _chainDriveHub(url) {
  const { rawGet, CookieJar } = require('../http');
  const jar  = new CookieJar();
  const page = await rawGet(url, { referer: new URL(url).origin + '/', jar });
  const direct = _parseDirectLinks(page.body);
  if (direct.length > 0) return direct.map(s => ({ ...s, via: 'drivehub' }));
  throw new Error('DriveHub chain: no links found');
}

// ── Nested MultiCloud chain ───────────────────────────────────────────────
async function _chainMultiCloud(url) {
  const { rawGet, CookieJar } = require('../http');
  const jar  = new CookieJar();
  const page = await rawGet(url, { referer: url });
  const links = _extractAllLinks(page.body);
  const servers = [];
  for (const link of links) {
    if (link.type === 'multicloud') continue; // prevent infinite loop
    try {
      const s = await _processLink(link);
      servers.push(...s);
    } catch (_) {
      servers.push({ label: link.label, url: link.url, server: link.type, via: 'multicloud-direct' });
    }
  }
  return servers;
}

// ── Extract ALL link types from any HTML ──────────────────────────────────
function _extractAllLinks(html) {
  const links = [];
  const seen  = new Set();

  const push = (type, url, label) => {
    if (!url || !url.startsWith('http') || seen.has(url)) return;
    seen.add(url);
    links.push({ type, url, label });
  };

  let m;

  // HubCloud
  const hcRe = /href=["'](https?:\/\/hubcloud\.[a-z]+\/(?:drive|d|file)\/[a-zA-Z0-9_-]+)["']/gi;
  while ((m = hcRe.exec(html)) !== null) push('hubcloud', m[1], 'HubCloud Server');

  // HubDrive
  const hdRe = /href=["'](https?:\/\/hubdrive\.[a-z]+\/file\/[a-zA-Z0-9_-]+)["']/gi;
  while ((m = hdRe.exec(html)) !== null) push('hubdrive', m[1], 'HubDrive Server');

  // GoFile
  const gfRe = /href=["'](https?:\/\/gofile\.io\/d\/[a-zA-Z0-9]+)["']/gi;
  while ((m = gfRe.exec(html)) !== null) push('gofile', m[1], 'GoFile Server');

  // DriveHub
  const dhRe = /href=["'](https?:\/\/[^"']*drivehub\.[a-z]+\/file\/[a-zA-Z0-9_-]+)["']/gi;
  while ((m = dhRe.exec(html)) !== null) push('drivehub', m[1], 'DriveHub Server');

  // Nested MultiCloud
  const mcRe = /href=["'](https?:\/\/[^"']*multicloudlinks[^"']+\/(?:view|f|file)\/[a-zA-Z0-9_-]+[^"']*)["']/gi;
  while ((m = mcRe.exec(html)) !== null) push('multicloud', m[1], 'MultiCloud Server');

  // Google Drive
  const gdRe = /href=["'](https?:\/\/drive\.google\.com\/[^"']+)["']/gi;
  while ((m = gdRe.exec(html)) !== null) push('gdrive', m[1], 'Google Drive');

  // PixelDrain
  const pxRe = /href=["'](https?:\/\/pixeldrain[^"']+)["']/gi;
  while ((m = pxRe.exec(html)) !== null) push('pixeldrain', m[1], 'PixelDrain');

  // Mega
  const mgRe = /href=["'](https?:\/\/mega\.nz\/[^"']+)["']/gi;
  while ((m = mgRe.exec(html)) !== null) push('mega', m[1], 'Mega');

  // MediaFire
  const mfRe = /href=["'](https?:\/\/[^"']*mediafire[^"']+)["']/gi;
  while ((m = mfRe.exec(html)) !== null) push('mediafire', m[1], 'MediaFire');

  // R2 / S3 direct
  const r2Re = /href=["'](https?:\/\/[^"']*\.r2\.cloudflarestorage[^"']+)["']/gi;
  while ((m = r2Re.exec(html)) !== null) push('r2', m[1], 'Direct Server');

  // FuckingFast
  const ffRe = /href=["'](https?:\/\/fuckingfast\.net\/[^"']+)["']/gi;
  while ((m = ffRe.exec(html)) !== null) push('buzz', m[1], 'Buzz Server');

  // TeraBox
  const tbRe = /href=["'](https?:\/\/[^"']*terabox[^"']+)["']/gi;
  while ((m = tbRe.exec(html)) !== null) push('terabox', m[1], 'TeraBox');

  // 1Fichier
  const ofRe = /href=["'](https?:\/\/1fichier\.com\/[^"']+)["']/gi;
  while ((m = ofRe.exec(html)) !== null) push('1fichier', m[1], '1Fichier');

  // OneDrive
  const odRe = /href=["'](https?:\/\/1drv\.ms\/[^"']+|https?:\/\/onedrive\.live[^"']+)["']/gi;
  while ((m = odRe.exec(html)) !== null) push('onedrive', m[1], 'OneDrive');

  // Buzzheavier / other direct CDN links
  const buzzRe = /href=["'](https?:\/\/[^"']*buzzheavier[^"']+)["']/gi;
  while ((m = buzzRe.exec(html)) !== null) push('buzzheavier', m[1], 'BuzzHeavier');

  return links;
}

function _parseDirectLinks(html) {
  return _extractAllLinks(html).filter(l =>
    ['gdrive','pixeldrain','mega','mediafire','r2','buzz','terabox','1fichier','onedrive','buzzheavier'].includes(l.type)
  ).map(l => ({ label: l.label, url: l.url, server: l.type, via: 'direct' }));
}

async function _tryPostEndpoints(url, host, id, jar) {
  const { rawGet, rawPost } = require('../http');
  const baseUrl = `https://${host}`;
  const endpoints = [
    `${baseUrl}/api/download`,
    `${baseUrl}/download`,
    `${baseUrl}/view/${id}/download`,
    `${baseUrl}/file/${id}`,
  ];
  for (const ep of endpoints) {
    try {
      const r = await rawPost(ep, { id, view_id: id }, { referer: url, jar, json: true });
      let json;
      try { json = JSON.parse(r.body); } catch (_) {}
      if (json?.links || json?.servers || json?.data || json?.url) {
        return _parseJsonLinks(json);
      }
      const links = _extractAllLinks(r.body);
      if (links.length > 0) return links.map(l => ({ label: l.label, url: l.url, server: l.type, via: 'post' }));
    } catch (_) {}
  }
  return [];
}

function _parseJsonLinks(json) {
  const links = [];
  const candidates = [json?.links, json?.servers, json?.data, json?.downloads, json?.urls];
  for (const list of candidates) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const url   = item?.url || item?.link || item?.href || item;
      const label = item?.name || item?.label || item?.server || 'Server';
      if (typeof url === 'string' && url.startsWith('http'))
        links.push({ label, url, server: _guessServer(url), via: 'api' });
    }
    if (links.length > 0) break;
  }
  if (links.length === 0 && json?.url)
    links.push({ label: 'Download Server', url: json.url, server: _guessServer(json.url), via: 'api' });
  return links;
}

function _parseMeta(html, fallbackId) {
  const meta = {};
  const h    = html.match(/<(?:h[1-3]|title)[^>]*>([^<]{5,200}?)<\/(?:h[1-3]|title)>/i);
  meta.filename = h ? h[1].trim().replace(/\s+/g,' ') : fallbackId;
  const sz = html.match(/(\d+(?:\.\d+)?\s*(?:GB|MB|KB|TB))/i);
  if (sz) meta.size = sz[1];
  return meta;
}

function _guessServer(url) {
  if (url.includes('drive.google'))  return 'gdrive';
  if (url.includes('pixeldrain'))    return 'pixeldrain';
  if (url.includes('mega.nz'))       return 'mega';
  if (url.includes('mediafire'))     return 'mediafire';
  if (url.includes('1drv'))          return 'onedrive';
  if (url.includes('r2.cloudflare')) return 'r2';
  if (url.includes('fuckingfast'))   return 'buzz';
  if (url.includes('gofile'))        return 'gofile';
  return 'other';
}

function _fmtSize(bytes) {
  if (!bytes) return undefined;
  const units = ['B','KB','MB','GB','TB'];
  let i = 0;
  while (bytes >= 1024 && i < 4) { bytes /= 1024; i++; }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

module.exports = new MultiCloudLinks();
