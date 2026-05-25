# Unified Panel

Dashboard global qui agrège les 2 panels `tiktok-panel/` et `youtube-panel/` en
une seule SPA — gestion des campagnes, comptes, activité et stats au même
endroit.

```
[Mac mini · Tailscale]
  tiktok-panel    :3010  (inchangé)
  youtube-panel   :3000  (inchangé)
  unified-panel   :3020  ← point d'entrée quotidien
```

Aucune DB locale, aucun worker. Tout est proxy + agrégation des 2 backends.

## Démarrage rapide

Pré-requis : `tiktok-panel` et `youtube-panel` tournent déjà (ports par défaut
`:3010` et `:3000`).

```bash
npm install
PORT=3020 npm start
open http://localhost:3020
```

Mac (double-clique) : `start.command` · Windows : `start.bat` · Serveur Linux/Mac (tmux) : `./tmux-start.sh`.

## Configuration (`.env`)

```bash
PORT=3020
TIKTOK_URL=http://localhost:3010
YOUTUBE_URL=http://localhost:3000
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

Le toggle **Tous / TikTok / YouTube** en haut filtre toutes les pages.

## Tests rapides

```bash
node --check server.js public/app.js lib/*.js
curl http://localhost:3020/api/platforms/status
curl http://localhost:3020/api/aggregate/overview | head -c 400
```

Voir `CLAUDE.md` pour la doc technique.
# unified-panel
