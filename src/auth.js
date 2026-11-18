'use strict';

const MASTER_KEY = process.env.MASTER_API_KEY || 'changeme-master-key-set-in-env';
const keyStore   = new Map();

// Default public key
keyStore.set('public-key-free-tier', {
  label    : 'free-tier',
  rateLimit: 20,
  created  : Date.now(),
  calls    : 0,
  lastReset: Date.now(),
});

// Master key automatically valid — Vercel env se aayegi
keyStore.set(MASTER_KEY, {
  label    : 'master',
  rateLimit: 1000,
  created  : Date.now(),
  calls    : 0,
  lastReset: Date.now(),
});

function _gen() {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return 'hcb-' + Array.from({ length: 32 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

function create(label = 'unnamed', rateLimit = 30) {
  const key = _gen();
  keyStore.set(key, { label, rateLimit, created: Date.now(), calls: 0, lastReset: Date.now() });
  return key;
}

function validate(key) {
  if (!key) return { valid: false, reason: 'No API key. Add header: X-API-Key: your-key or ?key= param' };
  if (!keyStore.has(key)) return { valid: false, reason: 'Invalid API key' };
  const rec = keyStore.get(key);
  const now = Date.now();
  if (now - rec.lastReset > 60_000) { rec.calls = 0; rec.lastReset = now; }
  if (rec.calls >= rec.rateLimit) return { valid: false, reason: `Rate limit (${rec.rateLimit}/min). Retry in ${Math.ceil((60_000 - (now - rec.lastReset)) / 1000)}s` };
  rec.calls++;
  return { valid: true, rec };
}

const isMaster = key => key === MASTER_KEY;
const list     = ()  => [...keyStore.entries()].map(([k,v]) => ({ key: k.slice(0,8)+'...', fullKey: k, ...v }));
const remove   = key => keyStore.delete(key);

module.exports = { validate, create, isMaster, list, remove, MASTER_KEY };
