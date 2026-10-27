# Orion Central — Multi-Device API (v1)

Semua endpoint memakai prefix `/v1`, JSON, dan autentikasi **bearer token** (desktop/mobile) atau
**sesi browser** (web/PWA). Owner ID selalu dari token — bukan dari payload.

## 1. Konvensi umum

### Header
| Header | Wajib | Keterangan |
|---|---|---|
| `Authorization: Bearer <token>` | ya (kecuali health/ready/bootstrap) | token perangkat atau access token sesi |
| `Content-Type: application/json` | ya (POST/PATCH) | — |

### Bentuk error
```json
{ "error": { "code": "CONFLICT", "message": "Percakapan diubah di perangkat lain." } }
```
Kode yang sering muncul: `UNAUTHENTICATED` (401), `FORBIDDEN` (403),
`NOT_FOUND_OR_FORBIDDEN` (404 — reply 404 untuk data milik owner lain agar keberadaan tidak bocor),
`CONFLICT` (409), `MISSING_FIELDS` (400), `PAYLOAD_TOO_LARGE` (413), `RATE_LIMITED` (429).

### Batas
| Batas | Nilai |
|---|---|
| Body maksimum | `CENTRAL_MAX_BODY_BYTES` (default 1 MiB) |
| Rate limit | `CENTRAL_RATE_LIMIT_PER_MIN` (default 120/menit per IP) |
| Halaman maksimum | 100 item (percakapan), 100 item (pesan) |
| Panjang judul percakapan | 200 karakter |
| Panjang pesan | 32 000 karakter |
| Role pesan | `user` \| `assistant` \| `system` \| `tool` |

## 2. Health

### `GET /v1/health` — tanpa auth
```json
{ "status": "ok", "service": "orion-central", "version": "1.0.0" }
```
### `GET /v1/ready` — tanpa auth, timeout 3 detik
`200 {"status":"ready","migrations":8}` · `503 {"status":"not_ready","error":{"code":"DEPENDENCY_UNAVAILABLE"}}`

## 3. Auth & device

| Method | Path | Keterangan |
|---|---|---|
| POST | `/v1/auth/bootstrap` | Butuh header `x-setup-key` (env `CENTRAL_SETUP_KEY`). Membuat owner + token pertama. **Sekali.** |
| POST | `/v1/devices` | `{name, platform}` → `{deviceId, token, expiresAt}` |
| GET | `/v1/devices` | daftar device owner |
| DELETE | `/v1/devices/:id` | cabut device → token **dan sesi** device ikut mati |
| POST | `/v1/auth/token` | terbitkan token baru (scope `auth:issue`) |
| POST | `/v1/auth/token/:id/rotate` | rotasi token (yang lama langsung mati) |
| DELETE | `/v1/auth/token/:id` | cabut token |

## 4. Sesi browser (web/PWA) — baru di Phase A

| Method | Path | Body | Hasil |
|---|---|---|---|
| POST | `/v1/sessions` | `{accessTtlMinutes?, refreshTtlDays?, userAgent?}` | `{sessionId, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt}` |
| POST | `/v1/sessions/refresh` | `{refreshToken}` | token baru (**rotasi**); token lama tidak berlaku |
| GET | `/v1/sessions` | — | daftar sesi owner (tanpa token) |
| DELETE | `/v1/sessions/:id` | — | logout / cabut sesi |

> **Replay refresh token** (memakai token lama lagi) → `401 REFRESH_REPLAY_DETECTED` dan **seluruh
> sesi dicabut** (tanda token bocor).

## 5. Percakapan & pesan — baru di Phase A

### `POST /v1/conversations`
```json
{ "title": "RencanaDIGIUM", "clientKey": "uuid-klien-1", "metadata": {} }
```
`201` → `{conversation, duplicate:false}` · `200` → `{conversation, duplicate:true}` bila `clientKey` sama.

### `GET /v1/conversations?limit=20&before=<updated_at>&includeDeleted=0`
```json
{ "conversations": [ { "id":"cnv-…", "title":"…", "pinned":false, "last_seq":4,
                        "message_count":4, "created_at":"…", "updated_at":"…" } ],
  "nextCursor": "2026-10-22T…", "hasMore": true }
```

### `GET /v1/conversations/:id`
`{conversation, messages:[20 pesan terakhir]}`

### `PATCH /v1/conversations/:id`
```json
{ "title": "Judul baru", "pinned": true, "expectedUpdatedAt": "2026-10-22T10:00:00.000Z" }
```
- Tanpa `expectedUpdatedAt` → update langsung.
- Dengan `expectedUpdatedAt` yang **tidak cocok** → `409 CONFLICT` (perubahan di perangkat lain).
  Ini mencegah last-write-wins buta.

### `DELETE /v1/conversations/:id` — soft delete (`deleted_at`)

### `POST /v1/conversations/:id/messages`
```json
{ "role": "user", "content": "Halo Orion", "clientMessageId": "uuid-pesan-1" }
```
`201` → `{message, duplicate:false}` · `200` → `{message, duplicate:true}` bila `clientMessageId` sama
(retry lintas perangkat **tidak** menduplikasi).

`message.seq` = urutan server (menaik per percakapan). Timestamp klien **diabaikan** untuk urutan.

### `GET /v1/conversations/:id/messages?after=<seq>&limit=50`
```json
{ "messages": [ {"id":"msg-…","seq":1,"role":"user","content":"…","device_id":"dev-…","created_at":"…"} ],
  "nextSeq": 4, "hasMore": false }
```

## 6. Misi, approval, memory, skill, job (dari Phase 2–5, tidak berubah)

| Method | Path | Keterangan |
|---|---|---|
| POST/GET | `/v1/missions` | buat/daftar misi |
| GET | `/v1/missions/:id` | misi + task + approval |
| POST | `/v1/missions/:id/cancel` | batalkan |
| GET | `/v1/approvals?status=pending` | daftar approval |
| POST | `/v1/approvals/:id/decision` | `{decision:"approved"\|"rejected"}` — server-authoritative, sekali saja |
| GET | `/v1/memory?q=&scope=&type=&status=` | cari memori (scope & sensitivity ditegakkan) |
| GET | `/v1/memory/:id` | detail + riwayat versi |
| POST | `/v1/memory/import` | impor metadata memori (migrasi Phase 4) |
| POST | `/v1/skills/import` | impor versi skill |
| GET | `/v1/skills/versions` | daftar versi skill (hash, status evaluasi) |
| POST | `/v1/skills/versions/:id/activate` | aktivasi (hash + evaluasi + policy wajib) |
| GET | `/v1/jobs`, `/v1/jobs/:id` | status job + attempt |
| POST | `/v1/jobs/:id/retry` | retry job (bukan dead-letter) |
| GET | `/v1/audit?limit=50` | audit trail owner |

## 7. Sinkronisasi

### `POST /v1/events` (outbox klien)
```json
{ "events": [ { "eventId":"ev-…", "type":"mission.state", "schemaVersion":1, "deviceSeq":12,
                "clientCreatedAt":"…", "payload":{ } } ] }
```
`200` → `{accepted, duplicates, rejected, conflicts, errors[], cursor}`
- `eventId` unik → upload ulang = `duplicates` (tidak menggandakan).
- `deviceSeq` unik per (owner, device).
- Payload berisi `owner_id`/`role`/`permissions` → **ditolak** (`CLIENT_SCOPE_FIELD_FORBIDDEN`).
- Tipe server-authoritative (`approval.decision`, `memory.verification`, `skill.active`,
  `budget.spent`) → **ditolak** & dicatat di `event_conflicts`.

### `GET /v1/events?after=<cursor>&limit=100` — pull event mentah.

### `GET /v1/sync/changes?since=<cursor>&limit=100&types=message.created,conversation.created`
**Delta feed terpadu** (semua entitas dalam satu cursor):
```json
{ "changes": [ { "id":"ev-…", "cursor":42, "type":"message.created", "payload":{…} } ],
  "cursor": 42, "hasMore": false }
```

### `GET /v1/stream` — SSE realtime
- Wajib `Authorization` header. `EventSource` **tidak** bisa mengirim header → gunakan
  `fetch()` + `ReadableStream` di web app.
- Event: `ready` (saat terhubung), `change` (perubahan), heartbeat `: ping` tiap 20 detik.
- Setelah reconnect, klien **wajib** menarik `/v1/sync/changes?since=<cursor>` untuk caught-up —
  SSE bukan sumber kebenaran.

## 8. Contoh alur lintas perangkat

```
Desktop                    Central                    Web / Mobile
  │ POST /v1/conversations ─▶│ (simpan, cursor=10)        │
  │ ◀─ 201 {conversation} ────│                            │
  │ POST .../messages ──────▶│ (seq=1, event message.created)
  │                           │◀── GET /v1/sync/changes?since=0 ──│
  │                           │──── messages[], cursor=10 ────▶│
  │                           │◀── POST .../messages (clientMessageId) ──│
  │                           │ (seq=2; duplikat clientMessageId → 200 duplicate)
  │ ◀─ GET .../messages?after=1 ────────────────────────────│
```

## 9. Contoh payload (ringkas)

**Buat percakapan**
```json
{ "title": "RencanaDIGIUM", "clientKey": "b1f0…", "metadata": { "origin": "desktop" } }
```
**Kirim pesan**
```json
{ "role": "user", "content": "Buat ringkasan mingguan", "clientMessageId": "m-9f2c…" }
```
**Putuskan approval**
```json
{ "decision": "approved" }
```
**Sinkronkan event**
```json
{ "events": [ { "eventId":"ev-77", "type":"mission.state", "schemaVersion":1, "deviceSeq":31, "payload": { "state":"running" } } ] }
```
