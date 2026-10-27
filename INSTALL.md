# Memasang ORION di Windows, macOS, dan Linux

> **Status jujur:** berkas installer (`.exe`, `.dmg`, `.AppImage`, `.deb`) **belum dibangun** — lingkungan tempat proyek ini disusun
> tidak punya internet maupun toolchain Windows/macOS. Proyek sudah dikonfigurasi lengkap; Anda tinggal menjalankan **satu** dari tiga cara di bawah.

## Cara A — tanpa memasang apa pun di PC (GitHub Actions)  ← paling mudah
1. Buat repositori GitHub (publik), unggah seluruh isi folder ini.
2. Buka tab **Actions → Build installer ORION → Run workflow**. Tunggu ±10–20 menit.
3. Unduh hasilnya di halaman run (bagian *Artifacts*): `.exe` (Windows), `.dmg` (macOS), `.AppImage`/`.deb`/`.tar.gz` (Linux).
4. Rilis resmi + auto-update: `git tag v4.0.0 && git push --tags` — installer ikut terunggah ke GitHub Release.

## Cara B — bangun di komputer Anda (klik dua kali)
Butuh **Node.js 18+** (disarankan LTS dari nodejs.org) dan internet. Bangun di OS yang sama dengan target (installer macOS hanya bisa dibuat di Mac).

| OS | Klik dua kali / jalankan | Hasil di folder `dist/modern/` |
|---|---|---|
| Windows | `build-installer-windows.bat` | `ORION-…-win-….exe` (installer), versi portable, zip |
| macOS | `build-installer-macos.command` | `ORION-…-mac-universal.dmg` (Intel + Apple Silicon), zip |
| Linux | `./build-installer-linux.sh` | `.AppImage`, `.deb`, `.tar.gz` |

## Cara C — perintah manual
```bash
npm install
npm start                # coba dulu sebagai aplikasi
npm test                 # semua uji otomatis
npm run dist:win         # Windows   | npm run dist:mac   # macOS   | npm run dist:linux  # Linux
```
Windows 7/8 atau macOS 10.13–10.14? Pakai profil lama: `npm run legacy:electron` lalu `npm run dist:win:legacy` / `dist:mac:legacy` (Electron 22, sudah tidak mendapat patch keamanan).

## Memasang hasilnya
**Windows** — jalankan `.exe`, pilih folder, selesai. Tanpa tanda tangan digital, SmartScreen menampilkan peringatan: *More info → Run anyway*.
**macOS** — buka `.dmg`, seret ORION ke *Applications*. Tanpa tanda tangan Apple: klik kanan → *Open*, atau `xattr -dr com.apple.quarantine /Applications/ORION.app`.
**Linux**
* `.deb` (Ubuntu/Debian): `sudo apt install ./ORION-*.deb` — paling andal, termasuk untuk Ubuntu 24.04+.
* `.AppImage`: `chmod +x ORION-*.AppImage && ./ORION-*.AppImage`. Bila muncul error FUSE: `sudo apt install libfuse2` (atau jalankan dengan `--appimage-extract-and-run`). Bila muncul error *sandbox* di Ubuntu 23.10+ (pembatasan user namespace), pakai `.deb`; opsi terakhir `--no-sandbox` (mengurangi keamanan).
* `.tar.gz`: ekstrak lalu jalankan biner `orion`.
* **Penyimpanan secret** (API key, token) butuh keyring (GNOME Keyring/KWallet). Tanpa keyring, ORION **menolak** menyimpan secret secara permanen (backend lemah `basic_text`); key hanya berlaku selama sesi.

## Versi OS (perkiraan — verifikasi di mesin target)
Profil `modern` mengikuti Electron terbaru: Windows 10/11 dan macOS/Linux yang masih didukung Chromium terbaru (cek https://www.electronjs.org/docs/latest/tutorial/support). Linux: distro 64-bit modern (mis. Ubuntu 20.04+/Debian 11+/Fedora terbaru). Batas pastinya berubah tiap rilis Electron.

## Pembaruan otomatis
Hanya untuk build dari GitHub Actions di repo publik: Windows (installer NSIS), macOS (**harus bertanda tangan** Developer ID), Linux (AppImage). `.deb`, portable, dan profil legacy: unduh manual. Instalasi pertama selalu manual.

## Belum terbukti (UNVERIFIED)
Pembuatan installer, pemasangan di ketiga OS, jendela/dialog native Electron, `safeStorage`, dan pembaruan otomatis belum dijalankan. Yang sudah diuji: logika di Node (101 tes), antarmuka di Chromium headless dengan bridge tiruan (6 suite + sapuan 5 ukuran layar). Setelah menginstal, lakukan uji awal: Desktop Hub → **Cek Sistem**.
