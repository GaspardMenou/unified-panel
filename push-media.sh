#!/bin/bash
# push-media.sh — Pousse des photos/médias sur les téléphones Android via ADB
# et les enregistre dans le MediaStore (visible immédiatement dans la galerie).
#
# Usage :
#   ./push-media.sh photo.jpg                  # push sur TOUS les téléphones
#   ./push-media.sh photo.jpg <serial>         # push sur un téléphone précis
#   ./push-media.sh dossier/                   # push tous les médias du dossier
#   ./push-media.sh --list                     # liste les téléphones
#
# Les fichiers atterrissent dans /sdcard/Pictures/UnifiedPanel/. Pour les rendre
# visibles dans la galerie/picker (compatible Android 10+), on utilise
# `content insert` qui crée la row MediaStore — le broadcast
# MEDIA_SCANNER_SCAN_FILE classique a été déprécié et ne marche plus.
#
# Pré-requis : `adb` dans le PATH (brew install android-platform-tools).

set -e

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[0;90m'
RESET='\033[0m'

if ! command -v adb >/dev/null 2>&1; then
    echo -e "${RED}❌ adb non installé.${RESET} Lance : brew install android-platform-tools"
    exit 1
fi

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

# ── Détection du mime type depuis l'extension ────────────────────────────────
mime_for() {
    local f="$1"
    local ext="${f##*.}"
    case "$(echo "$ext" | tr '[:upper:]' '[:lower:]')" in
        jpg|jpeg) echo "image/jpeg" ;;
        png)      echo "image/png" ;;
        gif)      echo "image/gif" ;;
        webp)     echo "image/webp" ;;
        mp4)      echo "video/mp4" ;;
        mov)      echo "video/quicktime" ;;
        *)        echo "application/octet-stream" ;;
    esac
}

# Le content provider à utiliser dépend du type (images vs vidéos)
provider_for() {
    case "$1" in
        image/*) echo "content://media/external/images/media" ;;
        video/*) echo "content://media/external/video/media" ;;
        *)       echo "content://media/external/file" ;;
    esac
}

# ── Push ──────────────────────────────────────────────────────────────────────
# `/sdcard/DCIM/` racine (pas un sous-dossier) : pattern utilisé par le worker
# yt-panel pour ses clips (qui pousse dans /sdcard/Movies/ racine et ça marche
# avec tous les pickers YouTube). Les sous-dossiers DCIM/* sont parfois ignorés
# par les pickers stricts (photo de profil notamment). Les fichiers sont
# préfixés `up_` pour pouvoir être nettoyés facilement.
REMOTE_DIR="/sdcard/DCIM"
FILENAME_PREFIX="up_"
echo "→ ${#FILES[@]} fichier(s) vers ${#DEVICES[@]} téléphone(s) dans $REMOTE_DIR/${FILENAME_PREFIX}*"
echo ""

for serial in "${DEVICES[@]}"; do
    # Détecte la version Android (utile pour debug, on log juste)
    sdk=$(adb -s "$serial" shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r' || echo "?")
    echo -e "📱 ${GREEN}$serial${RESET} ${DIM}(API $sdk)${RESET}"

    if ! adb -s "$serial" shell "mkdir -p $REMOTE_DIR" >/dev/null 2>&1; then
        echo -e "   ${RED}échec mkdir — téléphone inaccessible${RESET}"
        continue
    fi

    for file in "${FILES[@]}"; do
        filename=$(basename "$file")
        # Sanitize : remplace les espaces et caractères louches dans le nom
        # distant (le picker Android n'aime pas les espaces dans certains paths).
        safe_name="${filename// /_}"
        remote_name="${FILENAME_PREFIX}${safe_name}"
        remote_path="$REMOTE_DIR/$remote_name"
        mime=$(mime_for "$filename")
        provider=$(provider_for "$mime")
        printf "   ↳ %s " "$filename"

        # 1. Push le fichier
        if ! adb -s "$serial" push "$file" "$remote_path" >/dev/null 2>&1; then
            echo -e "${RED}push échec${RESET}"
            continue
        fi

        # 2. Insère dans MediaStore (Android 10+). Si l'entrée existe déjà,
        #    `content insert` la met à jour silencieusement.
        #
        #    Note : sur Android 11+, certains constructeurs scanned le path
        #    automatiquement quand on push dans /sdcard/Pictures. Mais pour
        #    être sûr, on force l'insertion via content provider.
        adb -s "$serial" shell "content insert \
            --uri $provider \
            --bind _data:s:$remote_path \
            --bind mime_type:s:$mime \
            --bind _display_name:s:$remote_name" >/dev/null 2>&1 || true

        # 3. Fallback legacy : broadcast classique (pré-Android 10).
        #    Ignoré silencieusement sur Android moderne, mais utile si SDK < 29.
        adb -s "$serial" shell "am broadcast \
            -a android.intent.action.MEDIA_SCANNER_SCAN_FILE \
            -d file://$remote_path" >/dev/null 2>&1 || true

        echo -e "${GREEN}OK${RESET} ${DIM}($mime)${RESET}"
    done
    echo ""
done

echo -e "${GREEN}✅ Terminé.${RESET}"
echo ""
echo "Les fichiers sont dans /sdcard/DCIM/ (racine — comme les clips du yt-panel"
echo "dans /sdcard/Movies/). Visibles directement dans tous les pickers Android,"
echo "y compris celui de l'app YouTube pour 'Modifier photo de profil'."
echo ""
echo "Pour nettoyer ces fichiers plus tard :"
echo "  adb -s $TARGET_SERIAL shell rm -f /sdcard/DCIM/up_*"
echo "  adb -s $TARGET_SERIAL shell content delete --uri content://media/external/images/media --where \"_data LIKE '%up_%'\""
