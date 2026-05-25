#!/bin/bash
# Lanceur Mac : démarre la stack complète (unified + tiktok + youtube + workers)
# dans 5 onglets Terminal. Double-clique ce fichier (chmod +x une fois).

set -e
cd "$(dirname "$0")"
UNIFIED_DIR="$(pwd)"
PARENT_DIR="$(cd .. && pwd)"

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
TIKTOK_URL="${TIKTOK_URL:-http://localhost:$TT_PORT}"
YOUTUBE_URL="${YOUTUBE_URL:-http://localhost:$YT_PORT}"

echo
echo "=== Stack Unified Panel — Lanceur Mac ==="
echo "Unified           : :$PORT  ← point d'entrée"
echo "TikTok backend    : :$TT_PORT  (interne)"
echo "YouTube backend   : :$YT_PORT  (interne)"
echo

if ! command -v node >/dev/null 2>&1; then
    echo "[ERREUR] Node.js n'est pas installé. https://nodejs.org/"
    read -p "Press Enter to exit..."
    exit 1
fi

if [ ! -d "$TT_PATH" ]; then echo "[ERREUR] tiktok-panel introuvable à $TT_PATH"; exit 1; fi
if [ ! -d "$YT_PATH" ]; then echo "[ERREUR] youtube-panel introuvable à $YT_PATH"; exit 1; fi

# Install dépendances si premier run
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

# Lance les 5 onglets Terminal
osascript <<EOF
tell application "Terminal"
    activate
    do script "cd '$TT_PATH' && PORT='$TT_PORT' npm start"
    delay 1
    do script "cd '$TT_PATH' && SPEED_FACTOR='$SPEED_FACTOR' MAX_PARALLEL='$MAX_PARALLEL' PANEL_URL='http://localhost:$TT_PORT' npm run worker"
    delay 1
    do script "cd '$YT_PATH' && PORT='$YT_PORT' npm start"
    delay 1
    do script "cd '$YT_PATH' && SPEED_FACTOR='$SPEED_FACTOR' MAX_PARALLEL='$MAX_PARALLEL' PANEL_URL='http://localhost:$YT_PORT' npm run worker"
    delay 2
    do script "cd '$UNIFIED_DIR' && PORT='$PORT' TIKTOK_URL='$TIKTOK_URL' YOUTUBE_URL='$YOUTUBE_URL' npm start"
end tell
EOF

sleep 4
open "http://localhost:$PORT"

echo
echo "=== Stack démarrée ==="
echo "Dashboard : http://localhost:$PORT"
echo "5 fenêtres Terminal ouvertes — ferme-les avec ./stop-all.command ou Ctrl+C dans chacune."
