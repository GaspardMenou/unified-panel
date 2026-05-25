// unified-panel — server.js
//
// API Express minimale qui :
//   1. Sert la SPA (`public/`)
//   2. Expose `/api/platforms/status` pour pinger les 2 backends
//   3. Proxy `/api/:platform/*` vers les 2 backends en passe-plat (GET +
//      liste blanche pour POST/PATCH/DELETE — pas d'upload multipart, pas
//      de routes webhook WORKER_SECRET)
//   4. Expose `/api/aggregate/*` qui fusionne les réponses des 2 backends
//
// Aucune DB locale, aucun worker. Source de vérité = les 2 backends.

const path = require('path');
const fs = require('fs');
const express = require('express');
const compression = require('compression');

const { PORT } = require('./config');
const { PLATFORMS, KEYS: PLATFORM_KEYS } = require('./lib/platforms');
const { fetchPlatform, fetchAll } = require('./lib/fetchPlatform');
const agg = require('./lib/aggregate');

// Version embarquée dans les URLs JS/CSS (`?v=`) — bust le cache à chaque
// redémarrage du serveur, sans changer le bundling. Hash du contenu des assets
// pour ne busser que quand ça change réellement.
const pkg = require('./package.json');
const ASSET_VERSION = (() => {
  try {
    const crypto = require('crypto');
    const h = crypto.createHash('sha1');
    h.update(fs.readFileSync(path.join(__dirname, 'public/app.js')));
    h.update(fs.readFileSync(path.join(__dirname, 'public/styles.css')));
    return h.digest('hex').slice(0, 8);
  } catch {
    return pkg.version || String(Date.now());
  }
})();

const app = express();
// Compression > 1KB only — pour les petites réponses (status, ping), le coût
// CPU de gzip dépasse le gain réseau (surtout en localhost / LAN Tailscale).
app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: '1mb' }));
// ETag faible : permet aux navigateurs de réutiliser le cache via
// `If-None-Match` même quand `Cache-Control: no-store` (typique de /api/*).
app.set('etag', 'weak');

// Cache HTTP : court sur API, plus long sur assets statiques (cf. les 2 panels source).
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

// ─── Static : sert la SPA ────────────────────────────────────────────────────
//
// `index.html` est servi par un handler dédié qui injecte `?v=<assetVersion>`
// dans les URLs `/app.js` et `/styles.css` — bust le cache navigateur après
// chaque deploy sans forcer un Cmd+Shift+R manuel.

function serveIndex(req, res) {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8')
      .replace('href="/styles.css"', `href="/styles.css?v=${ASSET_VERSION}"`)
      .replace('src="/app.js"',     `src="/app.js?v=${ASSET_VERSION}"`);
    res.set('Cache-Control', 'no-cache, must-revalidate');
    res.set('Content-Type', 'text/html; charset=UTF-8');
    res.send(html);
  } catch (err) {
    res.status(500).send('Failed to load index.html');
  }
}
app.get('/', serveIndex);
app.get('/index.html', serveIndex);

app.use(
  express.static(path.join(__dirname, 'public'), {
    index: false, // on gère `/` nous-mêmes pour injecter le cache-bust
    setHeaders: (res, filePath) => {
      if (/\.(js|css|woff2?)$/.test(filePath)) {
        // Long cache : le ?v=<hash> garantit qu'on bust quand le contenu change
        res.set('Cache-Control', 'public, max-age=86400, immutable');
      } else if (/\.(html|json)$/.test(filePath)) {
        res.set('Cache-Control', 'public, max-age=60, must-revalidate');
      }
    },
  })
);

// ─── Healthcheck (monitoring tiers) ──────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ ok: true, version: pkg.version, assetVersion: ASSET_VERSION, at: new Date().toISOString() });
});

// ─── /api/config ─────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  res.json({
    platforms: PLATFORM_KEYS.map(k => ({
      key: k,
      label: PLATFORMS[k].label,
      url: PLATFORMS[k].url,
    })),
    version: pkg.version,
    assetVersion: ASSET_VERSION,
  });
});

// ─── /api/platforms/status : ping rapide des 2 backends ──────────────────────

app.get('/api/platforms/status', async (req, res) => {
  const { tiktok, youtube } = await fetchAll('/api/config', { timeoutMs: 2500 });
  res.json({
    tiktok: {
      online: tiktok.ok,
      error: tiktok.ok ? null : tiktok.error,
      info: tiktok.ok ? tiktok.data : null,
      url: PLATFORMS.tiktok.url,
    },
    youtube: {
      online: youtube.ok,
      error: youtube.ok ? null : youtube.error,
      info: youtube.ok ? youtube.data : null,
      url: PLATFORMS.youtube.url,
    },
    at: new Date().toISOString(),
  });
});

// ─── /api/aggregate/* : vues unifiées ────────────────────────────────────────

app.get('/api/aggregate/overview', async (req, res) => {
  const results = await fetchAll('/api/stats');
  res.json(agg.overview(results));
});

app.get('/api/aggregate/logs', async (req, res) => {
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 200));
  // Chaque backend respecte `?limit=`, on demande un peu plus pour avoir
  // de la marge après le merge.
  const queryLimit = Math.min(500, limit * 2);
  const results = await fetchAll(`/api/logs?limit=${queryLimit}`);
  res.json(agg.logs(results, { limit }));
});

app.get('/api/aggregate/campaigns', async (req, res) => {
  const results = await fetchAll('/api/campaigns');
  res.json(agg.campaigns(results));
});

app.get('/api/aggregate/accounts', async (req, res) => {
  const results = await fetchAll('/api/accounts');
  res.json(agg.accounts(results));
});

app.get('/api/aggregate/charts', async (req, res) => {
  // YouTube expose `/api/stats/charts` directement. TikTok n'a pas
  // d'équivalent → on fait un fallback à partir de `/api/stats` + `/api/accounts`.
  const [yt, ttStats, ttAccs] = await Promise.all([
    fetchPlatform('youtube', '/api/stats/charts'),
    fetchPlatform('tiktok', '/api/stats'),
    fetchPlatform('tiktok', '/api/accounts'),
  ]);

  const ttChart = agg.tiktokChartFallback(ttStats, ttAccs);
  const ytChart = yt.ok ? yt.data : agg.emptyChartShape();

  res.json({
    combined: agg.combineCharts(ttChart, ytChart),
    tiktok: ttChart,
    youtube: ytChart,
    available: {
      tiktok: ttStats.ok,
      youtube: yt.ok,
    },
  });
});

// ─── /api/:platform/* — proxy passe-plat ─────────────────────────────────────
//
// GET : toujours autorisé (read-only) — on ne fait pas la liste blanche
// fine, le backend rejette les chemins inconnus avec un 404 propre.
//
// POST/PATCH/DELETE : liste blanche stricte pour bloquer les opérations
// dangereuses ou inadaptées à un proxy : upload multipart de clips, webhooks
// WORKER_SECRET, spawn de `login.js`.

const WRITE_ALLOWLIST = [
  // Campaigns — actions courantes
  { method: 'PATCH', re: /^\/api\/campaigns\/[^/]+$/ },
  { method: 'PATCH', re: /^\/api\/campaigns\/[^/]+\/status$/ },
  { method: 'POST',  re: /^\/api\/campaigns\/[^/]+\/pushall$/ },
  { method: 'POST',  re: /^\/api\/campaigns\/[^/]+\/pushnow$/ },
  { method: 'POST',  re: /^\/api\/campaigns\/[^/]+\/retry$/ },
  { method: 'POST',  re: /^\/api\/campaigns\/[^/]+\/retry-errors$/ },
  { method: 'POST',  re: /^\/api\/campaigns\/[^/]+\/schedule$/ },
  // Accounts — lift cooldown manuel uniquement (pas de login spawn, pas de
  // setters WORKER_SECRET)
  { method: 'DELETE', re: /^\/api\/accounts\/[^/]+\/cooldown$/ },
  // Worker settings — speed/parallel
  { method: 'PATCH', re: /^\/api\/worker-settings$/ },
];

function isWriteAllowed(method, path) {
  return WRITE_ALLOWLIST.some(rule => rule.method === method && rule.re.test(path));
}

app.all('/api/:platform/*', async (req, res) => {
  const platform = req.params.platform;
  if (!PLATFORMS[platform]) {
    return res.status(404).json({ error: `Plateforme inconnue: ${platform}` });
  }

  // Reconstruit le path cible : on retire UNIQUEMENT le segment `/:platform`,
  // pas le préfixe `/api/`. Les backends s'attendent à recevoir `/api/foo/bar`.
  //   `/api/tiktok/accounts/x/login` → `/api/accounts/x/login`
  const targetPath = req.originalUrl.replace(/^\/api\/[^/]+/, '/api');
  const method = req.method.toUpperCase();

  if (method !== 'GET' && !isWriteAllowed(method, targetPath.split('?')[0])) {
    return res.status(403).json({
      error: `Méthode ${method} ${targetPath} non autorisée via le proxy unified.`,
      hint: 'Utilise l\'UI native de la plateforme pour cette action.',
    });
  }

  const result = await fetchPlatform(platform, targetPath, {
    method,
    body: ['POST', 'PATCH', 'PUT'].includes(method) ? req.body : undefined,
  });

  if (!result.ok) {
    return res.status(result.status || 502).json({
      error: result.error,
      down: !!result.down,
      platform,
    });
  }
  res.status(result.status || 200).json(result.data);
});

// ─── Fallback : SPA index pour toute autre route GET ─────────────────────────

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  serveIndex(req, res);
});

// ─── Boot ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🌐 Unified Panel démarré sur http://localhost:${PORT}`);
  console.log(`   → TikTok backend :  ${PLATFORMS.tiktok.url}`);
  console.log(`   → YouTube backend : ${PLATFORMS.youtube.url}`);
  console.log('');
});
