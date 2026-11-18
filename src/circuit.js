'use strict';

class CircuitBreaker {
  constructor(threshold = 5, timeout = 60000) {
    this.threshold = threshold;
    this.timeout   = timeout;
    this._map      = new Map();
  }

  _get(id) {
    if (!this._map.has(id)) this._map.set(id, { state: 'CLOSED', fails: 0, openedAt: null, successes: 0 });
    return this._map.get(id);
  }

  isOpen(id) {
    const c = this._get(id);
    if (c.state === 'CLOSED') return false;
    if (c.state === 'OPEN') {
      if (Date.now() - c.openedAt > this.timeout) { c.state = 'HALF_OPEN'; c.successes = 0; return false; }
      return true;
    }
    return false;
  }

  onSuccess(id) {
    const c = this._get(id);
    if (c.state === 'HALF_OPEN') { if (++c.successes >= 2) { c.state = 'CLOSED'; c.fails = 0; } }
    else c.fails = 0;
  }

  onFailure(id) {
    const c = this._get(id);
    if (++c.fails >= this.threshold) { c.state = 'OPEN'; c.openedAt = Date.now(); }
  }

  status() {
    const out = {};
    for (const [id, c] of this._map) out[id] = c.state;
    return out;
  }
}

module.exports = new CircuitBreaker();
