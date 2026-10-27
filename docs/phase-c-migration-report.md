# Phase C — Migration Report (riwayat percakapan lokal → Orion Central)

Tanggal: 22 Okt 2026.

## 1. Format data lama (audit sebelum migrasi)

Struktur `State.convos` (localStorage `orion.convos`):
```json
[{
  "id": "cnv-…", "title": "…", "pinned": false,
  "createdAt": "ISO-8601", "updatedAt": "ISO-8601",
  "messages": [ { "id": "m-…", "role": "user|orion", "text": "…", "t": "ISO-8601" } ]
}]
```
Catatan: role lokal `orion` (bukan `assistant`); `attachments` hanya ada di UI (tidak dibawa).

## 2. Endpoint migrasi

`POST /v1/conversations/import` (butuh token terautentikasi):
```json
{ "conversations": [ … ] }
```
Respons (laporan):
```json
{ "found": 2, "imported": 4, "skipped": 0, "failed": 0,
  "conversations": 2, "messages": 4,
  "conflicts": [ { "id":"cnv-local-1", "reason":"CONTENT_DIFFERS", "resolution":"KEPT_EXISTING" } ],
  "errors": [] }
```

## 3. Aturan yang diterapkan
| Aturan | Implementasi | Hasil uji |
|---|---|---|
| ID dipertahankan | `id` lokal dipakai bila pola aman (`[A-Za-z0-9_-]{3,64}`) | ✓ terverifikasi di DB |
| Urutan pesan | `seq` = urutan asli (1..n) | ✓ |
| Waktu | `createdAt`/`updatedAt`/pesan `t` dipakai bila valid; **tidak dikarang** | ✓ |
| Judul & pin | dipertahankan | ✓ |
| Metadata | `migratedFrom` disimpan | ✓ |
| Role | `orion` → `assistant` | ✓ |
| Idempotensi | `client_key = 'migrated:<id>'` + `client_message_id` = id pesan lokal | ✓ impor ulang = 0 duplikat |
| Konflik ID | ID yang sudah dipakai → ID baru + dilaporkan (`REASSIGNED`) | ✓ |
| Konflik isi | isi berbeda pada id yang sama → **tidak ditimpa**, dilaporkan (`KEPT_EXISTING`) | ✓ |
| Gagal sebagian | dicatat per record (`failed`, `errors[]`), import lain tetap jalan | ✓ |
| Sumber data | **tidak dihapus** — salinan lokal tetap di localStorage | ✓ (dibuktikan: data lokal utuh setelah impor) |
| Tidak impor ulang tiap start | impor hanya saat Owner menjalankan migrasi (tombol/CLI), bukan otomatis | ✓ |
| Server yang memvalidasi | import hanya lewat token terautentikasi; tanpa token → 401 | ✓ |

## 4. Pemetaan field

| Lokal | Server |
|---|---|
| `id` (percakapan) | `conversations.id` (dengan penanganan konflik) |
| `id` (percakapan) | `conversations.client_key` = `migrated:<id>` (penanda idempotensi) |
| `title` | `conversations.title` |
| `pinned` | `conversations.pinned` (0/1) |
| `createdAt` / `updatedAt` | `conversations.created_at` / `updated_at` |
| `messages[].id` | `messages.client_message_id` (idempotensi) |
| `messages[].role` `orion` | `messages.role` `assistant` |
| `messages[].text` | `messages.content` |
| `messages[].t` | `messages.created_at` |
| `messages[].model`/`demo` | `messages.metadata` |

## 5. Jumlah record terverifikasi (run uji integrasi Phase C)
Fixture: 2 percakapan, 4 pesan.
- Run 1: `found=2, conversations=2, messages=4, imported=4, failed=0`
- Run 2 (ulang): `imported=0, skipped=4` — tidak ada duplikat (verifikasi: `conversations=2`, `messages=4`)
- Run 3 (isi berbeda, id sama): `conflicts=1 (KEPT_EXISTING)`, isi asli **tidak** berubah, jumlah percakapan tetap 2.

## 6. Prosedur migrasi nyata (Owner)
1. Pastikan Central aktif & desktop terautentikasi (Settings → Orion Central → Hubungkan).
2. Cadangkan data lokal lebih dulu (Settings → Data → Export Semua Data) — migrasi tidak menghapus sumber.
3. Settings → Orion Central → **Migrasi data lokal** → lihat laporan (found/imported/skipped/conflicts).
4. Verifikasi di Web App: daftar percakapan muncul dengan isi & urutan yang sama.
5. Bila perlu mengulang: aman — idempoten (laporan akan menunjukkan `skipped`, bukan duplikat).

## 7. Rollback
- **Migrasi**: hapus hasil impor di server bila perlu (`DELETE` per percakapan dari Web App). Salinan lokal
  tidak pernah hilang, jadi tidak ada data yang hilang.
- **Kode**: pasang ulang build sebelumnya; data lokal & server tetap utuh (dipisah per store).

## 8. Batasan
- Lampiran/attachment tidak dimigrasi (hanya teks) — harus dikonfirmasi bila dibutuhkan.
- `messages[].status` (error/synced) tidak dimigrasi (status transient, bukan data).
- Migrasi hanya untuk percakapan; memory & skill punya jalurnya sendiri (Phase B/5).
