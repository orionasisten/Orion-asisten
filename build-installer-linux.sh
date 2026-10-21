#!/bin/bash
# Membangun installer Linux: AppImage, .deb, dan .tar.gz.
cd "$(dirname "$0")" || exit 1
echo "=== ORION - bangun installer Linux ==="
command -v node >/dev/null 2>&1 || { echo "Node.js belum terpasang. Pasang LTS dari https://nodejs.org (atau lewat nvm/paket distro)."; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] || { echo "Node.js terlalu lama (butuh 18+)."; exit 1; }
echo "[1/2] Memasang dependensi (butuh internet)..."; npm install || { echo "GAGAL pada npm install"; exit 1; }
echo "[2/2] Membangun installer..."; npm run dist:linux || { echo "GAGAL pada build"; exit 1; }
echo "SELESAI. Hasil di dist/modern:"; ls -1 dist/modern | grep -E "AppImage|deb|tar.gz"
echo "Pasang: sudo apt install ./dist/modern/ORION-*-linux-*.deb   atau   chmod +x ORION-*.AppImage && ./ORION-*.AppImage"
