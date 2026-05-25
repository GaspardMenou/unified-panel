// Registre des plateformes connues. Toute extension (Instagram, Threads…) se
// fait ici — pas de string magique ailleurs dans le code.

const { TIKTOK_URL, YOUTUBE_URL } = require('../config');

const PLATFORMS = {
  tiktok: {
    key: 'tiktok',
    label: 'TikTok',
    url: TIKTOK_URL,
    accent: 'oklch(0.78 0.10 25)', // tiktok-ish red/pink
  },
  youtube: {
    key: 'youtube',
    label: 'YouTube',
    url: YOUTUBE_URL,
    accent: 'oklch(0.72 0.18 28)', // youtube-ish red
  },
};

const KEYS = Object.keys(PLATFORMS);

function get(key) {
  return PLATFORMS[key] || null;
}

module.exports = { PLATFORMS, KEYS, get };
