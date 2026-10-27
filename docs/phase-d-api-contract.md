# Phase D — API Contract (mobile ↔ Orion Central)

Semua endpoint memakai prefix `/v1`, JSON, dan **device token** lewat header:
```
Authorization: Bearer <device token>
```
Owner selalu dari token. Kesalahan memakai bentuk seragam:
```json
{ "error": { "code": "CONFLICT", "message": "Persetujuan sudah diputuskan." } }
```
Kode yang sering: `UNAUTHENTICATED`(401), `SESSION_EXPIRED`(401), `SESSION_REVOKED`(401),
`DEVICE_REVOKED`(401), `FORBIDDEN`(403), `NOT_FOUND_OR_FORBIDDEN`(404), `CONFLICT`(409),
`BAD_ROLE`(400), `MESSAGE_TOO_LARGE`(413), `RATE_LIMITED`(429), `INTERNAL_ERROR`(500),
`DEPENDENCY_UNAVAILABLE`(503), `NETWORK_ERROR`(0, sisi klien), `TIMEOUT`(0, sisi klien).

## 1. Identitas
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/v1/session` | — | `{ownerId, displayName, email, role, deviceId, authMethod, expiresAt}` |
| GET | `/v1/health` | — | `{status:"ok"}` (tanpa auth) |
| GET | `/v1/ready` | — | `{status:"ready", migrations:N}` (tanpa auth) |

## 2. Percakapan & pesan
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/v1/conversations?limit=30` | — | `{conversations:[…], nextCursor, hasMore}` |
| POST | `/v1/conversations` | `{title, clientKey}` | `{conversation, duplicate}` — `clientKey` membuat idempoten |
| GET | `/v1/conversations/:id` | — | `{conversation, messages}` |
| PATCH | `/v1/conversations/:id` | `{title?, pinned?, expectedUpdatedAt?}` | `{conversation}` — versi basi → `409` |
| DELETE | `/v1/conversations/:id` | — | `{ok, conversationId, deletedAt}` (soft delete) |
| GET | `/v1/conversations/:id/messages?after=<seq>&limit=50` | — | `{messages:[…], nextSeq, hasMore}` |
| POST | `/v1/conversations/:id/messages` | `{role, content, clientMessageId}` | `{message, duplicate}` — `clientMessageId` idempoten |
| POST | `/v1/conversations/:id/respond` | `{clientMessageId}` | `{message, usage, provider, model}` — inferensi server |

Pesan: `role` ∈ `user|assistant|system|tool`; `content` maks 32.000 karakter; urutan = `seq` server.

## 3. Misi
| Method | Path | Response |
|---|---|---|
| GET | `/v1/missions` | `{missions:[{id,title,state,budget_limit,budget_spent,budget_reserved,executions,max_executions,…}]}` |
| GET | `/v1/missions/:id` | `{mission, tasks:[…], approvals:[…]}` |
| POST | `/v1/missions/:id/cancel` | `{ok, missionId, state}` |

Status misi: `queued|planning|running|waiting_approval|paused|recovering|completed|failed|cancelled`
(+ `outcome_unknown` pada level task). Budget dihitung server; angka dari klien tidak dipercaya.

## 4. Approval
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/v1/approvals?status=pending` | — | `{approvals:[…]}` (termasuk `params`, `scope`, `fingerprint`, `expires_at`) |
| POST | `/v1/approvals/:id/decision` | `{decision:"approved"\|"rejected"}` | `{ok, approvalId, status}` |

Aturan: server-authoritative; keputusan kedua → `409`; kedaluwarsa → `409 EXPIRED`;
fingerprint approval tetap terikat aksi+resource+params+scope.

## 5. Perangkat
| Method | Path | Response |
|---|---|---|
| GET | `/v1/devices` | `{devices:[{id,name,platform,status,created_at,last_seen_at}]}` |
| POST | `/v1/devices` | `{deviceId, token, expiresAt}` — token **sekali** |
| DELETE | `/v1/devices/:id` | `{ok, deviceId}` — mencabut token & sesi device |

## 6. Sinkronisasi (delta)
| Method | Path | Response |
|---|---|---|
| GET | `/v1/sync/changes?since=<cursor>&limit=100&types=a,b` | `{changes:[{id,cursor,type,payload,received_at}], cursor, hasMore}` |
| GET | `/v1/events?after=<cursor>&limit=100` | `{events:[…], cursor, hasMore}` (event mentah) |

Tipe event relevan mobile: `message.created`, `conversation.created|updated|deleted`,
`mission.*`, `approval.*`. Kursor bersifat **server**; waktu klien bukan sumber kebenaran.

## 7. Push token
| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/v1/push/register` | `{token, platform:"android"\|"ios"}` | `{ok, id}` |
| POST | `/v1/push/revoke` | `{token}` | `{ok}` |
| GET | `/v1/push/tokens` | — | `{tokens:[…]}` |

## 8. Audit
| Method | Path | Response |
|---|---|---|
| GET | `/v1/audit?limit=50` | `{entries:[{action,outcome,target_type,created_at,…}]}` |

## 9. Paritas kontrak (dijaga tes otomatis)
`scripts/test-phaseD-mobile.js` mem-parse path yang dipakai `mobile/src/api/client.ts` lalu memverifikasi
setiap path terdaftar di router backend (`src/central/app.js`). Perubahan API yang lupa
diumpan mobile akan menggagalkan tes.
