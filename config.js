// Centralise la configuration runtime. Tout est surchargeable par env vars
// (`.env` lu via `--env-file-if-exists` côté `npm start`).

const PORT = Number(process.env.PORT) || 3020;

const TIKTOK_URL = (process.env.TIKTOK_URL || 'http://localhost:3010').replace(/\/+$/, '');
const YOUTUBE_URL = (process.env.YOUTUBE_URL || 'http://localhost:3000').replace(/\/+$/, '');

// Timeout des appels vers les 2 backends. Garder court : si un backend rame,
// la SPA dégrade gracieusement plutôt qu'attendre indéfiniment.
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 5000;

// Cache TTL pour les agrégats (sec). On poll côté front ; pas besoin de cache
// agressif. 0 désactive — utile pour debug.
const AGG_CACHE_MS = Number(process.env.AGG_CACHE_MS) || 1000;

module.exports = {
  PORT,
  TIKTOK_URL,
  YOUTUBE_URL,
  FETCH_TIMEOUT_MS,
  AGG_CACHE_MS,
};
