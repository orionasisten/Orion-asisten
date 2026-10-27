# Orion Multi-Device Architecture

Status: **Phase A selesai** (fondasi API & data lintas perangkat). Phase B–F belum dikerjakan.
Tanggal: 22 Okt 2026.

## 1. Prinsip

1. **Orion Central adalah sumber kebenaran tunggal** untuk percakapan, misi, approval, memory, dan
   status eksekusi. Desktop/web/mobile adalah *klien* dari API yang sama.
2. **Identitas berasal dari server.** Owner ID selalu diturunkan dari token/sesi terautentikasi;
   payload klien tidak pernah dipercaya untuk menentukan owner, scope, biaya, atau status verifikasi.
3. **Urutan ditentukan server.** Pesan memakai `seq` server (bukan timestamp klien), sehingga
   urutan identik di semua perangkat.
4. **Idempotensi di setiap operasi penting.** `clientKey` (percakapan), `clientMessageId` (pesan),
   `eventId` (sinkronisasi), `idempotency_key` (job).
5. **Konflik punya aturan eksplisit, bukan LWW buta.** Metadata percakapan memakai optimistic
   concurrency (409). Approval/verification/budget/skill-pointer bersifat *server-authoritative*.
6. **Cloud vs local task dibedakan tegas.** Task yang butuh file/workspace tetap butuh desktop agent
   yang terautentikasi; server tidak pernah menjalankan perintah di komputer Owner.
7. **Tidak ada sistem kedua.** Percakapan, misi, approval, memory, budget, skill, outbox, dan queue
   Phase 1–5.1 dipakai apa adanya; Phase A hanya menambah lapisan yang belum ada.

## 2. Pemetaan Phase 0–5.1 → multi-device

| Area |pra-Phase A | Phase A |
|---|---|---|
| Percakapan/pesan | **hanya `localStorage` renderer** (`State.convos`) — tidak lintas perangkat | `conversations` + `messages` di PostgreSQL (`migrasi 008`), API `/v1/conversations*` |
| Auth | bearer token per device (hash SHA-256) | + **sesi browser** (`/v1/sessions`: access+refresh, hash, rotasi, deteksi replay, revocation) |
| Device | register/list/revoke | + revoke device **ikut mencabut sesi** device tersebut |
| Sync | tabel `events` + cursor + outbox desktop | + **delta feed terpadu** `/v1/sync/changes` (semua entitas, satu cursor) + **SSE** `/v1/stream` |
| Misi/approval/memory/skill | sudah ada (Phase 2–5) | dipakai ulang;(strict) endpoint baru tidak menduplikasi |
| Budget/queue | sudah ada (Phase 3) | tidak berubah — enforcement tetap di server |

## 3. Diagram

```mermaid
flowchart LR
  subgraph Clients["Clients"]
    D[Windows Desktop\n(Electron: lokal + outbox)]
    W[Web App\n(Phase B: Cloudflare Pages)]
    M[Android / iOS\n(Phase D: Expo)]
  end
  subgraph Central["Orion Central (Railway)"]
    API[API v1\nauth • convos • missions • approvals\nmemory • skills • jobs • sync • SSE]
    DB[(PostgreSQL)]
    Q[Durable queue]
  end
  D -->|HTTPS + bearer/session| API
  W -->|HTTPS + session cookie/token| API
  M -->|HTTPS + session| API
  API --> DB
  API --> Q
  D -.->|local task (butuh file/workspace)| D
  API -.->|cloud task| Q
```

## 4. Kontrak inti

| Entitas | Identitas | Urutan | Idempotensi | Konflik |
|---|---|---|---|---|
| Conversation | `id` (server) | `updated_at` (server) | `client_key` | optimistic concurrency → 409 |
| Message | `id` (server) | `seq` per percakapan (server) | `client_message_id` | append-only (tidak pernah ditimpa) |
| Event | `id` (client-generated, unik) | `cursor` (server) | `id` unik | kebijakan per tipe (lihat `policy/scope.js`) |
| Approval | `id` (server) | — | fingerprint unik | **server-authoritative** |
| Memory record | `id` (lama, dipertahankan) | `content_version` | id + hash | merge-append, `inferred` tidak naik |
| Skill version | `version_id` (dari hash) | — | version_id | immutable, hash diverifikasi saat aktivasi |
| Job | `id` (server) | `priority`/`available_at` | `idempotency_key` | retry terbatas → dead-letter |

## 5. Batas keamanan

- **Renderer/browser/mobile tidak pernah menentukan biaya, scope, owner, atau status verifikasi.**
- **Approval terikat fingerprint** (aksi, resource, parameter, scope) — parameter berubah → approval
  baru; approval kedaluwarsa/berubah hash → ditolak.
- **Tidak ada eksekusi perintah arbitrer dari browser/mobile** — mobile/web hanya membaca status &
  mengambil keputusan approval yang divalidasi server.
- **Device revocation** mencabut token device **dan** sesinya; data Owner tidak dihapus.
- **Refresh token replay** (dipakai lagi) → seluruh sesi dicabut.
- Konten web/tool diperlakukan sebagai **data tidak tepercaya**, bukan instruksi sistem.

## 6. Batas yang masih ada (jujur)

- **Web App belum ada** (Phase B) — saat ini hanya API + desktop.
- **Android/iOS belum ada** (Phase D) — tidak ada klaim rilis store.
- **Realtime = SSE** (bukan WebSocket); SSE tidak otomatis reconnect + resume — klien harus
  memakai cursor delta feed untuk caught-up setelah reconnect.
- **Rate limiter in-memory per instance** (bukan lintas instance) — perlu store bersama bila
  diskalakan multi-instance.
- **Deployment Railway belum dijalankan** (belum ada kredensial).
