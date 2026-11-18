'use strict';

/**
 * BaseSite — all site plugins extend this.
 *
 * To add a NEW site:
 *   1. Create src/sites/yoursite.js
 *   2. Extend BaseSite
 *   3. Implement: match(), extract(), bypass()
 *   4. Register in src/registry.js
 *
 * That is the whole contract. Nothing else needed.
 */
class BaseSite {
  constructor() {
    /**
     * Site metadata — required
     */
    this.name        = 'unknown';     // human-readable name
    this.id          = 'unknown';     // unique slug used in API responses
    this.version     = '1.0.0';       // plugin version
    this.domains     = [];            // list of domains this plugin handles

    /**
     * Health state — maintained by orchestrator
     */
    this._healthy    = true;
    this._fails      = 0;
    this._lastOk     = null;
    this._lastFail   = null;
    this._lastHash   = null;          // hash of last successful HTML — detects site changes
  }

  /**
   * Returns true if this plugin can handle the given URL
   * @param {string} url
   * @returns {boolean}
   */
  match(url) {
    try {
      const host = new URL(url).hostname.replace('www.', '');
      return this.domains.some(d => host === d || host.endsWith('.' + d));
    } catch (_) { return false; }
  }

  /**
   * Extract file ID / metadata from URL
   * @param {string} url
   * @returns {{ id: string, [key: string]: any }}
   */
  extract(url) {
    throw new Error(`${this.id}.extract() not implemented`);
  }

  /**
   * Run the bypass and return structured result
   * @param {string} url
   * @returns {Promise<BypassResult>}
   */
  async bypass(url) {
    throw new Error(`${this.id}.bypass() not implemented`);
  }

  /**
   * Optional: validate that the site HTML hasn't changed structure
   * Override to add site-specific validation
   * @param {string} html
   * @returns {{ valid: boolean, reason?: string }}
   */
  validate(html) {
    return { valid: html.length > 200 };
  }

  /**
   * Record a successful bypass — called by orchestrator
   */
  onSuccess() {
    this._healthy  = true;
    this._fails    = 0;
    this._lastOk   = new Date().toISOString();
  }

  /**
   * Record a failed bypass — called by orchestrator
   * @param {Error} err
   */
  onFailure(err) {
    this._fails++;
    this._lastFail = new Date().toISOString();
    if (this._fails >= 5) this._healthy = false;
  }

  /**
   * Health report for /stats
   */
  health() {
    return {
      id      : this.id,
      name    : this.name,
      version : this.version,
      domains : this.domains,
      healthy : this._healthy,
      fails   : this._fails,
      last_ok : this._lastOk,
      last_fail: this._lastFail,
    };
  }

  /**
   * Normalize a result into standard shape
   */
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

/**
 * @typedef {Object} BypassResult
 * @property {boolean} success
 * @property {string}  site        - plugin id
 * @property {string}  file_id
 * @property {Object}  metadata    - { filename, size, type, date }
 * @property {Array}   servers     - [{ label, url, server }]
 * @property {string}  extracted_at
 */

module.exports = BaseSite;
