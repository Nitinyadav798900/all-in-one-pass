async extract(url) {
    const jar = new CookieJar();

    const pageRes = await rawGet(url, {
      headers        : BASE_HEADERS,
      jar,
      followRedirects: true,
      timeout        : 15000,
    });

    const html     = pageRes.body;
    const finalUrl = pageRes.url || url;

    // ── DEBUG DUMP — REMOVE AFTER FIX ────────────────────────────────────
    console.log('[voe:debug] finalUrl:', finalUrl);
    console.log('[voe:debug] html length:', html.length);
    console.log('[voe:debug] html snippet (0-3000):\n', html.slice(0, 3000));
    // ─────────────────────────────────────────────────────────────────────

    const fileId = (
      finalUrl.match(/\/([a-z0-9]{8,20})(?:[?/]|$)/) ||
      url.match(/\/([a-z0-9]{8,20})(?:[?/]|$)/)
    )?.[1] ?? null;

    if (!fileId) throw new Error('voe: could not extract file ID from URL');

    let found = extractM3u8(html);
    if (found) return this._buildResult(fileId, found);

    const baseUrl        = new URL(finalUrl).origin;
    const embedEndpoints = [
      `${baseUrl}/e/${fileId}`,
      `https://voe.sx/e/${fileId}`,
      `https://caseyseemavoid.com/e/${fileId}`,
    ];

    for (const endpoint of embedEndpoints) {
      try {
        const embedRes = await rawGet(endpoint, {
          headers: {
            ...BASE_HEADERS,
            Referer         : url,
            'Sec-Fetch-Dest': 'iframe',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'cross-site',
          },
          jar,
          timeout: 10000,
        });

        // ── DEBUG EMBED ───────────────────────────────────────────────────
        console.log('[voe:debug] embed endpoint:', endpoint);
        console.log('[voe:debug] embed length:', embedRes.body.length);
        console.log('[voe:debug] embed snippet (0-3000):\n', embedRes.body.slice(0, 3000));
        // ─────────────────────────────────────────────────────────────────

        found = extractM3u8(embedRes.body);
        if (found) return this._buildResult(fileId, found);
      } catch (e) {
        console.log('[voe:debug] embed failed:', endpoint, e.message);
        continue;
      }
    }

    try {
      const apiRes = await rawGet(`https://voe.sx/api/file/info/${fileId}`, {
        headers: BASE_HEADERS,
        jar,
        timeout: 8000,
      });
      console.log('[voe:debug] api response:', apiRes.body.slice(0, 1000));

      const data = typeof apiRes.body === 'string'
        ? JSON.parse(apiRes.body)
        : apiRes.body;

      const hls = data?.file?.hls    || data?.file?.stream;
      const mp4 = data?.file?.mp4    || data?.file?.direct;

      if (hls && !isBlocked(hls)) return this._buildResult(fileId, { url: hls, type: 'hls' });
      if (mp4 && !isBlocked(mp4)) return this._buildResult(fileId, { url: mp4, type: 'mp4' });
    } catch (e) {
      console.log('[voe:debug] api failed:', e.message);
    }

    throw new Error('voe: stream URL not found — page structure may have changed or token expired');
  }
