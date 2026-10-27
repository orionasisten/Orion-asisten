# API Connector Hub

Fondasi untuk menghubungkan Orion ke API publik maupun berautentikasi **secara terkontrol**. Kode: `src/connectors/`.
Rujukan arah arsitektur: `orion-architecture-blueprint-v1.1.md` (prinsip: Orion Core pusat kendali; connector hanya penyedia kemampuan).

## Alur status (lima keadaan yang sengaja dipisah)
```
katalog (discovered) → connector ditinjau (reviewed) → diuji (tested) → diaktifkan (enabled) → digunakan (usage.count > 0)
                                    ↑___________ ubah konfigurasi relevan keamanan ____________|  (kembali ke "reviewed")
```
* **Masuk katalog ≠ izin.** Katalog (`public-apis/public-apis`, MIT) hanya bahan penemuan dan tidak memuat base URL.
* **Ditinjau:** pengguna melengkapi base URL, allowlist host, metode, autentikasi, risiko, batas laju, dsb.; semuanya divalidasi.
* **Diuji:** `GET` ke `testPath` lewat gateway dengan **persetujuan native**; hasilnya terikat pada hash konfigurasi.
* **Diaktifkan:** hanya lewat dialog persetujuan native (`enable(id,'user-dialog')`); butuh uji yang cocok dengan konfigurasi sekarang.
* **Digunakan:** dihitung hanya bila panggilan sumber-model benar-benar sukses.
* `disabled` dan `revoked` (permanen; secret dihapus).

## Model data (`registry.js`)
`id, name, category, description, baseUrl, documentationUrl, authType (none|apiKey|bearer; oauth ditolak), auth, requiredSecrets,
allowedMethods, allowedHosts, dataClassification, rateLimit{perMinute}, usageCost{model,unitCost}, license, source{type,repo,url,
license,syncedAt,catalogId}, status, lastVerifiedAt, healthStatus, riskLevel, limits{timeoutMs,maxResponseBytes,maxRequestBytes,
retries}, responseSchema?, testPath?, configHash, lastTest, usage{count,lastUsedAt,missions}`. Disimpan di `userData/connectors/connectors.json`.
`riskLevel` tidak boleh lebih rendah dari yang diturunkan sistem (mis. metode tulis ⇒ minimal `write`; auth/data non-publik ⇒ minimal `read-private`).

## Satu-satunya jalur eksekusi: `gateway.call()`
Urutan: validasi permintaan → SSRF guard → **policy** → persetujuan → rate limit & concurrency → injeksi secret →
transport berbatas → validasi respons → audit. Tidak ada jalur kedua yang melewati ini (uji manual dan sinkron katalog
juga lewat gateway; sinkron katalog memakai `systemGet` dengan allowlist tetap).

### Policy (`policy.js`, fungsi murni `decide()`)
| Risiko | Efek |
|---|---|
| `read-public` | otomatis, bila mission aktif, connector aktif & dalam scope, dan batas belum tercapai |
| `read-private` | persetujuan per operasi (di-cache hanya untuk operasi identik dalam mission yang sama) |
| `write` | mission harus `allowWrites`; persetujuan **setiap** panggilan |
| `high-impact` | seperti `write` + wajib anggaran; persetujuan setiap panggilan |
Persetujuan terikat pada *fingerprint* (connector, hash konfigurasi, metode, host, path, query, hash body): mengubah parameter ⇒
fingerprint baru ⇒ persetujuan baru. Tidak ada mode "allow all". Batas per mission: jumlah panggilan, per connector, anggaran (connector berbiaya).

### Kontrol jaringan / SSRF (`netguard.js`, `transport.js`)
Diterapkan di aplikasi: hanya `https` + allowlist host (eksak atau `*.domain`, tanpa apex), port 443, tanpa kredensial di URL,
IP-literal ditolak, nama internal (`localhost`, `.internal`, `.local`, tanpa titik) ditolak, URL ambigu (spasi, `\`, kontrol) ditolak;
**setiap** alamat hasil DNS divalidasi di dalam `lookup` yang dipakai socket (IP yang divalidasi = IP yang dihubungi ⇒ DNS rebinding
tertutup); blok loopback, privat, CGNAT, link-local/metadata, multicast, dokumentasi, IPv4-mapped, NAT64, 6to4, Teredo, ULA;
redirect divalidasi **per hop** (maks 3, hanya GET/HEAD, kredensial dibuang bila lintas origin); batas waktu, ukuran respons
(dihentikan di tengah aliran), tanpa kompresi, tanpa pool koneksi; batas laju (token bucket), concurrency 2/connector & 4 global.
**Tidak** diterapkan (butuh infrastruktur): egress firewall tingkat jaringan/OS, dukungan proxy korporat, pinning sertifikat.

### Secret (`secrets.js` + bridge)
Dienkripsi `safeStorage` (Keychain macOS / DPAPI Windows); backend `basic_text` ditolak. UI **hanya-tulis**: tidak ada API untuk membaca
nilai. Gateway hanya mengambil secret yang tercantum di `requiredSecrets` connector tersebut. Secret tidak masuk prompt, log, audit,
atau pesan error (disaring nilai-spesifik + pola umum). Catatan: DPAPI/Keychain melindungi dari pengguna lain, bukan dari malware
yang berjalan sebagai pengguna yang sama.

### Audit (`audit.js`)
JSONL berantai hash di `userData/connectors/connector-audit.jsonl`: mission, tiap panggilan (connector, mission, metode, host, path,
fingerprint, jenis persetujuan, hasil, status, byte, durasi, retry), lifecycle, secret (hanya nama), emergency stop. **Tamper-evident,
bukan immutable**: perubahan terdeteksi (`verify()`), tetapi pelaku yang bisa menulis berkas dapat memotong seluruh log.

### Data pihak ketiga
Respons divalidasi (tipe konten, JSON, schema subset opsional tanpa regex), tidak pernah dieksekusi, diberi label **TIDAK TEPERCAYA**
+ provenance (connector, host, waktu, HTTP, byte, sha256) dan dipotong sebelum masuk ke model. Respons tidak dapat memicu aksi: tidak
ada jalur dari data ke shell/email/publikasi; perluasan izin hanya lewat dialog native.

## Tool untuk model (Chat)
`api_list_connectors` dan `api_call` — hanya ditawarkan bila "Pakai API connector di Chat" aktif, dan hanya untuk connector **aktif yang
dipilih** pengguna. Schema ketat (enum connector & metode). Mission dimulai lewat dialog native (daftar connector, batas); policy
divalidasi ulang **di proses utama** pada setiap panggilan. Hasil tool ≠ bukti panggilan terjadi: bukti ada di audit log.

## Emergency stop
Satu tombol: membatalkan panggilan API berjalan, memblokir yang baru, mengakhiri semua mission, menghentikan server MCP, dan membunuh
proses anak (terminal/agent). Lanjut hanya lewat dialog native. Operasi eksternal yang sudah terkirim tidak dapat ditarik kembali.

## Antarmuka (IPC `api:*`)
`overview`, `catalog:list|sync|importFile`, `connector:review|update|test|enable|disable|revoke|remove`, `secret:set|has|del`,
`mission:start|end`, `call`, `stop`, `resume`, `audit:tail|verify`. Pemanggil dipercaya hanya bila berasal dari jendela ORION (`file://`).

## Menambah connector
1. Desktop Hub → **API Hub** → *Sinkron dari GitHub* (persetujuan) atau *Impor dari README.md…*; atau *Tambah connector manual*.
2. *Tinjau*: lengkapi base URL dari **dokumentasi resmi API**, allowlist host, metode (default hanya GET), autentikasi, batas, path uji.
3. Isi secret (bila perlu) → *Uji* → *Aktifkan* → pilih di **Scope & mission Chat** → aktifkan "Pakai API connector di Chat".

## Pengujian
`npm test` → `scripts/selftest.js` + `scripts/test-connectors.js` (Node murni, server API palsu lokal; hook uji guard hanya aktif dengan
`ORION_TESTING=1` dan tidak dapat dicapai dari UI/IPC). Cakupan: IP & URL, redaksi, path/query, schema, metadata & auth, lifecycle,
parser katalog, audit berantai, secret store, policy; SSRF (resolusi privat/mapped/campuran, end-to-end ke server lokal, DNS rebinding),
redirect (allowlist, DNS privat, kredensial lintas origin), 401/403/404/429/5xx, timeout, respons besar/JSON rusak/binary/terkompresi/
tidak sesuai schema, persetujuan tulis & cache baca-privat, batas mission/laju/concurrency, emergency stop & pembatalan, prompt
injection, anggaran, pencabutan, kebocoran secret. Uji mutasi manual (SSRF dimatikan, validasi redirect dicopot, kredensial lintas
origin, approval tulis dilewati) masing-masing membuat tes gagal.
Belum dapat diuji: Electron native (dialog, `safeStorage`), unduhan GitHub nyata, API pihak ketiga nyata.

## Keterbatasan yang diketahui
OAuth belum didukung (`DESIGNED`); metadata katalog tidak terverifikasi dan format baris README **belum dicocokkan dengan berkas
aktual** (parser menghitung baris yang gagal dibaca); `dns.lookup` memakai resolver OS (tanpa DoH/proxy); batas mission/laju/biaya
berada di memori (reset saat restart); belum ada impor OpenAPI; schema respons hanya subset; audit tidak diangkur ke luar perangkat.
