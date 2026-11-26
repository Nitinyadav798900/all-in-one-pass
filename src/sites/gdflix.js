'use strict';

const BaseSite = require('../site-base');
const { rawGet, rawPost, sleep, CookieJar } = require('../http');
const https = require('https');

class GDFlix extends BaseSite {
  constructor() {
    super();
    this.name    = 'GDFlix';
    this.id      = 'gdflix';
    this.version = '4.0.0';
    this.domains = [
      'gdflix.io',
      'new1.gdflix.io',  'new2.gdflix.io',  'new3.gdflix.io',
      'new4.gdflix.io',  'new5.gdflix.io',  'new6.gdflix.io',
      'new7.gdflix.io',  'new8.gdflix.io',  'new9.gdflix.io',
      'new10.gdflix.io', 'new11.gdflix.io', 'new12.gdflix.io',
      'new13.gdflix.io', 'new14.gdflix.io', 'new15.gdflix.io',
      'gdflix.lol', 'gdflix.mom', 'gdflix.dad', 'gdflix.sbs', 'gdflix.vip',
    ];
  }

  extract(url) {
    const u     = new URL(url);
    const match = u.pathname.match(/\/file\/([a-zA-Z0-9_-]+)/);
    if (!match) throw new Error(`GDFlix: URL se ID nahi mila — ${url}`);
    return { id: match[1], host: u.hostname };
  }

  async bypass(url) {
    const { id, host } = this.extract(url);
    const hostList = [host, ...this.domains.filter(d => d !== host)];

    for (const tryHost of hostList) {
      try {
        console.log(`[gdflix] trying host: ${tryHost}`);
        const result = await this._bypassHost(id, tryHost);
        if (result && result.servers.length > 0) return result;
      } catch (e) {
        console.warn(`[gdflix] host ${tryHost} failed: ${e.message}`);
      }
    }

    throw new Error('GDFlix: sab hosts fail ho gaye — CF protection active');
  }

  async _bypassHost(id, host) {
    const jar = new CookieJar();
    const UA  = _randomUA();

    // ── Step 1: Root warm-up ─────────────────────────────────────────
    try {
      await rawGet(`https://${host}/`, {
        jar,
        headers        : _headers(UA, null, 'none', 'navigate'),
        followRedirects: true,
        timeout        : 15000,
      });
      await sleep(800 + Math.random() * 600);
    } catch (e) {
      console.warn(`[gdflix] root warmup failed: ${e.message}`);
    }

    // ── Step 2: File page ────────────────────────────────────────────
    const fileUrl = `https://${host}/file/${id}`;
    const page    = await rawGet(fileUrl, {
      jar,
      headers        : _headers(UA, `https://${host}/`, 'same-origin', 'navigate'),
      followRedirects: true,
      timeout        : 25000,
    });

    if (page.status === 403) throw new Error(`GDFlix: 403 on ${host}`);
    if (page.status === 404) throw new Error(`GDFlix: 404 — file not found`);
    if (page.status >= 400)  throw new Error(`GDFlix: HTTP ${page.status}`);

    const html = _decodeHtml(page.body || '');
    if (html.length < 500) throw new Error(`GDFlix: page too short — ${html.length} bytes`);

    const meta = _parseMeta(html, id);

    // ── FIX 1: staticKey — multiple patterns se extract ──────────────
    const staticKey =
      html.match(/formData\.append\(["']key["'],\s*["']([a-f0-9]{40})["']\)/)?.[1]       ||
      html.match(/var\s+key\s*=\s*["']([a-f0-9]{40})["']/)?.[1]                           ||
      html.match(/name=["']key["']\s+value=["']([a-f0-9]{40})["']/)?.[1]                  ||
      html.match(/["']key["']\s*:\s*["']([a-f0-9]{40})["']/)?.[1]                         ||
      html.match(/data-key=["']([a-f0-9]{40})["']/)?.[1]                                   ||
      '0ae13449dc27736320b4b05d1d9adb1d8d8d3694';

    // ── FIX 2: action_token — page se nikalo ─────────────────────────
    const actionToken =
      html.match(/name=["']action_token["']\s+value=["']([^"']+)["']/)?.[1]              ||
      html.match(/["']action_token["']\s*:\s*["']([^"']{10,})["']/)?.[1]                  ||
      html.match(/action_token['"]\s*,\s*['"]([^'"]{10,})['"]/)?.[1]                      ||
      html.match(/var\s+action_token\s*=\s*["']([^"']+)["']/)?.[1]                        ||
      '';

    console.log(`[gdflix] host=${host} id=${id} key=${staticKey} action_token=${actionToken ? actionToken.slice(0,10)+'...' : 'EMPTY'}`);

    // ── Step 3: Visible links ────────────────────────────────────────
    const serverLinks = _extractAllLinks(html);
    console.log(`[gdflix] visible links: ${serverLinks.length}`);
    serverLinks.forEach(l => console.log(`  → [${l.type}] ${l.label} :: ${l.url.slice(0, 80)}`));

    const finalServers = [];

    // ── Step 4: POST — 3 variants try karo ───────────────────────────
    const postVariants = [
      { action: 'original',  key: staticKey, action_token: actionToken },
      { action: 'download',  key: staticKey, action_token: actionToken },
      { action: 'direct',    key: staticKey, action_token: actionToken },
    ];

    for (const variant of postVariants) {
      try {
        await sleep(300 + Math.random() * 400);
        const postResult = await _postBypass(id, host, jar, UA, variant);
        if (postResult.length > 0) {
          finalServers.push(...postResult);
          console.log(`[gdflix] POST [${variant.action}]: ${postResult.length} links`);
          // agar direct link mila toh baaki variants skip karo
          const hasReal = postResult.some(s => !['telegram','direct-fallback'].includes(s.server));
          if (hasReal) break;
        }
      } catch (e) {
        console.warn(`[gdflix] POST [${variant.action}] failed: ${e.message}`);
      }
    }

    // ── Step 5: Visible links chain ──────────────────────────────────
    for (const link of serverLinks) {
      // telegram already add ho gaya hai POST se — skip
      if (finalServers.some(s => s.url === link.url)) continue;
      try {
        const servers = await _processLink(link, jar, UA, host);
        finalServers.push(...servers);
      } catch (e) {
        console.warn(`[gdflix] chain failed [${link.type}]: ${e.message}`);
        finalServers.push({
          label : link.label,
          url   : link.url,
          server: link.type,
          via   : 'direct-fallback',
        });
      }
    }

    // ── FIX 3: Agar sirf telegram mila — page se JS URLs bhi nikalo ──
    const hasRealServer = finalServers.some(s =>
      !['telegram', 'direct-fallback', 'unknown'].includes(s.server)
    );

    if (!hasRealServer) {
      console.log('[gdflix] only telegram found — trying JS/inline URL extraction');
      const jsLinks = _extractJsLinks(html);
      console.log(`[gdflix] JS extraction: ${jsLinks.length} links`);
      for (const link of jsLinks) {
        if (finalServers.some(s => s.url === link.url)) continue;
        try {
          const servers = await _processLink(link, jar, UA, host);
          finalServers.push(...servers);
        } catch {
          finalServers.push({ label: link.label, url: link.url, server: link.type, via: 'js-fallback' });
        }
      }
    }

    if (finalServers.length === 0) throw new Error(`GDFlix: koi server nahi mila on ${host}`);

    // Deduplicate
    const seen   = new Set();
    const unique = finalServers.filter(s => {
      if (!s.url || seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });

    // Sort: real servers pehle, telegram last
    unique.sort((a, b) => {
      const priority = { r2: 0, busycdn: 1, instant: 1, mgt: 2, cloud: 3,
                         pixeldrain: 4, gofile: 5, hubcloud: 6, telegram: 99 };
      return (priority[a.server] ?? 50) - (priority[b.server] ?? 50);
    });

    console.log(`[gdflix] done — ${unique.length} unique servers`);
    return this._result(id, meta, unique);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  POST bypass — 3 variants support
// ─────────────────────────────────────────────────────────────────────────────

async function _postBypass(fileId, host, jar, UA, { action, key, action_token }) {
  const form = new URLSearchParams();
  form.append('action',       action);
  form.append('key',          key);
  form.append('action_token', action_token);

  const res = await rawPost(`https://${host}/file/${fileId}`, {
    jar,
    headers: {
      'User-Agent'         : UA,
      'Content-Type'       : 'application/x-www-form-urlencoded',
      'x-token'            : host,
      'Referer'            : `https://${host}/file/${fileId}`,
      'Origin'             : `https://${host}`,
      'Accept'             : 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language'    : 'en-US,en;q=0.9',
      'X-Requested-With'   : 'XMLHttpRequest',
      'Sec-Fetch-Dest'     : 'empty',
      'Sec-Fetch-Mode'     : 'cors',
      'Sec-Fetch-Site'     : 'same-origin',
      'sec-ch-ua'          : '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile'   : '?0',
      'sec-ch-ua-platform' : '"Windows"',
    },
    body   : form.toString(),
    timeout: 20000,
  });

  // ── FIX 4: response properly parse karo ──────────────────────────────
  let json = null;
  try {
    const bodyStr = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    // JSON ke alawa HTML bhi aa sakta hai — dono handle karo
    if (bodyStr.trim().startsWith('{') || bodyStr.trim().startsWith('[')) {
      json = JSON.parse(bodyStr);
    } else {
      // HTML response — links directly extract karo
      const html    = _decodeHtml(bodyStr);
      const links   = _extractAllLinks(html);
      const jsLinks = _extractJsLinks(html);
      return [...links, ...jsLinks].map(l => ({
        label : l.label,
        url   : l.url,
        server: l.type,
        via   : `post-html-${action}`,
      }));
    }
  } catch {
    return [];
  }

  if (!json) return [];

  const servers  = [];
  const urlsToProcess = [];

  // json.url, json.visit_url, json.download_url — sab check karo
  for (const field of ['url', 'visit_url', 'download_url', 'link', 'direct']) {
    if (json[field] && typeof json[field] === 'string' && json[field].startsWith('http')) {
      urlsToProcess.push(json[field]);
    }
  }

  // json.servers array bhi ho sakta hai
  if (Array.isArray(json.servers)) {
    for (const s of json.servers) {
      const u = s.url || s.link || s.href;
      if (u && u.startsWith('http')) urlsToProcess.push(u);
    }
  }

  for (const u of urlsToProcess) {
    const fakeLink = _classifyUrl(u);
    try {
      const chained = await _processLink(fakeLink, jar, UA, host);
      servers.push(...chained);
    } catch {
      servers.push({ label: fakeLink.label, url: u, server: fakeLink.type, via: `post-${action}` });
    }
  }

  return servers;
}

// ─────────────────────────────────────────────────────────────────────────────
//  FIX 5: JS inline links — window.location, fetch, ajax URLs
// ─────────────────────────────────────────────────────────────────────────────

function _extractJsLinks(html) {
  const links = [], seen = new Set();
  const push  = (type, url, label) => {
    if (!url || !url.startsWith('http') || seen.has(url)) return;
    seen.add(url);
    links.push({ type, url, label });
  };

  // window.open / window.location
  const winRe = /window\.(?:open|location(?:\.href)?)\s*[=(]\s*["'](https?:\/\/[^"']+)["']/g;
  let m;
  while ((m = winRe.exec(html)) !== null) {
    const classified = _classifyUrl(m[1]);
    push(classified.type, m[1], classified.label);
  }

  // fetch() / ajax url:
  const fetchRe = /(?:fetch|url)\s*[:(]\s*["'](https?:\/\/[^"']+)["']/g;
  while ((m = fetchRe.exec(html)) !== null) {
    const classified = _classifyUrl(m[1]);
    push(classified.type, m[1], classified.label);
  }

  // var/const/let links
  const varRe = /(?:var|const|let)\s+\w+\s*=\s*["'](https?:\/\/[^"']{20,})["']/g;
  while ((m = varRe.exec(html)) !== null) {
    const u = m[1];
    if (u.includes('cdn') || u.includes('r2') || u.includes('download') ||
        u.includes('busycdn') || u.includes('token') || u.includes('.mkv') ||
        u.includes('.mp4') || u.includes('pixeldrain') || u.includes('gofile')) {
      const classified = _classifyUrl(u);
      push(classified.type, u, classified.label);
    }
  }

  // data-url / data-href attributes
  const dataRe = /data-(?:url|href|link|src)=["'](https?:\/\/[^"']+)["']/g;
  while ((m = dataRe.exec(html)) !== null) {
    const classified = _classifyUrl(m[1]);
    push(classified.type, m[1], classified.label);
  }

  // action= form targets
  const actionRe = /action=["'](https?:\/\/[^"']+)["']/g;
  while ((m = actionRe.exec(html)) !== null) {
    const classified = _classifyUrl(m[1]);
    push(classified.type, m[1], classified.label);
  }

  return links;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Link dispatcher (unchanged from original)
// ─────────────────────────────────────────────────────────────────────────────

async function _processLink(link, jar, UA, gdflixHost) {
  switch (link.type) {
    case 'instant':     return _chainInstantDL(link.url, jar, UA, gdflixHost);
    case 'r2':          return [{ label: link.label, url: link.url, server: 'r2',          via: 'direct' }];
    case 'cloud':       return _chainCloud(link.url, jar, UA, gdflixHost);
    case 'mgt':         return _chainMGT(link.url, jar, UA, gdflixHost);
    case 'pixeldrain':  return _chainPixelDrain(link.url);
    case 'telegram':    return [{ label: link.label, url: link.url, server: 'telegram',    via: 'direct' }];
    case 'gofile':      return _chainGoFile(link.url);
    case 'hubcloud':    return _chainHubCloud(link.url, jar, UA);
    case 'gdrive':      return [{ label: link.label, url: link.url, server: 'gdrive',      via: 'direct' }];
    case 'mega':        return [{ label: link.label, url: link.url, server: 'mega',        via: 'direct' }];
    case 'mediafire':   return [{ label: link.label, url: link.url, server: 'mediafire',   via: 'direct' }];
    case 'buzzheavier': return [{ label: link.label, url: link.url, server: 'buzzheavier', via: 'direct' }];
    case 'fuckingfast': return [{ label: link.label, url: link.url, server: 'fuckingfast', via: 'direct' }];
    case 'terabox':     return [{ label: link.label, url: link.url, server: 'terabox',     via: 'direct' }];
    case 'onedrive':    return [{ label: link.label, url: link.url, server: 'onedrive',    via: 'direct' }];
    case '1fichier':    return [{ label: link.label, url: link.url, server: '1fichier',    via: 'direct' }];
    case 'dropbox':     return [{ label: link.label, url: link.url, server: 'dropbox',     via: 'direct' }];
    default:
      return [{ label: link.label, url: link.url, server: link.type, via: 'direct' }];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Chain handlers (all unchanged from original)
// ─────────────────────────────────────────────────────────────────────────────

async function _chainInstantDL(url, jar, UA, gdflixHost) {
  const res = await rawGet(url, {
    jar,
    headers        : _headers(UA, `https://${gdflixHost}/`),
    followRedirects: true,
    timeout        : 20000,
  });
  const finalUrl = res.finalUrl || url;
  if (finalUrl !== url && !finalUrl.includes('instadl') && !finalUrl.includes('busycdn')) {
    return [{ label: 'Instant DL [10GBPS]', url: finalUrl, server: 'busycdn', via: 'instadl-redirect' }];
  }
  const html  = _decodeHtml(res.body || '');
  const links = _extractAllLinks(html);
  if (links.length > 0) {
    return links.map(l => ({ label: l.label, url: l.url, server: l.type, via: 'instadl-page' }));
  }
  return [{ label: 'Instant DL [10GBPS]', url, server: 'busycdn', via: 'instadl-direct' }];
}

async function _chainCloud(url, jar, UA, gdflixHost) {
  const res = await rawGet(url, {
    jar,
    headers        : _headers(UA, `https://${gdflixHost}/`),
    followRedirects: true,
    timeout        : 20000,
  });
  const finalUrl = res.finalUrl || url;
  if (finalUrl !== url && !finalUrl.includes(gdflixHost)) {
    return [{ label: 'Fast Cloud / ZipDisk', url: finalUrl, server: 'cloud', via: 'cloud-redirect' }];
  }
  const html   = _decodeHtml(res.body || '');
  const dlLink = html.match(/href=["'](https?:\/\/[^"']*(?:\.r2\.dev|cdn|\.mkv|\.mp4|\.zip)[^"']*)["']/i)?.[1];
  if (dlLink) return [{ label: 'Fast Cloud / ZipDisk', url: dlLink, server: 'cloud', via: 'cloud-href' }];
  const iframe = html.match(/<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/i)?.[1];
  if (iframe)  return [{ label: 'Fast Cloud / ZipDisk', url: iframe, server: 'cloud', via: 'cloud-iframe' }];
  return [{ label: 'Fast Cloud / ZipDisk', url, server: 'cloud', via: 'cloud-direct' }];
}

async function _chainMGT(url, jar, UA, gdflixHost) {
  const res = await rawGet(url, {
    jar,
    headers        : _headers(UA, `https://${gdflixHost}/`),
    followRedirects: true,
    timeout        : 15000,
  });
  const finalUrl = res.finalUrl || url;
  if (finalUrl !== url) {
    return [{ label: 'Direct Server [MGT]', url: finalUrl, server: 'mgt', via: 'mgt-redirect' }];
  }
  const html   = _decodeHtml(res.body || '');
  const dlLink = html.match(/href=["'](https?:\/\/[^"']*(?:\.mkv|\.mp4|\.r2\.dev|download)[^"']*)["']/i)?.[1];
  if (dlLink) return [{ label: 'Direct Server [MGT]', url: dlLink, server: 'mgt', via: 'mgt-href' }];
  return [{ label: 'Direct Server [MGT]', url, server: 'mgt', via: 'mgt-direct' }];
}

async function _chainPixelDrain(url) {
  const id = url.match(/\/u\/([a-zA-Z0-9]+)/)?.[1];
  if (!id) return [{ label: 'PixelDrain', url, server: 'pixeldrain', via: 'direct' }];
  return [{ label: 'PixelDrain [Direct]', url: `https://pixeldrain.com/api/file/${id}?download`, server: 'pixeldrain', via: 'pixeldrain-api' }];
}

async function _chainGoFile(url) {
  let id = url.match(/\/d\/([a-zA-Z0-9]+)/)?.[1];
  if (!id) {
    try {
      const res = await rawGet(url, { followRedirects: true, timeout: 10000 });
      const html = res.body || '';
      id = html.match(/gofile\.io\/d\/([a-zA-Z0-9]+)/)?.[1]
        || (res.finalUrl || '').match(/\/d\/([a-zA-Z0-9]+)/)?.[1];
    } catch {}
  }
  if (!id) throw new Error(`GoFile: ID not found — ${url}`);

  const tokenRaw = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname      : 'api.gofile.io',
      path          : '/accounts',
      method        : 'POST',
      headers       : { 'Content-Type': 'application/json', 'Content-Length': '2',
                        'Origin': 'https://gofile.io', 'Referer': 'https://gofile.io/' },
      timeout: 12000,
    }, res => {
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
    if (dlUrl) servers.push({ label: `[GF] ${child.name || 'GoFile'}`, url: dlUrl, server: 'gofile', size: child.size ? _fmtSize(child.size) : undefined, via: 'gofile-api' });
  }
  if (servers.length === 0) throw new Error('GoFile: no files in content');
  return servers;
}

async function _chainHubCloud(url, jar, UA) {
  let id = null;
  for (const p of [/\/(?:drive|d)\/([a-zA-Z0-9_-]+)/, /\/file\/([a-zA-Z0-9_-]+)/]) {
    const m = url.match(p);
    if (m) { id = m[1]; break; }
  }
  if (!id) throw new Error('HubCloud: ID not found');

  const HOSTS = ['hubcloud.mov','hubcloud.cx','hubcloud.in','hubcloud.pw','hubcloud.fans'];
  let html1 = null, url1 = null;
  for (const h of HOSTS) {
    try {
      const r = await rawGet(`https://${h}/drive/${id}`, {
        headers: { 'User-Agent': UA, 'Referer': 'https://www.google.com/' },
        timeout: 12000,
      });
      if (r.status === 200 && r.body.length > 500) {
        html1 = _decodeHtml(r.body);
        url1  = r.finalUrl || `https://${h}/drive/${id}`;
        break;
      }
    } catch {}
  }
  if (!html1) throw new Error('HubCloud: page not reachable');

  const tokenUrl = html1.match(/href=["'](https:\/\/gamerxyt\.com[^"']+)["']/i)?.[1]
                || html1.match(/(https?:\/\/gamerxyt\.com\/[^\s"'<>]+)/i)?.[1];
  if (!tokenUrl) throw new Error('HubCloud: gamerxyt token URL not found');

  await sleep(2600);

  const r2      = await rawGet(tokenUrl, { headers: { 'User-Agent': UA, 'Referer': url1 }, timeout: 15000 });
  const servers = _parseHubCloudPage(_decodeHtml(r2.body));
  if (servers.length === 0) throw new Error('HubCloud: no links on final page');
  return servers.map(s => ({ ...s, label: `[HC] ${s.label}`, via: 'hubcloud' }));
}

function _parseHubCloudPage(html) {
  const links = [], seen = new Set();
  const push  = (label, url, server) => {
    if (!url || !url.startsWith('http') || seen.has(url)) return;
    seen.add(url);
    links.push({ label, url, server });
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

// ─────────────────────────────────────────────────────────────────────────────
//  _extractAllLinks (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

function _extractAllLinks(html) {
  const links = [], seen = new Set();
  const push  = (type, url, label) => {
    if (!url || !url.startsWith('http') || seen.has(url)) return;
    seen.add(url);
    links.push({ type, url, label });
  };
  let m;

  const patterns = [
    [/href=["'](https?:\/\/busycdn\.[^\s"'<>]+)["']/gi,                        'instant',     'Instant DL [10GBPS]'],
    [/href=["'](https?:\/\/[a-z0-9-]+\.instadl\.[^\s"'<>]+)["']/gi,            'instant',     'Instant DL [10GBPS]'],
    [/href=["'](https?:\/\/pub-[a-f0-9]+\.r2\.dev\/[^\s"'<>]+)["']/gi,         'r2',          'Cloud Download [R2]'],
    [/(https?:\/\/pub-[a-f0-9]+\.r2\.dev\/[a-f0-9]+\?token=[0-9]+)/g,          'r2',          'Cloud Download [R2]'],
    [/href=["'](https?:\/\/[^\s"'<>]+\/cloud\/[^\s"'<>]+)["']/gi,              'cloud',       'Fast Cloud / ZipDisk'],
    [/href=["'](https?:\/\/[^\s"'<>]+\/cflare\/[^\s"'<>]+)["']/gi,             'cloud',       'Fast Cloud / Cflare'],
    [/href=["'](https?:\/\/speed-dl\.[^\s"'<>]+)["']/gi,                        'mgt',         'Direct Server [MGT]'],
    [/href=["'](https?:\/\/[a-z0-9-]+\.mxgserver\.workers\.dev\/[^\s"'<>]+)["']/gi, 'mgt',    'Direct Server [MGT]'],
    [/href=["'](https?:\/\/pixeldrain(?:\.dev|\.com)\/u\/[a-zA-Z0-9]+)["']/gi, 'pixeldrain',  'PixelDrain DL'],
    [/href=["'](https?:\/\/filesgram\.xyz\/[^\s"'<>]+)["']/gi,                  'telegram',    'Telegram File'],
    [/href=["'](https?:\/\/gofile\.io\/d\/[a-zA-Z0-9]+)["']/gi,                'gofile',      'GoFile Server'],
    [/href=["'](https?:\/\/goflix\.sbs\/[^\s"'<>]+)["']/gi,                     'gofile',      'GoFile [Multiup]'],
    [/href=["'](https?:\/\/hubcloud\.[a-z]+\/(?:drive|d|file)\/[a-zA-Z0-9_-]+)["']/gi, 'hubcloud', 'HubCloud Server'],
    [/href=["'](https?:\/\/drive\.google\.com\/[^\s"'<>]+)["']/gi,              'gdrive',      'Google Drive'],
    [/href=["'](https?:\/\/mega\.nz\/[^\s"'<>]+)["']/gi,                        'mega',        'Mega.nz'],
    [/href=["'](https?:\/\/[^\s"'<>]*mediafire[^\s"'<>]+)["']/gi,               'mediafire',   'MediaFire'],
    [/href=["'](https?:\/\/[^\s"'<>]*buzzheavier[^\s"'<>]+)["']/gi,             'buzzheavier', 'BuzzHeavier'],
    [/href=["'](https?:\/\/fuckingfast\.net\/[^\s"'<>]+)["']/gi,                'fuckingfast', 'FuckingFast'],
    [/href=["'](https?:\/\/[^\s"'<>]*terabox[^\s"'<>]+)["']/gi,                 'terabox',     'TeraBox'],
    [/href=["'](https?:\/\/1fichier\.com\/[^\s"'<>]+)["']/gi,                   '1fichier',    '1Fichier'],
    [/href=["'](https?:\/\/1drv\.ms\/[^\s"'<>]+|https?:\/\/onedrive\.live[^\s"'<>]+)["']/gi, 'onedrive', 'OneDrive'],
    [/href=["'](https?:\/\/[^\s"'<>]*dropbox\.com[^\s"'<>]+)["']/gi,            'dropbox',     'Dropbox'],
  ];

  for (const [re, type, label] of patterns) {
    while ((m = re.exec(html)) !== null) push(type, m[1], label);
  }

  return links;
}

// ─────────────────────────────────────────────────────────────────────────────
//  _classifyUrl (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

function _classifyUrl(url) {
  if (!url) return { type: 'unknown', url, label: 'Unknown' };
  if (url.includes('busycdn') || url.includes('instadl'))       return { type: 'instant',     url, label: 'Instant DL [10GBPS]' };
  if (url.includes('r2.dev'))                                    return { type: 'r2',          url, label: 'Cloud Download [R2]' };
  if (url.includes('/cloud/') || url.includes('/cflare/'))       return { type: 'cloud',       url, label: 'Fast Cloud / ZipDisk' };
  if (url.includes('mxgserver') || url.includes('speed-dl'))     return { type: 'mgt',         url, label: 'Direct Server [MGT]' };
  if (url.includes('pixeldrain'))                                 return { type: 'pixeldrain',  url, label: 'PixelDrain' };
  if (url.includes('filesgram') || url.includes('t.me'))         return { type: 'telegram',    url, label: 'Telegram File' };
  if (url.includes('gofile.io') || url.includes('goflix.sbs'))   return { type: 'gofile',      url, label: 'GoFile' };
  if (url.includes('hubcloud'))                                   return { type: 'hubcloud',    url, label: 'HubCloud' };
  if (url.includes('drive.google.com'))                          return { type: 'gdrive',      url, label: 'Google Drive' };
  if (url.includes('mega.nz'))                                    return { type: 'mega',        url, label: 'Mega.nz' };
  if (url.includes('mediafire'))                                  return { type: 'mediafire',   url, label: 'MediaFire' };
  if (url.includes('buzzheavier'))                                return { type: 'buzzheavier', url, label: 'BuzzHeavier' };
  if (url.includes('fuckingfast'))                                return { type: 'fuckingfast', url, label: 'FuckingFast' };
  if (url.includes('terabox'))                                    return { type: 'terabox',     url, label: 'TeraBox' };
  if (url.includes('1fichier'))                                   return { type: '1fichier',    url, label: '1Fichier' };
  if (url.includes('1drv.ms') || url.includes('onedrive'))       return { type: 'onedrive',    url, label: 'OneDrive' };
  if (url.includes('dropbox'))                                    return { type: 'dropbox',     url, label: 'Dropbox' };
  return { type: 'direct', url, label: 'Direct Link' };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Misc helpers
// ─────────────────────────────────────────────────────────────────────────────

function _headers(UA, referer = null, fetchSite = 'none', fetchMode = 'navigate') {
  const h = {
    'User-Agent'                : UA,
    'Accept'                    : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language'           : 'en-US,en;q=0.9',
    'Accept-Encoding'           : 'gzip, deflate, br',
    'Connection'                : 'keep-alive',
    'Upgrade-Insecure-Requests' : '1',
    'Sec-Fetch-Dest'            : fetchMode === 'navigate' ? 'document' : 'empty',
    'Sec-Fetch-Mode'            : fetchMode,
    'Sec-Fetch-Site'            : fetchSite,
    'Sec-Fetch-User'            : fetchMode === 'navigate' ? '?1' : undefined,
    'sec-ch-ua'                 : '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile'          : '?0',
    'sec-ch-ua-platform'        : '"Windows"',
    'Cache-Control'             : 'max-age=0',
  };
  if (referer) h['Referer'] = referer;
  Object.keys(h).forEach(k => h[k] === undefined && delete h[k]);
  return h;
}

function _randomUA() {
  const UAs = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  ];
  return UAs[Math.floor(Math.random() * UAs.length)];
}

function _decodeHtml(html) {
  return html
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'");
}

function _parseMeta(html, fallbackId) {
  const meta      = {};
  const nameMatch = html.match(/Name\s*:\s*([^<]{5,300}?)(?:<\/li>|<\/td>|\n)/i);
  meta.filename   = nameMatch ? nameMatch[1].trim().replace(/\s+/g, ' ') : fallbackId;
  const szMatch   = html.match(/Size\s*:\s*(\d+(?:\.\d+)?\s*(?:GB|MB|KB|TB))/i);
  if (szMatch)  meta.size   = szMatch[1];
  const fmtMatch  = html.match(/Format\s*:\s*([a-z0-9]+)/i);
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

module.exports = new GDFlix();
