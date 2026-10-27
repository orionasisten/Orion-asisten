# Audit Fase A — Orion Desktop vs Blueprint v1.1

Tanggal audit: 16 Okt 2026. Sumber: kode aktual di workspace (`orion-desktop/`), `orion-architecture-blueprint-v1.1.md`,
dan hasil pengujian yang benar-benar dijalankan. **Kode menentukan kondisi saat ini; blueprint menentukan arah.**

## Ruang lingkup yang diaudit
Repo ini adalah **Orion Desktop** (Electron + web app HTML): tidak ada backend Orion Core, tidak ada akun/passkey, dan
tidak ada penyimpanan sisi-server. Semua "state" bisnis (proyek, misi, memori, event) berada di `localStorage` aplikasi web.
Artinya otoritas pusat yang dirancang blueprint (identitas, policy broker, audit tak-dapat-diubah, scheduler) **belum ada**;
Desktop saat ini menjalankan *policy broker lokal* berbasis dialog persetujuan native.

## Label status
`IMPLEMENTED` kode ada · `TESTED` ada tes otomatis yang dijalankan · `DEPLOYED` berjalan di lingkungan nyata ·
`PARTIAL` sebagian · `DESIGNED` hanya di blueprint · `UNVERIFIED` belum dibuktikan · `BLOCKED` terhalang.
Tidak ada fitur yang berstatus `DEPLOYED`: installer belum dibangun dan Electron belum pernah dijalankan di sini.

## Tabel status per area
| Area | Status | Bukti / catatan |
|---|---|---|
| Capability Hub & Agent Registry | PARTIAL | Desktop Hub mendaftar skill, plugin, server MCP, preset provider. Belum ada manifest terpadu (provenance, lisensi, izin, versi, rollback) dan belum ada verifikasi pihak ketiga. |
| Claude Code / Codex CLI bridge | IMPLEMENTED, UNVERIFIED | `agent:run` dengan persetujuan native, prompt via stdin. Hanya diuji di UI dengan mock; `runProc`/dialog belum diuji native. |
| Skill & plugin registry | IMPLEMENTED, TESTED | Validasi manifest + bundel diuji (Node); UI diuji (mock). Plugin deklaratif saja; belum bertanda tangan. |
| MCP + izin per tool | IMPLEMENTED, TESTED | stdio dan HTTP diuji dengan server palsu; mode ketat; env diblokir bila berbahaya. Dialog native UNVERIFIED. |
| Remote MCP | IMPLEMENTED, TESTED, **dibatasi** | Blueprint §23 menempatkannya setelah validasi native; sekarang **default MATI** (flag eksperimental) dan memakai SSRF guard. |
| Model Gateway & fallback | PARTIAL | Satu provider OpenAI-compatible + preset + tool-calling. Tidak ada fallback, kuota, anggaran, atau pelacakan biaya. |
| Idea Foundry | DESIGNED | Tidak ada di kode. |
| Project Manager & task graph | PARTIAL | Daftar proyek/misi di UI lokal; tidak ada task graph atau penjadwalan. |
| Memory Manager & Galaxy | PARTIAL | "Memory Brain" lokal di UI; Galaxy tidak ada. |
| Voice Gateway (STT/TTS) | IMPLEMENTED, TESTED (headless) | STT cloud diuji dengan audio palsu di Chromium; TTS sistem. UNVERIFIED di Electron dan dengan penyedia nyata. |
| Social Media Autopilot | DESIGNED | Tidak ada. |
| Oracle / Research | DESIGNED | Tidak ada (REA hanya untuk reverse engineering). |
| Search OS / SEO | DESIGNED | Tidak ada. |
| Browser / computer-use | DESIGNED | Hanya terjangkau lewat tool REA (UNVERIFIED). |
| Credential Lifecycle Manager | PARTIAL | Secret dienkripsi `safeStorage` (API key, STT, token MCP, secret connector); tidak ada rotasi/kedaluwarsa; pencabutan hanya untuk connector. |
| Mission Control, notifikasi, audit | PARTIAL | Papan misi UI lokal. Log event aplikasi = array `localStorage` (maks 250, dapat diubah). **Baru:** audit connector berantai hash (tamper-evident). |
| Packaging, update, rollback | PARTIAL, UNVERIFIED | Konfigurasi electron-builder, CI, logika updater (diuji dengan mock). Belum ada installer terbangun, signing, atau rollback. |
| Backend cloud & Desktop Executor | DESIGNED | Tidak ada. |
| **API Connector Registry / Hub** | **IMPLEMENTED, TESTED (Node)** | Lihat `docs/api-connector-hub.md`. UI diuji dengan mock; native UNVERIFIED. |

## Konflik blueprint ↔ kode dan penyelesaian terkecil yang aman
1. **Urutan remote MCP (blueprint §23).** Remote MCP sudah dikirim pada sesi sebelumnya tanpa validasi native. Perubahan minimal: flag
   `experimental.remoteMcp` default `false` (ditegakkan di proses utama untuk `mcp:add` dan `start`), persetujuan native untuk
   mengaktifkan, dan transport HTTP kini memakai SSRF guard yang sama dengan API Hub. Tidak ada fitur yang dihapus.
2. **Policy broker pusat.** Blueprint menempatkannya di Orion Core (belum ada). Perubahan minimal: `connectors/policy.js` dibuat
   sebagai fungsi murni `decide()` sehingga dapat didelegasikan ke backend kelak; sementara ditegakkan lokal di proses utama.
3. **Emergency stop.** Sebelumnya tidak ada. Kini satu tombol menghentikan panggilan API, server MCP, dan proses anak
   (terminal/agent). Proses anak dan dialog native belum diuji native → `UNVERIFIED`.

## Risiko yang ditemukan saat audit (belum seluruhnya diatasi)
* Renderer adalah permukaan serangan (XSS di konten chat). Mitigasi: semua aksi berisiko memakai dialog persetujuan native; renderer tidak pernah menerima nilai secret.
* Log event aplikasi web dapat diubah dari `localStorage`; jangan diperlakukan sebagai bukti.
* Belum ada pemeriksaan integritas/tanda tangan untuk skill & plugin pihak ketiga.
