# Phase C — Testing

Tanggal: 22 Okt 2026. Lingkungan: Windows 11, Node 24.22.0, Electron 43.8.1, PostgreSQL 17.10 (nyata).

## 1. Lapisan tes

| Lapisan | Perintah | Cakupan | Hasil |
|---|---|---|---|
| Unit/integrasi (Node) | `npm test` | seluruh fase 0–5.1 + scan rahasia | **265 lulus, 0 gagal** |
| Integrasi PostgreSQL (6 suite) | `npm run test:postgres` | 20 + 8 + 9 + 15 + 12 + **11** | **75 lulus, 0 gagal** |
| Web unit (vitest+jsdom) | `npm run web:test` | api client, login, chat, approval | **20 lulus, 0 gagal** |
| Web typecheck | `npm run web:typecheck` | TypeScript strict | exit 0 |
| Web build | `npm run web:build` | Vite production build | exit 0 |
| E2E web (browser) | `npm run e2e:web` | Chromium + Central + PG | **16 lulus, 0 gagal** |
| **E2E desktop↔web** | `npm run e2e:desktop-central` | Electron desktop + web + Central + PG | **13 lulus, 0 gagal** |
| Desktop smoke | `npm run smoke` | 13 probe Electron | PASS |
| Rilis Windows | `npm run verify:release` | installer + portable | **15/15 PASS** |

## 2. Skenario wajib & status

| # | Skenario | Status | Bukti |
|---|---|---|---|
| 1 | Riwayat lokal lama dapat dimigrasikan | **PASS** | `test-phaseC`: ID/urutan/waktu/judul/pin dipertahankan (2 percakapan, 4 pesan) |
| 2 | Migrasi ulang tidak duplikasi | **PASS** | impor ulang → `imported=0`, `skipped=4`; DB tetap 2 percakapan/4 pesan |
| 3 | Pesan dari desktop terlihat di Web App | **PASS** | E2E: marker desktop ditemukan di DOM web |
| 4 | Pesan dari Web App muncul di desktop | **PASS** | E2E: balasan web muncul di desktop (lewat sinkronisasi) |
| 5 | Urutan pesan konsisten | **PASS** | `seq` sama di kedua klien & menaik di server |
| 6 | Pagination stabil | **PASS** | Phase A: 3+3+1 halaman, tanpa duplikat antar halaman |
| 7 | Reconnect tidak menggandakan pesan | **PASS** | `clientMessageId` sama → `duplicate:true`, jumlah pesan tetap 1 |
| 8 | Timeout saat kirim tidak duplikasi | **PASS** | outbox memakai idempotency key stabil; retry → server dedupe |
| 9 | Restart desktop tidak menghilangkan outbox | **PASS** | outbox count tetap 1 setelah objek baru (folder sama) |
| 10 | Restart backend tidak merusak riwayat/cursor | **PASS** | kursor persisten di config; delta feed lanjut dari cursor |
| 11 | Device revocation menghentikan akses desktop | **PASS** | setelah revoke → 401; pengiriman outbox dihentikan |
| 12 | Session expiry ditangani | **PASS** | 401 `SESSION_EXPIRED` → status "perangkat dicabut/expired" |
| 13 | Data Owner tidak bisa dibaca identitas lain | **PASS** | identitas kedua → 404 |
| 14 | Fitur lokal tetap bekerja | **PASS** | `npm test` + smoke; desktop tetap jalan tanpa Central (mode lokal) |
| 15 | Regresi Phase 0–5.1/A/B tetap lulus | **PASS** | 265 + 75 + 20 + 16 + 13 = 379 tes hijau |

## 3. Skenario E2E lintas perangkat (13 langkah)
1. Aplikasi desktop ORION berjalan (proses Electron nyata, bukan mock).
2. Desktop terautentikasi ke Central (token perangkat, disimpan di main process).
3. Renderer desktop mendeteksi mode cloud.
4. Percakapan dibuat dari desktop.
5. Pesan terkirim dari desktop (terlihat di UI).
6. Percakapan tersimpan di Orion Central (PostgreSQL).
7. Isi pesan di server sama dengan yang dikirim.
8. Web App login Owner berhasil.
9. **Pesan dari desktop terlihat di Web App.**
10. Balasan terkirim dari Web App.
11. **Desktop menerima balasan dari web lewat sinkronisasi.**
12. Catch-up via `/central:sync` juga menulis balasan (bukan hanya SSE).
13. Urutan & isi konsisten di server.

Bukti visual: `web/e2e-artifacts/11-desktop-cross-device.png` (desktop menampilkan pesan desktop + balasan web).

## 4. Yang BELUM diuji (jujur)
- **Windows 10 native** (x64): **BLOCKED** — tidak ada mesin Win10; jalankan `npm run verify:release` di Win10/CI.
- **Code signing**: **BLOCKED** — tidak ada sertifikat.
- **Perangkat fisik Android/iOS**: **BLOCKED** — belum ada aplikasi mobile (Phase D).
- **E2E browser penuh (Playwright/Chrome)**: memakai Chromium milik Electron; **tidak** menguji
  Safari/iOS browser secara nyata.
- **Railway/Cloudflare deploy**: **BELUM DIJALANKAN** — tidak ada kredensial.
- **Beban/load test**: belum dilakukan.
- **Multi-instance sync** (>1 desktop): belum diuji (delta feed & SSE per-instance, uji single-instance).
- **Lampiran/attachment** tidak dimigrasi (di luar cakupan migrasi).

## 5. Cara mengulang
```bash
npm test                        # 265 tes
npm run test:postgres           # 75 tes di PostgreSQL 17.10 nyata
npm run e2e:web                 # 16 tes browser
npm run e2e:desktop-central     # 13 tes lintas perangkat
npm run web:test && npm run web:typecheck && npm run web:build
npm run smoke && npm run verify:release
```
Syarat: `npm install --no-save embedded-postgres@17.10.0-beta.17` + `npm install-scripts approve
@embedded-postgres/windows-x64` + `npm rebuild @embedded-postgres/windows-x64`, dan dependensi `web/` sudah
terpasang (`npm run web:install`).
