'use strict';

class BaseSite {
  constructor() {
    this.name     = 'unknown';
    this.id       = 'unknown';
    this.version  = '1.0.0';
    this.domains  = [];
    this._healthy = true;
    this._fails   = 0;
    this._lastOk  = null;
    this._lastFail= null;
  }

  match(url) {
    try {
      const host = new URL(url).hostname.replace('www.', '');
      return this.domains.some(d => host === d || host.endsWith('.' + d));
    } catch (_) { return false; }
  }

  extract(url) { throw new Error(`${this.id}.extract() not implemented`); }

  // opts is optional — always default to {}
  async bypass(url, opts = {}) { throw new Error(`${this.id}.bypass() not implemented`); }

  validate(html) { return { valid: html.length > 200 }; }

  onSuccess() {
    this._healthy = true;
    this._fails   = 0;
    this._lastOk  = new Date().toISOString();
  }

  onFailure(err) {
    this._fails++;
    this._lastFail = new Date().toISOString();
    if (this._fails >= 5) this._healthy = false;
  }

  health() {
    return {
      id       : this.id,
      name     : this.name,
      version  : this.version,
      domains  : this.domains,
      healthy  : this._healthy,
      fails    : this._fails,
      last_ok  : this._lastOk,
      last_fail: this._lastFail,
    };
  }

  _result(fileId, metadata, servers, extra = {}) {
    return {
      success     : true,
      site        : this.id,
      file_id     : fileId,
      metadata,
      servers,
      extracted_at: new Date().toISOString(),
      ...extra,
    };
  }
}

module.exports = BaseSite;
