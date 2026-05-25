# Unified Panel

Dashboard global qui agrège les 2 panels `tiktok-panel/` et `youtube-panel/` en
une seule SPA — gestion des campagnes, comptes, activité et stats au même
endroit. **Le unified-panel orchestre la stack complète** : tu lances un seul
script et il démarre les 5 services nécessaires.

```
[Mac mini · Tailscale]                          ← une seule commande à lancer
  unified-panel       :3020   POINT D'ENTRÉE    → ./tmux-start.sh
    ├── tt-panel      :3010   (interne)         │
    ├── tt-worker     Puppeteer Chrome          │ orchestrés par
    ├── yt-panel      :3000   (interne)         │ unified-panel
    └── yt-worker     ADB Android               ┘
```

Le unified-panel n'a aucune DB locale, aucun worker propre. Il proxy + agrège
les 2 backends et **les lance pour toi** depuis son `tmux-start.sh`.

## Démarrage rapide

Pré-requis : avoir cloné `tiktok-panel/` et `youtube-panel/` à côté de
`unified-panel/` (frères dans le même dossier parent).

```bash
cd unified-panel
./tmux-start.sh        # démarre TOUT (5 windows tmux dans une seule session)
open http://localhost:3020
```

- Mac (double-clique) : `start.command` (ouvre 5 onglets Terminal)
- Windows : `start.bat`
- Stop : `./tmux-stop.sh` ou `./stop.command`

Si les 2 panels avaient déjà leur propre session tmux (`tp-tiktok-panel`,
`yp-youtube-panel`), arrête-les d'abord — `tmux-start.sh` du unified refuse de
démarrer pour éviter les collisions de port.

## Configuration (`.env`)

```bash
# Ports
PORT=3020                          # public, point d'entrée
TT_PORT=3010                       # interne, jamais exposé
YT_PORT=3000                       # interne, jamais exposé

# Chemins vers les 2 panels (par défaut : frères du unified-panel)
TT_PATH=../tiktok-panel
YT_PATH=../youtube-panel

# Tuning des workers (forwardé aux deux)
SPEED_FACTOR=1.2
MAX_PARALLEL=2

# URLs internes que le unified consomme (loopback)
TIKTOK_URL=http://localhost:3010
YOUTUBE_URL=http://localhost:3000

# Timeout sur les appels HTTP vers les 2 backends
FETCH_TIMEOUT_MS=5000
```

## Pages

- **Vue d'ensemble** — KPIs agrégés, comparatif des 2 plateformes, derniers logs.
- **Campagnes** — liste fusionnée avec badge, drawer de détail + actions
  (changer statut, push all, retry errors).
- **Comptes** — comptes TikTok + chaînes YouTube, lift de cooldown.
- **Activité** — flux logs fusionné, filtres type/plateforme/recherche.
- **Statistiques** — graphes SVG (publications 30j, statuts, horaire, top
  comptes, par campagne, types d'erreurs).
- **Studio Android** (lien externe, sidebar) — ouvre `youtube-panel/#/studio`
  dans un nouvel onglet pour piloter les téléphones en live.

Le toggle **Tous / TikTok / YouTube** en haut filtre toutes les pages.

## Tests rapides

```bash
node --check server.js public/app.js lib/*.js
curl http://localhost:3020/api/platforms/status
curl http://localhost:3020/api/aggregate/overview | head -c 400
```

Voir `CLAUDE.md` pour la doc technique.
