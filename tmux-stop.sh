#!/bin/bash
# tmux-stop.sh — Arrête proprement les 5 windows (unified + tiktok + youtube
# + 2 workers) et ferme la session tmux. Symétrique de tmux-start.sh.

cd "$(dirname "$0")"

if [ -f .env ]; then
    set -o allexport
    # shellcheck disable=SC1091
    source .env
    set +o allexport
fi

SESSION="${TMUX_SESSION:-up-$(basename "$(pwd)")}"

if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "⏸  Arrêt propre des process (Ctrl+C dans chaque window)..."
    for window in unified tt-panel tt-worker yt-panel yt-worker; do
        tmux send-keys -t "$SESSION:$window" C-c 2>/dev/null || true
    done
    sleep 2
    tmux kill-session -t "$SESSION"
    echo "✅ Session '$SESSION' fermée."
else
    echo "ℹ️  Aucune session tmux '$SESSION' active."
fi

# Cleanup : processus orphelins éventuels (worker crash, hang Chrome, …)
KILLED=""
pkill -f "node server.js" 2>/dev/null && KILLED="$KILLED servers"
pkill -f "node worker.js" 2>/dev/null && KILLED="$KILLED workers"
if [ -n "$KILLED" ]; then
    echo "🧹 Process orphelins tués :$KILLED"
fi

# Note : on ne tue PAS les Chrome de Puppeteer ici (data/profiles/*) — c'est
# le worker.js qui les gère via sa propre déconnexion. Si vraiment besoin :
#   pkill -f "Google Chrome.*--user-data-dir=.*data/profiles"
