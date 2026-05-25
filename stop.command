#!/bin/bash
# Stoppe toute la stack Unified Panel (process node server.js + worker.js).
# Plus pratique que de fermer 5 onglets Terminal à la main.

echo "⏸  Arrêt de la stack Unified Panel..."

KILLED=""
pkill -f "node server.js" 2>/dev/null && KILLED="$KILLED servers"
pkill -f "node worker.js" 2>/dev/null && KILLED="$KILLED workers"
pkill -f "node --env-file-if-exists=.env server.js" 2>/dev/null

if [ -n "$KILLED" ]; then
    echo "🧹 Arrêté :$KILLED"
else
    echo "ℹ️  Aucun process actif."
fi

echo "✅ Stack arrêtée."
