# MultiSite Bypass API v7

Universal bypass API — one endpoint, all sites. Plugin architecture means adding a new site takes **5 minutes**.

---

## Supported Sites

| Site | Domain(s) | URL Pattern |
|------|-----------|-------------|
| HubCloud | hubcloud.pw/cx/mov/in/fans/club | `/drive/{id}` |
| HubDrive | hubdrive.blog/de/mom/pro | `/file/{id}` |
| MultiCloudLinks | multicloudlinks.com | `/view/{id}?...` |
| DriveHub | drivehub.dad/ws/in | `/file/{id}` |
| GoFile | gofile.io | `/d/{id}` |

---

## Quick Start

```bash
# 1. Clone / download
git clone your-repo
cd multisite-bypass-api

# 2. Install
npm install

# 3. Config
cp .env.example .env
# Edit .env — set MASTER_API_KEY at minimum

# 4. Run
npm start
# → [multisite-bypass v7] :3000
# → [sites] hubcloud, hubdrive, multicloud, drivehub, gofile
```

---

## API Reference

### Base URL
```
http://localhost:3000
# or deployed: https://your-api.vercel.app
```

### Authentication
Add header to every request:
```
X-API-Key: your-api-key
```

Default free-tier key: `public-key-free-tier` (20 req/min)
Master key: set in `MASTER_API_KEY` env var

---

### `GET /bypass?url=...`
Universal bypass — works for ALL supported sites.

```bash
# HubCloud
curl "http://localhost:3000/bypass?url=https://hubcloud.pw/drive/ABC123" \
  -H "X-API-Key: public-key-free-tier"

# GoFile
curl "http://localhost:3000/bypass?url=https://gofile.io/d/pVawQzDG" \
  -H "X-API-Key: public-key-free-tier"

# MultiCloudLinks (full URL with query params)
curl "http://localhost:3000/bypass?url=https://new3.multicloudlinks.com/view/f533404ca2%3Fc%3D72hb9w%26exp%3D1795012311%26token%3D0a724cea14ed2209" \
  -H "X-API-Key: public-key-free-tier"
```

**Force fresh bypass (skip cache):**
```bash
curl "http://localhost:3000/bypass?url=...&nocache=1"
```

**Response:**
```json
{
  "success": true,
  "site": "hubcloud",
  "file_id": "hjbxwnwshhhqyu8",
  "metadata": {
    "filename": "Killing.Season.2013.1080p...",
    "size": "1.9 GB",
    "type": "video/x-matrosk",
    "date": "15-Nov-2026 06:44:41"
  },
  "servers": [
    { "label": "Direct Server",    "url": "https://...", "server": "r2"         },
    { "label": "10Gbps Server",    "url": "https://...", "server": "10gbps"     },
    { "label": "PixelDrain Server","url": "https://...", "server": "pixeldrain" },
    { "label": "Buzz Server",      "url": "https://...", "server": "buzz"       }
  ],
  "cached": false,
  "extracted_at": "2026-11-18T10:00:00.000Z"
}
```

---

### `POST /batch`
Process up to 10 URLs at once — any mix of sites.

```bash
curl -X POST "http://localhost:3000/batch" \
  -H "X-API-Key: public-key-free-tier" \
  -H "Content-Type: application/json" \
  -d '{
    "urls": [
      "https://hubcloud.pw/drive/ABC123",
      "https://gofile.io/d/pVawQzDG",
      "https://hubdrive.blog/file/3002211248"
    ]
  }'
```

---

### `GET /prefetch?url=...`
Warm the cache in background. Returns immediately.
```bash
curl "http://localhost:3000/prefetch?url=https://hubcloud.pw/drive/ABC123" \
  -H "X-API-Key: public-key-free-tier"
```

---

### `GET /sites`
List all loaded plugins.
```bash
curl "http://localhost:3000/sites"
```
```json
[
  { "id": "hubcloud",   "name": "HubCloud",         "version": "2.0.0", "healthy": true },
  { "id": "hubdrive",   "name": "HubDrive",          "version": "1.0.0", "healthy": true },
  { "id": "multicloud", "name": "MultiCloudLinks",   "version": "1.0.0", "healthy": true },
  { "id": "drivehub",   "name": "DriveHub",          "version": "1.0.0", "healthy": true },
  { "id": "gofile",     "name": "GoFile",            "version": "1.0.0", "healthy": true }
]
```

---

### `POST /sites/:id/reload` (master key)
Hot-reload a plugin after editing — no server restart needed.
```bash
curl -X POST "http://localhost:3000/sites/hubcloud/reload" \
  -H "X-API-Key: your-master-key"
```

---

### `GET /stats` 
Full system stats.
```bash
curl "http://localhost:3000/stats" -H "X-API-Key: your-key"
```

---

### `DELETE /cache?url=...` (master key)
Clear cached result for a URL.
```bash
curl -X DELETE "http://localhost:3000/cache?url=https://gofile.io/d/ABC" \
  -H "X-API-Key: your-master-key"
```

---

### Admin: API Keys (master key)
```bash
# Create key
curl -X POST "http://localhost:3000/admin/keys" \
  -H "X-API-Key: your-master-key" \
  -H "Content-Type: application/json" \
  -d '{ "label": "myapp", "rateLimit": 60 }'

# List keys
curl "http://localhost:3000/admin/keys" -H "X-API-Key: your-master-key"

# Delete key
curl -X DELETE "http://localhost:3000/admin/keys/hcb-abc..." \
  -H "X-API-Key: your-master-key"
```

---

## ➕ Adding a New Site (5 minutes)

### Step 1 — Copy the template
```bash
cp src/sites/_TEMPLATE.js src/sites/mynewsite.js
```

### Step 2 — Edit `src/sites/mynewsite.js`
Fill in 4 sections:
1. **Identity** — name, id, domains
2. **extract()** — parse file ID from URL
3. **validate()** — check HTML structure
4. **bypass()** — fetch page, extract links

### Step 3 — Register in `src/registry.js`
```js
const SITE_FILES = [
  'hubcloud.js',
  'hubdrive.js',
  'multicloud.js',
  'drivehub.js',
  'gofile.js',
  'mynewsite.js',  // ← add here
];
```

### Step 4 — Test
```bash
node test/test-all.js
# or hot-reload without restart:
curl -X POST http://localhost:3000/sites/mynewsite/reload -H "X-API-Key: master"
```

**That's it. No other files need changing.**

---

## 🔄 Auto-Update Detection

The registry tracks the structure of responses using MD5 hashes.
When a site changes its HTML and the hash shifts, you see it in `/stats`:

```json
"change_alerts": [
  {
    "id": "hubdrive",
    "detectedAt": "2026-11-18T10:00:00.000Z",
    "message": "Site structure may have changed for hubdrive — verify parser still works"
  }
]
```

When you see an alert:
1. Open `src/sites/hubdrive.js`
2. Update the regex patterns in `_parseLinks()`
3. `POST /sites/hubdrive/reload` — live without restart

---

## Deploy on Vercel

```bash
# Set env vars
npx vercel env add MASTER_API_KEY
npx vercel env add UPSTASH_REDIS_REST_URL      # optional
npx vercel env add UPSTASH_REDIS_REST_TOKEN    # optional

# Deploy
npx vercel --prod
```

---

## File Structure

```
multisite-bypass-api/
├── index.js                  ← Express server, all endpoints
├── package.json
├── vercel.json
├── .env.example
├── src/
│   ├── orchestrator.js       ← cache + circuit + retry → registry
│   ├── registry.js           ← plugin loader + auto-update detector
│   ├── site-base.js          ← BaseSite class all plugins extend
│   ├── http.js               ← core HTTP client, cookie jar, fingerprinting
│   ├── cache.js              ← Redis + in-memory cache
│   ├── auth.js               ← API key management
│   ├── circuit.js            ← per-site circuit breaker
│   ├── retry.js              ← exponential backoff + jitter
│   └── sites/
│       ├── _TEMPLATE.js      ← copy this to add a new site
│       ├── hubcloud.js       ← HubCloud plugin
│       ├── hubdrive.js       ← HubDrive plugin
│       ├── multicloud.js     ← MultiCloudLinks plugin
│       ├── drivehub.js       ← DriveHub plugin
│       └── gofile.js         ← GoFile plugin
└── test/
    └── test-all.js           ← integration tests for all sites
```
