# Menu input Chat: data, pencarian realtime, kemampuan

Tombol **+** di kotak chat membuka tiga kelompok. Kode: `app-src/orion-input.js`, `orion-extract.js`, `orion-web.js`, `orion-capabilities.js`; sisi aman di `src/webtools.js` dan `src/bridge.js`.

## 1. Lampirkan data
| Sumber | Perilaku |
|---|---|
| Berkas (juga drag-drop & paste) | teks/kode/CSV/JSON/log, HTML, **DOCX, XLSX, PPTX**, **PDF (best-effort)**, **gambar** (dikecilkan ≤ 1280 px, dikirim sebagai `image_url`), **audio** (ditranskripsi lewat STT cloud bila diatur) |
| Tempel teks/data | menjadi lampiran bernama |
| Dari URL web | proses utama mengambil halaman (izin per host; hanya GET; IP privat/internal diblokir) → teks |
| Dari workspace | berkas teks/kode ≤ 1 MB di folder kerja (`.env`/kunci diblokir) |

Batas: berkas ≤ 25 MB (gambar ≤ 20 MB, audio ≤ 25 MB); teks per lampiran ≤ 30.000 karakter, total ≤ 80.000, maks 4 gambar. Yang dipotong ditandai di chip dan di pesan ke model.
**Jujur tentang kegagalan:** video, format lama (.doc/.xls/.ppt), PDF hasil scan atau berfont CID, audio tanpa STT, dan berkas > batas ditampilkan sebagai ⚠ dengan alasan, dan model diberi tahu bahwa lampiran tidak terbaca (tidak menebak isinya).
Model tanpa vision: permintaan ditolak provider → ulangi otomatis tanpa gambar + peringatan.
Lampiran tetap tersedia di pertanyaan lanjutan **selama aplikasi terbuka** (cache di memori); setelah restart hanya nama berkas yang tersisa dan model diminta meminta unggah ulang.
Ekstraksi: ZIP dibaca dengan batas 24 MB terdekompresi per entri (anti zip-bomb); pemindai XML/HTML linear (diuji dengan input jahat 300–500 ribu tag).

## 2. Cari & riset realtime
* Sesi dimulai dengan **dialog native** (penyedia, batas, peringatan bila "semua host"). Selama sesi model melihat `web_search` dan `web_fetch`.
* **Penyedia:** Wikipedia ID/EN (tanpa key), Brave Search API (key), Google Programmable Search (key + cx), SearXNG publik (https). Pencarian web umum **butuh key atau instans SearXNG**; tidak ada pencarian web umum tanpa penyedia.
* **Halaman:** izin per host (opsi "izinkan host ini selama sesi"); opsi "semua host publik" default MATI karena membuka risiko kebocoran data lewat URL.
* **Batas:** pencarian 10/sesi, halaman 8 (riset: 25/20); URL ≤ 512 karakter; respons ≤ 1,5 MB; teks halaman ≤ 20.000 karakter.
* **Riset mendalam:** instruksi prosedur (sub-pertanyaan → beberapa pencarian → baca sumber primer → bandingkan → jawaban dengan sitasi [n], tingkat keyakinan, hal yang belum diketahui). Batas waktu Chat dinaikkan ke 15 menit (5 menit untuk tool lain; aslinya 60 detik memutus loop tool).
* Hasil pencarian/halaman diberi label **TIDAK TEPERCAYA** + provenance (penyedia/host, waktu, byte, sha256); semua lewat gateway (SSRF guard, redirect divalidasi per hop, audit dengan kueri terpotong 120 karakter). Emergency stop menutup sesi.
* Keterbatasan: format respons Brave/Google/SearXNG/Wikipedia di tes berasal dari dokumentasi publik dan **belum dicocokkan dengan layanan nyata**; ORION tidak merender JavaScript (halaman SPA mungkin kosong); tidak membaca PDF dari web.

## 3. Skill, plugin & connector
Pemilih menampilkan dan mengaktifkan: skill (+ pasang dari folder / SKILL.md), plugin (jalankan prompt, pasang dari folder), connector (API connector aktif, server MCP mulai/berhenti), dan **Temukan online** (GitHub: MCP server, skill, plugin — hanya daftar dengan bintang, lisensi, tanggal, status arsip; tombol buka di GitHub).
**Tidak ada pemasangan otomatis.** Pemasangan skill: dialog persetujuan, hanya berkas teks (.md/.txt/.json/.yaml), maks 40 berkas/1 MB, tanpa symlink/skrip. Nama topik GitHub untuk skill/plugin adalah tebakan terbaik dan mungkin tidak menjaring semua repositori.
