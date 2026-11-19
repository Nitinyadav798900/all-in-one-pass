'use strict';

const BaseSite = require('../site-base');
const { rawGet, rawPost, sleep, CookieJar } = require('../http');

/**
 * HubDrive bypass — with chain support
 * HubDrive page ke andar ye links ho sakte hain:
 *   - HubCloud links  → chain bypass
 *   - Direct R2/S3    → direct
 *   - Google Drive    → direct
 *   - PixelDrain      → direct
 *   - GoFile          → chain bypass
 *   - MediaFire       → direct
 */
class HubDrive extends BaseSite {
  constructor() {
    super();
    this.name    = 'HubDrive';
    this.id      = 'hubdrive';
    this.version = '2.0.0';
    this.domains = [
      'hubdrive.blog',
      'hubdrive.de',
      'hubdrive.mom',
      'hubdrive.pro',
    ];
  }

  extract(url) {
    const u     = new URL(url);
    const match = u.pathname.match(/\/file\/([a-zA-Z0-9_-]+)/);
    if (!match) throw new Error('HubDrive: file ID nahi mila');
    return { id: match[1], host: u.hostname };
  }

  validate(html) {
    return {
      valid : html.length > 300,
      reason: 'HubDrive: empty page',
    };
  }

  async bypass(url) {
    const { id, host } = this.extract(url);
    const jar = new CookieJar();

    // ── Stage 1: Page load ───────────────────────────────────────────
    const page = await rawGet(url, {
      referer: `https://${host}/`,
      jar,
    });

    if (page.status === 404) throw new Error(`HubDrive: file not found (${id})`);

    const meta = _parseMeta(page.body, id);

    // ── Stage 2: Sab intermediate links nikalo ───────────────────────
    // Ye links doosri sites ke hote hain — HubCloud, GoFile etc.
    const intermediateLinks = _extractIntermediateLinks(page.body, host);
    console.log(`[hubdrive] intermediate links found: ${intermediateLinks.length}`);
    intermediateLinks.forEach(l => console.log(`  → ${l.type}: ${l.url}`));

    // ── Stage 3: Chain bypass ────────────────────────────────────────
    // Agar intermediate links hain toh unhe bypass karo
    if (intermediateLinks.length > 0) {
      const allServers = [];

      for (const link of intermediateLinks) {
        try {
          if (link.type === 'hubcloud') {
            // HubCloud bypass chain
            const hubcloudResult = await _bypassHubCloud(link.url);
            if (hubcloudResult.length > 0) {
              allServers.push(...hubcloudResult.map(s => ({
                ...s,
                label: `[HubCloud] ${s.label}`,
                via  : 'hubcloud',
              })));
            }
          } else if (link.type === 'gofile') {
            // GoFile bypass chain
            const gofileResult = await _bypassGoFile(link.url);
            if (gofileResult.length > 0) {
              allServers.push(...gofileResult.map(s => ({
                ...s,
                label: `[GoFile] ${s.label}`,
                via  : 'gofile',
              })));
            }
          } else if (link.type === 'multicloud') {
            // MultiCloud page load karke links nikalo
            const mcResult = await _bypassMultiCloud(link.url, jar);
            if (mcResult.length > 0) {
              allServers.push(...mcResult.map(s => ({
                ...s,
                label: `[MultiCloud] ${s.label}`,
                via  : 'multicloud',
              })));
            }
          } else {
            // Direct link — seedha add karo
            allServers.push({
              label : link.label,
              url   : link.url,
              server: link.type,
              via   : 'direct',
            });
          }
        } catch (e) {
          console.warn(`[hubdrive] chain failed for ${link.type}: ${e.message}`);
          // Chain fail ho toh bhi original link add karo
          allServers.push({
            label : link.label,
            url   : link.url,
            server: link.type,
            via   : 'direct-fallback',
          });
        }
      }

      if (allServers.length > 0) {
        return this._result(id, meta, allServers);
      }
    }

    // ── Stage 4: Direct links page pe hi hain? ───────────────────────
    const directServers = _parseDirectLinks(page.body);
    if (directServers.length > 0) {
      return this._result(id, meta, directServers);
    }

    // ── Stage 5: POST endpoints try karo ─────────────────────────────
    await sleep(1500);
    const csrf    = _extractCsrf(page.body);
    const postBody = { _token: csrf || '', action: 'download', id };
    const baseUrl  = `https://${host}`;

    const endpoints = [
      `${baseUrl}/file/${id}/download`,
      `${baseUrl}/dl/${id}`,
      `${baseUrl}/download/${id}`,
    ];

    for (const ep of endpoints) {
      try {
        const r = await rawPost(ep, postBody, { referer: url, jar });
        const servers = _parseDirectLinks(r.body);
        if (servers.length > 0) return this._result(id, meta, servers);
      } catch (_) {}
    }

    throw new Error('HubDrive: koi bhi download link nahi mila');
  }
}

// ── HubCloud chain bypass ────────────────────────────────────────────────
async function _bypassHubCloud(url) {
  const { rawGet: get, sleep: wait, globalJar } = require('../http');

  // Normalize URL
  let driveUrl = url;
  if (!url.includes('/drive/') && !url.includes('/d/')) {
    // hubcloud.blog/file/ID format bhi hota hai kuch baar
    const match = url.match(/\/(?:file|drive|d)\/([a-zA-Z0-9_-]+)/);
    if (match) driveUrl = `https://hubcloud.mov/drive/${match[1]}`;
  }

  const DRIVE_HOSTS = ['hubcloud.mov', 'hubcloud.cx', 'hubcloud.in', 'hubcloud.pw'];
  let html1, url1;

  for (const host of DRIVE_HOSTS) {
    const id    = driveUrl.match(/\/(?:drive|d)\/([a-zA-Z0-9_-]+)/)?.[1];
    if (!id) continue;
    const tryUrl = `https://${host}/drive/${id}`;
    try {
      const r = await get(tryUrl, { referer: 'https://www.google.com/' });
      if (r.status === 200 && r.body.length > 500) {
        html1 = r.body; url1 = r.finalUrl; break;
      }
    } catch (_) {}
  }

  if (!html1) throw new Error('HubCloud chain: page not found');

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
  await wait(2600);

  const r2 = await get(tokenUrl, { referer: url1 });
  return _parseHubCloudServers(r2.body);
}

function _parseHubCloudServers(html) {
  const links = [], seen = new Set();
  const push  = (label, url, server) => {
    if (!url || !url.startsWith('http') || seen.has(url)) return;
    seen.add(url); links.push({ label, url, server });
  };
  let m;
  const r2Re = /href=["'](https:\/\/[a-z0-9]+\.r2\.cloudflarestorage\.com\/[^"']+)["']/gi;
  while ((m = r2Re.exec(html)) !== null) push('Direct Server', m[1], 'r2');
  const gpdlRe = /href=["'](https:\/\/gpdl\.hubcloud[^"']+)["']/gi;
  while ((m = gpdlRe.exec(html)) !== null) push('10Gbps Server', m[1], '10gbps');
  const pxlJs = html.match(/var\s+pxl\s*=\s*["'](https?:\/\/pixeldrain[^"']+)["']/);
  if (pxlJs) push('PixelDrain', pxlJs[1], 'pixeldrain');
  const pxlRe = /href=["'](https?:\/\/pixeldrain[^"']+)["']/gi;
  while ((m = pxlRe.exec(html)) !== null) push('PixelDrain', m[1], 'pixeldrain');
  const ffRe = /href=["'](https:\/\/fuckingfast\.net\/[^"']+)["']/gi;
  while ((m = ffRe.exec(html)) !== null) push('Buzz Server', m[1], 'buzz');
  return links;
}

// ── GoFile chain bypass ──────────────────────────────────────────────────
async function _bypassGoFile(url) {
  const https = require('https');
  const id    = url.match(/\/d\/([a-zA-Z0-9]+)/)?.[1];
  if (!id) throw new Error('GoFile chain: ID not found');

  // Get guest token
  const tokenRaw = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.gofile.io', path: '/accounts', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '2', 'Origin': 'https://gofile.io' },
      timeout: 10000,
    }, (res) => {
      let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve(raw));
    });
    req.on('error', reject); req.write('{}'); req.end();
  });

  const tokenJson = JSON.parse(tokenRaw);
  if (tokenJson.status !== 'ok') throw new Error('GoFile chain: token failed');
  const token = tokenJson.data.token;

  // Get content
  const { rawGet } = require('../http');
  const apiUrl = `https://api.gofile.io/contents/${id}?wt=4fd6sg89d7s6&cache=true&token=${token}`;
  const r      = await rawGet(apiUrl, { referer: 'https://gofile.io/', headers: { 'Accept': 'application/json' } });
  const json   = JSON.parse(r.body);

  if (json.status !== 'ok') throw new Error(`GoFile chain: ${json.status}`);

  const servers   = [];
  const children  = json.data?.children ? Object.values(json.data.children) : [json.data];
  for (const child of children) {
    if (child.type !== 'file') continue;
    const dlUrl = child.link || child.directLink;
    if (dlUrl) servers.push({ label: child.name || 'GoFile CDN', url: dlUrl, server: 'gofile' });
  }
  return servers;
}

// ── MultiCloud chain bypass ──────────────────────────────────────────────
async function _bypassMultiCloud(url, jar) {
  const { rawGet } = require('../http');
  const r = await rawGet(url, { referer: url, jar });
  return _parseDirectLinks(r.body);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function _extractIntermediateLinks(html, currentHost) {
  const links = [];
  const seen  = new Set();

  const push = (type, url, label) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    links.push({ type, url, label });
  };

  // HubCloud links
  const hcRe = /href=["'](https?:\/\/(?:hubcloud\.[a-z]+)\/(?:drive|d)\/[a-zA-Z0-9_-]+)["']/gi;
  let m;
  while ((m = hcRe.exec(html)) !== null) push('hubcloud', m[1], 'HubCloud Server');

  // hubcloud.blog ya similar domain with /file/
  const hcBlogRe = /href=["'](https?:\/\/hubcloud[^"'\/]*\/file\/[a-zA-Z0-9_-]+)["']/gi;
  while ((m = hcBlogRe.exec(html)) !== null) push('hubcloud', m[1], 'HubCloud Server');

  // GoFile links
  const gfRe = /href=["'](https?:\/\/gofile\.io\/d\/[a-zA-Z0-9]+)["']/gi;
  while ((m = gfRe.exec(html)) !== null) push('gofile', m[1], 'GoFile Server');

  // MultiCloudLinks
  const mcRe = /href=["'](https?:\/\/[^"']*multicloudlinks[^"']+)["']/gi;
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

  return links;
}

function _parseDirectLinks(html) {
  const links = [], seen = new Set();
  const push  = (label, url, server) => {
    if (!url || !url.startsWith('http') || seen.has(url) || url.length < 25) return;
    seen.add(url); links.push({ label, url, server });
  };
  let m;
  const r2Re = /href=["'](https?:\/\/[^"']*\.r2\.cloudflarestorage[^"']+)["']/gi;
  while ((m = r2Re.exec(html)) !== null) push('Direct Server', m[1], 'r2');
  const gdRe = /href=["'](https?:\/\/drive\.google\.com\/[^"']+)["']/gi;
  while ((m = gdRe.exec(html)) !== null) push('Google Drive', m[1], 'gdrive');
  const pxRe = /href=["'](https?:\/\/pixeldrain[^"']+)["']/gi;
  while ((m = pxRe.exec(html)) !== null) push('PixelDrain', m[1], 'pixeldrain');
  const mgRe = /href=["'](https?:\/\/mega\.nz\/[^"']+)["']/gi;
  while ((m = mgRe.exec(html)) !== null) push('Mega', m[1], 'mega');
  const ffRe = /href=["'](https?:\/\/fuckingfast\.net\/[^"']+)["']/gi;
  while ((m = ffRe.exec(html)) !== null) push('Buzz Server', m[1], 'buzz');
  return links;
}

function _parseMeta(html, fallbackId) {
  const meta = {};
  const h    = html.match(/<h[1-4][^>]*>([^<]{5,200}?)<\/h[1-4]>/i);
  if (h) meta.filename = h[1].trim();
  else   meta.filename = fallbackId;
  const sz = html.match(/(\d+(?:\.\d+)?\s*(?:GB|MB|KB))/i);
  if (sz) meta.size = sz[1];
  return meta;
}

function _extractCsrf(html) {
  const m = html.match(/<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i)
         || html.match(/name=["']_token["'][^>]*value=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

module.exports = new HubDrive();
