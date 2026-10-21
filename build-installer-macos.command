#!/bin/bash
# Klik dua kali (atau jalankan di Terminal) untuk membangun installer macOS (.dmg).
cd "$(dirname "$0")" || exit 1
echo "=== ORION - bangun installer macOS (.dmg) ==="
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js belum terpasang. Pasang versi LTS dari https://nodejs.org lalu jalankan ulang."; open "https://nodejs.org/en/download"; read -r -p "Tekan Enter..."; exit 1
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then echo "Node.js terlalu lama (butuh 18+)."; read -r -p "Tekan Enter..."; exit 1; fi
echo "[1/2] Memasang dependensi (butuh internet)..."; npm install || { echo "GAGAL pada npm install"; read -r -p "Tekan Enter..."; exit 1; }
echo "[2/2] Membangun installer..."; npm run dist:mac || { echo "GAGAL pada build"; read -r -p "Tekan Enter..."; exit 1; }
echo "SELESAI. Installer ada di dist/modern (ORION-...-mac-universal.dmg)."
echo "Catatan: tanpa tanda tangan Apple, buka dengan klik kanan > Open, atau: xattr -dr com.apple.quarantine /Applications/ORION.app"
open dist/modern; read -r -p "Tekan Enter untuk menutup..."
