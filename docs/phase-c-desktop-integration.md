# Phase C — Desktop ↔ Orion Central Integration

Tanggal: 22 Okt 2026. Status: selesai (Phase A/B tidak diubah secara breaking).

## 1. Yang berubah (arsitektur)

```
┌─ ORION Desktop (Electron) ────────────┐        ┌─ Orion Central (Railway) ─┐
│ Renderer (app/index.html)              │        │ /v1/conversations*         │
│   └─ app-src/orion-cloud.js (Cloud)    │        │ /v1/sync/changes (cursor)  │
│        │ IPC (tanpa secret)            │        │ /v1/stream (SSE)           │
│ Main process (src/bridge.js)          │        │ /v1/conversations/import   │
│   └─ src/central/desktop-sync.js      │        │ PostgreSQL (truth)         │
│        ├─ token perangkat (safeStorage)│        └────────────────────────────┘
│        ├─ outbox pesan (file, persisten)│
│        └─ SSE + delta catch-up (cursor) │
└────────────────────────────────────────┘
```

- **Renderer tidak pernah memegang token.** Token perangkat disimpan terenkripsi (Windows DPAPI
  lewat `safeStorage`) di main process; renderer hanya memanggil IPC.
- **Orion Central = sumber kebenaran** untuk percakapan setelah sinkronisasi aktif. `State.convos`
  menjadi *cermin* (cache) berisi `serverId` per percakapan; server menang saat refresh.
- **Lokal tetap berfungsi**: tanpa Central (atau offline), desktop tetap memakai localStorage
  seperti sebelumnya — hanya ditandai `syncState:'local'`.

## 2. Peta dependensi `State.convos` (18 titik) & perlakuannya

| Titik | Perilaku setelah Phase C |
|---|---|
| `seedConvos()` / init `State.convos` | Seed lokal tetap (mode lokal) |
| `Chat.init` → `activeId` | tetap + `Cloud.refresh()` bila Central aktif |
| `Chat.convo()` | baca cermin lokal (server sudah disinkronkan) |
| `Chat.newConvo()` | buat lokal + **buat juga di server** (`serverId` disimpan) |
| `Chat.submit()` | pesan optimistic + kirim ke server (idempotency key = id pesan lokal) |
| `Chat.generate()` | balasan Orion + kirim ke server (role `assistant`) |
| `Chat.retry()` | hapus balasan lokal; regenerate (terkirim ulang sebagai pesan baru) |
| `renderConvos()` / `renderMsgs()` | tidak berubah (cermin) |
| pin / rename / delete | optimistic lokal + diteruskan ke server (`PATCH`/`DELETE`) |
| analytics (jumlah pesan) | tidak berubah |
| export / import backup | tidak berubah (backup lokal tetap) |
| wipe data | tidak berubah |
| pencarian global (Ctrl+K) | tidak berubah |
| seed `DB.set('convos')` | tidak berubah |

## 3. Autentikasi desktop

- Alur: **Web App → Perangkat → "+ Token perangkat"** (token ditampilkan sekali) → Owner menempel
  token di **Settings → Orion Central → Hubungkan** (desktop: `src/bridge.js` `central:desktopLogin`).
- Token disimpan terenkripsi di main process (`cfg.secrets` + `safeStorage`), **tidak** masuk renderer,
  log, atau URL. Tidak ada password Owner di desktop.
- Verifikasi identitas tetap di server: `GET /v1/session` + scope owner + status device.
- **Pencabutan device** → server menolak token (401) → desktop menandai "perangkat dicabut" dan
  **berhenti mengirim** (outbox tidak dicoba ulang).
- **Session expiry** → `SESSION_EXPIRED` → statusShown, perlu login ulang dengan token baru.

## 4. Outbox & reconnect

- Outbox pesan: file JSONL di `<userData>/central-outbox-messages/` (persisten, tahan restart).
- Idempotency key stabil: `clientMessageId` = id pesan lokal; event outbox `msg-<clientMessageId>`.
- Status pesan di UI: `local` → `syncing` → `synced` / `pending` (menunggu) / `error`.
- Retry: flush tiap 15 dtk (bersamaan dengan poll) + backoff di sisi server (delta/SSE).
- Timeout ≠ gagal: sebelum mengirim ulang, key yang sama dipakai → server dedupe (tidak duplikat).
- Secret/token tidak pernah ditulis ke outbox (hanya isi pesan).

## 5. Sinkronisasi (SSE + delta)

- Kursor persisten di `cfg.central.centralCursor` (bertahan restart).
- SSE: `GET /v1/stream` dengan header `Authorization` (token tidak pernah di URL).
- Catch-up: `GET /v1/sync/changes?since=<cursor>` — dijalankan saat SSE tersambung ulang, saat
  reconnect, dan tiap poll (15 dtk). SSE **hanya notifikasi**; data tetap diambil lewat API.
- Deduplikasi: `client_message_id` + `seq` server; renderer menyaring ID yang sudah ada.
- Renderer menerima event lewat `orion:central:event` (IPC) → `Cloud.refresh()`.

## 6. Cloud task vs local task (tetap tegas)

| Jenis | Penanda | realities |
|---|---|---|
| Cloud task | `state` misi + worker Central | jalan di server; tidak butuh desktop |
| Local task | butuh file/workspace/CLI | butuh desktop agent aktif & terautentikasi |
| Waiting approval | approval `pending` | tidak dilewati aunque Owner pindah perangkat |
| Outcome unknown | task `outcome_unknown` | tidak di-retry otomatis (Phase 3.1) |
| Offline queued | pesan `pending` di outbox | **belum** eksekusi di server |

Budget, approval, memory scope, dan policy misi tetap ditegakkan **di server** (tidak berubah di
Phase C).

## 7. Cara menjalankan

```bash
# 1) server Central
CENTRAL_DB_DRIVER=postgres DATABASE_URL=postgresql://… CENTRAL_SETUP_KEY=<32+> node src/central/server.js

# 2) web app → Perangkat → "+ Token perangkat" → salin token
# 3) desktop → Settings → Orion Central → URL + token → "Hubungkan"
# 4) chat: pesan dari desktop muncul di web & sebaliknya
```

## 8. Troubleshooting
| Gejala | Penyebab & solusi |
|---|---|
| Status "Orion lokal" | Central belum dikonfigurasi / token belum ditempel → Settings → Orion Central |
| Status "perangkat dicabut" | device dicabut di web → buat token baru |
| Pesan stuck "Menunggu sinkronisasi" | Central tak terjangkau → pesan aman di outbox, terkirim saat online |
| Percakapan lama tidak muncul | riwayat lokal belum dimigrasikan → Settings → Orion Central → "Migrasi data lokal" |
| SSE tidak konek | proxy/Railway dapat memblokir streaming → dipakai fallback delta 15 dtk (tetap sinkron) |
