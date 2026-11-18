'use strict';

async function withRetry(fn, opts = {}) {
  const { attempts = 3, baseMs = 1500, maxMs = 10000, factor = 2, jitter = 0.3 } = opts;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(i); }
    catch (err) {
      lastErr = err;
      if (err.message.includes('not found') || err.message.includes('Invalid URL') || err.message.includes('password')) throw err;
      if (i < attempts - 1) {
        const base  = Math.min(baseMs * Math.pow(factor, i), maxMs);
        const wait  = Math.round(base + base * jitter * (Math.random() * 2 - 1));
        console.log(`[retry] attempt ${i+1} — ${err.message} — wait ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

module.exports = { withRetry };
