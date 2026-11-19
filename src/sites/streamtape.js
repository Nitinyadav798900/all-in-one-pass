
'use strict';

const BaseSite = require('../site-base');

class StreamTape extends BaseSite {
  constructor() {
    super();

    this.name = 'StreamTape';
    this.id = 'streamtape';
    this.version = '1.0.0';

    this.domains = [
      'streamtape.to'
    ];
  }

  match(url) {
    try {
      const parsed = new URL(url);

      return (
        parsed.protocol === 'https:' &&
        this.domains.includes(parsed.hostname.toLowerCase()) &&
        /^\/(?:v|e)\/[A-Za-z0-9]+\/?$/i.test(parsed.pathname)
      );
    } catch {
      return false;
    }
  }

  extract(url) {
    if (!this.match(url)) {
      throw new Error('StreamTape: Invalid URL');
    }

    const parsed = new URL(url);
    const match = parsed.pathname.match(
      /^\/(?:v|e)\/([A-Za-z0-9]+)\/?$/i
    );

    return {
      id: match[1],
      host: parsed.hostname
    };
  }

  async bypass(url) {
    const { id, host } = this.extract(url);

    return {
      success: true,
      site: this.id,
      name: this.name,
      version: this.version,
      file_id: id,
      filename: null,
      servers: [],
      playback: {
        status: 'not_resolved',
        message: 'Authorized StreamTape playback integration required'
      },
      source: `https://${host}/v/${id}`,
      extracted_at: new Date().toISOString()
    };
  }
}

module.exports = new StreamTape();
