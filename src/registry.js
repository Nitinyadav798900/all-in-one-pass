'use strict';

const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

/**
 * SiteRegistry — central plugin manager
 *
 * HOW TO ADD A NEW SITE:
 * ──────────────────────
 * 1. Create src/sites/yoursite.js  (extend BaseSite)
 * 2. Add the filename to SITE_FILES below
 * 3. Done. Auto-discovered on startup.
 *
 * That's the whole contract.
 */

const SITE_FILES = [
  'hubcloud.js',
  'hubdrive.js',
  'multicloud.js',
  'drivehub.js',
  'gofile.js',
  // ← add new site filenames here
];

class SiteRegistry {
  constructor() {
    this._plugins      = new Map(); // id → plugin instance
    this._htmlHashes   = new Map(); // id → last-seen HTML hash
    this._changeAlerts = [];        // { id, detectedAt, oldHash, newHash }
    this._loaded       = false;
  }

  /**
   * Load all site plugins
   */
  load() {
    const dir = path.join(__dirname, 'sites');
    for (const file of SITE_FILES) {
      try {
        const plugin = require(path.join(dir, file));
        this._plugins.set(plugin.id, plugin);
        console.log(`[registry] loaded: ${plugin.id} (${plugin.name})`);
      } catch (e) {
        console.error(`[registry] failed to load ${file}: ${e.message}`);
      }
    }
    this._loaded = true;
    console.log(`[registry] ${this._plugins.size} sites loaded`);
  }

  /**
   * Find the right plugin for a URL
   * @param {string} url
   * @returns {BaseSite|null}
   */
  match(url) {
    if (!this._loaded) this.load();
    for (const plugin of this._plugins.values()) {
      if (plugin.match(url)) return plugin;
    }
    return null;
  }

  /**
   * Get plugin by ID
   * @param {string} id
   * @returns {BaseSite|null}
   */
  get(id) { return this._plugins.get(id) || null; }

  /**
   * Run bypass using the correct plugin
   * @param {string} url
   * @returns {Promise<BypassResult>}
   */
  async bypass(url) {
    const plugin = this.match(url);
    if (!plugin) {
      throw new Error(
        `No plugin found for URL: ${url}\n` +
        `Supported sites: ${this.supportedDomains().join(', ')}\n` +
        `To add support: create src/sites/yoursite.js and add it to registry.js`
      );
    }

    try {
      const result = await plugin.bypass(url);
      plugin.onSuccess();
      this._trackHtml(plugin.id, JSON.stringify(result.servers));
      return result;
    } catch (err) {
      plugin.onFailure(err);
      throw err;
    }
  }

  /**
   * Track HTML structure changes — auto-update detector
   * When a site changes its HTML and links stop parsing,
   * the registry detects the hash change and flags it.
   */
  _trackHtml(pluginId, content) {
    const hash = crypto.createHash('md5').update(content).digest('hex');
    const prev = this._htmlHashes.get(pluginId);

    if (prev && prev !== hash) {
      const alert = {
        id        : pluginId,
        detectedAt: new Date().toISOString(),
        oldHash   : prev,
        newHash   : hash,
        message   : `Site structure may have changed for ${pluginId} — verify parser still works`,
      };
      this._changeAlerts.push(alert);
      console.warn(`[registry] ⚠ structure change detected: ${pluginId}`);
    }

    this._htmlHashes.set(pluginId, hash);
  }

  /**
   * All supported domains across all plugins
   */
  supportedDomains() {
    const domains = [];
    for (const p of this._plugins.values()) domains.push(...p.domains);
    return domains;
  }

  /**
   * Full status report
   */
  status() {
    const plugins = [...this._plugins.values()].map(p => p.health());
    return {
      total_plugins   : plugins.length,
      healthy         : plugins.filter(p => p.healthy).length,
      plugins,
      change_alerts   : this._changeAlerts.slice(-10), // last 10
      supported_domains: this.supportedDomains(),
    };
  }

  /**
   * Reload a single plugin (hot-reload when file changes)
   * @param {string} id  plugin ID
   */
  reload(id) {
    const plugin = this._plugins.get(id);
    if (!plugin) return { success: false, error: `Plugin ${id} not found` };

    try {
      const filePath = require.resolve(path.join(__dirname, 'sites', `${id}.js`));
      delete require.cache[filePath];
      const fresh = require(filePath);
      this._plugins.set(fresh.id, fresh);
      return { success: true, id: fresh.id, version: fresh.version };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * List all plugins
   */
  list() {
    return [...this._plugins.values()].map(p => ({
      id     : p.id,
      name   : p.name,
      version: p.version,
      domains: p.domains,
      healthy: p._healthy,
    }));
  }
}

// Singleton
const registry = new SiteRegistry();
registry.load();

module.exports = registry;
