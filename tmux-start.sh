#!/bin/bash
# tmux-start.sh — Orchestre les 3 services (unified + tiktok + youtube + workers)
# dans une SEULE session tmux multi-windows. Survit au close de la SSH.
#
# Une seule commande à connaître pour lancer la stack complète :
#   ./tmux-start.sh
#
# Override possible via env :
#   PORT=3020                 # port public du unified-panel (point d'entrée)
#   TT_PORT=3010              # port interne tiktok-panel
#   YT_PORT=3000              # port interne youtube-panel
#   TT_PATH=../tiktok-panel   # chemin vers le projet tiktok-panel
#   YT_PATH=../youtube-panel  # chemin vers le projet youtube-panel
#   SPEED_FACTOR=1.2          # forwardé aux workers
#   MAX_PARALLEL=2

set -e

cd "$(dirname "$0")"
UNIFIED_DIR="$(pwd)"
PARENT_DIR="$(cd .. && pwd)"

# .env du unified-panel (pour PORT, TIKTOK_URL, YOUTUBE_URL)
if [ -f .env ]; then
    set -o allexport
    # shellcheck disable=SC1091
    source .env
    set +o allexport
fi

PORT="${PORT:-3020}"
TT_PORT="${TT_PORT:-3010}"
YT_PORT="${YT_PORT:-3000}"
TT_PATH="${TT_PATH:-$PARENT_DIR/tiktok-panel}"
YT_PATH="${YT_PATH:-$PARENT_DIR/youtube-panel}"
SPEED_FACTOR="${SPEED_FACTOR:-1.2}"
MAX_PARALLEL="${MAX_PARALLEL:-2}"

# URLs internes que le unified consomme (loopback, jamais exposées dehors)
TIKTOK_URL="${TIKTOK_URL:-http://localhost:$TT_PORT}"
YOUTUBE_URL="${YOUTUBE_URL:-http://localhost:$YT_PORT}"

SESSION="${TMUX_SESSION:-up-$(basename "$UNIFIED_DIR")}"

# ── Pré-checks ────────────────────────────────────────────────────────────────
if ! command -v tmux >/dev/null 2>&1; then
    echo "❌ tmux non installé. Lance : brew install tmux"
    exit 1
fi
if ! command -v node >/dev/null 2>&1; then
    echo "❌ Node.js manquant."
    exit 1
fi

if [ ! -d "$TT_PATH" ]; then
    echo "❌ tiktok-panel introuvable à : $TT_PATH"
    echo "   Override avec TT_PATH=/chemin/vers/tiktok-panel ./tmux-start.sh"
    exit 1
fi
if [ ! -d "$YT_PATH" ]; then
    echo "❌ youtube-panel introuvable à : $YT_PATH"
    echo "   Override avec YT_PATH=/chemin/vers/youtube-panel ./tmux-start.sh"
    exit 1
fi

# Avertit si d'autres sessions tmux des 2 panels tournent déjà — collisions de
# port sinon. Le user doit les arrêter manuellement ou laisser cette session
# les gérer.
for legacy in "tp-$(basename "$TT_PATH")" "yp-$(basename "$YT_PATH")"; do
    if tmux has-session -t "$legacy" 2>/dev/null; then
        echo "⚠️  Session tmux héritée '$legacy' encore active."
        echo "   Arrête-la d'abord : tmux kill-session -t $legacy"
        echo "   (ou cd $TT_PATH/$YT_PATH puis ./tmux-stop.sh)"
        exit 1
    fi
done

if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "⚠️  Session '$SESSION' déjà active. Utilise ./tmux-stop.sh pour arrêter."
    exit 0
fi

# ── Install dépendances si premier run ────────────────────────────────────────
install_if_needed() {
    local dir="$1" label="$2"
    if [ ! -d "$dir/node_modules" ]; then
        echo "📦 Installation des dépendances $label..."
        (cd "$dir" && PUPPETEER_SKIP_DOWNLOAD=true npm install)
    fi
}
install_if_needed "$UNIFIED_DIR" "unified-panel"
install_if_needed "$TT_PATH" "tiktok-panel"
install_if_needed "$YT_PATH" "youtube-panel"

# ── Démarrage des windows tmux ────────────────────────────────────────────────
echo "🚀 Démarrage de la session tmux '$SESSION'..."

# Window 1 : tiktok-panel server (port interne)
tmux new-session -d -s "$SESSION" -n "tt-panel" -c "$TT_PATH"
tmux send-keys -t "$SESSION:tt-panel" "PORT=$TT_PORT npm start" C-m

# Window 2 : tiktok-panel worker (Chrome Puppeteer)
tmux new-window -t "$SESSION" -n "tt-worker" -c "$TT_PATH"
tmux send-keys -t "$SESSION:tt-worker" \
    "SPEED_FACTOR=$SPEED_FACTOR MAX_PARALLEL=$MAX_PARALLEL PANEL_URL=http://localhost:$TT_PORT npm run worker" C-m

# Window 3 : youtube-panel server (port interne)
tmux new-window -t "$SESSION" -n "yt-panel" -c "$YT_PATH"
tmux send-keys -t "$SESSION:yt-panel" "PORT=$YT_PORT npm start" C-m

# Window 4 : youtube-panel worker (ADB Android)
tmux new-window -t "$SESSION" -n "yt-worker" -c "$YT_PATH"
tmux send-keys -t "$SESSION:yt-worker" \
    "SPEED_FACTOR=$SPEED_FACTOR MAX_PARALLEL=$MAX_PARALLEL PANEL_URL=http://localhost:$YT_PORT npm run worker" C-m

# Petit délai pour laisser les backends ouvrir leurs ports
sleep 3

# Window 5 : unified-panel (point d'entrée) — démarré en dernier pour que les
# 2 backends soient disponibles à l'ouverture de la première requête.
tmux new-window -t "$SESSION" -n "unified" -c "$UNIFIED_DIR"
tmux send-keys -t "$SESSION:unified" \
    "PORT=$PORT TIKTOK_URL=$TIKTOK_URL YOUTUBE_URL=$YOUTUBE_URL npm start" C-m

sleep 2

# ── Récap ─────────────────────────────────────────────────────────────────────
echo ""
echo "✅ Session '$SESSION' active — 5 windows en cours"
echo "   1. tt-panel   :$TT_PORT   (interne)"
echo "   2. tt-worker  Puppeteer Chrome"
echo "   3. yt-panel   :$YT_PORT   (interne)"
echo "   4. yt-worker  ADB Android"
echo "   5. unified    :$PORT   ← POINT D'ENTRÉE"
echo ""

LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")
echo "🌐 Dashboard unifié :"
echo "   http://localhost:$PORT"
[ -n "$LOCAL_IP" ] && echo "   http://$LOCAL_IP:$PORT   (LAN / Tailscale)"
echo ""
echo "📺 Commandes utiles :"
echo "   tmux attach -t $SESSION              voir les logs (Ctrl+B puis n/p pour naviguer)"
echo "   tmux a -t $SESSION \\; selectw -t unified   attach directement sur la window unified"
echo "   ./tmux-stop.sh                       tout arrêter d'un coup"
echo ""
echo "💡 Tu peux fermer ta SSH, ça continue à tourner."
