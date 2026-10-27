# Phase E — Audit Keamanan & Kesiapan Rilis (E1)

**Tanggal audit:** 22 Oktober 2026  
**Repo:** `C:\Users\DIGIUM\Documents\Orion`  
**Metode:** pembacaan source aktual + eksekusi suite yang ada + probe serangan terkontrol pada server lokal (SQLite & PostgreSQL 17.10 embedded).  
**Status:** **BELUM RELEASE-READY.** Tidak ada deployment, perubahan DNS, kredensial, atau tindakan berbiaya yang dilakukan.

> Dokumen ini adalah hasil audit independen. Klaim pada laporan Phase A–D tidak dipakai sebagai bukti; semua temuan di bawah merujuk ke source, tes, atau probe yang dijalankan ulang.

---

## 1. Ringkasan eksekutif

| Area | Status | Catatan |
|---|---|---|
| Isolasi owner pada endpoint data | **Baik sebagian** | Owner selalu dari token; owner A tidak bisa membaca data owner B pada tes. Namun ada dua kebocoran lintas-owner (event ID, push token). |
| Device token lifecycle | **Sebagian** | Hash SHA-256, expiry, revoke, rotasi tersedia. Revoke tidak menutup SSE, tidak mencabut push token, dan logout klien tidak memanggil server. |
| Push token | **Tidak lolos** | Token dapat direbut owner lain; tidak dicabut saat device dicabut; endpoint `GET /v1/push/tokens` tidak dipakai klien. |
| Web auth/session | **Tidak lolos** | Refresh setelah access token kedaluwarsa selalu 401; logout setelah reload tidak mencabut sesi. |
| Mobile auth/pairing | **Tidak lolos** | URL yang ditempel Owner diabaikan oleh API client; auto-login cold start balapan dengan pemuatan token. |
| Otorisasi misi/approval | **Sebagian** | Owner-scoped dan approval server-authoritative; role/scope tidak ditegakkan; `/respond` melewati budget/approval. |
| Idempotensi & transaksi | **Sebagian** | Pesan/event/job baik; approval punya jendela balapan; `/respond` tidak idempoten; refresh sesi tidak atomik. |
| Rate limiting | **Tidak lolos** | In-memory, hanya per-IP, tidak lintas-instance; satu IP menghabiskan kuota semua token. |
| CORS/CSRF/cookie | **Baik sebagian** | Allowlist eksplisit + double-submit benar; `CENTRAL_TRUST_PROXY` tidak dipakai. |
| Migrasi/backup | **Sebagian** | Transaksi + advisory lock + checksum; tidak ada rollback/down, restore belum diuji. |
| Rahasia di log/bundle/backup | **Baik** | Tidak ditemukan token di log/URL/bundle; SecureStore & safeStorage benar; chat content dapat masuk backup perangkat. |

**Kesimpulan:** ada **8 temuan Tinggi** yang harus diperbaiki sebelum deployment produksi dan sebelum E2 (build Android) dianggap siap distribusi. E2–E6 belum dikerjakan pada putaran ini.

---

## 2. Ruang lingkup & metode

Diperiksa:

- `src/central/app.js` (713 baris): seluruh route v1, middleware auth, CORS/CSRF, rate limit, push, SSE.
- `src/central/auth/tokens.js`, `policy/scope.js`, `webauth.js`, `config.js`, `server.js`.
- `src/central/conversations.js`, `sync/events.js`, `desktop-sync.js`, `outbox.js`, `mission/orchestrator.js`, `queue/queue.js`, `audit.js`.
- Migrasi `001`–`010`, driver SQLite/PostgreSQL, `db/migrate.js`.
- `mobile/`: `api/client.ts`, `state/session.tsx`, `state/sync.ts`, `storage/stores.ts`, layar, `app.json`, `eas.json`, prebuild Android.
- `web/`: `api/client.ts`, `state/session.tsx`, `hooks/useRealtime.ts`, `pages/Devices.tsx`.
- Artefak build/rilis yang ada (tanpa menjalankan build native baru).

Probe baru (ditambahkan untuk audit, bukan kode produk):

- `scripts/audit-phaseE-probes.js` — 16 probe pada server SQLite in-memory.
- `scripts/audit-phaseE-pg-probe.js` — probe PostgreSQL nyata (approval paralel, budget, worker, migrasi).

Lingkungan: Windows, Node `v24.22.0`, npm `11.19.1`, PostgreSQL `17.10` embedded, Electron/Chromium tersedia. Emulator Android tidak tersedia (`Virtualization Enabled In Firmware: No`); tidak ada perangkat fisik; tidak ada macOS/Xcode.

---

## 3. Hasil tes yang benar-benar dijalankan

| Suite | Perintah | Hasil |
|---|---|---|
| Unit/integration desktop + secret scan | `npm test` | **exit 0**; 270 tes lulus (58+34+17+7+27+22+20+6+34+45), 5 dilewati (Electron-dependent), secret scan 309 file: **0 temuan nyata**, 7 placeholder/fixture |
| Integrasi PostgreSQL | `npm run test:postgres` | **exit 0**; 81 tes (20+8+15+12+11+15) |
| Mobile unit | `cd mobile && npm test -- --ci` | **exit 0**; 14 tes |
| Mobile typecheck | `cd mobile && npm run typecheck` | **exit 0** |
| Web unit | `cd web && npm test` | **exit 0**; 20 tes / 3 file |
| Web typecheck | `cd web && npm run typecheck` | **exit 0** |
| Web build | `cd web && npm run build` | **exit 0**; bundle 186.49 kB (57.19 kB gzip) |
| E2E Web | `npm run e2e:web` | **exit 0**; 16 lulus |
| E2E Desktop↔Web↔Central | `npm run e2e:desktop-central` | **exit 0**; 13 lulus |
| Probe audit SQLite | `node scripts/audit-phaseE-probes.js` | 13 **FINDING**, 1 INFO |
| Probe audit PostgreSQL | `node scripts/pg-harness.js --run scripts/audit-phaseE-pg-probe.js` | 1 FINDING; 1 PASS; 2 INFO; 10 migrasi terpasang |

Tidak dijalankan pada audit ini: build APK/AAB, build IPA, emulator, perangkat fisik, push FCM/APNs nyata, load test, deployment produksi, restore backup. Lihat §9.

---

## 4. Temuan Tinggi (release blocker)

### AUD-01 — URL Orion Central yang dimasukkan Owner di mobile diabaikan

**Bukti:** `mobile/src/state/session.tsx:64-74` hanya menyimpan URL ke AsyncStorage dan state React. `setApiBaseUrl()` tidak pernah dipanggil oleh kode aplikasi (hanya oleh unit test). `mobile/src/api/client.ts:32-35` selalu memakai `EXPO_PUBLIC_ORION_API_URL` atau override yang tidak pernah diset.

**Dampak:**

- Menempelkan URL staging/lokal di layar pairing **tidak** mengubah tujuan request.
- Bila `EXPO_PUBLIC_ORION_API_URL` kosong, `fetch('/v1/session')` memakai URL relatif dan gagal di React Native.
- Setelah restart, URL tersimpan tetap tidak dipakai, tetapi Settings menampilkannya seolah aktif (status menyesatkan).
- Build produksi `eas.json` mengunci `https://orion-central.up.railway.app`, sehingga pairing ke server lain tetap menuju URL tersebut.

**Perbaikan:** panggil `setApiBaseUrl(url)` sebelum `Api.session()` di `pair()` dan saat hidrasi; gunakan URL tersimpan sebagai sumber tunggal; tambah tes yang membuktikan request menuju URL yang dimasukkan.

### AUD-02 — Auto-login cold start kalah balapan dengan pemuatan token

**Bukti:** `mobile/src/state/session.tsx:26-35` memuat token secara async ke variabel `cached`, sedangkan `useEffect` kedua (baris 62) langsung memanggil `refresh()`. Saat `refresh()` berjalan, `tokenProvider()` masih `null`, sehingga `GET /v1/session` tanpa `Authorization` → 401 → status `anonymous`.

**Dampak:** token valid di SecureStore tetapi aplikasi menampilkan layar pairing setiap cold start (tergantung timing). Ini juga membuat klaim “sesi dipulihkan” tidak dapat diandalkan.

**Perbaikan:** selesaikan hidrasi token sebelum mengizinkan request; jadikan provider async/await; render splash sampai hidrasi selesai; tambah tes urutan startup.

### AUD-03 — Refresh sesi web tidak mungkin setelah access token kedaluwarsa

**Bukti:** `/v1/sessions/refresh` tidak ada di daftar `PUBLIC` (`src/central/app.js:662`). Middleware cookie menolak access token kedaluwarsa lebih dulu (`app.js:673-680`), sebelum handler refresh dijalankan. Web justru mencoba refresh setelah menerima 401 (`web/src/state/session.tsx:33-43`).

**Probe:** `refresh-setelah-access-expired` → **401 `SESSION_EXPIRED`**.

**Dampak:** tab yang idle > 30 menit tidak bisa memperpanjang sesi; pengguna dipaksa login ulang meskipun refresh token (30 hari) masih valid. Dokumentasi `multi-device-deployment.md` yang menyatakan refresh berfungsi saat access kedaluwarsa **tidak sesuai implementasi**.

**Perbaikan:** izinkan refresh hanya dengan cookie refresh (tanpa access), validasi hash + status + expiry, wajibkan CSRF, rotasi atomik; atau middleware khusus yang menerima access kedaluwarsa untuk route refresh.

### AUD-04 — Logout tidak mencabut sesi/token di server

**Bukti:**

- Desktop: `src/central/desktop-sync.js:61` memanggil `DELETE /v1/sessions/current`. Router mencocokkannya sebagai `DELETE /v1/sessions/:id` dengan `id = "current"` (`app.js:364-369`) → `revokeSession` tidak menemukan baris → respons `200 {"ok":0}`. Token perangkat tetap valid.
- Web setelah reload: `web/src/api/client.ts:90` memanggil `DELETE /v1/sessions` bila `sessionId` tidak diketahui (setelah reload) → tidak ada route → **404**; cookie HttpOnly tidak dibersihkan.
- Probe: `route-logout-tidak-ada` → desktop `200 {"ok":0}`, web tanpa id `404`, `GET /v1/session` dengan token lama tetap **200**.

**Dampak:** “Putuskan”/logout hanya menghapus state lokal. Token/sesi tetap valid sampai expiry (default 720 jam) dan tetap dapat dipakai bila disalin.

**Perbaikan:** tambah route logout self (`DELETE /v1/sessions/current` yang benar atau revoke berdasarkan token id/sesi aktif), selalu kirim `Set-Cookie` pembersih, dan sediakan endpoint revoke token perangkat untuk mobile/desktop.

### AUD-05 — SSE yang sudah terbuka tetap menerima event setelah token/device dicabut

**Bukti:** `app.js:543-564` memverifikasi identitas hanya saat koneksi dibuka; polling 3 detik berikutnya hanya memfilter `owner_id`. Tidak ada pengecekan ulang status token/device/sesi.

**Probe:** device dicabut → request baru **401**, tetapi stream lama masih menerima **4 event** setelah pencabutan (`sse-terbuka-bertahan-setelah-token-dicabut`).

**Dampak:** perangkat yang dicabut tetap menerima data real-time sampai koneksi putus. Ini melanggar “token dicabut → semua permintaan terproteksi ditolak”.

**Perbaikan:** simpan `tokenId`/`sessionId` di stream dan cek status setiap poll (atau setiap 15–30 detik); tutup stream saat revoke; batasi umur stream; kurangi interval polling atau gunakan LISTEN/NOTIFY.

### AUD-06 — Sesi cookie tidak memeriksa status device; login menerima `deviceId` arbitrer

**Bukti:** `POST /v1/auth/login` mengambil `body.deviceId` tanpa validasi kepemilikan/status (`app.js:388`), lalu `createSession` menyimpannya (`conversations.js:151-166`). Middleware cookie (`app.js:673-683`) tidak memeriksa `devices.status`.

**Probe:** login dengan `deviceId` perangkat yang **sudah dicabut** → **200**, dan `GET /v1/session` dengan cookie tersebut → **200** (`cookie-session-abaikan-device-revoked`).

**Dampak:** pencabutan perangkat tidak konsisten: bearer ditolak, cookie session tetap hidup. Device ID palsu juga dapat mencemari audit/aktivitas.

**Perbaikan:** validasi `deviceId` milik owner dan `status = active` saat login/createSession; cek status device pada setiap request cookie (join ke `devices`), atau cabut semua sesi terkait saat revoke (sudah ada, tetapi tidak menutup sesi dengan device ID palsu).

### AUD-07 — Push token dapat direbut owner lain dan tidak dicabut saat device dicabut

**Bukti:**

- `app.js:493-500`: jika token sudah ada milik owner lain, server **memindahkan kepemilikan** ke pemanggil dan mengembalikan `200 {reassigned:true}`.
- `DELETE /v1/devices/:id` (`app.js:120-129`) mencabut token bearer & sesi, tetapi **tidak** menyentuh `push_tokens`.
- `status` push token tidak pernah diperiksa oleh pengirim (pengirim push juga belum ada).

**Probe:** owner B mendaftarkan token milik owner A → `200`, baris DB menjadi milik B. Device dicabut → `push_tokens.status` tetap `active`.

**Dampak:** notifikasi owner A dapat dialihkan ke perangkat B (bila token diketahui), dan perangkat yang dicabut tetap menjadi target push. Isolasi antar-owner dan siklus hidup token tidak terpenuhi.

**Perbaikan:** jangan pindahkan kepemilikan lintas owner (kembalikan 409 atau simpan baris terpisah per owner); cabut push token saat device dicabut; periksa `status='active'` sebelum mengirim; gunakan UPSERT atomik.

### AUD-08 — Scope memori ditentukan klien, data `private` dapat dibaca

**Bukti:** `app.js:224-243` mengambil `callerScope` dari query string (`?scope=`), bukan dari token. `canAccessScope` (`policy/scope.js:46-54`) menganggap scope yang sama selalu boleh, tanpa memandang `sensitivity`.

**Probe:** record `scope='mission'`, `sensitivity='private'` dapat dibaca dengan `GET /v1/memory` (tanpa parameter) **dan** `GET /v1/memory?scope=mission` (`memory-scope-ditentukan-klien`).

**Dampak:** batas privasi memori (mission/session/private) tidak enforceable; perangkat mana pun dengan token owner dapat membaca seluruh memori.

**Perbaikan:** scope pemanggil harus berasal dari klaim token/misi yang terautentikasi, bukan query; tolak `private` kecuali konteks misi yang cocok; tambah tes negatif.

---

## 5. Temuan Sedang

### AUD-09 — Event ID global lintas owner (squatting / event hilang)

`sync/events.js:61` memeriksa duplikat hanya dengan `WHERE id = ?` tanpa `owner_id`; `events.id` adalah PRIMARY KEY global. Owner B yang lebih dulu memakai sebuah `eventId` membuat upload owner A dianggap `duplicates` dan **event A tidak tersimpan** (probe `event-id-squatting-lintas-owner`). Cursor milik event B juga dikembalikan ke A.

**Perbaikan:** cek `(owner_id, id)` atau jadikan kunci komposit; perlakukan benturan lintas-owner sebagai konflik eksplisit, bukan duplikat.

### AUD-10 — Ganti password tidak mencabut token/sesi lain

`app.js:404-414` hanya memperbarui `password_hash`. Token perangkat dan sesi lama tetap valid (probe `ganti-password-tidak-mencabut-token`). **Perbaikan:** cabut semua token/sesi lain (kecuali sesi yang melakukan perubahan) dan catat audit.

### AUD-11 — Rate limiting tidak memenuhi syarat produksi

- `app.js:629` memakai kunci **hanya IP** (`remoteAddress`), bukan owner+token+route seperti komentar.
- In-memory per proses → tidak lintas-instance; `hits.clear()` saat >5000 kunci menghapus semua limit.
- `CENTRAL_TRUST_PROXY` dibaca (`config.js:71`) tetapi **tidak pernah dipakai**; di belakang Railway/Cloudflare semua klien tampak satu IP.
- `CENTRAL_RATE_LIMIT_PER_MIN` tidak divalidasi; nilai non-numerik → `NaN` → perbandingan selalu false → **rate limit mati diam-diam**.
- Login throttle (`webauth.js:101-113`) juga in-memory per instance.

**Probe:** satu IP menghabiskan kuota; token valid berikutnya mendapat **429** (`rate-limit-per-ip-bukan-per-token`).

**Perbaikan:** backend bersama (Redis/Postgres) atau minimal dokumentasikan single-instance; kunci owner+IP; percayai `X-Forwarded-For` hanya dari proxy tepercaya; validasi env; jangan clear seluruh map.

### AUD-12 — `reconcileBudget` gagal di PostgreSQL

`mission/orchestrator.js:44` memakai `MAX(0, budget_reserved - ?)`; PostgreSQL tidak memiliki `MAX(a,b)` (harus `GREATEST`). Probe PG: **`function max(integer, integer) does not exist`**. Ini membuat rekonsiliasi budget produksi selalu error (setelah reservasi berhasil), berpotensi menyisakan `budget_reserved` menggantung. **Perbaikan:** dialek-aware `GREATEST(0, ...)` untuk PG dan `MAX(0, ...)` untuk SQLite, atau hitung di aplikasi dalam transaksi.

### AUD-13 — `hasMore` delta feed salah saat filter `types` dipakai

`app.js:527-540` mengambil `LIMIT n` lalu memfilter `types` di JS; `hasMore = rows.length === limit` dihitung dari hasil **setelah** filter. Probe: dua event `agent.note` + satu `mission.state`, request `limit=2&types=mission.state` → `changes=[]`, `hasMore=false`, cursor tidak maju. Klien yang mempercayai `hasMore` berhenti dan **kehilangan event**.

**Perbaikan:** filter di SQL sebelum `LIMIT`, atau hitung `hasMore` dari query tambahan; jangan menurunkan cursor saat hasil kosong karena filter.

### AUD-14 — Outbox desktop: status “sent” bisa salah dan entri gagal permanen dihapus

- `desktop-sync.js:99-101`: `sendMessage` mengembalikan `sent` bila **ada** item mana pun yang berhasil di `flushOutbox`, bukan item yang baru.
- `desktop-sync.js:123-128`: kegagalan permanen memanggil `markSynced()` → entri **dihapus dari outbox**; renderer hanya menandai pesan lokal `error` + toast (`app-src/orion-cloud.js:132-143`), tanpa tombol kirim ulang.

**Dampak:** status pengiriman bisa tidak jujur; pesan gagal permanen tidak dapat dikirim ulang setelah restart. **Perbaikan:** hasil per-item; simpan `failed` persisten seperti mobile; sediakan kirim ulang/hapus.

### AUD-15 — `/v1/conversations/:id/respond` melewati budget/approval dan tidak idempoten

`app.js:446-476` memanggil provider AI langsung, tanpa `reserveBudget`, tanpa approval, dan `clientMessageId` default memakai `Date.now()` sehingga retry membuat balasan & biaya ganda. Ini bertentangan dengan klaim “budget & approval dicek di server” untuk eksekusi model. **Perbaikan:** wajibkan idempotency key dari klien, dedupe sebelum panggilan provider, kaitkan ke misi/budget atau dokumentasikan sebagai chat non-misi dengan batas biaya.

### AUD-16 — `GET /v1/push/tokens` tidak diperlukan klien

Hanya dipakai `scripts/test-phaseD-mobile.js` dan dokumentasi; mobile (`api/client.ts`) dan web tidak memanggilnya. Respons sudah minimal (tanpa nilai token: `id, device_id, platform, status, created_at, last_seen_at`), tetapi endpoint menambah permukaan data perangkat tanpa kebutuhan produk. **Perbaikan:** hapus, atau jadikan admin-only dengan scope eksplisit dan dokumentasikan alasannya.

### AUD-17 — Tidak ada worker misi di Orion Central

Tidak ada modul worker di `src/central`; `orchestrator`/`queue` tidak dipanggil oleh `server.js`. Probe PG: misi baru tetap `queued`, jumlah job `0`. Misi tersimpan (tidak hilang saat restart), tetapi **tidak pernah dieksekusi** oleh Central. Ini bukan bug keamanan, tetapi gap release yang harus dinyatakan jujur (E4 no. 8 hanya menguji persistensi). **Perbaikan:** dokumentasikan bahwa eksekusi misi dilakukan desktop/klien, atau tambahkan worker dengan lease/heartbeat.

### AUD-18 — Enumerasi email lewat timing login

`app.js:381` hanya menjalankan `verifyPassword` bila owner ditemukan (`owner && owner.password_hash`), sehingga email tak dikenal merespons jauh lebih cepat daripada email valid (scrypt ~50 ms). Komentar “selalu jalankan verifikasi (waktu konstan-ish)” tidak benar. **Perbaikan:** verifikasi terhadap dummy hash saat owner tidak ada; pertahankan pesan error identik.

---

## 6. Temuan Rendah / Informasi

| ID | Temuan | Bukti | Dampak | Saran |
|---|---|---|---|---|
| AUD-19 | Budget/`maxExecutions` negatif diterima | Probe `misi-budget-negatif-diterima` → 201 | Misi tidak dapat dieksekusi / angka tidak wajar | Validasi `>= 0`, batas atas |
| AUD-20 | Penerbitan token menerima `deviceId`/`scopes` arbitrer; scope tidak ditegakkan | Probe `token-deviceid-tanpa-validasi` → 201, token lalu 401 `DEVICE_UNKNOWN`; hanya `/v1/auth/token` yang cek `auth:issue` | Token tak terpakai; model least-privilege ilusi | Validasi device milik owner & aktif; tegakkan scope per route |
| AUD-21 | Payload event dipotong 1000 karakter; `mission.state` dari klien diterima | `sync/events.js:73-78,91`; `scrub()` di `audit.js:17` memotong 1000 | Data event hilang diam-diam; status misi dapat dipalsukan di feed | Redaksi tanpa truncation; tolak `mission.state`/`mission.task.state` dari klien |
| AUD-22 | Pagination pesan hanya maju | `conversations.js:136-147` hanya `after` | Riwayat >100 pesan tidak bisa dimuat ulang oleh klien | Tambah `before`/backward pagination |
| AUD-23 | Shutdown tidak benar-benar graceful | `server.js:54-59` memanggil `process.exit(0)` segera | Request in-flight/SSE terpotong saat deploy | Tunggu `server.close`, batas drain, tutup pool, tangani `unhandledRejection` |
| AUD-24 | Registrasi push rawan balapan & `platform` tidak diperbarui saat reassign | `app.js:493-511` select-then-insert; `platform` tidak di-set saat update | 500 saat dua perangkat mendaftar bersamaan; metadata salah | UPSERT atomik; update semua kolom |
| AUD-25 | Guard keputusan approval tidak memeriksa jumlah baris terupdate | `app.js:200-203`; update `AND status='pending'` tetapi hasil diabaikan | Secara teori dua request dapat sama-sama 200; belum tereproduksi (8 paralel PG: 1×200, 7×409) | Gunakan `UPDATE ... RETURNING` dan cek hasil; kembalikan 409 bila 0 |
| AUD-26 | Login CSRF & bootstrap | `/v1/auth/login` publik tanpa cek Origin (`app.js:372`); setup key dibandingkan `!==`; panjang minimum tidak divalidasi | Login-CSRF (dampak rendah, single-owner); brute force setup key | Cek Origin/allowlist; `timingSafeEqual`; validasi panjang & rate limit khusus |
| AUD-27 | Token pairing ditampilkan di DOM web | `web/src/pages/Devices.tsx:43` (banner notice) | Token terlihat sampai reload; screenshot/shoulder-surf | Tampilkan sekali di modal, salin, lalu hapus dari state/DOM |
| AUD-28 | Backup Android | `AndroidManifest.xml`: `allowBackup="true"`; SecureStore dikecualikan oleh rule library; AsyncStorage **tidak** dikecualikan | Kredensial aman; isi chat/outbox dapat masuk backup | Dokumentasikan; pertimbangkan `allowBackup=false` atau exclude AsyncStorage |
| AUD-29 | Migrasi forward-only; `010` tanpa FK; restore belum diuji | `db/migrate.js`, `010_push_tokens.sql` | Rollback hanya lewat restore; orphan push token mungkin | Dokumentasikan prosedur backup/restore & uji restore di E3 |
| AUD-30 | Refresh paralel dengan cookie yang sama | Probe `refresh-paralel-token-sama` → `[200, 401 UNAUTHENTICATED]`, sesi tetap `active` | Satu tab mendapat 401 → UI logout padahal sesi valid | Terima refresh via cookie refresh tanpa access; rotasi atomik + grace window |
| AUD-31 | Pagination/`hasMore` & pesan panjang | lihat AUD-13/22 | — | — |

---

## 7. Jawaban langsung atas pertanyaan audit E1

| Pertanyaan | Jawaban |
|---|---|
| Push registration, ownership, revocation, isolasi antarperangkat | **Tidak lolos.** Registrasi terikat owner+device dari token, tetapi token dapat dipindahkan ke owner lain dan tidak dicabut saat device dicabut. |
| Apakah `GET /v1/push/tokens` diperlukan klien? | **Tidak.** Hanya dipakai tes & dokumen. Respons sudah meminimalkan data (tanpa nilai token), tetapi endpoint sebaiknya dihapus/dibatasi. |
| Device token hashing, expiry, revocation, rotasi | **Sebagian.** SHA-256 dari token acak 256-bit, expiry dicek, revoke per device berfungsi untuk bearer; SSE terbuka tidak ditutup; logout tidak memanggil revoke; rotasi tersedia tetapi tidak dipakai klien; tidak ada rotasi otomatis. |
| Konfigurasi Expo SecureStore sesuai SDK terpasang | **Ya.** `WHEN_UNLOCKED_THIS_DEVICE_ONLY` ada di `expo-secure-store` 58.0.2 (iOS `thisDeviceOnly`); Android memakai EncryptedSharedPreferences dan rule backup library mengecualikan `SecureStore`. |
| Kredensial di log, crash report, bundle, backup, storage tidak aman | **Tidak ditemukan kebocoran kredensial.** Token mobile hanya SecureStore; desktop hanya `safeStorage` di main process; tidak ada token di URL/log/bundle. Catatan: web menampilkan token pairing di DOM; tidak ada crash reporter; isi chat di AsyncStorage dapat masuk backup perangkat. |
| Otorisasi server pada setiap operasi misi & approval | **Sebagian.** Semua route memakai `assertOwnership` (owner dari token) dan approval server-authoritative. Namun role/scope tidak ditegakkan; scope memori dari klien; `/respond` melewati budget/approval. |
| Konsistensi idempotensi & transaksi DB | **Sebagian.** Pesan (`client_message_id` unik), event (`event_id`), job (`idempotency_key`), migrasi transaksional. Approval punya jendela balapan; `/respond` tidak idempoten; refresh sesi tidak atomik; `reconcileBudget` rusak di PG. |
| Rate limiting lintas-instance & proteksi endpoint auth | **Tidak.** In-memory, per-IP, tidak lintas-instance; throttle login per-instance; env invalid dapat mematikan limit. |
| CORS, cookie, CSRF, reverse proxy | **Baik sebagian.** Allowlist eksplisit tanpa wildcard, cookie HttpOnly/Secure/SameSite, CSRF double-submit untuk request cookie non-GET. `CENTRAL_TRUST_PROXY` tidak dipakai; `X-Forwarded-Proto` dipercaya tanpa validasi proxy; HSTS belum diatur (harus di proxy). |
| Validasi environment & gagal start jika secret wajib tidak ada | **Sebagian.** DB/port/driver divalidasi; `CENTRAL_SETUP_KEY` kosong = bootstrap nonaktif (aman). Tidak ada mode produksi yang mewajibkan CORS/setup key/panjang secret; nilai rate limit tidak valid tidak menggagalkan start. |
| Migrasi PostgreSQL aman saat deploy & backup/restore | **Sebagian.** Advisory lock + transaksi per migrasi + checksum. Tidak ada down migration, tidak ada backup otomatis, restore belum diuji. |

---

## 8. Kontrol yang terverifikasi baik (jangan diregresi)

- Owner ID selalu dari token; payload klien yang memuat `owner_id`/`role`/`permissions` ditolak (`sync/events.js:34`), bukan diabaikan.
- Token disimpan sebagai hash SHA-256; plaintext hanya sekali; expiry & status device dicek pada bearer (`auth/tokens.js:55-77`).
- Password Owner: scrypt + salt + `timingSafeEqual`; tidak pernah plaintext (`webauth.js:19-34`).
- Cookie sesi: HttpOnly untuk access/refresh, Secure mengikuti HTTPS, SameSite Strict/None; CSRF double-submit untuk mutasi via cookie (`webauth.js:73-90`, `app.js:684-689`).
- CORS allowlist eksplisit dengan credentials, tanpa wildcard (`app.js:610-617`).
- Default-deny: semua endpoint kecuali health/ready/bootstrap/login membutuhkan identitas (`app.js:691-694`).
- Pesan idempoten (`008` unique `owner_id, client_message_id`), event idempoten, job idempoten, transaksi pesan+counter+event, klaim job atomik, migrasi checksum + advisory lock.
- Secret scan: 309 file, 0 temuan nyata; tidak ada token di log/URL/bundle yang ditemukan.
- Mobile: token hanya di SecureStore, field token `secureTextEntry`, tidak ada fallback ke AsyncStorage.
- Desktop: token hanya di main process via `safeStorage`; renderer tidak menerima token; `logout` lokal menghapus secret (meski server tidak dicabut — AUD-04).
- `ready` punya timeout; body limit; header/request timeout; error tidak membocorkan stack trace.

---

## 9. Batasan audit & hal yang TIDAK diklaim

- **Tidak ada build APK/AAB native** pada audit ini. Status build Android tetap **BLOCKED** sampai dibuktikan di Linux CI/EAS (E2). Tidak ada checksum artefak baru.
- **Tidak ada build IPA**; butuh macOS + Xcode.
- **Tidak ada pengujian emulator/perangkat fisik**; virtualisasi firmware tidak aktif dan tidak ada perangkat.
- **Tidak ada push FCM/APNs nyata**; server juga belum memiliki pengirim push.
- **Tidak ada deployment produksi**, perubahan DNS, pembuatan akun, atau pembelian.
- **Tidak ada load test / pen-test eksternal**; hasil ini adalah audit source + probe terkontrol, bukan jaminan keamanan.
- **Tidak ada uji restore backup**; prosedur baru akan disusun di E3.
- Temuan approval double-decision (AUD-25) adalah analisis kode; balapan belum berhasil direproduksi pada 8 request paralel PG. Tidak diklaim sebagai eksploit yang terbukti.

---

## 10. Urutan remediasi yang disarankan sebelum E2/E3

1. **AUD-03, AUD-04, AUD-05** — perbaiki siklus sesi/token (refresh, logout, SSE) agar pencabutan benar-benar berlaku.
2. **AUD-06, AUD-07, AUD-08, AUD-09** — tutup isolasi/otorisasi (device session, push ownership, memory scope, event ID).
3. **AUD-01, AUD-02** — perbaiki pairing/startup mobile sebelum build APK diuji.
4. **AUD-10, AUD-11, AUD-12** — password/session revocation, rate limit produksi, bug PostgreSQL budget.
5. **AUD-13–AUD-18** — konsistensi sinkronisasi, status jujur, idempotensi inferensi, worker/gap yang harus didokumentasikan.
6. Baru setelah itu: E2 build Android (CI/EAS), E3 runbook deployment, E4 acceptance lintas klien, E5/E6.

---

## 11. Perubahan file pada putaran audit ini

- **Ditambahkan:** `scripts/audit-phaseE-probes.js` (probe SQLite).
- **Ditambahkan:** `scripts/audit-phaseE-pg-probe.js` (probe PostgreSQL).
- **Ditambahkan:** `docs/phase-e-security-audit.md` (dokumen ini).
- **Tidak ada perubahan kode produk, konfigurasi produksi, migrasi, atau artefak rilis.**

E2–E6 belum dimulai. Tidak ada klaim PASS untuk build, deployment, push, iOS, atau perangkat fisik.

---

## Lampiran A — keluaran probe (ringkas, apa adanya)

Perintah:

```powershell
node scripts/audit-phaseE-probes.js
node scripts/pg-harness.js --run scripts/audit-phaseE-pg-probe.js
```

Keluaran SQLite (13 FINDING + 1 INFO):

| Probe | Verdict | Detail kunci |
|---|---|---|
| refresh-setelah-access-expired | FINDING | 401 `SESSION_EXPIRED` |
| route-logout-tidak-ada | FINDING | desktop 200 `{"ok":0}`, web 404, token lama masih 200 |
| refresh-paralel-token-sama | FINDING | `[200, 401 UNAUTHENTICATED]`, sesi `active` |
| memory-scope-ditentukan-klien | FINDING | record `private` terbaca tanpa scope & `scope=mission` |
| device-revoke-tidak-mencabut-push | FINDING | push token tetap `active` |
| cookie-session-abaikan-device-revoked | FINDING | login & session 200 dengan device dicabut |
| push-token-reassign-lintas-owner | FINDING | owner B mengambil alih token owner A |
| push-tokens-response-minimal | INFO | field: `id, device_id, platform, status, created_at, last_seen_at` |
| event-id-squatting-lintas-owner | FINDING | A: `accepted=0, duplicates=1`; event A tidak terlihat |
| ganti-password-tidak-mencabut-token | FINDING | token lama tetap 200 |
| delta-feed-hasMore-dengan-filter | FINDING | `changes=0`, `hasMore=false`, cursor tidak maju |
| misi-budget-negatif-diterima | FINDING | 201 untuk `budgetLimit=-100`, `maxExecutions=-1` |
| token-deviceid-tanpa-validasi | FINDING | issue 201; token baru 401 `DEVICE_UNKNOWN` |
| sse-terbuka-bertahan-setelah-token-dicabut | FINDING | request baru 401; 4 event diterima setelah revoke |
| rate-limit-per-ip-bukan-per-token | FINDING | token valid kena 429 setelah IP menghabiskan kuota |

Keluaran PostgreSQL:

| Probe | Verdict | Detail |
|---|---|---|
| approval-keputusan-ganda-paralel | PASS (belum tereproduksi) | 8 request: 1×200, 7×409; final `approved` |
| reconcile-budget-postgres | FINDING | `function max(integer, integer) does not exist` |
| misi-tanpa-worker-di-central | INFO | state `queued`, 0 job |
| migrasi-terpasang | INFO | 10 migrasi `001`–`010` |


## 10. Remediation R1-R5 (E1-R) � Bukti

| R | Temuan | Status | Bukti |
|---|---|---|---|
| R1 | Refresh race/replay/logout/revoke/SSE | Perbaiki | Phase A 22/22, Phase B 16/16, probe PASS |
| R2 | Push token bound device + event identity 011 | Perbaiki | Phase D 17/17, probe PASS |
| R3 | /respond 503 + server-side role/scope | Perbaiki | Phase B, audit role checks |
| R4 | Budget CASE + delta filter + outbox + rate limit | Perbaiki | Postgres 81/81, probe rate-limit PASS |
| R5 | URL normalization + pairing status | Perbaiki | Mobile 15/15, typecheck OK |

**Status E1-R:** R1-R5 selesai, semua probe PASS, semua suite (Phase A/B/D, Postgres, web, mobile) lulus. Belum deployment, belum APK/IPA, belum load test real.

