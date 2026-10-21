# ORION Desktop v4.0

Pembungkus desktop (Electron) untuk **ORION — Sovereign Intelligence OS**, lengkap dengan
konfigurasi installer **Windows**, **macOS**, dan **Linux** (panduan: [`INSTALL.md`](INSTALL.md)), adapter Tools nyata, sistem **skill**, **plugin**, dan **connector**.

> Installer (.exe / .dmg) tidak bisa dibuat di sandbox tempat proyek ini disusun (tanpa jaringan, tanpa toolchain Windows/macOS).
> Proyek ini sudah siap build: jalankan satu perintah di mesin Anda, atau pakai GitHub Actions (di bawah).

## Isi proyek

| Path | Fungsi |
|---|---|
| `source/Orion_v_4_0.html` | Web app asli (tidak diubah) |
| `scripts/prepare-app.js` | Membangun `app/index.html`: CSP, menu **Desktop Hub**, sambungan tombol Tools, font lokal |
| `app-src/orion-desktop.js` | UI Desktop Hub, injeksi skill ke Chat, plugin command, loop tool MCP |
| `app-src/orion-stt.js` | STT cloud untuk Voice (pengganti Web Speech yang tidak jalan di Electron) |
| `src/mcp.js` | Klien MCP: server lokal (stdio) dan jarak jauh (Streamable HTTP + token), diuji dengan server nyata |
| `resources/skills/rea-reverse-engineering/`, `resources/plugins/rea-toolkit/`, `resources/third_party/rea/` | Skill, plugin, dan notice lisensi untuk integrasi REA |
| `app-src/orion-input.js`, `orion-extract.js`, `orion-web.js`, `orion-capabilities.js`, `orion-fixes.css` | Menu input Chat: lampiran, pencarian/riset, pemilih kemampuan, CSS responsif |
| `src/webtools.js` | Pencarian web, pembaca halaman, discovery (lewat gateway yang sama) |
| `src/updater.js` | Pembaruan otomatis lewat GitHub Releases (selalu bertanya dulu) |
| `src/main.js`, `src/preload.js`, `src/bridge.js` | Proses utama Electron, jembatan aman (IPC), adapter |
| `resources/skills/` | 10 skill bawaan (8 agent Orion + gaya ringkas + konteks DIGIUM) |
| `resources/plugins/` | 3 plugin bawaan: Dev Workflow, Project Planning, Security Audit |
| `resources/connectors/presets.json` | 10 preset AI provider + perintah CLI agent |
| `electron-builder.config.js` | Target installer + profil `modern` / `legacy` |
| `.github/workflows/build.yml` | Build otomatis Windows + macOS di cloud |

## Build installer

Prasyarat: Node.js 20+ (jalankan `npm install` sekali).

```bash
npm install
npm start               # coba dulu sebagai aplikasi desktop
npm test                # uji mandiri (tanpa Electron)

# Di Windows:
npm run dist:win        # NSIS installer (x64 + arm64), portable, zip
# Di macOS:
npm run dist:mac        # DMG + zip universal (Intel + Apple Silicon)
# Di Linux:
npm run dist:linux      # AppImage, .deb, .tar.gz (x64; arm64 dengan ORION_LINUX_ARM64=1)
```

Hasil ada di `dist/modern/`. DMG hanya bisa dibuat di macOS; installer Windows paling andal dibuat di Windows.

### Tanpa mesin Windows/Mac: GitHub Actions
1. Unggah proyek ini ke repo GitHub (jalankan `npm install` dulu dan commit `package-lock.json`).
2. Tab **Actions → Build installer ORION → Run workflow**. Artefak (.exe, .dmg, .zip) muncul di halaman run.
3. Push tag `v4.0.0` untuk otomatis membuat GitHub Release berisi semua installer.

### Dukungan versi OS

| Profil | Perintah | Windows | macOS |
|---|---|---|---|
| `modern` (default, Electron terbaru) | `dist:win` / `dist:mac` | 10 / 11 (x64, arm64) | versi yang masih didukung Chromium terbaru, Intel + Apple Silicon |
| `legacy` (Electron 22) | `npm run legacy:electron` lalu `dist:win:legacy` / `dist:mac:legacy` | 7 / 8 / 8.1 / 10 / 11 (x64, ia32) | 10.13+ (Intel + Apple Silicon) |

Batas minimum persis ditentukan Electron/Chromium dan berubah tiap rilis — cek
<https://www.electronjs.org/docs/latest/tutorial/support> dan **uji di mesin target**. Profil `legacy`
memakai Electron 22 yang sudah *end-of-life* (tanpa patch keamanan); pakai hanya bila perlu mendukung OS lama.
Tidak didukung: Windows XP/Vista, macOS ≤ 10.12, PowerPC.

### Code signing (disarankan untuk distribusi)
Tanpa signing, installer tetap jalan tetapi OS menampilkan peringatan:
* **Windows (SmartScreen):** *More info → Run anyway*. Hilangkan dengan sertifikat code-signing: set secret `CSC_LINK` (file .pfx/URL) dan `CSC_KEY_PASSWORD`.
* **macOS (Gatekeeper):** klik kanan → *Open*, atau `xattr -dr com.apple.quarantine /Applications/ORION.app`. Hilangkan dengan Apple Developer ID + notarisasi: set `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

## Menu input Chat (tombol +) dan kualitas

* **Lampirkan data** (berkas/foto/audio, tempel, URL web, workspace; DOCX/XLSX/PPTX/PDF/teks/gambar), **Cari & riset realtime**, dan **pemilih Skill, plugin & connector** (+ penemuan online). Rincian, batas, dan model keamanan: [`docs/chat-input.md`](docs/chat-input.md).
* **Pemasangan di Windows/macOS/Linux:** lihat [`INSTALL.md`](INSTALL.md) (GitHub Actions satu klik, atau skrip klik-dua-kali `build-installer-*`).
* **Uji:** `npm test` (Node: 101 tes — keamanan jaringan, alat web, ekstraksi, bridge dengan Electron tiruan). UI diuji di Chromium headless dengan bridge tiruan, termasuk sapuan ±265 tombol per tampilan di lima ukuran layar (1440, 820, 390, 360, 320 px). Skrip UI tidak dikemas; Electron asli belum pernah dijalankan.
* Perbaikan bug aplikasi sumber lewat `prepare-app.js`: "Invalid Date", top bar meluap di layar kecil (CSS tambahan `app-src/orion-fixes.css`), dan Chat yang diputus pada 60 detik saat memakai tool/riset.

## Cek Sistem

Desktop Hub → **Cek Sistem**, atau tanyakan di Chat "cek sistem Orion" (model memakai tool `orion_system_check`, hanya ditawarkan saat pesan memintanya).
Pemeriksaan **lokal dan hanya-baca**: versi/runtime, provider AI, Voice (STT/TTS/mikrofon), workspace, tool terdeteksi, skill/plugin, server MCP,
API Hub, penyimpanan lokal, pembaruan, Dudu. Tidak memuat API key. Uji koneksi ke provider hanya bila diminta. "OK" berarti konfigurasi/status
terbaca baik, **bukan** bukti fitur berjalan end-to-end. Dudu "Belum terhubung" adalah kondisi normal tanpa backend Dudu milik Anda.
Juga diperbaiki: bug "Invalid Date" pada percakapan/proyek (data memakai `updatedAt`, UI membaca `updated`) lewat `scripts/prepare-app.js`.

## API Connector Hub (blueprint v1.1)

Registry + gateway untuk API publik/berautentikasi dengan SSRF guard, policy per risiko, persetujuan native, audit berantai hash,
secret terenkripsi OS, dan emergency stop. Katalog penemuan: public-apis/public-apis (MIT) — masuk katalog **bukan** izin.
Desktop Hub → **API Hub**. Detail desain, kontrol keamanan, dan keterbatasan: [`docs/api-connector-hub.md`](docs/api-connector-hub.md);
audit kondisi aktual terhadap blueprint: [`docs/audit-blueprint-v1.1.md`](docs/audit-blueprint-v1.1.md). Tes: `npm test`.
Remote MCP kini **default mati** (flag eksperimental di tab MCP) sesuai urutan blueprint §23.

## REA — Reverse Engineer Anything (morluto/rea)

Integrasi dengan [REA](https://github.com/morluto/rea), server MCP (paket npm `rea-agents`, MIT, proyek pihak ketiga)
yang membantu menyelidiki biner, aplikasi native/.NET/Electron/Android, dan firmware secara berbasis bukti.
ORION **tidak menyertakan kode REA**: server diunduh dari npm saat dijalankan. Yang ditambahkan di sini:

* **Desktop Hub → REA:** cek Node.js (REA butuh 22.19+, 24.11+, atau 26+), persetujuan batas penggunaan, tombol *Pasang & jalankan REA* (menambah server, memulainya, mengaktifkan skill dan tool MCP di Chat), dan *REA Doctor* (diagnostik hanya-baca).
* **Skill "REA Reverse Engineering":** aturan kerja berbasis bukti, rute target → tool, batas penggunaan yang sah. Diadaptasi dari skill resmi REA (lihat `resources/third_party/rea/`).
* **Plugin "REA Toolkit":** 8 prompt siap pakai (pahami fitur, analisis aplikasi JS/Electron, bandingkan versi, .NET, APK, firmware, spesifikasi perilaku clean-room, checklist investigasi).
* **Mode tool bertahap di Chat:** katalog REA berisi ±140–170 tool (puluhan ribu token jika dikirim semua; API OpenAI membatasi 128). Katalog besar otomatis dikirim sebagai 3 tool meta (`mcp_find_tools` → `mcp_describe_tool` → `mcp_call_tool`). Katalog kecil tetap dikirim langsung. Tool tertentu bisa dimatikan per server.
* **Klien MCP:** kini mendukung environment per server (REA memakai `REA_MCP_INPUT_SCHEMA_PROFILE=compact`; variabel berbahaya seperti `PATH`/`NODE_OPTIONS` diblokir) dan **mode ketat** (izin diminta setiap pemanggilan, tanpa opsi "izinkan sesi") — REA dipasang dengan mode ketat.

Catatan penting:
* **Versi dipin ke 6.4.0** (bisa diubah di tab REA). Zip yang Anda unggah berlabel 6.5.0, tetapi saya hanya bisa memastikan 6.3.0–6.4.0 sudah terbit di npm; cek dulu dengan `npm view rea-agents version`. REA sering mengubah antarmuka antar versi (mis. sejak 6.0.0 semua path wajib absolut), jadi naikkan versi dengan sengaja.
* **Engine native tetap Anda siapkan sendiri** (Ghidra, Hopper, IDA, JADX, dll.; lihat `docs/installation.md` di repo REA). Analisis JavaScript/Electron statis dan .NET tidak butuh engine native. Variabel seperti `GHIDRA_INSTALL_DIR` bisa dimasukkan di kolom Environment saat menambah server.
* **Batas penggunaan:** hanya untuk target yang sah. REA sendiri menolak penjebolan DRM/lisensi/anti-cheat, cheat game, pelewatan autentikasi tanpa izin, dan penyalinan software berhak cipta; skill ORION mengikuti batas yang sama.
* **Hasil besar dipotong** (maks 100 KB per panggilan di sisi ORION); REA menyimpan Evidence lengkap dan bisa dibaca per halaman lewat tool `inspect_analysis_view`.
* Tool REA yang menjalankan program, mengamati runtime, atau menyentuh perangkat memicu dialog persetujuan setiap kali; baca argumennya sebelum mengizinkan.

## Pembaruan otomatis (GitHub Releases)

Build yang dibuat di **GitHub Actions** otomatis terhubung ke repo itu sendiri (`ORION_UPDATE_REPO=owner/repo`).
Build lokal: `ORION_UPDATE_REPO=owner/repo npm run dist:win` (macOS/Linux) atau set variabel itu lebih dulu di Windows.
Tanpa variabel ini, pembaruan nonaktif dan menu hanya memberi tahu bahwa belum dikonfigurasi.

Cara kerja: 15 detik setelah dibuka ORION memeriksa rilis terbaru secara senyap; bila ada versi baru, muncul dialog
**Unduh / Nanti**, lalu **Mulai ulang / Nanti**. Tidak pernah mengunduh atau memasang tanpa persetujuan.
Pemeriksaan manual: menu **Bantuan → Periksa Pembaruan…** atau Desktop Hub → Ringkasan.

Cara merilis versi baru:
1. Naikkan `"version"` di `package.json` (mis. `4.1.0`) — updater membandingkan nomor versi.
2. Commit, lalu `git tag v4.1.0 && git push --tags` → workflow membangun semua installer + berkas `latest*.yml`/`blockmap` dan membuat GitHub Release.

Syarat dan batasan:
* **Instalasi pertama tetap manual**; pembaruan hanya berlaku untuk versi yang sudah memuat updater ini.
* **Repo harus publik** (repo privat butuh token dan tidak ditangani di sini).
* **Windows:** hanya installer NSIS yang bisa auto-update (versi *portable* dan zip tidak).
* **macOS:** auto-update mensyaratkan aplikasi **bertanda tangan** (Developer ID). Tanpa signing, pembaruan gagal dan ORION menawarkan buka halaman rilis untuk unduh manual.
* **Profil legacy** (Electron 22) memakai pembaruan manual via halaman rilis, dengan channel terpisah (`legacy.yml`) agar tidak bentrok dengan profil modern.

## Yang sudah berfungsi (setelah diinstal)

* **AI Provider** — Desktop Hub → Connectors: terapkan preset (OpenAI, Anthropic mode kompatibel, OpenRouter, Groq, Gemini, Mistral, DeepSeek, Together, Ollama, LM Studio), muat daftar model langsung dari provider, test koneksi. Masalah CORS diatasi di proses utama.
* **API key aman** — "Simpan aman" mengenkripsi lewat Keychain macOS / DPAPI Windows dan memuatnya otomatis.
* **Workspace** — pilih folder proyek; jelajah berkas, `git status/log/diff`, terminal (setiap perintah minta persetujuan).
* **Claude Code & Codex CLI** — dideteksi dari PATH login shell; dijalankan di workspace dengan persetujuan; prompt via stdin.
* **Tools & Integrations** — tombol *Test* kini mengecek tool sungguhan (Claude Code, Codex, Git, Playwright, SQLite/psql, Docker/Vercel/Netlify/gh, workspace).
* **Voice (STT cloud)** — Desktop Hub → Voice: pilih OpenAI / Groq / server lokal, isi model dan key, klik *Uji mikrofon*. Voice Orion lalu merekam, mendeteksi jeda bicara, dan mengirim audio ke `/audio/transcriptions`. Audio dikirim ke penyedia yang Anda pilih; untuk privasi penuh pakai server lokal (mis. faster-whisper).
* **MCP** — Desktop Hub → MCP: tambah server dari preset (filesystem, memory, sequential-thinking, fetch, git) atau kustom. Aktifkan "Pakai tool MCP di Chat" agar model memanggil tool lewat function-calling (maks 6 putaran). Server bisa **lokal (stdio)** atau **jarak jauh (URL HTTP, protokol Streamable HTTP)** dengan token Bearer opsional yang disimpan terenkripsi (Keychain/DPAPI) dan tidak dapat dibaca halaman web. URL harus `https://` (http hanya untuk localhost). Server dan **setiap pemanggilan tool** minta persetujuan native (ada opsi "izinkan semua dari server ini" per sesi). Hasil tool diperlakukan sebagai data, bukan instruksi.
* **Skills** — folder berisi `SKILL.md`. Skill yang diaktifkan disisipkan ke setiap pesan Chat.
* **Plugins** — folder berisi `plugin.json` (prompt command + opsional `skills/`). Pasang dari Desktop Hub.

### Membuat skill
```
<folder data>/skills/nama-skill/SKILL.md
---
name: Nama Skill
description: Kapan skill ini dipakai
---
Instruksi untuk Orion…
```
### Membuat plugin
```json
{ "id": "my-plugin", "name": "My Plugin", "version": "1.0.0", "permissions": [],
  "commands": [ { "id": "ringkas", "title": "Ringkas", "input": "Teks", "prompt": "Ringkas:\n{{input}}" } ] }
```
Placeholder: `{{input}}`, `{{git.status}}`, `{{git.log}}`, `{{git.diff}}`, `{{file:path/relatif}}`.
Buka folder data lewat menu **Berkas** atau Desktop Hub → Ringkasan.

## Model keamanan
* Renderer tanpa Node (`contextIsolation`, `sandbox`); hanya API `window.orionDesktop` dari preload.
* Tulis berkas, terminal, dan coding agent selalu lewat **dialog persetujuan native** (default tombol: Batal).
* Akses berkas dibatasi ke workspace (tahan path traversal & symlink); `.env`, kunci privat, `.npmrc` tidak bisa dibaca/ditulis.
* Git hanya perintah baca dengan argumen tetap (`--no-ext-diff`, `--no-textconv`, fsmonitor dimatikan).
* Plugin bersifat deklaratif — tidak mengeksekusi kode. CSP ketat; navigasi eksternal dibuka di browser sistem.
* Header CORS hanya ditambahkan untuk request yang berasal dari jendela ORION.

## Keterbatasan yang jujur
* **STT cloud bukan streaming:** teks muncul setelah Anda berhenti bicara (~1 detik jeda), tanpa teks sementara. Ambang deteksi suara otomatis menyesuaikan kebisingan awal; di ruangan sangat bising bisa meleset.
* **MCP:** hanya fitur *tools* (belum resources/prompts/sampling). Server jarak jauh: hanya transport Streamable HTTP (belum transport HTTP+SSE lama), autentikasi hanya token Bearer (belum OAuth), dan tanpa notifikasi dari server di luar permintaan. Belum ada variabel environment per server untuk stdio — gunakan environment sistem. Nama paket preset berasal dari repo server MCP resmi; pastikan masih ada dan Anda memercayainya sebelum dijalankan. Tool calling bergantung pada dukungan provider/model.
* **Belum diuji di Electron asli:** logika UI, STT (audio palsu), klien MCP lokal & HTTP (server palsu), dan alur updater (mock) diuji di Chromium headless dan Node; pengunduhan pembaruan sungguhan dari GitHub belum dicoba; bagian khusus Electron (jendela, dialog persetujuan, keychain, CORS shim, installer) belum bisa dijalankan di lingkungan penyusunan ini — jalankan `npm start` dulu dan laporkan bila ada yang janggal.
* **Dudu Orchestrator** tetap butuh endpoint backend milik Anda (kontrak ada di Tools → Konfigurasi).
* Belum ada auto-update (butuh server rilis). Data (proyek, misi, chat) tetap di penyimpanan lokal aplikasi; gunakan Export di Settings untuk cadangan.
* Pengaturan CLI agent bisa disesuaikan di `agents.override.json` (folder data) bila flag CLI berubah antar versi.
