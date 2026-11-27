
'use strict';

const cheerio = require('cheerio');

class MCloud {
  constructor() {
    this.id = 'mcloud';
    this.name = 'MCloud';
    this.domains = ['mcloud.best'];
  }

  match(url) {
    try {
      const parsed = new URL(url);
      return this.domains.includes(parsed.hostname);
    } catch {
      return false;
    }
  }

  extract(url) {
    const parsed = new URL(url);
    const id = parsed.pathname.split('/').filter(Boolean).pop() || '';

    return {
      id,
      token: parsed.searchParams.get('token') || null,
      url: parsed.href
    };
  }

  parseHtml(html, sourceUrl = '') {
    if (typeof html !== 'string' || !html.trim()) {
      throw new Error('HTML content is empty');
    }

    const $ = cheerio.load(html);

    const getText = (selector) =>
      $(selector).first().text().trim();

    const title = getText('title');

    const getInfo = (label) => {
      let result = '';

      $('.list-group-item').each((_, element) => {
        const item = $(element);
        if (item.text().toLowerCase().includes(label.toLowerCase())) {
          result = item.find('i').text().trim();
        }
      });

      return result;
    };

    const servers = [];

    $('.mirrors-container a[href]').each((_, element) => {
      const link = $(element);

      const href = link.attr('href');
      const baseUrl = link.attr('data-minute-base-url') || null;
      const name = link.text().replace(/\s+/g, ' ').trim();

      if (!href) return;

      let type = 'direct';

      if (/pixeldrain/i.test(href)) {
        type = 'pixeldrain';
      } else if (/r2\.dev|cloudflarestorage/i.test(href)) {
        type = 'fsl';
      }

      servers.push({
        name,
        type,
        url: href,
        baseUrl,
        target: link.attr('target') || null
      });
    });

    const copyLink = getText('#shareLinkUrl');

    const fileId = (() => {
      try {
        return this.extract(sourceUrl).id;
      } catch {
        return null;
      }
    })();

    return {
      success: true,
      site: this.id,
      fileId,
      sourceUrl,
      title,
      file: {
        name: title,
        mimeType: getInfo('MimeType'),
        size: getInfo('Size')
      },
      tokenPage: copyLink || sourceUrl,
      ready: /Download Links Ready/i.test($.text()),
      servers,
      serverCount: servers.length
    };
  }

  validate(html) {
    const $ = cheerio.load(html);

    const hasMirrors = $('.mirrors-container').length > 0;
    const hasDownloadText = /Download Links Ready/i.test($.text());

    return {
      valid: hasMirrors && hasDownloadText,
      hasMirrors,
      hasDownloadText
    };
  }
}

module.exports = new MCloud();
