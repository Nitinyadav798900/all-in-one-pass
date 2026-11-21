'use strict';

const crypto = require('crypto');
const path   = require('path');

/**
 * SiteRegistry — central plugin manager
 *
 * HOW TO ADD A NEW SITE:
 *   1. Create src/sites/yoursite.js  (extend BaseSite)
 *   2. Add filename to SITE_FILES below
 *   3. Done. Auto-loads on startup.
 */
const SITE_FILES = [
  'hubcloud.js',
  'hubdrive.js',
  'multicloud.js',
  'drivehub.js',
  'gofile.js',
  'streamtape.js',
  'voe.js',
  // ← add new sites here
];

class SiteRegistry {
  constructor() {
    this._plugins      = new Map();
    this._htmlHashes   = new Map();
    this._changeAlerts = [];
    this._loaded       = false;
  }

  load() {
    const dir = path.join(__dirname, 'sites');
    for (const file of SITE_FILES) {
      try {
        const plugin = require(path.join(dir, file));

        // Validate plugin has required methods
        if (typeof plugin.match   !== 'function') { console.error(`[registry] ${file}: missing match() method`);   continue; }
        if (typeof plugin.extract !== 'function') { console.error(`[registry] ${file}: missing extract() method`); continue; }
        if (typeof plugin.bypass  !== 'function') { console.error(`[registry] ${file}: missing bypass() method`);  continue; }
        if (!plugin.id)                           { console.error(`[registry] ${file}: missing id property`);       continue; }

        this._plugins.set(plugin.id, plugin);
        console.log(`[registry] ✓ loaded: ${plugin.id} (${plugin.name} v${plugin.version}) — ${plugin.domains.join(', ')}`);
      } catch (e) {
        console.error(`[registry] ✗ failed to load ${file}: ${e.message}`);
      }
    }
    this._loaded = true;
    console.log(`[registry] ${this._plugins.size}/${SITE_FILES.length} sites loaded`);
  }

  /**
   * Find the right plugin for a URL
   * Returns null if no plugin matches — never throws
   */
  match(url) {
    if (!this._loaded) this.load();
    try {
      for (const plugin of this._plugins.values()) {
        if (plugin.match(url)) return plugin;
      }
    } catch (e) {
      console.error(`[registry] match() error: ${e.message}`);
    }
    return null;
  }

  /**
   * Run bypass using the correct plugin
   */
  async bypass(url) {
    const plugin = this.match(url);
    if (!plugin) {
      throw new Error(
        `No plugin found for: ${_hostname(url)}\n` +
        `Supported: ${this.supportedDomains().join(', ')}`
      );
    }
    try {
      const result = await plugin.bypass(url);
      plugin.onSuccess();
      this._trackHash(plugin.id, JSON.stringify(result.servers));
      return result;
    } catch (err) {
      plugin.onFailure(err);
      throw err;
    }
  }

  /**
   * Hot-reload a single plugin without restarting server
   */
  reload(id) {
    const plugin = this._plugins.get(id);
    if (!plugin) return { success: false, error: `Plugin '${id}' not found` };
    try {
      const filePath = require.resolve(path.join(__dirname, 'sites', `${id}.js`));
      delete require.cache[filePath];
      const fresh = require(filePath);
      if (typeof fresh.match   !== 'function') throw new Error('missing match()');
      if (typeof fresh.bypass  !== 'function') throw new Error('missing bypass()');
      this._plugins.set(fresh.id, fresh);
      return { success: true, id: fresh.id, name: fresh.name, version: fresh.version };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  _trackHash(pluginId, content) {
    const hash = crypto.createHash('md5').update(content).digest('hex');
    const prev = this._htmlHashes.get(pluginId);
    if (prev && prev !== hash) {
      const alert = {
        id        : pluginId,
        detectedAt: new Date().toISOString(),
        message   : `Structure change detected for ${pluginId} — verify parser still works`,
      };
      this._changeAlerts.push(alert);
      if (this._changeAlerts.length > 20) this._changeAlerts.shift();
      console.warn(`[registry] ⚠ structure change: ${pluginId}`);
    }
    this._htmlHashes.set(pluginId, hash);
  }

  supportedDomains() {
    const d = [];
    for (const p of this._plugins.values()) d.push(...p.domains);
    return d;
  }

  list() {
    return [...this._plugins.values()].map(p => ({
      id     : p.id,
      name   : p.name,
      version: p.version,
      domains: p.domains,
      healthy: p._healthy,
      fails  : p._fails,
    }));
  }

  get(id) { return this._plugins.get(id) || null; }

  status() {
    return {
      total_plugins    : this._plugins.size,
      healthy          : [...this._plugins.values()].filter(p => p._healthy).length,
      plugins          : this.list(),
      change_alerts    : this._changeAlerts.slice(-10),
      supported_domains: this.supportedDomains(),
    };
  }
}

function _hostname(url) {
  try { return new URL(url).hostname; } catch (_) { return url; }
}

const registry = new SiteRegistry();
registry.load();

module.exports = registry;
