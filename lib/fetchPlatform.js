// Wrapper fetch vers les 2 backends. Tolère timeout + backend down sans
// crasher le serveur unified — la SPA reçoit `{ ok: false, error }` et
// dégrade gracieusement (l'autre plateforme reste visible).

const { get: getPlatform } = require('./platforms');
const { FETCH_TIMEOUT_MS } = require('../config');

async function fetchPlatform(platformKey, path, opts = {}) {
  const platform = getPlatform(platformKey);
  if (!platform) {
    return { ok: false, status: 0, error: `Plateforme inconnue: ${platformKey}` };
  }

  const url = `${platform.url}${path.startsWith('/') ? path : '/' + path}`;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs || FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
      body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
      signal: ctrl.signal,
    });

    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json().catch(() => null) : await res.text();

    if (!res.ok) {
      return { ok: false, status: res.status, error: (data && data.error) || res.statusText, data };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      error: isTimeout ? 'Timeout' : (err.message || 'Network error'),
      down: true,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// Helper : appelle les 2 backends en parallèle, retourne `{ tiktok: result, youtube: result }`.
async function fetchAll(path, opts) {
  const [tiktok, youtube] = await Promise.all([
    fetchPlatform('tiktok', path, opts),
    fetchPlatform('youtube', path, opts),
  ]);
  return { tiktok, youtube };
}

module.exports = { fetchPlatform, fetchAll };
