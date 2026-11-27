'use strict';

const BaseSite = require('../site-base');
const { rawGet, rawPost, sleep, CookieJar } = require('../http');
const https = require('https');

class MultiCloudLinks extends BaseSite {
  constructor() {
    super();
    this.name    = 'MultiCloudLinks';
    this.id      = 'multicloud';
    this.version = '4.1.0';
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
    // /view/bc89f5353a?c=4lizfd&exp=...&token=...
    // /view/4lizfd  (short form)
    const match = u.pathname.match(/\/(?:view|f|file|watch)\/([a-zA-Z0-9_-]+)/);
    if (!match) throw new Error('MultiCloudLinks: URL se ID nahi mila');
    return {
      id   : match[1],
      host : u.hostname,
      query: u.search,
      full : url,         // preserve signed params
    };
  }

  validate(html) {
    return { valid: html.length > 200 };
  }

  async bypass(url) {
    const { id, host, full } = this.extract(url);
    const jar = new CookieJar();

    // ── UA + base headers matching browser fingerprint ───────────────
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36 Edg/158.0.0.0';

    const BASE_HEADERS = {
      'User-Agent'               : UA,
      'Accept'                   : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language'          : 'en-US,en;q=0.9',
      'Accept-Encoding'          : 'gzip, deflate, br',
      'Cache-Control'            : 'max-age=0',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest'           : 'document',
      'Sec-Fetch-Mode'           : 'navigate',
      'Sec-Fetch-Site'           : 'none',
      'Sec-Fetch-User'           : '?1',
      'Sec-CH-UA'                : '"Chromium";v="158", "Not.A/Brand";v="24", "Microsoft Edge";v="158"',
      'Sec-CH-UA-Mobile'         : '?0',
      'Sec-CH-UA-Platform'       : '"Windows"',
      'Priority'                 : 'u=0, i',
    };

    // ── Stage 1: resolve signed URL ──────────────────────────────────
    // If URL has no signed params, hit base page first to get redirect
    // then follow to the signed /view/hash?c=id&exp=...&token=... form
    let signedUrl = full;

    const hasToken = full.includes('token=') && full.includes('exp=');

    if (!hasToken) {
      console.log(`[multicloud] no token in URL -- resolving signed URL for id: ${id}`);
      signedUrl = await _resolveSignedUrl(`https://${host}/view/${id}`, jar, BASE_HEADERS);
      console.log(`[multicloud] signed URL: ${signedUrl}`);
    }

    // ── Stage 2: load the signed page ───────────────────────────────
    const page = await rawGet(signedUrl, {
      jar,
      headers        : { ...BASE_HEADERS, 'Referer': `https://${host}/` },
      followRedirects: true,
      timeout        : 20000,
    });

    if (page.status >= 400) throw new Error(`MultiCloudLinks: HTTP ${page.status} on signed page`);

    const html = _decodeHtml(page.body || '');
    const meta = _parseMeta(html, id);

    console.log(`[multicloud] page loaded, length: ${html.length}`);

    // ── Stage 3: extract server links ────────────────────────────────
    const serverLinks = _extractAllLinks(html);
    console.log(`[multicloud] found ${serverLinks.length} server links`);
    serverLinks.forEach(l => console.log(`  → [${l.type}] ${l.url.slice(0, 80)}`));

    // ── Stage 4: if no links found, try JS-rendered token fetch ──────
    if (serverLinks.length === 0) {
      console.warn('[multicloud] no links in HTML, trying token-based API fetch');
      const apiLinks = await _tryApiEndpoint(host, id, jar, BASE_HEADERS);
      if (apiLinks.length > 0) {
        serverLinks.push(...apiLinks);
      } else {
        console.error('[multicloud] HTML snippet:', html.slice(0, 2000));
        throw new Error('MultiCloudLinks: koi link nahi mila page pe -- token expired ya invalid');
      }
    }

    // ── Stage 5: chain bypass ────────────────────────────────────────
    const finalServers = [];

    for (const link of serverLinks) {
      console.log(`[multicloud] processing [${link.type}]: ${link.url.slice(0, 60)}`);
      try {
        const servers = await _processLink(link, jar, UA, BASE_HEADERS);
        finalServers.push(...servers);
      } catch (e) {
        console.warn(`[multicloud] ${link.type} chain failed: ${e.message}`);
        finalServers.push({
          label : link.label,
          url   : link.url,
          server: link.type,
          via   : 'direct',
        });
      }
    }

    if (finalServers.length === 0) throw new Error('MultiCloudLinks: sab chains fail ho gayi');

    // Deduplicate
    const seen   = new Set();
    const unique = finalServers.filter(s => {
      if (!s.url || seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });

    return this._result(id, meta, unique);
  }
}

// ── Resolve signed URL from short /view/id ────────────────────────────────
// Site does a 302 to /view/hash?c=id&exp=X&token=Y
// We follow that redirect and capture the final signed URL
async function _resolveSignedUrl(baseUrl, jar, headers) {
  // try HEAD first to get redirect target without downloading body
  const res = await rawGet(baseUrl, {
    jar,
    headers        : { ...headers, 'Referer': new URL(baseUrl).origin + '/' },
    followRedirects: true,   // follow to get cookies set
    timeout        : 15000,
  });

  // finalUrl will be the signed URL after redirect chain
  const finalUrl = res.finalUrl || baseUrl;

  if (finalUrl.includes('token=') && finalUrl.includes('exp=')) {
    return finalUrl;
  }

  // If no redirect happened, try to extract signed link from the page body
  const html = _decodeHtml(res.body || '');

  // Some pages embed the real link in a meta refresh or JS window.location
  const metaRefresh = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["']\d+;\s*url=([^"']+)["']/i)?.[1];
  if (metaRefresh && metaRefresh.includes('token=')) return metaRefresh;

  const windowLoc = html.match(/window\.location(?:\.href)?\s*=\s*["'](https?:\/\/[^"']+token=[^"']+)["']/i)?.[1];
  if (windowLoc) return windowLoc;

  // fallback -- return as-is and let the page load handle it
  return finalUrl;
}

// ── API endpoint fallback (some versions use /api/links or /api/file) ─────
async function _tryApiEndpoint(host, id, jar, headers) {
  const endpoints = [
    `https://${host}/api/links/${id}`,
    `https://${host}/api/file/${id}`,
    `https://${host}/api/get/${id}`,
  ];

  for (const ep of endpoints) {
    try {
      const res = await rawGet(ep, {
        jar,
        headers: {
          ...headers,
          'Accept' : 'application/json, text/plain, */*',
          'Referer': `https://${host}/`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        timeout: 10000,
      });

      if (res.status !== 200) continue;

      const json = JSON.parse(res.body);
      const links = [];

      // common shapes: { links: [...] } or { data: { links: [...] } } or { servers: [...] }
      const arr = json.links || json.data?.links || json.servers || json.data || [];
      if (Array.isArray(arr)) {
        for (const item of arr) {
          const url = item.url || item.link || item.href;
          if (url && url.startsWith('http')) {
            links.push({
              type : _guessType(url),
              url,
              label: item.name || item.label || item.server || 'Server',
            });
          }
        }
      }

      if (links.length > 0) {
        console.log(`[multicloud] API endpoint ${ep} returned ${links.length} links`);
        return links;
      }
    } catch (e) {
      console.warn(`[multicloud] API endpoint ${ep} failed: ${e.message}`);
    }
  }

  return [];
}

function _guessType(url) {
  if (url.includes('hubcloud'))      return 'hubcloud';
  if (url.includes('hubdrive'))      return 'hubdrive';
  if (url.includes('gofile'))        return 'gofile';
  if (url.includes('multidownload')) return 'multidownload';
  if (url.includes('reqinstant'))    return 'reqinstant';
  if (url.includes('pixeldrain'))    return 'pixeldrain';
  if (url.includes('gdrive') || url.includes('drive.google')) return 'gdrive';
  if (url.includes('mega.nz'))       return 'mega';
  if (url.includes('mediafire'))     return 'mediafire';
  if (url.includes('gdbazar'))       return 'gdbazar';
  if (url.includes('fuckingfast') || url.includes('buzzheavier')) return 'buzz';
  return 'direct';
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

// ── Process each link type ────────────────────────────────────────────────
async function _processLink(link, jar, UA, BASE_HEADERS) {
  const h = BASE_HEADERS || {
    'User-Agent': UA,
    'Accept'    : 'text/html,*/*',
  };
  switch (link.type) {
    case 'hubcloud':      return _chainHubCloud(link.url, jar, UA);
    case 'hubdrive':      return _chainHubDrive(link.url, jar, UA, h);
    case 'gofile':        return _chainGoFile(link.url);
    case 'drivehub':      return _chainDriveHub(link.url, jar, UA, h);
    case 'multicloud':    return _chainMultiCloud(link.url, UA, h);
    case 'reqinstant':    return _chainReqInstant(link.url, jar, UA, h);
    case 'multidownload': return _chainMultiDownload(link.url, jar, UA, h);
    case 'gdbazar':       return _chainGdbazar(link.url, jar, UA, h);
    case 'viking':        return _chainViking(link.url, jar, UA, h);
    case 'pixeldrain_mc': return _chainPixeldrainMC(link.url, jar, UA, h);
    case 'filebee':       return _chainFilebee(link.url, jar, UA, h);
    case 'gdflix':        return _chainGdflix(link.url, jar, UA, h);
    default:
      return [{
        label : link.label,
        url   : link.url,
        server: link.type,
        via   : 'direct',
      }];
  }
}

// ── reqinstant chain ─────────────────────────────────────────────────────
async function _chainReqInstant(url, jar, UA, h) {
  const res = await rawGet(url, {
    jar,
    headers        : { ...h, 'Referer': 'https://multicloudlinks.com/' },
    followRedirects: true,
    timeout        : 15000,
  });

  const finalUrl = res.finalUrl || url;
  const html     = _decodeHtml(res.body || '');

  if (finalUrl !== url && (
    finalUrl.includes('.mp4') ||
    finalUrl.includes('download') ||
    !finalUrl.includes('reqinstant')
  )) {
    return [{ label: 'Instant Server', url: finalUrl, server: 'instant', via: 'reqinstant' }];
  }

  const links = _extractAllLinks(html);
  if (links.length > 0) {
    const servers = [];
    for (const l of links) {
      if (['reqinstant', 'multicloud'].includes(l.type)) continue;
      try {
        const s = await _processLink(l, jar, UA, h);
        servers.push(...s);
      } catch {
        servers.push({ label: l.label, url: l.url, server: l.type, via: 'reqinstant-direct' });
      }
    }
    if (servers.length > 0) return servers;
  }

  return [{ label: 'Instant Server', url, server: 'instant', via: 'reqinstant-fallback' }];
}

// ── multidownload.click chain ─────────────────────────────────────────────
async function _chainMultiDownload(url, jar, UA, h) {
  const res = await rawGet(url, {
    jar,
    headers        : { ...h, 'Referer': 'https://multicloudlinks.com/' },
    followRedirects: true,
    timeout        : 15000,
  });

  const finalUrl = res.finalUrl || url;

  if (finalUrl !== url && !finalUrl.includes('multidownload')) {
    return [{ label: 'Turbo Download (R2)', url: finalUrl, server: 'r2', via: 'multidownload' }];
  }

  const html  = _decodeHtml(res.body || '');
  const links = _extractAllLinks(html);

  if (links.length > 0) {
    return links.map(l => ({ label: l.label, url: l.url, server: l.type, via: 'multidownload-page' }));
  }

  return [{ label: 'Turbo Download (R2)', url, server: 'r2', via: 'multidownload-direct' }];
}

// ── gdbazar chain ─────────────────────────────────────────────────────────
async function _chainGdbazar(url, jar, UA, h) {
  const res   = await rawGet(url, {
    jar,
    headers        : { ...h, 'Referer': 'https://multicloudlinks.com/' },
    followRedirects: true,
    timeout        : 15000,
  });
  const html  = _decodeHtml(res.body || '');
  const links = _extractAllLinks(html);
  const direct = links.filter(l => ['r2','gdrive','pixeldrain','mega','mediafire','direct'].includes(l.type));
  if (direct.length > 0) return direct.map(l => ({ ...l, via: 'gdbazar' }));
  if (links.length > 0)  return links.map(l => ({ ...l, via: 'gdbazar' }));
  return [{ label: 'GDBazar', url, server: 'gdbazar', via: 'direct' }];
}

// ── viking chain ──────────────────────────────────────────────────────────
async function _chainViking(url, jar, UA, h) {
  const res      = await rawGet(url, {
    jar,
    headers        : { ...h, 'Referer': 'https://multicloudlinks.com/' },
    followRedirects: true,
    timeout        : 15000,
  });
  const finalUrl = res.finalUrl || url;
  if (finalUrl !== url && !finalUrl.includes('viking')) {
    return [{ label: 'Viking Server', url: finalUrl, server: 'cdn', via: 'viking' }];
  }
  const html  = _decodeHtml(res.body || '');
  const links = _extractAllLinks(html);
  if (links.length > 0) return links.map(l => ({ ...l, via: 'viking' }));
  return [{ label: 'Viking Server', url, server: 'viking', via: 'direct' }];
}

// ── pixeldra.multicloudlinks chain ───────────────────────────────────────
async function _chainPixeldrainMC(url, jar, UA, h) {
  const res      = await rawGet(url, {
    jar,
    headers        : { ...h, 'Referer': 'https://multicloudlinks.com/' },
    followRedirects: true,
    timeout        : 15000,
  });
  const finalUrl = res.finalUrl || url;
  if (finalUrl !== url) {
    return [{ label: 'PixelDrain', url: finalUrl, server: 'pixeldrain', via: 'pixeldrain-mc' }];
  }
  const html  = _decodeHtml(res.body || '');
  const links = _extractAllLinks(html);
  if (links.length > 0) return links.map(l => ({ ...l, via: 'pixeldrain-mc' }));
  return [{ label: 'PixelDrain', url, server: 'pixeldrain', via: 'direct' }];
}

// ── filebee chain ─────────────────────────────────────────────────────────
async function _chainFilebee(url, jar, UA, h) {
  const res      = await rawGet(url, {
    jar,
    headers        : { ...h, 'Referer': 'https://multicloudlinks.com/' },
    followRedirects: true,
    timeout        : 15000,
  });
  const finalUrl = res.finalUrl || url;
  if (finalUrl !== url && !finalUrl.includes('filebee')) {
    return [{ label: 'FileBee CDN', url: finalUrl, server: 'cdn', via: 'filebee' }];
  }
  const html   = _decodeHtml(res.body || '');
  const dlLink = html.match(/href=["'](https?:\/\/[^"']*(?:download|\.mp4|\.mkv|\.zip)[^"']*)["']/i)?.[1];
  if (dlLink) return [{ label: 'FileBee CDN', url: dlLink, server: 'cdn', via: 'filebee' }];
  return [{ label: 'FileBee', url, server: 'filebee', via: 'direct' }];
}

// ── gdflix chain ──────────────────────────────────────────────────────────
async function _chainGdflix(url, jar, UA, h) {
  const res      = await rawGet(url, {
    jar,
    headers        : { ...h, 'Referer': 'https://multicloudlinks.com/' },
    followRedirects: true,
    timeout        : 15000,
  });
  const finalUrl = res.finalUrl || url;
  if (finalUrl !== url && !finalUrl.includes('gdflix')) {
    return [{ label: 'GDFlix CDN', url: finalUrl, server: 'cdn', via: 'gdflix' }];
  }
  const html  = _decodeHtml(res.body || '');
  const links = _extractAllLinks(html);
  if (links.length > 0) return links.map(l => ({ ...l, via: 'gdflix' }));
  return [{ label: 'GDFlix', url, server: 'gdflix', via: 'direct' }];
}

// ── HubCloud chain ────────────────────────────────────────────────────────
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
        headers: { 'User-Agent': UA, 'Referer': 'https://www.google.com/' },
        timeout: 10000,
      });
      if (r.status === 200 && r.body.length > 500) { html1 = r.body; url1 = r.finalUrl; break; }
    } catch {}
  }
  if (!html1) throw new Error('HubCloud chain: page not reachable');

  const tokenUrl = html1.match(/href=["'](https:\/\/gamerxyt\.com[^"']+)["']/i)?.[1]
                || html1.match(/(https?:\/\/gamerxyt\.com\/[^\s"'<>]+)/i)?.[1];
  if (!tokenUrl) throw new Error('HubCloud chain: token not found');

  const { globalJar } = require('../http');
  globalJar.set('xla', 's4t');
  globalJar.set('xyt', '1');
  await sleep(2600);

  const r2      = await rawGet(tokenUrl, { headers: { 'User-Agent': UA, 'Referer': url1 } });
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

// ── HubDrive chain ────────────────────────────────────────────────────────
async function _chainHubDrive(url, jar, UA, h) {
  const page   = await rawGet(url, {
    headers        : { ...h, 'Referer': new URL(url).origin + '/' },
    jar,
    timeout        : 15000,
    followRedirects: true,
  });
  const html   = _decodeHtml(page.body || '');
  const links  = _extractAllLinks(html);
  const servers = [];
  for (const link of links) {
    try {
      const s = await _processLink(link, jar, UA, h);
      servers.push(...s.map(x => ({ ...x, via: `hubdrive→${link.type}` })));
    } catch {
      servers.push({ label: link.label, url: link.url, server: link.type, via: 'hubdrive-direct' });
    }
  }
  if (servers.length > 0) return servers;
  const direct = _parseDirectLinks(html);
  if (direct.length > 0) return direct.map(s => ({ ...s, via: 'hubdrive' }));
  throw new Error('HubDrive chain: no links found');
}

// ── GoFile chain ──────────────────────────────────────────────────────────
async function _chainGoFile(url) {
  const id = url.match(/\/d\/([a-zA-Z0-9]+)/)?.[1];
  if (!id) throw new Error('GoFile chain: ID not found');

  const tokenRaw = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.gofile.io', path: '/accounts', method: 'POST',
      headers : {
        'Content-Type'  : 'application/json',
        'Content-Length': '2',
        'Origin'        : 'https://gofile.io',
        'Referer'       : 'https://gofile.io/',
      },
      timeout: 12000,
    }, (res) => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve(raw)); });
    req.on('error', reject);
    req.write('{}'); req.end();
  });

  const tokenJson = JSON.parse(tokenRaw);
  if (tokenJson.status !== 'ok') throw new Error('GoFile chain: token failed');
  const token = tokenJson.data.token;

  const r    = await rawGet(
    `https://api.gofile.io/contents/${id}?wt=4fd6sg89d7s6&cache=true&token=${token}`,
    { headers: { 'Referer': 'https://gofile.io/', 'Accept': 'application/json' } }
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
async function _chainDriveHub(url, jar, UA, h) {
  const page   = await rawGet(url, {
    headers        : { ...h, 'Referer': new URL(url).origin + '/' },
    jar,
    timeout        : 15000,
    followRedirects: true,
  });
  const html   = _decodeHtml(page.body || '');
  const direct = _parseDirectLinks(html);
  if (direct.length > 0) return direct.map(s => ({ ...s, via: 'drivehub' }));
  throw new Error('DriveHub chain: no links found');
}

// ── Nested MultiCloud chain ───────────────────────────────────────────────
async function _chainMultiCloud(url, UA, h) {
  const jar  = new CookieJar();
  const page = await rawGet(url, {
    headers        : { ...h, 'Referer': url },
    jar,
    followRedirects: true,
    timeout        : 15000,
  });
  const html  = _decodeHtml(page.body || '');
  const links = _extractAllLinks(html);
  const servers = [];
  for (const link of links) {
    if (link.type === 'multicloud') continue;
    try {
      const s = await _processLink(link, jar, UA, h);
      servers.push(...s);
    } catch {
      servers.push({ label: link.label, url: link.url, server: link.type, via: 'multicloud-direct' });
    }
  }
  return servers;
}

// ── Extract ALL link types from HTML ─────────────────────────────────────
function _extractAllLinks(html) {
  const links = [], seen = new Set();
  const push  = (type, url, label) => {
    if (!url || !url.startsWith('http') || seen.has(url)) return;
    seen.add(url); links.push({ type, url, label });
  };
  let m;

  const mdRe  = /href=["'](https?:\/\/[a-z0-9]+\.multidownload\.click\/[^"']+)["']/gi;
  while ((m = mdRe.exec(html))  !== null) push('multidownload', m[1], 'Turbo Download (R2)');

  const riRe  = /href=["'](https?:\/\/reqinstant\.multicloudlinks\.com\/[^"']+)["']/gi;
  while ((m = riRe.exec(html))  !== null) push('reqinstant', m[1], 'Instant Server');

  const vkRe  = /href=["'](https?:\/\/viking\.multicloudlinks\.com\/[^"']+)["']/gi;
  while ((m = vkRe.exec(html))  !== null) push('viking', m[1], 'Viking Server');

  const pdmRe = /href=["'](https?:\/\/pixeldra\.multicloudlinks\.com\/[^"']+)["']/gi;
  while ((m = pdmRe.exec(html)) !== null) push('pixeldrain_mc', m[1], 'PixelDrain');

  const gdbRe = /href=["'](https?:\/\/gdbazar\.com\/[^"']+)["']/gi;
  while ((m = gdbRe.exec(html)) !== null) push('gdbazar', m[1], 'GDBazar');

  const fbRe  = /href=["'](https?:\/\/filebee\.live\/[^"']+)["']/gi;
  while ((m = fbRe.exec(html))  !== null) push('filebee', m[1], 'FileBee');

  const gfxRe = /href=["'](https?:\/\/gdflix\.[^"']+)["']/gi;
  while ((m = gfxRe.exec(html)) !== null) push('gdflix', m[1], 'GDFlix');

  const hcRe  = /href=["'](https?:\/\/hubcloud\.[a-z]+\/(?:drive|d|file)\/[a-zA-Z0-9_-]+)["']/gi;
  while ((m = hcRe.exec(html))  !== null) push('hubcloud', m[1], 'HubCloud Server');

  const hdRe  = /href=["'](https?:\/\/hubdrive\.[a-z]+\/file\/[a-zA-Z0-9_-]+)["']/gi;
  while ((m = hdRe.exec(html))  !== null) push('hubdrive', m[1], 'HubDrive Server');

  const gfRe  = /href=["'](https?:\/\/gofile\.io\/d\/[a-zA-Z0-9]+)["']/gi;
  while ((m = gfRe.exec(html))  !== null) push('gofile', m[1], 'GoFile Server');

  const dhRe  = /href=["'](https?:\/\/[^"']*drivehub\.[a-z]+\/file\/[a-zA-Z0-9_-]+)["']/gi;
  while ((m = dhRe.exec(html))  !== null) push('drivehub', m[1], 'DriveHub Server');

  const mcRe  = /href=["'](https?:\/\/[^"']*multicloudlinks[^"']+\/(?:view|f|file)\/[a-zA-Z0-9_-]+[^"']*)["']/gi;
  while ((m = mcRe.exec(html))  !== null) push('multicloud', m[1], 'MultiCloud Server');

  const gdRe  = /href=["'](https?:\/\/drive\.google\.com\/[^"']+)["']/gi;
  while ((m = gdRe.exec(html))  !== null) push('gdrive', m[1], 'Google Drive');

  const pxRe  = /href=["'](https?:\/\/pixeldrain[^"']+)["']/gi;
  while ((m = pxRe.exec(html))  !== null) push('pixeldrain', m[1], 'PixelDrain');

  const mgRe  = /href=["'](https?:\/\/mega\.nz\/[^"']+)["']/gi;
  while ((m = mgRe.exec(html))  !== null) push('mega', m[1], 'Mega');

  const mfRe  = /href=["'](https?:\/\/[^"']*mediafire[^"']+)["']/gi;
  while ((m = mfRe.exec(html))  !== null) push('mediafire', m[1], 'MediaFire');

  const r2Re  = /href=["'](https?:\/\/[^"']*\.r2\.cloudflarestorage[^"']+)["']/gi;
  while ((m = r2Re.exec(html))  !== null) push('r2', m[1], 'Direct Server');

  const ffRe  = /href=["'](https?:\/\/fuckingfast\.net\/[^"']+)["']/gi;
  while ((m = ffRe.exec(html))  !== null) push('buzz', m[1], 'Buzz Server');
  const bzRe  = /href=["'](https?:\/\/[^"']*buzzheavier[^"']+)["']/gi;
  while ((m = bzRe.exec(html))  !== null) push('buzzheavier', m[1], 'BuzzHeavier');

  const tbRe  = /href=["'](https?:\/\/[^"']*terabox[^"']+)["']/gi;
  while ((m = tbRe.exec(html))  !== null) push('terabox', m[1], 'TeraBox');

  const ofRe  = /href=["'](https?:\/\/1fichier\.com\/[^"']+)["']/gi;
  while ((m = ofRe.exec(html))  !== null) push('1fichier', m[1], '1Fichier');

  const odRe  = /href=["'](https?:\/\/1drv\.ms\/[^"']+|https?:\/\/onedrive\.live[^"']+)["']/gi;
  while ((m = odRe.exec(html))  !== null) push('onedrive', m[1], 'OneDrive');

  return links;
}

function _parseDirectLinks(html) {
  return _extractAllLinks(html)
    .filter(l => ['gdrive','pixeldrain','mega','mediafire','r2','buzz','terabox','1fichier','onedrive','buzzheavier'].includes(l.type))
    .map(l => ({ label: l.label, url: l.url, server: l.type, via: 'direct' }));
}

function _parseMeta(html, fallbackId) {
  const meta = {};
  const h    = html.match(/<(?:h[1-3]|title)[^>]*>([^<]{5,200}?)<\/(?:h[1-3]|title)>/i);
  meta.filename = h ? h[1].trim().replace(/\s+/g, ' ') : fallbackId;
  const sz      = html.match(/(\d+(?:\.\d+)?\s*(?:GB|MB|KB|TB))/i);
  if (sz) meta.size = sz[1];
  return meta;
}

function _fmtSize(bytes) {
  if (!bytes) return undefined;
  const units = ['B','KB','MB','GB','TB'];
  let i = 0;
  while (bytes >= 1024 && i < 4) { bytes /= 1024; i++; }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

module.exports = new MultiCloudLinks();
