/**
 * Streamtape Bypass
 * Turns https://streamtape.to/v/ID  →  direct get_video?...&stream=1
 *
 * Usage (browser / node):
 *   const link = await streamtapeBypass('https://streamtape.to/v/zwJ0wBLy8AIYqpV');
 *   console.log(link);
 */

export async function streamtapeBypass(pageUrl, options = {}) {
  const idMatch = String(pageUrl).match(/\/(?:v|e)\/([A-Za-z0-9]+)/i);
  if (!idMatch) throw new Error('Invalid Streamtape URL');

  const headers = {
    'User-Agent':
      options.userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: 'https://streamtape.to/',
    ...(options.headers || {}),
  };

  const res = await fetch(pageUrl, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`Page fetch failed: ${res.status}`);
  const html = await res.text();

  // Reconstruct from the page's own JS assignment
  // pattern: getElementById('norobotlink').innerHTML = '//streamtape.to/get_video?id=' + ('xxxyyyy...').substring(1).substring(2)
  const assignRe =
    /getElementById\(['"](?:norobotlink|captchalink|ideoooolink)['"]\)\.innerHTML\s*=\s*[^;]*?\(\s*['"]([^'"]+)['"]\s*\)\.substring\(\s*(\d+)\s*\)(?:\.substring\(\s*(\d+)\s*\))?/i;

  let path = null;
  const m = html.match(assignRe);
  if (m) {
    let s = m[1];
    const a = parseInt(m[2], 10) || 0;
    const b = m[3] !== undefined ? parseInt(m[3], 10) : 0;
    if (a) s = s.substring(a);
    if (b) s = s.substring(b);
    path = '/get_video?id=' + s;
  }

  // Fallback: any clean get_video string already present in the page
  if (!path) {
    const direct = html.match(
      /\/get_video\?id=([A-Za-z0-9]+)&expires=(\d+)&ip=([^&"']+)&token=([A-Za-z0-9_-]+)/
    );
    if (direct) {
      path = `/get_video?id=${direct[1]}&expires=${direct[2]}&ip=${direct[3]}&token=${direct[4]}`;
    }
  }

  if (!path) throw new Error('Streamtape video link not found (page layout changed or blocked)');

  // Strip residual dummy prefixes sometimes left in token
  path = path.replace(/token=[A-Za-z0-9_-]*?(defg|xcdd|xcd)/i, 'token=');

  if (!path.includes('stream=1')) path += '&stream=1';

  return 'https://streamtape.to' + path;
}

// CLI when run with node
if (typeof process !== 'undefined' && process.argv[1] && /streamtape-bypass\.js$/.test(process.argv[1])) {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node streamtape-bypass.js <streamtape-url>');
    process.exit(1);
  }
  streamtapeBypass(url)
    .then((link) => console.log(link))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
