#!/bin/bash
# push-media.sh — Pousse des photos/médias sur les téléphones Android via ADB.
# Utile pour préparer la création de chaînes YouTube (photos de profil, etc.)
#
# Usage :
#   ./push-media.sh photo.jpg                  # push sur TOUS les téléphones connectés
#   ./push-media.sh photo.jpg <serial>         # push sur un téléphone précis
#   ./push-media.sh dossier/                   # push tous les fichiers du dossier sur tous les téléphones
#   ./push-media.sh photo.jpg --list           # liste les téléphones sans rien pousser
#
# Les fichiers atterrissent dans /sdcard/Pictures/UnifiedPanel/ et un media-scan
# est déclenché pour qu'ils apparaissent dans la galerie (visible depuis l'app
# YouTube quand tu choisis une photo de profil).
#
# Pré-requis : `adb` dans le PATH (brew install android-platform-tools).

set -e

# ── Couleurs ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

# ── Pré-checks ────────────────────────────────────────────────────────────────
if ! command -v adb >/dev/null 2>&1; then
    echo -e "${RED}❌ adb non installé.${RESET} Lance : brew install android-platform-tools"
    exit 1
fi

# ── Arguments ─────────────────────────────────────────────────────────────────
SOURCE="${1:-}"
TARGET_SERIAL="${2:-}"

if [ "$SOURCE" = "--list" ] || [ "$TARGET_SERIAL" = "--list" ]; then
    echo "Téléphones connectés :"
    adb devices | tail -n +2 | grep -v '^$'
    exit 0
fi

if [ -z "$SOURCE" ]; then
    echo "Usage : $0 <fichier-ou-dossier> [serial]"
    echo "       $0 --list"
    exit 1
fi

if [ ! -e "$SOURCE" ]; then
    echo -e "${RED}❌ Source introuvable : $SOURCE${RESET}"
    exit 1
fi

# ── Liste des téléphones cibles ──────────────────────────────────────────────
if [ -n "$TARGET_SERIAL" ]; then
    DEVICES=("$TARGET_SERIAL")
else
    # Tous les téléphones en état 'device' (online + autorisés)
    DEVICES=()
    while IFS=$'\t' read -r serial state; do
        if [ "$state" = "device" ] && [ -n "$serial" ]; then
            DEVICES+=("$serial")
        fi
    done < <(adb devices | tail -n +2)
fi

if [ ${#DEVICES[@]} -eq 0 ]; then
    echo -e "${YELLOW}⚠️  Aucun téléphone connecté.${RESET}"
    echo "    Vérifie avec : adb devices"
    exit 1
fi

# ── Liste des fichiers à pousser ─────────────────────────────────────────────
FILES=()
if [ -d "$SOURCE" ]; then
    # Dossier : tous les fichiers (images + vidéos courants)
    while IFS= read -r -d '' f; do
        FILES+=("$f")
    done < <(find "$SOURCE" -maxdepth 1 -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.gif' -o -iname '*.webp' -o -iname '*.mp4' -o -iname '*.mov' \) -print0)
    if [ ${#FILES[@]} -eq 0 ]; then
        echo -e "${YELLOW}⚠️  Aucun fichier média trouvé dans $SOURCE${RESET}"
        exit 1
    fi
else
    FILES=("$SOURCE")
fi

# ── Push ──────────────────────────────────────────────────────────────────────
REMOTE_DIR="/sdcard/Pictures/UnifiedPanel"
echo "→ ${#FILES[@]} fichier(s) vers ${#DEVICES[@]} téléphone(s) dans $REMOTE_DIR"
echo ""

for serial in "${DEVICES[@]}"; do
    echo -e "📱 ${GREEN}$serial${RESET}"

    # Crée le dossier distant (idempotent)
    adb -s "$serial" shell "mkdir -p $REMOTE_DIR" >/dev/null 2>&1 || {
        echo -e "   ${RED}échec mkdir — téléphone inaccessible${RESET}"
        continue
    }

    for file in "${FILES[@]}"; do
        filename=$(basename "$file")
        printf "   ↳ %s … " "$filename"
        if adb -s "$serial" push "$file" "$REMOTE_DIR/$filename" >/dev/null 2>&1; then
            # Trigger MediaScanner pour que la galerie le voie immédiatement
            adb -s "$serial" shell "am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://$REMOTE_DIR/$filename" >/dev/null 2>&1 || true
            echo -e "${GREEN}OK${RESET}"
        else
            echo -e "${RED}échec${RESET}"
        fi
    done
    echo ""
done

echo -e "${GREEN}✅ Terminé.${RESET}"
echo ""
echo "Les fichiers sont dans la galerie Android du téléphone, dossier 'UnifiedPanel'."
echo "Tu peux les sélectionner depuis l'app YouTube lors de la création de chaîne."
