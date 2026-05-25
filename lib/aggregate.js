// Fusion des réponses des 2 backends pour produire des vues unifiées.
//
// Convention clé : chaque entrée porte un champ `platform` ('tiktok'|'youtube')
// pour permettre filtrage + badge côté UI.

// ─── Helpers internes ───────────────────────────────────────────────────────

function safeArray(result) {
  if (!result || !result.ok || !Array.isArray(result.data)) return [];
  return result.data;
}

function safeObject(result) {
  if (!result || !result.ok || !result.data || typeof result.data !== 'object') return null;
  return result.data;
}

function withPlatform(items, platform) {
  return items.map(it => ({ ...it, platform }));
}

function compareIsoDesc(a, b) {
  return String(b || '').localeCompare(String(a || ''));
}

// ─── Logs : tri chrono desc ──────────────────────────────────────────────────

function logs({ tiktok, youtube }, { limit = 200 } = {}) {
  const merged = [
    ...withPlatform(safeArray(tiktok), 'tiktok'),
    ...withPlatform(safeArray(youtube), 'youtube'),
  ];
  merged.sort((a, b) => compareIsoDesc(a.timestamp, b.timestamp));
  return merged.slice(0, limit);
}

// ─── Campaigns : merge + normalisation légère ────────────────────────────────
//
// Les 2 backends ont des shapes proches mais pas identiques. On expose un
// shape commun pour le front, en gardant `raw` pour cas spécifiques.

function normalizeCampaign(c, platform) {
  if (!c) return null;
  const stats = c.scheduleStats || {};
  const total = stats.total ?? 0;
  const done = stats.done ?? 0;
  const successRate = total > 0 ? Math.round((done / total) * 100) : null;

  return {
    id: c.id,
    name: c.name,
    status: c.status,
    archived: !!c.archived,
    platform,
    type: c.type || null,                  // tiktok-specific
    postsPerDay: c.postsPerDay ?? null,
    startDate: c.startDate || null,
    endDate: c.endDate || null,
    createdAt: c.createdAt || null,
    stats: {
      total,
      done,
      pending: stats.pending ?? 0,
      queued: stats.queued ?? 0,
      running: stats.running ?? 0,
      errors: stats.errors ?? 0,
      skipped: stats.skipped ?? 0,
      successRate,
    },
    clipsCount: Array.isArray(c.clips) ? c.clips.length : (c.clipsCount ?? null),
    accountIds: Array.isArray(c.accountIds) ? c.accountIds : [],
    raw: c,
  };
}

function campaigns({ tiktok, youtube }) {
  const tt = safeArray(tiktok).map(c => normalizeCampaign(c, 'tiktok')).filter(Boolean);
  const yt = safeArray(youtube).map(c => normalizeCampaign(c, 'youtube')).filter(Boolean);
  const merged = [...tt, ...yt];
  merged.sort((a, b) => compareIsoDesc(a.createdAt, b.createdAt));
  return merged;
}

// ─── Accounts : merge + shape commun ────────────────────────────────────────
//
// TikTok : `{ id, username, needsLogin, cooldownUntil, ... }`
// YouTube : `{ id, username, channelName, handle, phoneId, googleLoginId, needsLogin, cooldownUntil, ... }`
//
// On expose `label` = nom à afficher, `meta` = champs plateforme-specific.

function normalizeAccount(a, platform) {
  if (!a) return null;
  const label =
    platform === 'youtube'
      ? (a.channelName || a.handle || a.username || a.id)
      : (a.username || a.id);
  const cooldownActive =
    a.cooldownActive === true ||
    (a.cooldownUntil && new Date(a.cooldownUntil).getTime() > Date.now());

  return {
    id: a.id,
    label,
    platform,
    loggedIn: a.loggedIn ?? null,
    needsLogin: !!a.needsLogin,
    cooldownActive: !!cooldownActive,
    cooldownUntil: a.cooldownUntil || null,
    cooldownReason: a.cooldownReason || null,
    captchaPending: !!a.captchaPending,
    meta:
      platform === 'youtube'
        ? {
            channelName: a.channelName || null,
            handle: a.handle || null,
            phoneId: a.phoneId || null,
            googleLoginId: a.googleLoginId || null,
          }
        : {
            username: a.username || null,
            hasPassword: !!a.hasPassword || !!a.password,
          },
    createdAt: a.createdAt || null,
    raw: a,
  };
}

function accounts({ tiktok, youtube }) {
  const tt = safeArray(tiktok).map(a => normalizeAccount(a, 'tiktok')).filter(Boolean);
  const yt = safeArray(youtube).map(a => normalizeAccount(a, 'youtube')).filter(Boolean);
  return [...tt, ...yt].sort((a, b) => a.label.localeCompare(b.label));
}

// ─── Stats / overview ───────────────────────────────────────────────────────
//
// Les 2 backends exposent `/api/stats` avec un shape proche : `{ campaigns,
// accounts, total, done, pending, queued, errors, skipped, live, archived,
// byCampaign }`. On fait la somme pour les totaux, on garde le breakdown par
// plateforme pour les vues comparées.

function pickStats(s) {
  if (!s) return null;
  return {
    campaigns: s.campaigns ?? 0,
    accounts: s.accounts ?? 0,
    total: s.total ?? 0,
    done: s.done ?? 0,
    pending: s.pending ?? 0,
    queued: s.queued ?? 0,
    errors: s.errors ?? 0,
    skipped: s.skipped ?? 0,
    live: s.live || null,
    archived: s.archived || null,
  };
}

function overview({ tiktok, youtube }) {
  const tt = pickStats(safeObject(tiktok));
  const yt = pickStats(safeObject(youtube));

  const sum = (k) => (tt ? tt[k] : 0) + (yt ? yt[k] : 0);
  const totalDone = sum('done');
  const totalAll = sum('total');
  const successRate = totalAll > 0 ? Math.round((totalDone / totalAll) * 100) : null;

  return {
    totals: {
      campaigns: sum('campaigns'),
      accounts: sum('accounts'),
      total: totalAll,
      done: totalDone,
      pending: sum('pending'),
      queued: sum('queued'),
      errors: sum('errors'),
      skipped: sum('skipped'),
      successRate,
    },
    tiktok: tt,
    youtube: yt,
    available: {
      tiktok: !!tt,
      youtube: !!yt,
    },
  };
}

// ─── Charts : agrégation séries temporelles ─────────────────────────────────
//
// Stratégie : on consomme `/api/stats/charts` de YouTube (riche, déjà
// pré-calculé) + on dérive un shape équivalent pour TikTok à partir de son
// `/api/stats` (basique) + détails de campagnes. Pour v1, si TikTok n'a pas de
// /charts, on retourne juste les daily/statusDist depuis ses byCampaign +
// quelques approximations. Les graphes manquants se grisent côté UI.

function emptyChartShape() {
  return {
    kpi: { totalPublished: 0, successRate: null, last24h: null, channels: 0, inCooldown: 0, errors7d: null },
    daily: [],
    hourly: new Array(24).fill(0),
    statusDist: { done: 0, error: 0, skipped: 0, pending: 0, queued: 0 },
    topChannels: [],
    byCampaign: [],
    errorTypes: { uploadLimit: 0, captcha: 0, login: 0, other: 0 },
  };
}

function tiktokChartFallback(statsResult, accountsResult) {
  const s = pickStats(safeObject(statsResult)) || {};
  const accs = safeArray(accountsResult);
  const inCooldown = accs.filter(a => {
    if (a.cooldownActive === true) return true;
    if (a.cooldownUntil && new Date(a.cooldownUntil).getTime() > Date.now()) return true;
    return false;
  }).length;
  const total = s.total || 0;
  const done = s.done || 0;
  return {
    kpi: {
      totalPublished: done,
      successRate: total > 0 ? Math.round((done / total) * 100) : null,
      last24h: null,
      channels: s.accounts || 0,
      inCooldown,
      errors7d: null,
    },
    daily: [],
    hourly: new Array(24).fill(0),
    statusDist: {
      done,
      error: s.errors || 0,
      skipped: s.skipped || 0,
      pending: s.pending || 0,
      queued: s.queued || 0,
    },
    topChannels: [],
    byCampaign: (s.byCampaign || []).map(c => ({
      name: c.name,
      done: c.done || 0,
      total: c.total || 0,
    })),
    errorTypes: { uploadLimit: 0, captcha: 0, login: 0, other: s.errors || 0 },
  };
}

function combineCharts(ttChart, ytChart) {
  // Somme des KPIs additifs ; recalcul du taux de succès sur le grand total.
  const tt = ttChart || emptyChartShape();
  const yt = ytChart || emptyChartShape();

  const totalPublished = (tt.kpi.totalPublished || 0) + (yt.kpi.totalPublished || 0);
  const sumStatuses = (k) => (tt.statusDist[k] || 0) + (yt.statusDist[k] || 0);
  const total =
    sumStatuses('done') + sumStatuses('error') + sumStatuses('skipped') +
    sumStatuses('pending') + sumStatuses('queued');

  // Merge daily : index sur date, somme done/error/skipped
  const dailyMap = new Map();
  [...(tt.daily || []), ...(yt.daily || [])].forEach(d => {
    const cur = dailyMap.get(d.date) || { date: d.date, done: 0, error: 0, skipped: 0 };
    cur.done += d.done || 0;
    cur.error += d.error || 0;
    cur.skipped += d.skipped || 0;
    dailyMap.set(d.date, cur);
  });
  const daily = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  // Hourly : somme position par position
  const hourly = new Array(24).fill(0).map((_, i) => (tt.hourly?.[i] || 0) + (yt.hourly?.[i] || 0));

  return {
    kpi: {
      totalPublished,
      successRate: total > 0 ? Math.round((sumStatuses('done') / total) * 100) : null,
      last24h: (tt.kpi.last24h || 0) + (yt.kpi.last24h || 0),
      channels: (tt.kpi.channels || 0) + (yt.kpi.channels || 0),
      inCooldown: (tt.kpi.inCooldown || 0) + (yt.kpi.inCooldown || 0),
      errors7d: (tt.kpi.errors7d || 0) + (yt.kpi.errors7d || 0),
    },
    daily,
    hourly,
    statusDist: {
      done: sumStatuses('done'),
      error: sumStatuses('error'),
      skipped: sumStatuses('skipped'),
      pending: sumStatuses('pending'),
      queued: sumStatuses('queued'),
    },
    topChannels: [
      ...(tt.topChannels || []).map(c => ({ ...c, platform: 'tiktok' })),
      ...(yt.topChannels || []).map(c => ({ ...c, platform: 'youtube' })),
    ].sort((a, b) => (b.done || 0) - (a.done || 0)).slice(0, 12),
    byCampaign: [
      ...(tt.byCampaign || []).map(c => ({ ...c, platform: 'tiktok' })),
      ...(yt.byCampaign || []).map(c => ({ ...c, platform: 'youtube' })),
    ].sort((a, b) => (b.total || 0) - (a.total || 0)).slice(0, 12),
    errorTypes: {
      uploadLimit: (tt.errorTypes?.uploadLimit || 0) + (yt.errorTypes?.uploadLimit || 0),
      captcha: (tt.errorTypes?.captcha || 0) + (yt.errorTypes?.captcha || 0),
      login: (tt.errorTypes?.login || 0) + (yt.errorTypes?.login || 0),
      other: (tt.errorTypes?.other || 0) + (yt.errorTypes?.other || 0),
    },
  };
}

module.exports = {
  logs,
  campaigns,
  accounts,
  overview,
  tiktokChartFallback,
  combineCharts,
  emptyChartShape,
  // Exposés pour usage spécifique côté server.js
  normalizeCampaign,
  normalizeAccount,
};
