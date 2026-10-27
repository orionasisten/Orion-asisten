# Phase D — Autentikasi & Pairing Perangkat

Tanggal: 22 Okt 2026.

## 1. Audit mekanisme yang tersedia (Phase A–C)
| Mekanisme | Bentuk | Cocok untuk native? |
|---|---|---|
| Bearer token perangkat | `Authorization: Bearer <device token>`, hash SHA-256 di server, expiry + revocation | **Ya** — dipakai mobile |
| Sesi browser (cookie) | `HttpOnly` cookie + CSRF double-submit + `SameSite` | **Tidak** — native tidak punya cookie jar, dan proteksi CSRF tidak relevan/tidak berlaku untuk native |
| API key model (`aikey`) | Rahasia provider AI | **Tidak pernah** — hanya untuk proses desktop |

Kesimpulan: mobile memakai **device token (bearer)**, alur yang sama dengan Desktop (Phase C).
Cookie auth **tidak** dilewati/dilemahkan, dan CSRF/CORS Web App **tidak** diubah.

## 2. Alur pairing (Owner)
1. Owner membuka **Web App → Perangkat → “+ Token perangkat”** (nama perangkat, mis. "Pixel Owner").
2. Server membuat device + token (ditampilkan **sekali**), menyimpannya sebagai hash SHA-256.
3. Owner menyalin token ke aplikasi mobile → **Settings/Atur → Hubungkan**: isi URL Orion Central + token.
4. Mobile memverifikasi token lewat `GET /v1/session`, lalu menyimpannya di **secure store** native.
5. From now on, semua request memakai `Authorization: Bearer <token>`.

Alternatif tanpa Web App: `POST /v1/devices` memakai token owner dari CLI/Postman → token dicetak sekali.

## 3. Penyimpanan kredensial
| Data | Penyimpanan | Alasan |
|---|---|---|
| Token perangkat | `expo-secure-store` (Keychain iOS / EncryptedSharedPreferences Android, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`) | Terenkripsi, tidak terbaca skrip lain, hilang bila perangkat diretas/di-unlock |
| Outbox pesan | AsyncStorage | bukan rahasia; butuh persistensi & volume kecil |
| Kursor sinkronisasi | AsyncStorage | bukan rahasia |
| Preferensi UI | AsyncStorage | bukan rahasia |
| URL Central | AsyncStorage | bukan rahasia |

**Dilarang** (dijaga tes & review): token di AsyncStorage, `localStorage`, URL, query string, log, analytics,
screenshot, source code, atau `.env` yang ikut ter-commit.

## 4. Siklus hidup sesi
| Situasi | Perilaku aplikasi |
|---|---|
| Berhasil pair | status `authenticated`; token disimpan di secure store |
| Token kedaluwarsa (`SESSION_EXPIRED`) | status `expired`; ajakan pairing ulang dengan token baru |
| Perangkat dicabut (`SESSION_REVOKED`/`DEVICE_REVOKED`) | status `revoked`; **outbox dihentikan** (tidak ada pengiriman berulang ke device mati) |
| Owner mencabut device lain | token device itu langsung ditolak server (401) — terbukti di tes integrasi |
| Logout | token dihapus dari secure store; state lokal dibersihkan; outbox tetap (tidak secret) |
| Offline | status tetap `authenticated` (token masih valid) + banner offline |

## 5. Otorisasi di server (tidak bergantung perangkat)
Setiap permintaan diverifikasi server: `owner_id` dari token, `device_id` terikat, status device `active`,
scope endpoint, fingerprint approval, dan budget. Mobile **tidak** mengirim owner/role sendiri;
payload yang mencoba melakukan itu ditolak (`CLIENT_SCOPE_FIELD_FORBIDDEN`).

## 6. Batas yang jujur
- Device token = **berlaku penuh** untuk owner tersebut; jika hilang, harus dicabut di Web App.
  (Belum ada scope per-perangkat yang lebih halus.)
- Belum ada pairing berbasis kode sekali pakai (short code). Alur sekarang: token sekali tampil
  (rahasia bersama, seperti pola "device pairing code"). Jika token bocor, Owner mencabut device di Web App.
- Belum ada biometri/passcode untuk membuka aplikasi.
