# CLAUDE.md — mémoire technique Unified Panel

Doc destinée aux sessions Claude Code (pas aux humains finaux). Sec, pas de marketing.

---

## Rôle du projet

Dashboard global qui agrège les 2 panels `tiktok-panel/` et `youtube-panel/` en une **seule SPA**. Les 2 backends restent indépendants (ports, DB, workers, uploads) ; ce projet est une couche de présentation + agrégation.

- **Pas de DB locale** — toute donnée vient des 2 backends.
- **Pas de worker** — aucune logique de publication ici.
- **Source de vérité** : les 2 backends (`/api/*`).

---

## Layout

| Fichier | Rôle |
|---|---|
| `server.js` | Express minimal : sert la SPA, proxy `/api/:platform/*` (GET + write listblanche), agrégations `/api/aggregate/*`, ping `/api/platforms/status`. ~210 lignes. |
| `config.js` | Vars d'env (`PORT`, `TIKTOK_URL`, `YOUTUBE_URL`, `FETCH_TIMEOUT_MS`). |
| `lib/platforms.js` | Registre des plateformes (`tiktok`, `youtube`). |
| `lib/fetchPlatform.js` | Wrapper fetch avec timeout + dégradation gracieuse (backend down → `{ ok: false, down: true }`). |
| `lib/aggregate.js` | Fusion réponses 2 backends : `logs`, `campaigns`, `accounts`, `overview`, `combineCharts`, `tiktokChartFallback`. |
| `public/index.html` | Layout SPA, sidebar, toggle plateforme global, sections par route. |
| `public/app.js` | SPA vanilla, hash routing, 5 pages, graphes SVG portés du yt-panel. |
| `public/styles.css` | Repris **intégralement** du `youtube-panel/public/styles.css` + surcouches `unified-panel` (badges plateforme, toggle, drawer). |
| `tmux-*.sh` | Déploiement Mac mini. `TMUX_SESSION` défaut = `up-$(basename $PWD)`. |
| `start.command` / `start.bat` | Lanceurs locaux. |

---

## Décisions de design

### Toggle plateforme global (state + UI)

État : `state.platform` ∈ `{'all', 'tiktok', 'youtube'}`. Persisté en `localStorage('platform')`. Chaque page filtre `state.campaigns/accounts/logs` via `filterByPlatform()`. Le toggle est dupliqué dans le header de chaque page via `data-toggle-mirror` ; les listeners synchronisent toutes les instances quand on clique.

### Polling au lieu de socket.io

Les 2 backends émettent des events socket riches mais en v1 on poll :
- Stats / campagnes / comptes : 15s (background, sur toutes les pages)
- Logs : 5s, **seulement** quand la page Activity est active (`startLogsPolling` en `onRouteEnter('activity')`)

Raison : socket.io multi-backend = complexité, double connexion, race conditions. On garde la porte ouverte v2 si besoin de feedback < 5s sur les actions.

### Proxy avec liste blanche stricte

`server.js` accepte tout GET vers `/api/:platform/*` (read-only safe) mais limite POST/PATCH/DELETE à une liste explicite (`WRITE_ALLOWLIST`). Volontairement **non proxiés** :
- `POST /api/campaigns/:id/clips` (upload multipart — laisse au backend natif)
- `POST /api/accounts/:id/login` (spawne `login.js`, cross-machine impossible)
- `POST /api/accounts/:id/cooldown` et `POST /api/accounts/:id/captcha` (nécessitent `WORKER_SECRET`, réservés aux workers)
- `POST /api/worker/*` (webhooks worker)

### Agrégation côté serveur, pas côté client

Les endpoints `/api/aggregate/*` font le merge des 2 backends côté Node (parallèle via `fetchAll`). La SPA reçoit du JSON prêt à afficher. Avantage : si l'un des 2 backends est down, le serveur le détecte et marque `available.tiktok / available.youtube` → l'UI dégrade sans recoder la logique côté front.

### Graphes SVG portés du YouTube panel

Fonctions `chartCols / chartDonut / chartHBars / chartProgress` copiées telles quelles dans `public/app.js`. Aucune dépendance externe. Variables CSS partagées (`--accent`, `--bad`, etc.) du `styles.css` du yt-panel.

### TikTok n'a pas `/api/stats/charts`

YouTube expose des séries temporelles riches via `/api/stats/charts`. TikTok n'a que `/api/stats` basique. Côté unified : `aggregate.tiktokChartFallback(stats, accounts)` construit un shape compatible (sans daily/hourly) à partir de `/api/stats` + `/api/accounts`. L'UI grise proprement les graphes vides (`Pas de série temporelle disponible.`).

### Drawer plutôt que page détail

Détail de campagne ouvert en `aside.drawer` à droite, sans changer la route. Slide-in CSS, fermé par Escape / clic backdrop / bouton ×. Garde le contexte de la liste filtrée derrière.

---

## Conventions

- **IDs** : passe-plat depuis les backends (UUID v4 côté source). Pas de génération côté unified.
- **Plateforme dans chaque item** : champ `platform` ('tiktok'|'youtube') ajouté par `aggregate.js`. Toujours présent côté front.
- **Shapes normalisés front** : `aggregate.normalizeCampaign / normalizeAccount` produisent un shape commun. Le shape brut est gardé dans `raw` si une page a besoin de spécificités.
- **Timestamps** : ISO 8601 partout, tri lexicographique direct.
- **Commentaires** : français, expliquer le **pourquoi**.

---

## Endpoints unified-panel

```
GET    /api/config                          -- { platforms: [{key, label, url}] }
GET    /api/platforms/status                -- ping rapide TT + YT
GET    /api/aggregate/overview              -- stats agrégées + breakdown par plateforme
GET    /api/aggregate/logs?limit=200        -- logs des 2 backends fusionnés
GET    /api/aggregate/campaigns             -- liste campagnes normalisée + badge
GET    /api/aggregate/accounts              -- liste comptes normalisée + badge
GET    /api/aggregate/charts                -- { combined, tiktok, youtube } pour la page Stats

GET    /api/:platform/*                     -- proxy passe-plat (GET only)
POST/PATCH/DELETE /api/:platform/*          -- proxy write avec liste blanche
```

---

## Configuration

`.env` à la racine (lu via `--env-file-if-exists` côté npm start) :

```bash
PORT=3020
TIKTOK_URL=http://localhost:3010
YOUTUBE_URL=http://localhost:3000
FETCH_TIMEOUT_MS=5000
```

Aucune var n'est obligatoire : tous les défauts marchent en local si les 2 panels tournent sur les ports standards.

---

## Tests / vérifs

Pas de framework. Avant un commit risqué :

```bash
node --check server.js
node --check config.js
node --check lib/platforms.js lib/fetchPlatform.js lib/aggregate.js
node --check public/app.js

# Pré-requis : tiktok-panel sur :3010 et youtube-panel sur :3000
PORT=3020 npm start

# Smoke tests
curl http://localhost:3020/api/platforms/status
curl http://localhost:3020/api/aggregate/overview
curl http://localhost:3020/api/aggregate/campaigns | head -c 200
```

---

## Gotchas connus

### Si un backend est down

- `/api/platforms/status` → `online: false`, `error: "Timeout"` ou `"Network error"`.
- `/api/aggregate/*` retourne quand même les données de l'autre backend (pas de 500).
- La SPA badge le backend offline dans la sidebar et continue à fonctionner sur l'autre.

### Cache navigateur agressif

`Cache-Control: max-age=86400` sur JS/CSS, `60s, must-revalidate` sur HTML/JSON. Après un deploy d'`app.js` : force-refresh (Cmd+Shift+R).

### Polling 15s + actions write

Après une action write (push, change status), la SPA déclenche un `refreshAll()` immédiat + un re-render du drawer 1s plus tard pour absorber le délai côté worker. Pas de socket → pas de feedback instantané ; assumé en v1.

### Création de campagne

Volontairement absente. Le bouton "Ouvrir l'UI native" du drawer redirige vers le backend natif (`TIKTOK_URL/#/campaigns` ou `YOUTUBE_URL/#/campaigns`). Reproduire l'upload multipart + le formulaire complexe ici ne ferait que dupliquer du code.

### Toggle plateforme multi-instance

Le toggle existe en plusieurs exemplaires (un dans le header de chaque page, mirroré depuis `#platform-toggle`). `buildPlatformToggles()` clone le HTML et attache les listeners ; `syncPlatformToggles()` met à jour la classe `active` partout. Si on ajoute une page, ajouter un `<div class="platform-toggle" data-toggle-mirror>` dans son `<header>`.

---

## Orchestration de la stack — 1 session tmux pour les 5 services

Depuis v1.1, le `tmux-start.sh` du unified-panel ne démarre plus seulement son
propre serveur : il orchestre **toute la stack** dans une session tmux unique :

| Window tmux | Process | Port | Visibilité |
|---|---|---|---|
| `tt-panel`   | `tiktok-panel/server.js` | 3010 | localhost-only (interne) |
| `tt-worker`  | `tiktok-panel/worker.js` (Puppeteer Chrome) | — | — |
| `yt-panel`   | `youtube-panel/server.js` | 3000 | localhost-only (interne) |
| `yt-worker`  | `youtube-panel/worker.js` (ADB Android) | — | — |
| `unified`    | `unified-panel/server.js` | 3020 | **POINT D'ENTRÉE** (Tailscale/LAN) |

Le user n'a qu'une seule commande à connaître : `./tmux-start.sh` côté unified.
Les 2 panels TikTok/YouTube restent **100 % inchangés** côté code — leurs
projets séparés continuent à fonctionner. Le unified les *spawne* depuis sa
propre session.

**Hygiène** : si tu avais auparavant des sessions tmux séparées pour les 2
panels (`tp-*`, `yp-*`), le `tmux-start.sh` du unified refuse de démarrer tant
qu'elles sont actives — pour éviter les collisions de port. Arrête-les
manuellement avant : `tmux kill-session -t tp-tiktok-panel` etc.

**Variables d'env utiles** (cf. `.env.example`) :
- `TT_PATH` / `YT_PATH` : chemins vers les 2 projets (défaut : `../tiktok-panel`, `../youtube-panel`)
- `TT_PORT` / `YT_PORT` : ports internes (3010 / 3000)
- `PORT` : port public du unified (3020)
- `SPEED_FACTOR` / `MAX_PARALLEL` : forwardés aux 2 workers

## Déploiement Mac mini (prod)

```bash
# Depuis la machine de dev
rsync -av --exclude=node_modules --exclude=data unified-panel/ macmini:~/panel/unified-panel/

# Sur le Mac mini : arrête les sessions héritées si présentes
ssh macmini "tmux kill-session -t tp-tiktok-panel 2>/dev/null; tmux kill-session -t yp-youtube-panel 2>/dev/null"

# Puis lance la stack complète depuis le unified
ssh macmini "cd ~/panel/unified-panel && ./tmux-start.sh"

# Accès via Tailscale
open http://<macmini-tailscale-ip>:3020/
```

---

## TODO immédiats / v2 envisageables

- Socket.io multi-backend pour feedback temps-réel < 5s (post-update, account-update).
- Bouton "Forcer un refresh" globalement visible (actuellement uniquement Stats).
- Cron stats archivées dans une mini-DB locale pour graphes long-terme cross-plateforme (au-delà des 30j du yt-panel).
- Auth basique si exposé hors Tailscale.
