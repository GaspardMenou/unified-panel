// Unified Panel — SPA vanilla, hash routing, polling. Pas de socket.io en v1.
//
// Architecture :
//   - state global + routing simple
//   - toggle plateforme global persisté en localStorage, mirroré sur chaque page
//   - polling 15s pour stats/campaigns/accounts (fond), 5s pour logs sur la
//     page Activité (active uniquement quand visible)
//   - les 2 backends sont consommés via le serveur unified (proxy + aggregates)

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const PLATFORM_LABELS = { tiktok: 'TikTok', youtube: 'YouTube' };
const PLATFORM_COLORS = { tiktok: 'var(--tt)', youtube: 'var(--yt)' };

// Traduction des statuts campagne pour affichage. La valeur technique reste
// en anglais côté backend / classes CSS (`status-running`).
const STATUS_LABELS = {
  draft:      'Brouillon',
  scheduled:  'Planifiée',
  running:    'En cours',
  paused:     'En pause',
  done:       'Terminée',
  archived:   'Archivée',
};
const statusLabel = (s) => STATUS_LABELS[s] || s;

// Couleur à utiliser pour un item donné. Si pas de plateforme : fallback accent
// vert mât (neutre, sémantique "all/total/ok").
const platformColor = (platform) => PLATFORM_COLORS[platform] || 'var(--accent)';

// ─── Empty states ───────────────────────────────────────────────────────────
// Format : `<li>` complet à injecter dans une liste vide. Les empty states
// éduquent : ils disent CE QUI s'affichera ici + pourquoi + comment agir.
//
// Convention : `kind` raconte la cause (backend, filter, never, …) → message
// différent. La fonction inspecte l'état global pour choisir.

function emptyStateHtml({ icon = '∅', title, hint, action }) {
  return `
    <li class="empty-state">
      <span class="empty-icon" aria-hidden="true">${escapeHtml(icon)}</span>
      <div class="empty-title">${escapeHtml(title)}</div>
      ${hint ? `<div class="empty-hint">${hint}</div>` : ''}
      ${action ? `<div class="empty-action">${action}</div>` : ''}
    </li>`;
}

function whyEmpty(scope) {
  // Diagnostic : la liste est vide parce que…
  const ttDown = state.status?.tiktok?.online === false;
  const ytDown = state.status?.youtube?.online === false;
  const bothDown = ttDown && ytDown;
  if (bothDown) return 'both-down';
  if (state.platform === 'tiktok'  && ttDown) return 'platform-down';
  if (state.platform === 'youtube' && ytDown) return 'platform-down';
  if (scope === 'campaigns' && state.campFilter !== 'all') return 'filter';
  if (scope === 'accounts'  && state.accFilter  !== 'all') return 'filter';
  if (scope === 'logs'      && (state.logFilter !== 'all' || state.logSearch)) return 'filter';
  return 'no-data';
}

function nativeUrlButton(label, platform, hash = '/campaigns') {
  const url = platformBackendUrl(platform);
  if (!url) return '';
  return `<a class="btn-ghost btn-sm" href="${url}/#${hash}" target="_blank" rel="noopener">${escapeHtml(label)} ↗</a>`;
}

// ─── localStorage safe — Safari privé throw sur setItem ────────────────────
const storage = {
  get(key, fallback = null) {
    try { return localStorage.getItem(key) ?? fallback; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); }
    catch { /* private mode / full → silencieux */ }
  },
};

const state = {
  route: 'overview',
  platform: storage.get('platform', 'all'),   // 'all' | 'tiktok' | 'youtube'
  status: { tiktok: null, youtube: null },
  overview: null,
  campaigns: [],
  campFilter: 'all',
  accounts: [],
  accFilter: 'all',
  logs: [],
  logFilter: 'all',
  logSearch: '',
  charts: null,
  pollingTimer: null,
  pollingDelay: 15000,
  pollingFailures: 0,
  logsPollingTimer: null,
  drawerCampaign: null,
  drawerLastFocus: null,   // élément à re-focus à la fermeture du drawer
  online: navigator.onLine !== false,
};

// ─── Routing ────────────────────────────────────────────────────────────────

const ROUTES = new Set(['overview', 'campaigns', 'accounts', 'activity', 'stats']);
const parseRoute = () => {
  const h = (location.hash || '').replace(/^#\/?/, '').split('/')[0] || 'overview';
  return ROUTES.has(h) ? h : 'overview';
};
function setRoute(route) {
  if (!ROUTES.has(route)) route = 'overview';
  state.route = route;
  $$('.route').forEach(s => s.classList.toggle('route-active', s.dataset.route === route));
  $$('.nav-item').forEach(a => a.classList.toggle('nav-active', a.dataset.route === route));
  const target = route === 'overview' ? '#/' : `#/${route}`;
  if (location.hash !== target) history.replaceState(null, '', target);
  onRouteEnter(route);
  window.scrollTo({ top: 0 });
}
function onRouteEnter(route) {
  // Logs polling actif uniquement sur Activity (sinon : économie réseau)
  if (route !== 'activity') stopLogsPolling();
  if (route === 'overview')   renderOverview();
  if (route === 'campaigns')  renderCampaigns();
  if (route === 'accounts')   renderAccounts();
  if (route === 'activity')   { renderActivity(); startLogsPolling(); }
  if (route === 'stats')      renderStats();
}
window.addEventListener('hashchange', () => setRoute(parseRoute()));

// ─── Toasts ─────────────────────────────────────────────────────────────────

const TOAST_ICONS = { success: '✓', error: '✕', warn: '⚠', info: 'i' };
function toast(level, title, message = '', duration = 3500) {
  const wrap = $('#toasts');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = `toast toast-${level}`;
  el.innerHTML = `
    <span class="toast-icon">${TOAST_ICONS[level] || '·'}</span>
    <div class="toast-body">
      <div class="toast-title"></div>
      ${message ? '<div class="toast-msg"></div>' : ''}
    </div>
    <button class="toast-close" aria-label="Fermer">×</button>`;
  el.querySelector('.toast-title').textContent = title;
  if (message) el.querySelector('.toast-msg').textContent = message;
  const close = () => { el.classList.add('exiting'); setTimeout(() => el.remove(), 220); };
  el.querySelector('.toast-close').addEventListener('click', close);
  wrap.appendChild(el);
  if (duration > 0) setTimeout(close, duration);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);

async function api(path, opts = {}) {
  const init = { headers: {}, ...opts };
  if (opts.body && !(opts.body instanceof FormData)) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const r = await fetch(path, init);
  if (!r.ok) {
    let msg = r.statusText;
    try { const j = await r.json(); msg = j.error || msg; } catch {}
    throw new Error(msg);
  }
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}

async function tryApi(path, opts = {}, { okMsg, errTitle = 'Erreur' } = {}) {
  try {
    const res = await api(path, opts);
    if (okMsg) toast('success', okMsg);
    return res;
  } catch (e) {
    toast('error', errTitle, e.message);
    throw e;
  }
}

function fmtRelative(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const sec = (Date.now() - d.getTime()) / 1000;
  if (sec < 5)    return 'à l\'instant';
  if (sec < 60)   return `il y a ${Math.floor(sec)} s`;
  if (sec < 120)  return 'il y a 1 min';
  if (sec < 3600) return `il y a ${Math.floor(sec / 60)} min`;
  if (sec < 7200) return 'il y a 1 h';
  if (sec < 86400) return `il y a ${Math.floor(sec / 3600)} h`;
  if (sec < 172800) return 'hier';
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
}

function fmtDateShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
}

function badgeHtml(platform) {
  if (!platform) return '';
  const label = PLATFORM_LABELS[platform] || platform;
  return `<span class="badge" data-platform="${platform}"><span class="badge-dot"></span>${escapeHtml(label)}</span>`;
}

function filterByPlatform(items) {
  if (state.platform === 'all') return items;
  return items.filter(it => it.platform === state.platform);
}

function platformBackendUrl(platform) {
  const info = state.status?.[platform];
  return info?.url || '';
}

// ─── Toggle plateforme global ───────────────────────────────────────────────

function buildPlatformToggles() {
  // Crée le toggle dans chaque emplacement marqué `data-toggle-mirror`,
  // en clonant le contenu du toggle principal.
  const main = $('#platform-toggle');
  if (!main) return;
  const html = main.innerHTML;
  $$('.platform-toggle[data-toggle-mirror]').forEach(el => {
    el.innerHTML = html;
  });
  // Attache les listeners sur TOUS les toggles (main + mirrors).
  $$('.platform-toggle').forEach(group => {
    group.querySelectorAll('button[data-platform]').forEach(btn => {
      btn.addEventListener('click', () => setPlatform(btn.dataset.platform));
    });
  });
  syncPlatformToggles();
}

function syncPlatformToggles() {
  $$('.platform-toggle').forEach(group => {
    group.querySelectorAll('button[data-platform]').forEach(btn => {
      const isActive = btn.dataset.platform === state.platform;
      btn.classList.toggle('active', isActive);
      // Le toggle est un radio group — annonce l'état aux screen readers
      if (btn.getAttribute('role') === 'radio') {
        btn.setAttribute('aria-checked', String(isActive));
      }
    });
  });
}

function setPlatform(p) {
  if (!['all', 'tiktok', 'youtube'].includes(p)) p = 'all';
  state.platform = p;
  storage.set('platform', p);
  document.body.dataset.activePlatform = p;
  syncPlatformToggles();
  // Listes filtrables (Campagnes, Comptes, Activité) : filtrage CSS via
  // body[data-active-platform] — évite un re-render innerHTML complet. Mais
  // Overview/Stats calculent des agrégats qui changent selon le toggle →
  // re-render JS obligatoire.
  if (state.route === 'overview' || state.route === 'stats') {
    onRouteEnter(state.route);
  } else {
    updateFilteredCounts();
  }
}

// Recompte les éléments visibles après application des filtres (toggle + status
// + recherche) pour mettre à jour les badges "(N)" sans toucher au DOM des listes.
function updateFilteredCounts() {
  if (state.route === 'campaigns') {
    const count = filterByPlatform(state.campaigns)
      .filter(c => state.campFilter === 'all' || c.status === state.campFilter).length;
    $('#camp-count').textContent = count ? `(${count})` : '';
  }
  if (state.route === 'accounts') {
    const count = filterByPlatform(state.accounts)
      .filter(a => state.accFilter === 'all'
        || (state.accFilter === 'cooldown' && a.cooldownActive)
        || (state.accFilter === 'needs-login' && a.needsLogin)).length;
    $('#acc-count').textContent = count ? `(${count})` : '';
  }
}

// ─── Statut backend (sidebar) ───────────────────────────────────────────────

async function refreshBackendStatus() {
  try {
    const s = await api('/api/platforms/status');
    state.status.tiktok = s.tiktok;
    state.status.youtube = s.youtube;
  } catch (e) {
    // si même /api/platforms/status échoue, on suppose unified DOWN — rien à faire
  }
  renderBackendStatus();
}

function renderBackendStatus() {
  const wrap = $('#backend-status');
  if (!wrap) return;
  ['tiktok', 'youtube'].forEach(p => {
    const el = wrap.querySelector(`.bs-item[data-platform="${p}"]`);
    if (!el) return;
    const online = state.status?.[p]?.online === true;
    el.classList.toggle('online', online);
    el.classList.toggle('offline', !online);
    el.title = online ? `${PLATFORM_LABELS[p]} OK` : `${PLATFORM_LABELS[p]} hors ligne`;
  });
  // Lien Studio Android : pointe vers le YouTube backend (seul à avoir cette
  // page). Mis à jour à chaque refresh de status pour absorber un changement
  // d'URL backend en runtime.
  const studio = $('#nav-studio');
  if (studio) {
    const ytUrl = state.status?.youtube?.url;
    if (ytUrl) {
      studio.href = `${ytUrl}/#/studio`;
      studio.classList.remove('nav-disabled');
    } else {
      studio.href = '#';
      studio.classList.add('nav-disabled');
      studio.title = 'YouTube backend hors ligne — Studio inaccessible';
    }
  }
}

// ─── Polling ────────────────────────────────────────────────────────────────

async function refreshAll() {
  // Trace succès/échec global : si TOUTES les promesses échouent, on backoff
  const results = await Promise.allSettled([
    api('/api/aggregate/overview'),
    api('/api/aggregate/campaigns'),
    api('/api/aggregate/accounts'),
  ]);
  const [ov, camps, accs] = results;
  if (ov.status === 'fulfilled')    state.overview = ov.value;
  if (camps.status === 'fulfilled') state.campaigns = camps.value;
  if (accs.status === 'fulfilled')  state.accounts  = accs.value;

  const allFailed = results.every(r => r.status === 'rejected');
  if (allFailed) {
    state.pollingFailures++;
    state.pollingDelay = Math.min(15000 * Math.pow(2, state.pollingFailures), 5 * 60 * 1000); // max 5min
  } else {
    state.pollingFailures = 0;
    state.pollingDelay = 15000;
  }
  updateNetBanner();
  // re-render seulement la page active (perf : pas de DOM thrash inutile)
  onRouteEnter(state.route);
}

// Polling adaptatif : pause si tab inactive ou navigator offline ; backoff
// exponentiel si les requêtes échouent en série (15s → 30s → 1min → … → 5min).
function scheduleNextPoll() {
  if (state.pollingTimer) clearTimeout(state.pollingTimer);
  if (document.hidden || !state.online) return;
  state.pollingTimer = setTimeout(async () => {
    await refreshBackendStatus();
    await refreshAll();
    scheduleNextPoll();
  }, state.pollingDelay);
}

function startPolling() {
  scheduleNextPoll();
}

async function refreshLogs() {
  try {
    const logs = await api('/api/aggregate/logs?limit=200');
    state.logs = logs;
    if (state.route === 'activity') renderActivity();
    if (state.route === 'overview') renderOverviewLogs();
  } catch {}
}

function startLogsPolling() {
  if (state.logsPollingTimer) clearInterval(state.logsPollingTimer);
  if (document.hidden || !state.online) return;
  refreshLogs();
  state.logsPollingTimer = setInterval(refreshLogs, 5000);
}

function stopLogsPolling() {
  if (state.logsPollingTimer) clearInterval(state.logsPollingTimer);
  state.logsPollingTimer = null;
}

// ─── Page OVERVIEW ──────────────────────────────────────────────────────────

function renderOverview() {
  const ov = state.overview;
  const platform = state.platform;

  // Sélectionne les stats à afficher selon le toggle.
  let s;
  if (!ov) {
    s = { campaigns: '—', accounts: '—', done: '—', pending: '—', queued: '—', errors: '—', successRate: '—' };
  } else if (platform === 'all') {
    s = ov.totals;
  } else {
    const p = ov[platform];
    if (p) {
      const total = p.total || 0;
      s = {
        campaigns: p.campaigns,
        accounts: p.accounts,
        done: p.done,
        pending: p.pending,
        queued: p.queued,
        errors: p.errors,
        successRate: total > 0 ? Math.round((p.done / total) * 100) : null,
      };
    } else {
      s = { campaigns: 0, accounts: 0, done: 0, pending: 0, queued: 0, errors: 0, successRate: null };
    }
  }
  $('#s-done').textContent       = s.done ?? '—';
  $('#s-success').textContent    = s.successRate == null ? '—' : `${s.successRate}%`;
  $('#s-campaigns').textContent  = s.campaigns ?? '—';
  $('#s-accounts').textContent   = s.accounts ?? '—';
  $('#s-pending').textContent    = s.pending ?? '—';
  $('#s-queued').textContent     = s.queued ?? '—';
  $('#s-errors').textContent     = s.errors ?? '—';

  $('#s-done-foot').textContent =
    platform === 'all' ? 'cumul TikTok + YouTube' : `${PLATFORM_LABELS[platform]} seul`;

  renderOverviewSplit();
  renderOverviewLogs();
}

function renderOverviewSplit() {
  const el = $('#overview-split');
  if (!el) return;
  const ov = state.overview;
  if (!ov || (!ov.tiktok && !ov.youtube)) {
    el.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon" aria-hidden="true">⚠</span>
        <div class="empty-title">Aucune donnée disponible</div>
        <div class="empty-hint">Les 2 backends sont injoignables ou n'ont jamais publié. Le polling reprend automatiquement quand un backend répond.</div>
      </div>`;
    return;
  }
  // Barres horizontales par plateforme : publiés / en attente / erreurs.
  const items = [];
  ['tiktok', 'youtube'].forEach(p => {
    const s = ov[p];
    if (!s) {
      items.push({ name: PLATFORM_LABELS[p], done: 0, pending: 0, errors: 0, platform: p, offline: true });
    } else {
      items.push({
        name: PLATFORM_LABELS[p],
        done: s.done || 0,
        pending: s.pending || 0,
        errors: s.errors || 0,
        platform: p,
      });
    }
  });
  const max = Math.max(1, ...items.map(i => i.done + i.pending + i.errors));
  el.innerHTML = items.map(i => {
    const total = i.done + i.pending + i.errors;
    const pct = (v) => total > 0 ? (v / max * 100) : 0;
    // Couleur "publiés" = couleur de la plateforme → la ligne raconte la
    // plateforme d'un coup d'œil. Pending = info (neutre), errors = bad.
    const doneColor = platformColor(i.platform);
    return `
      <div class="hbar" style="${i.offline ? 'opacity:0.4' : ''}">
        <span class="hbar-label">${badgeHtml(i.platform)}</span>
        <span class="hbar-track" style="display:flex; overflow:hidden">
          <span class="hbar-fill" style="width:${pct(i.done).toFixed(1)}%; background:${doneColor}" title="${i.done} publiés"></span>
          <span class="hbar-fill" style="width:${pct(i.pending).toFixed(1)}%; background:var(--info)" title="${i.pending} en attente"></span>
          <span class="hbar-fill" style="width:${pct(i.errors).toFixed(1)}%; background:var(--bad)" title="${i.errors} erreurs"></span>
        </span>
        <span class="hbar-val">${i.offline ? '<span class="muted">offline</span>' : `${i.done} <span class="muted">/ ${i.errors} err</span>`}</span>
      </div>
    `;
  }).join('');
}

function renderOverviewLogs() {
  const el = $('#logs-overview');
  if (!el) return;
  const items = filterByPlatform(state.logs).slice(0, 8);
  if (!items.length) {
    const ttDown = state.status?.tiktok?.online === false;
    const ytDown = state.status?.youtube?.online === false;
    const msg = (ttDown && ytDown)
      ? 'Backends injoignables — pas de logs récents.'
      : 'Pas encore d\'activité — les événements apparaîtront ici dès la première publication.';
    el.innerHTML = `<li class="muted" style="padding:14px">${escapeHtml(msg)}</li>`;
    return;
  }
  el.innerHTML = items.map(renderLogItem).join('');
}

// ─── Page CAMPAGNES ─────────────────────────────────────────────────────────

function renderCampaigns() {
  let items = filterByPlatform(state.campaigns);
  if (state.campFilter !== 'all') {
    items = items.filter(c => c.status === state.campFilter);
  }
  $('#camp-count').textContent = items.length ? `(${items.length})` : '';

  const list = $('#campaigns-list');
  if (!items.length) {
    const why = whyEmpty('campaigns');
    const platformLabel = state.platform === 'all' ? '' : PLATFORM_LABELS[state.platform];
    list.innerHTML = why === 'both-down' ? emptyStateHtml({
      icon: '⚠',
      title: 'Les deux backends sont injoignables',
      hint: 'TikTok (:3010) et YouTube (:3000) ne répondent pas. Vérifie que les services tmux tournent toujours.',
      action: `<button type="button" class="btn-ghost btn-sm" onclick="location.reload()">Réessayer</button>`,
    }) : why === 'platform-down' ? emptyStateHtml({
      icon: '⚠',
      title: `Backend ${platformLabel} hors ligne`,
      hint: `Le panel ${platformLabel} ne répond pas. Bascule sur "Tous" pour voir l'autre plateforme en attendant.`,
      action: `<button type="button" class="btn-ghost btn-sm" data-platform-fallback="all">Voir toutes les plateformes</button>`,
    }) : why === 'filter' ? emptyStateHtml({
      icon: '⊘',
      title: `Aucune campagne ${escapeHtml(state.campFilter)}${platformLabel ? ` sur ${platformLabel}` : ''}`,
      hint: 'Essaie un autre filtre ou la vue "Toutes".',
      action: `<button type="button" class="btn-ghost btn-sm" data-camp-filter-reset>Voir toutes les campagnes</button>`,
    }) : emptyStateHtml({
      icon: '∅',
      title: 'Aucune campagne pour le moment',
      hint: 'Crée ta première campagne depuis l\'UI native — l\'upload des clips se fait là-bas. Elle apparaîtra ici dans les 15s qui suivent.',
      action: [
        nativeUrlButton('Créer sur TikTok', 'tiktok'),
        nativeUrlButton('Créer sur YouTube', 'youtube'),
      ].filter(Boolean).join(' '),
    });
    // Wire les actions de l'empty state
    list.querySelector('[data-platform-fallback]')?.addEventListener('click', () => setPlatform('all'));
    list.querySelector('[data-camp-filter-reset]')?.addEventListener('click', () => {
      state.campFilter = 'all';
      $('#camp-status-filter').querySelectorAll('button').forEach(b =>
        b.classList.toggle('seg-active', b.dataset.campFilter === 'all'));
      renderCampaigns();
    });
    return;
  }
  list.innerHTML = items.map(c => {
    const pct = c.stats.total ? (c.stats.done / c.stats.total * 100) : 0;
    const rate = c.stats.successRate;
    const rateClass = rate == null ? 'tone-mute' : rate >= 80 ? 'tone-good' : rate >= 50 ? 'tone-warn' : 'tone-bad';
    const label = `${PLATFORM_LABELS[c.platform]} · ${c.name} · ${statusLabel(c.status)}, ${c.stats.done} sur ${c.stats.total} publiés`;
    return `
      <li class="campaign" role="button" tabindex="0" aria-label="${escapeHtml(label)}" data-id="${escapeHtml(c.id)}" data-platform="${c.platform}">
        <header class="camp-head">
          ${badgeHtml(c.platform)}
          <h3 class="camp-name">${escapeHtml(c.name)}</h3>
          <span class="status status-${escapeHtml(c.status)}">${escapeHtml(statusLabel(c.status))}</span>
        </header>
        <div class="camp-meta">
          <span>${c.stats.done}/${c.stats.total} publiés</span>
          <span class="${rateClass}">${rate == null ? '—' : rate + '%'}</span>
          ${c.stats.errors ? `<span class="tone-bad">${c.stats.errors} err</span>` : ''}
          ${c.stats.pending ? `<span class="muted">${c.stats.pending} en attente</span>` : ''}
        </div>
        <div class="bar"><span style="width:${pct.toFixed(1)}%"></span></div>
      </li>
    `;
  }).join('');

  list.querySelectorAll('li.campaign').forEach(li => {
    const open = () => openDrawer(li.dataset.id, li.dataset.platform);
    li.addEventListener('click', open);
    // Enter/Space → activer (pattern role="button" + tabindex="0")
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  });
}

// ─── Drawer détail campagne ─────────────────────────────────────────────────

// ─── Focus trap helper ──────────────────────────────────────────────────────
// Boucle Tab/Shift+Tab à l'intérieur d'un container. Pattern dialog/modal.
function trapFocus(container, e) {
  if (e.key !== 'Tab') return;
  const focusables = container.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  if (!focusables.length) { e.preventDefault(); return; }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault(); first.focus();
  }
}

async function openDrawer(campaignId, platform) {
  // Sauvegarde le focus courant pour le restaurer à la fermeture
  state.drawerLastFocus = document.activeElement;
  state.drawerCampaign = { id: campaignId, platform };

  const drawer = $('#drawer');
  const backdrop = $('#drawer-backdrop');
  backdrop.hidden = false;
  backdrop.classList.add('open');
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  document.body.classList.add('drawer-open');

  // Affichage immédiat depuis l'état liste, détail chargé en parallèle.
  const camp = state.campaigns.find(c => c.id === campaignId && c.platform === platform);
  const badge = $('#drawer-badge');
  badge.dataset.platform = platform;
  badge.querySelector('[data-role="label"]').textContent = PLATFORM_LABELS[platform];
  $('#drawer-title').textContent = camp?.name || 'Campagne';
  $('#drawer-body').innerHTML = '<div class="muted" role="status">Chargement…</div>';

  // Focus le bouton de fermeture en premier (point d'entrée prévisible)
  // — défer pour laisser le navigateur appliquer la transition CSS.
  setTimeout(() => $('#drawer-close').focus(), 50);

  try {
    const detail = await api(`/api/${platform}/campaigns/${campaignId}`);
    // Garde-fou : si le user a refermé pendant le chargement, on ne rend rien.
    if (state.drawerCampaign?.id !== campaignId) return;
    renderDrawerBody(detail, platform);
  } catch (e) {
    if (state.drawerCampaign?.id !== campaignId) return;
    $('#drawer-body').innerHTML = `<div class="empty-state empty-state-warn" role="alert"><span class="empty-icon" aria-hidden="true">⚠</span>${escapeHtml(e.message)}</div>`;
  }
}

function closeDrawer() {
  if (!state.drawerCampaign) return; // déjà fermé
  state.drawerCampaign = null;
  const drawer = $('#drawer');
  const backdrop = $('#drawer-backdrop');
  drawer.classList.remove('open');
  backdrop.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('drawer-open');
  // Hide backdrop après la transition (380ms) pour ne pas bloquer les clics
  setTimeout(() => { if (!state.drawerCampaign) backdrop.hidden = true; }, 400);

  // Restaure le focus sur l'élément qui a ouvert le drawer
  const last = state.drawerLastFocus;
  state.drawerLastFocus = null;
  if (last && typeof last.focus === 'function' && document.contains(last)) {
    last.focus();
  }
}

function renderDrawerBody(c, platform) {
  const stats = c.scheduleStats || {};
  const total = stats.total || (c.schedule?.length ?? 0);
  const done = stats.done || 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const clips = c.clips || [];

  // Status switcher — TikTok + YouTube partagent les mêmes statuts principaux.
  // La valeur reste technique en anglais (cohérent avec backend) mais on
  // affiche le libellé traduit.
  const STATUSES = ['draft', 'scheduled', 'running', 'paused', 'done'];
  const statusBtns = STATUSES.map(s =>
    `<button type="button" class="seg-btn ${c.status === s ? 'seg-active' : ''}" data-status="${s}" aria-label="Passer en ${statusLabel(s)}">${statusLabel(s)}</button>`
  ).join('');

  const upcoming = (c.schedule || [])
    .filter(p => p.status === 'pending')
    .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)))
    .slice(0, 5);

  const recentErrors = (c.schedule || [])
    .filter(p => p.status === 'error')
    .slice(0, 5);

  $('#drawer-body').innerHTML = `
    <div class="stats" style="grid-template-columns:repeat(auto-fit,minmax(110px,1fr))">
      <div class="stat"><span class="stat-label">Publiés</span><span class="stat-value tone-good">${done}</span></div>
      <div class="stat"><span class="stat-label">Total</span><span class="stat-value">${total}</span></div>
      <div class="stat"><span class="stat-label">Erreurs</span><span class="stat-value tone-bad">${stats.errors || 0}</span></div>
      <div class="stat"><span class="stat-label">En attente</span><span class="stat-value">${stats.pending || 0}</span></div>
    </div>
    <div class="bar"><span style="width:${pct}%"></span></div>

    <section>
      <header class="card-head" style="padding:0; margin-bottom:8px"><h2>Statut</h2></header>
      <div class="seg" id="drawer-status-seg">${statusBtns}</div>
    </section>

    <section>
      <header class="card-head" style="padding:0; margin-bottom:8px"><h2>Actions</h2></header>
      <div class="drawer-actions">
        <button type="button" id="drawer-pushall" class="btn-ghost">Publier la file d'attente</button>
        <button type="button" id="drawer-retry"   class="btn-ghost">Réessayer les erreurs</button>
        <button type="button" id="drawer-open-native">Ouvrir le panel ↗</button>
      </div>
    </section>

    ${upcoming.length ? `
      <section>
        <header class="card-head" style="padding:0; margin-bottom:8px"><h2>Prochaines publications</h2></header>
        <ul class="list list-dense">
          ${upcoming.map(p => `
            <li>
              <span class="muted">${escapeHtml(fmtDateShort(p.scheduledAt))}</span>
              · ${escapeHtml(p.accountUsername || p.accountId || '?')}
              <span class="muted">— ${escapeHtml(p.clipName || '')}</span>
            </li>`).join('')}
        </ul>
      </section>` : ''}

    ${recentErrors.length ? `
      <section>
        <header class="card-head" style="padding:0; margin-bottom:8px"><h2>Erreurs récentes</h2></header>
        <ul class="list list-dense">
          ${recentErrors.map(p => `
            <li>
              <span class="muted">${escapeHtml(fmtDateShort(p.scheduledAt))}</span>
              · ${escapeHtml(p.accountUsername || '?')}
              <span class="tone-bad">${escapeHtml((p.error || '').slice(0, 80))}</span>
            </li>`).join('')}
        </ul>
      </section>` : ''}

    ${clips.length ? `
      <section>
        <header class="card-head" style="padding:0; margin-bottom:8px">
          <h2>Clips <span class="muted">${clips.length}</span></h2>
        </header>
        <ul class="list list-dense">
          ${clips.slice(0, 10).map(cl => `<li>${escapeHtml(cl.name || cl.path)}</li>`).join('')}
          ${clips.length > 10 ? `<li class="muted">+ ${clips.length - 10} autres</li>` : ''}
        </ul>
      </section>` : ''}
  `;

  // Wire-up status segment
  $('#drawer-status-seg').querySelectorAll('button[data-status]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const newStatus = btn.dataset.status;
      if (newStatus === c.status) return;
      await tryApi(`/api/${platform}/campaigns/${c.id}/status`,
        { method: 'PATCH', body: { status: newStatus } },
        { okMsg: `Campagne passée en « ${statusLabel(newStatus)} »`, errTitle: 'Échec du changement de statut' });
      refreshAll();
      openDrawer(c.id, platform); // refresh drawer
    });
  });

  $('#drawer-pushall').addEventListener('click', async () => {
    await tryApi(`/api/${platform}/campaigns/${c.id}/pushall`, { method: 'POST' },
      { okMsg: 'Publications lancées', errTitle: 'Échec de la publication en file' });
    setTimeout(() => openDrawer(c.id, platform), 1000);
  });

  $('#drawer-retry').addEventListener('click', async () => {
    await tryApi(`/api/${platform}/campaigns/${c.id}/retry-errors`, { method: 'POST' },
      { okMsg: 'Erreurs replanifiées', errTitle: 'Échec du retry' });
    setTimeout(() => openDrawer(c.id, platform), 1000);
  });

  $('#drawer-open-native').addEventListener('click', () => {
    const url = platformBackendUrl(platform);
    if (!url) return toast('warn', `Adresse ${PLATFORM_LABELS[platform]} inconnue`,
      'Le statut du backend n\'a pas encore été récupéré.');
    window.open(`${url}/#/campaigns`, '_blank');
  });
}

// ─── Page COMPTES ───────────────────────────────────────────────────────────

function renderAccounts() {
  let items = filterByPlatform(state.accounts);
  if (state.accFilter === 'cooldown')    items = items.filter(a => a.cooldownActive);
  if (state.accFilter === 'needs-login') items = items.filter(a => a.needsLogin);

  $('#acc-count').textContent = items.length ? `(${items.length})` : '';

  const list = $('#accounts-list');
  if (!items.length) {
    const why = whyEmpty('accounts');
    const platformLabel = state.platform === 'all' ? '' : PLATFORM_LABELS[state.platform];
    list.innerHTML = why === 'both-down' || why === 'platform-down' ? emptyStateHtml({
      icon: '⚠',
      title: why === 'both-down' ? 'Backends injoignables' : `Backend ${platformLabel} hors ligne`,
      hint: 'Les comptes sont stockés côté backend. Vérifie les services tmux.',
    }) : state.accFilter === 'cooldown' ? emptyStateHtml({
      icon: '✓',
      title: 'Aucun compte en cooldown',
      hint: 'Tout est OK — pas de shadowban, pas de captcha, pas de upload-limit en cours.',
    }) : state.accFilter === 'needs-login' ? emptyStateHtml({
      icon: '✓',
      title: 'Tous les comptes sont connectés',
      hint: 'Aucun login à refaire pour le moment.',
    }) : emptyStateHtml({
      icon: '∅',
      title: 'Aucun compte enregistré',
      hint: 'Ajoute tes comptes TikTok ou tes chaînes YouTube depuis l\'UI native de chaque plateforme.',
      action: [
        nativeUrlButton('Comptes TikTok', 'tiktok', '/accounts'),
        nativeUrlButton('Chaînes YouTube', 'youtube', '/accounts'),
      ].filter(Boolean).join(' '),
    });
    return;
  }

  list.innerHTML = items.map(a => {
    const flags = [];
    if (a.cooldownActive) flags.push(`<span class="tone-warn">cooldown jusqu'au ${escapeHtml(fmtDateShort(a.cooldownUntil))}</span>`);
    if (a.needsLogin)     flags.push('<span class="tone-bad">login requis</span>');
    if (a.captchaPending) flags.push('<span class="tone-bad">captcha à résoudre</span>');
    if (a.loggedIn === true) flags.push('<span class="tone-good">connecté</span>');

    const meta = a.platform === 'youtube'
      ? `<span class="muted">${escapeHtml(a.meta.handle || a.meta.channelName || '')}</span>`
      : `<span class="muted">${escapeHtml(a.meta.username || '')}</span>`;

    const liftLabel = `Lever le cooldown de ${a.label}`;
    const openLabel = `Ouvrir ${a.label} dans l'UI native ${PLATFORM_LABELS[a.platform]}`;

    return `
      <li class="list-item" data-id="${escapeHtml(a.id)}" data-platform="${a.platform}">
        ${badgeHtml(a.platform)}
        <div class="grow">
          <div><strong>${escapeHtml(a.label)}</strong> ${meta}</div>
          <div class="li-meta-row">${flags.join(' · ') || '<span class="muted">—</span>'}</div>
        </div>
        <div class="row row-tight">
          ${a.cooldownActive ? `<button type="button" class="btn-ghost btn-sm" data-action="lift-cooldown" aria-label="${escapeHtml(liftLabel)}">Lever cooldown</button>` : ''}
          <button type="button" class="btn-ghost btn-sm" data-action="open-native" aria-label="${escapeHtml(openLabel)}" title="Ouvrir l'UI native">↗</button>
        </div>
      </li>
    `;
  }).join('');

  list.querySelectorAll('li.list-item').forEach(li => {
    li.querySelector('[data-action="lift-cooldown"]')?.addEventListener('click', async () => {
      await tryApi(`/api/${li.dataset.platform}/accounts/${li.dataset.id}/cooldown`, { method: 'DELETE' },
        { okMsg: 'Cooldown levé · le compte peut publier à nouveau', errTitle: 'Impossible de lever le cooldown' });
      refreshAll();
    });
    li.querySelector('[data-action="open-native"]')?.addEventListener('click', () => {
      const url = platformBackendUrl(li.dataset.platform);
      if (!url) return toast('warn', 'URL plateforme inconnue');
      window.open(`${url}/#/accounts`, '_blank');
    });
  });
}

// ─── Page ACTIVITÉ ──────────────────────────────────────────────────────────

function renderActivity() {
  let items = filterByPlatform(state.logs);
  if (state.logFilter !== 'all') items = items.filter(l => l.type === state.logFilter);
  if (state.logSearch) {
    const q = state.logSearch.toLowerCase();
    items = items.filter(l => (l.message || '').toLowerCase().includes(q));
  }
  const el = $('#logs');
  if (!items.length) {
    const why = whyEmpty('logs');
    el.innerHTML = why === 'both-down' ? emptyStateHtml({
      icon: '⚠',
      title: 'Backends injoignables',
      hint: 'Les logs viennent des 2 backends. Vérifie les services tmux et rafraîchis dans 30 secondes.',
    }) : why === 'filter' ? emptyStateHtml({
      icon: '⊘',
      title: 'Aucun événement ne correspond aux filtres',
      hint: state.logSearch ? `Aucun log ne contient « ${escapeHtml(state.logSearch)} ».` : 'Essaie un autre type ou bascule sur "Tous".',
      action: '<button type="button" class="btn-ghost btn-sm" data-logs-reset>Effacer les filtres</button>',
    }) : emptyStateHtml({
      icon: '·',
      title: 'Pas encore d\'activité',
      hint: 'Les événements de publication, erreurs et changements de statut apparaîtront ici en temps réel (rafraîchissement toutes les 5 s).',
    });
    el.querySelector('[data-logs-reset]')?.addEventListener('click', () => {
      state.logFilter = 'all';
      state.logSearch = '';
      $('#log-type-filter').querySelectorAll('button').forEach(b =>
        b.classList.toggle('seg-active', b.dataset.logFilter === 'all'));
      $('#logs-search').value = '';
      renderActivity();
    });
    return;
  }
  el.innerHTML = items.slice(0, 200).map(renderLogItem).join('');
}

function renderLogItem(l) {
  // data-platform sur le <li> permet le filtrage CSS via body[data-active-platform]
  return `
    <li class="log log-${escapeHtml(l.type || 'info')}" data-platform="${escapeHtml(l.platform || '')}">
      <span class="log-time">${escapeHtml(fmtRelative(l.timestamp))}</span>
      ${badgeHtml(l.platform)}
      <span class="log-msg">${escapeHtml(l.message || '')}</span>
    </li>`;
}

// ─── Page STATS — graphes SVG portés du YouTube panel ───────────────────────

function chartCols(el, cols) {
  const W = 640, H = 150;
  const max = Math.max(1, ...cols.map(c => c.parts.reduce((s, p) => s + p.value, 0)));
  const bw = W / Math.max(1, cols.length);
  let svg = '';
  cols.forEach((c, i) => {
    const x = i * bw + bw * 0.12;
    const w = bw * 0.76;
    let y = H;
    for (const p of c.parts) {
      if (!p.value) continue;
      const h = p.value / max * (H - 2);
      y -= h;
      svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${p.color}" rx="1"><title>${escapeHtml(c.title)}</title></rect>`;
    }
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart-svg chart-bars">${svg}</svg>`;
}

function chartDonut(el, segments) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const R = 42, C = 2 * Math.PI * R;
  let off = 0;
  const rings = segments.filter(s => s.value > 0).map(s => {
    const len = s.value / total * C;
    const ring = `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${s.color}" stroke-width="15"
      stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"
      transform="rotate(-90 60 60)" />`;
    off += len;
    return ring;
  }).join('');
  const legend = segments.map(s =>
    `<span class="lg"><span class="lg-dot" style="background:${s.color}"></span>${escapeHtml(s.label)} <strong>${s.value}</strong></span>`
  ).join('');
  el.innerHTML = `<svg viewBox="0 0 120 120" class="chart-svg chart-donut">${rings}</svg>`
    + `<div class="chart-legend">${legend}</div>`;
}

function chartHBars(el, items) {
  const max = Math.max(1, ...items.map(i => i.value));
  el.innerHTML = items.map(i => `
    <div class="hbar">
      <span class="hbar-label" title="${escapeHtml(i.label)}">${i.platform ? badgeHtml(i.platform) : ''}${escapeHtml(i.label)}</span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${(i.value / max * 100).toFixed(1)}%${i.color ? `;background:${i.color}` : ''}"></span></span>
      <span class="hbar-val">${i.value}${i.sub ? ` <span class="muted">${escapeHtml(i.sub)}</span>` : ''}</span>
    </div>`).join('') || '<span class="muted">Aucune donnée.</span>';
}

function chartProgress(el, items) {
  el.innerHTML = items.map(i => {
    const pct = i.total ? i.done / i.total * 100 : 0;
    return `<div class="hbar">
      <span class="hbar-label" title="${escapeHtml(i.name)}">${i.platform ? badgeHtml(i.platform) : ''}${escapeHtml(i.name)}</span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${pct.toFixed(1)}%${i.color ? `;background:${i.color}` : ''}"></span></span>
      <span class="hbar-val">${i.done}/${i.total}</span>
    </div>`;
  }).join('') || '<span class="muted">Aucune campagne.</span>';
}

async function renderStats() {
  let d;
  try { d = await api('/api/aggregate/charts'); }
  catch (e) { toast('error', 'Stats indisponibles', e.message); return; }
  state.charts = d;

  // Sélection selon le toggle plateforme
  const view =
    state.platform === 'tiktok'  ? d.tiktok :
    state.platform === 'youtube' ? d.youtube :
    d.combined;

  const k = view.kpi;
  const card = (label, value, tone, foot) =>
    `<div class="stat${foot ? ' stat-feature' : ''}">
      <span class="stat-label">${label}</span>
      <span class="stat-value${tone ? ' ' + tone : ''}">${value}</span>
      ${foot ? `<span class="stat-foot">${foot}</span>` : ''}
    </div>`;

  $('#stats-kpi').innerHTML =
    card('Publiés', k.totalPublished ?? '—', 'tone-good', state.platform === 'all' ? 'TT + YT' : PLATFORM_LABELS[state.platform]) +
    card('Taux de succès', k.successRate == null ? '—' : k.successRate + '%',
         k.successRate == null ? 'tone-mute' : k.successRate >= 80 ? 'tone-good' : k.successRate >= 50 ? 'tone-warn' : 'tone-bad') +
    card('24 h', k.last24h ?? '—') +
    card('Comptes', k.channels ?? 0) +
    card('En cooldown', k.inCooldown ?? 0, k.inCooldown ? 'tone-warn' : 'tone-mute');

  if (view.daily && view.daily.length) {
    chartCols($('#chart-daily'), view.daily.map(x => ({
      parts: [
        { value: x.done, color: 'var(--accent)' },
        { value: x.error, color: 'var(--bad)' },
        { value: x.skipped, color: 'var(--text-4)' },
      ],
      title: `${x.date} — ${x.done} publié(s)${x.error ? `, ${x.error} err` : ''}`,
    })));
  } else {
    $('#chart-daily').innerHTML = '<div class="empty-state"><span class="empty-icon">—</span>Pas de série temporelle disponible.</div>';
  }

  chartDonut($('#chart-status'), [
    { label: 'Publié', value: view.statusDist.done, color: 'var(--accent)' },
    { label: 'Erreur', value: view.statusDist.error, color: 'var(--bad)' },
    { label: 'Skip', value: view.statusDist.skipped, color: 'var(--text-4)' },
    { label: 'En attente', value: view.statusDist.pending, color: 'var(--info)' },
    { label: 'En cours', value: view.statusDist.queued, color: 'var(--warn)' },
  ]);

  if (view.hourly && view.hourly.some(v => v > 0)) {
    chartCols($('#chart-hourly'), view.hourly.map((n, h) => ({
      parts: [{ value: n, color: 'var(--accent)' }],
      title: `${h} h — ${n} publication(s)`,
    })));
  } else {
    $('#chart-hourly').innerHTML = '<div class="empty-state"><span class="empty-icon">—</span>Pas de données horaires.</div>';
  }

  chartHBars($('#chart-channels'), (view.topChannels || []).map(c => ({
    label: c.name, value: c.done, sub: c.errors ? `· ${c.errors} err` : '',
    platform: c.platform,
    color: platformColor(c.platform),
  })));

  chartProgress($('#chart-campaigns'), (view.byCampaign || []).map(c => ({
    name: c.name, done: c.done, total: c.total,
    platform: c.platform,
    color: platformColor(c.platform),
  })));

  chartDonut($('#chart-errors'), [
    { label: 'Upload-limit', value: view.errorTypes.uploadLimit, color: 'var(--bad)' },
    { label: 'Captcha', value: view.errorTypes.captcha, color: 'var(--warn)' },
    { label: 'Login', value: view.errorTypes.login, color: 'var(--info)' },
    { label: 'Autre', value: view.errorTypes.other, color: 'var(--text-4)' },
  ]);
}

// ─── Wiring filtres + actions globales ──────────────────────────────────────

function wireFilters() {
  // Campagnes — status
  $('#camp-status-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-camp-filter]');
    if (!btn) return;
    state.campFilter = btn.dataset.campFilter;
    $('#camp-status-filter').querySelectorAll('button').forEach(b =>
      b.classList.toggle('seg-active', b === btn));
    renderCampaigns();
  });

  // Comptes — état
  $('#acc-state-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-acc-filter]');
    if (!btn) return;
    state.accFilter = btn.dataset.accFilter;
    $('#acc-state-filter').querySelectorAll('button').forEach(b =>
      b.classList.toggle('seg-active', b === btn));
    renderAccounts();
  });

  // Logs — type
  $('#log-type-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-log-filter]');
    if (!btn) return;
    state.logFilter = btn.dataset.logFilter;
    $('#log-type-filter').querySelectorAll('button').forEach(b =>
      b.classList.toggle('seg-active', b === btn));
    renderActivity();
  });

  // Logs — search
  $('#logs-search').addEventListener('input', (e) => {
    state.logSearch = e.target.value.trim();
    renderActivity();
  });

  // Drawer close
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-backdrop').addEventListener('click', closeDrawer);
  window.addEventListener('keydown', (e) => {
    if (!state.drawerCampaign) return;
    if (e.key === 'Escape') { closeDrawer(); return; }
    // Focus trap : boucle Tab/Shift+Tab à l'intérieur du drawer
    trapFocus($('#drawer'), e);
  });

  // Stats refresh manuel
  $('#stats-refresh').addEventListener('click', renderStats);
}

// ─── Résilience : visibility, online/offline, banner net ────────────────────

function updateNetBanner() {
  const banner = $('#net-banner');
  if (!banner) return;
  if (!state.online) {
    banner.hidden = false;
    banner.dataset.level = 'offline';
    banner.innerHTML = '<strong>Hors-ligne</strong> · Le navigateur n\'a plus de réseau. Reprise auto à la reconnexion.';
    return;
  }
  // Si les 2 backends répondent OK : pas de banner
  const ttDown = state.status?.tiktok?.online === false;
  const ytDown = state.status?.youtube?.online === false;
  if (state.pollingFailures >= 2 || (ttDown && ytDown)) {
    banner.hidden = false;
    banner.dataset.level = 'degraded';
    banner.innerHTML = `<strong>Backends injoignables</strong> · ` +
      `Vérifie les services tmux sur le Mac mini (TikTok :3010, YouTube :3000). ` +
      `Nouvel essai dans ${Math.round(state.pollingDelay / 1000)}s.`;
    return;
  }
  if (ttDown || ytDown) {
    banner.hidden = false;
    banner.dataset.level = 'degraded';
    const down = ttDown ? 'TikTok' : 'YouTube';
    banner.innerHTML = `<strong>${down} hors ligne</strong> · ` +
      `L'autre plateforme reste consultable. Vérifie le service tmux <code>${ttDown ? 'tp-tiktok-panel' : 'yp-youtube-panel'}</code>.`;
    return;
  }
  banner.hidden = true;
}

// ─── First-run hint ─────────────────────────────────────────────────────────
// Au tout premier lancement (pas de localStorage), un toast explique le
// concept clé : toggle plateforme global. Marqué comme vu pour ne plus
// réapparaître. Dismissable.

function maybeShowFirstRunHint() {
  if (storage.get('seen-first-run') === '1') return;
  setTimeout(() => {
    toast('info',
      'Premier lancement',
      'Le toggle « Tous · TikTok · YouTube » en haut de chaque page filtre les données des deux backends. Les actions (push, retry, lift cooldown) sont relayées directement au panel concerné.',
      9000);
    storage.set('seen-first-run', '1');
  }, 800);
}

function wireResilience() {
  // Pause polling quand l'onglet n'est pas visible — économie batterie + backend
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (state.pollingTimer) clearTimeout(state.pollingTimer);
      stopLogsPolling();
    } else {
      // Au retour : un refresh immédiat puis on relance les cycles
      refreshBackendStatus();
      refreshAll();
      scheduleNextPoll();
      if (state.route === 'activity') startLogsPolling();
    }
  });

  // Network online/offline — sans réseau on coupe le polling proprement
  window.addEventListener('online', () => {
    state.online = true;
    state.pollingFailures = 0;
    state.pollingDelay = 15000;
    updateNetBanner();
    refreshBackendStatus();
    refreshAll();
    scheduleNextPoll();
    if (state.route === 'activity') startLogsPolling();
  });
  window.addEventListener('offline', () => {
    state.online = false;
    updateNetBanner();
    if (state.pollingTimer) clearTimeout(state.pollingTimer);
    stopLogsPolling();
  });
}

// ─── Boot ───────────────────────────────────────────────────────────────────

(async function boot() {
  // Initialise l'attribut de filtrage CSS dès le boot (avant le 1er render)
  document.body.dataset.activePlatform = state.platform;
  buildPlatformToggles();
  wireFilters();
  wireResilience();
  updateNetBanner();

  // Charge initial : status + données agrégées en parallèle.
  await Promise.all([refreshBackendStatus(), refreshAll(), refreshLogs()]);
  updateNetBanner();

  setRoute(parseRoute());
  startPolling();
  maybeShowFirstRunHint();
})();
