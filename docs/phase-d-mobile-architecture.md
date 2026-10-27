# Phase D — Mobile Architecture (Android & iOS)

Tanggal: 22 Okt 2026. Stack: **React Native 0.88 + Expo SDK 58 + TypeScript**.

## 1. Posisi mobile dalam arsitektur Orion
```
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│ Windows Desktop │   │  Web App        │   │  Mobile (RN)    │
│ (Electron)      │   │  (React/Vite)   │   │  (Expo)         │
└────────┬────────┘   └────────┬────────┘   └────────┬────────┘
         │  device token (bearer)                   │
         └───────────────┬─────────────────────────┘
                         ▼
              Orion Central (Railway)
              API v1 · PostgreSQL · queue
                         ▲
                         │  device token (bearer, native)
                  ┌──────┴───────┐
                  │ Android/iOS  │  ← aplikasi ini
                  └──────────────┘
```
Mobile adalah **klien API**, bukan sumber kebenaran. Ia tidak menentukan izin, anggaran, status misi,
atau approval — semua itu ditegakkan server (`src/central/app.js`).

## 2. Struktur folder
```
mobile/
  App.tsx                    root: providers + tab bar (Chat/Misi/Setuju/Perangkat/Atur)
  app.json                   config Expo (bundle id, plugin secure-store & notifications)
  src/
    theme.ts                 palet ORION (latar #07090D, aksen #F5B82E, tipografi)
    api/client.ts            klien HTTP (bearer, normalisasi error, tanpa dependensi RN)
    api/types.ts             tipe kontrak
    api/platform.ts          platform & nama perangkat (terpisah agar client testable di Node)
    state/session.tsx        pairing, sesi, expiry, revocation, reauth
    state/sync.ts            outbox pesan + delta catch-up
    storage/stores.ts        secure store (token) & AsyncStorage (outbox, cursor)
    components/ui.tsx        Card/Button/Field/Tag + state loading/empty/error/offline
    components/TabBar.tsx    navigasi bawah (Android & iOS)
    screens/                 Login, Chat, Missions, Approvals, Devices, Settings
  __tests__/mobile.test.ts   unit test (jest)
  AGENTS.md                  aturan kerja khusus folder ini
```

## 3. Navigasi
Tab bar bawah (5 tab) — pola yang nyaman untuk sentuh di kedua platform:
`Chat · Misi · Setuju · Perangkat · Atur`. Ikon & warna mengikuti identitas Orion.
Tablet/landscape: konten tetap satu kolom agar mudah dibaca; tidak ada layout desktop-yang-dipotong.

## 4. Identitas visual
Menggunakan palet yang sama dengan Desktop & Web (dari `:root` di `source/Orion_v_4_0.html`):
`--bg #07090D`, `--panel #0D1119`, `--surf #131A25`, `--gold #F5B82E`, `--gold2 #FFD978`,
`--teal #39E0CE`, `--red #F2545B`, teks `#F4F5F7/#A6AFBD/#66738A`.
Tipografi: Space Grotesk (display), Inter (isi), JetBrains Mono (meta). Mode gelap (`userInterfaceStyle: dark`).

## 5. State & error handling
| Keadaan | Perlakuan |
|---|---|
| Loading awal | "Memeriksa sesi dengan Orion Central…" |
| Belum paired | Layar pairing (URL + token perangkat) |
| Offline | Banner amber + data terakhir tetap tampil; pesan aman di outbox |
| Kosong | Empty state per layar (bukan layar kosong) |
| 401 | `expired`/`revoked`/`anonymous` → status jelas + ajakan pairing ulang |
| 403/404/409/429/5xx | Pesan error server dinormalisasi (tanpa stack trace) |
| Token habis | Status "perangkat dicabut" + pengiriman outbox dihentikan |

## 6. Offline & sinkronisasi
- **Outbox** (AsyncStorage, tanpa secret): pesan menunggu dengan `clientMessageId` stabil.
- **Cursor** disimpan lokal → catch-up `/v1/sync/changes?since=<cursor>` setelah restart.
- Polling 12 detik saat foreground (SSE tidak dipakai sebagai,andalan: koneksi panjang tidak
  diandalkan di background mobile).
- Entri yang permanen gagal (mis. percakapan dihapus) tetap disimpan sebagai `failed`, **tidak** memblokir
  antrean, dan **tidak** di-retry otomatis. UI menampilkan "N pesan gagal terkirim" dengan tombol
  **Kirim ulang** / **Hapus** sehingga tidak ada pesan yang hilang diam-diam.
- 401/expired → pengiriman dihentikan, status ditampilkan.

## 7. Push notification
- `expo-notifications`; token didaftarkan ke server (`POST /v1/push/register`) — terikat owner + device.
- **Tanpa kredensial provider** (tidak ada `EXPO_PUBLIC_EAS_PROJECT_ID`) → mode pengembangan:
  aplikasi melaporkan jujur "push nyata belum aktif", tidak berpura-pura.
- Notifikasi hanya berisi jenis peristiwa ("Misi selesai", "Approval perlu keputusan"), **tanpa** isi
  percakapan atau token.

## 8. Yang TIDAK ada di mobile (batas disengaja)
- Tidak ada penentuan budget/approval/izin lokal.
- Tidak ada akses filesystem/workspace.
- Tidak ada eksekusi shell/agent.
- Tidak ada penyimpanan kredensial selain `expo-secure-store`.
