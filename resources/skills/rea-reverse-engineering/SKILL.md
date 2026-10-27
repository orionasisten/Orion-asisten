---
name: REA Reverse Engineering
description: Menyelidiki biner, aplikasi (native, .NET, Electron/JS, Android, firmware) dan perilaku runtime dengan server MCP REA — berbasis bukti dan dalam batas penggunaan yang sah.
---
Diadaptasi dari skill resmi REA (MIT, morluto/rea). Dipakai bersama tool server MCP "rea".

## Kapan dipakai
Pakai REA bila kesimpulan bergantung pada artefak yang dikirim (biner, paket, ASAR), dekompilasi, atau bukti runtime. Jika source code lengkap tersedia, analisis kodenya langsung; jangan jalankan REA.

## Batas penggunaan yang sah (wajib)
Hanya untuk analisis sah: riset keamanan, analisis malware/insiden, CTF dan edukasi, interoperabilitas, pelestarian perangkat lunak, serta debugging/audit software milik sendiri atau yang Anda berwenang periksa.
Tolak dengan sopan dan tawarkan alternatif sah bila diminta: menjebol DRM/lisensi/anti-cheat, membuat cheat game atau merusak layanan online, melewati autentikasi atau kontrol akses sistem tanpa izin, menyalin software berhak cipta atau kode/aset terproteksinya.
Izin memeriksa sebuah berkas BUKAN izin menjalankannya, mencegat lalu lintas, atau mengubah perangkat/layanan pihak lain.

## Aturan kerja
- Pakai hanya tool yang benar-benar tersedia; versi REA berbeda-beda. Pada mode tool bertahap: `mcp_find_tools` → `mcp_describe_tool` → `mcp_call_tool`.
- Semua path input HARUS absolut. Jika pengguna hanya menyebut "aplikasi saya" tanpa nama/path, tanyakan dulu; jangan memilih contoh sendiri.
- Mulai dari yang ringkas: `detail: "summary"`, lalu halaman/tampilan terfokus (mis. `inspect_analysis_view` dengan referensi Evidence yang dikembalikan). Jangan mengulang analisis identik.
- Hasil yang bertanda DIPOTONG tidak lengkap dan bukan JSON utuh: jangan diparse; minta tampilan lebih kecil.
- Bedakan OBSERVASI, INFERENSI, dan TIDAK DIKETAHUI. Kutip Evidence ID, sebutkan batasan dan cakupan. Analisis statis tidak pernah berarti sesuatu "teramati berjalan".
- Setiap panggilan tool memicu dialog persetujuan di komputer pengguna. Sebelum memanggil tool yang menjalankan program, menyambung ke proses/perangkat, atau menangkap lalu lintas, jelaskan singkat apa yang akan dilakukan dan mengapa; jangan memperluas target atau aksi di luar permintaan.

## Rute berdasarkan target (nama tool REA)
- ASAR / folder JavaScript-Electron: `analyze_javascript_application` (summary dulu) → `inspect_analysis_view`; telusuri fitur dengan `trace_application_feature`.
- Arsip/paket (ZIP, APK, IPA, MSIX, DMG): `open_binary` dengan path lokal, atau `inspect_artifact`.
- APK (kelas, method, referensi): `inspect_android_package`.
- Assembly .NET (PE/CLI): `inspect_managed_artifact`, lalu anggota tipe.
- Firmware: `inspect_firmware_regions`; ekstraksi (`extract_firmware`) hanya jika diminta, ke direktori keluaran absolut yang baru.
- Biner native (exe, dll, so, dylib): `open_binary` lalu tool analisis terfokus (fungsi, pseudocode, string, referensi); `binary_overview` bila tersedia.
- Halaman browser / aplikasi Electron yang sedang terbuka milik pengguna: `list_browser_targets`, `list_electron_targets`; sebelum mengamati Electron, cek `inspect_electron_fuses`.
- Capture jaringan terekam (HAR/SAZ/pcap): `inspect_web_network_capture`, `inspect_pcap_capture`, `inspect_packet_capture` (membaca rekaman, bukan menangkap langsung).
- Lainnya: WebAssembly `inspect_wasm_artifact`, SQLite `inspect_sqlite_database`, Go `inspect_go_binary`, Rust `inspect_rust_binary`, bytecode EVM `inspect_evm_interface`, resource PE `inspect_pe_resources`.
Bila ragu, cek `binary_session` (ketersediaan tool) dan kembalilah ke daftar tool nyata.

## Investigasi luas
1. Ubah permintaan menjadi checklist pertanyaan beserta bukti yang dibutuhkan tiap jawaban.
2. Mulai dari inventori terkecil; ikuti alur dari titik masuk ke data, perubahan state, hingga hasil. Satu hipotesis per kelompok panggilan.
3. Periksa juga resource dan konfigurasi yang dikemas, jangan menyimpulkan dari nama berkas atau string saja.
4. Corroborate dengan jenis bukti yang sesuai; pakai pengamatan runtime hanya bila bukti statis tak cukup dan diizinkan.
5. Simpan buku temuan: klaim | Evidence ID | keyakinan | batas pencarian | yang belum diketahui. Sebelum selesai, tandai tiap pertanyaan: terjawab / sebagian / belum.

## Dari temuan ke implementasi
Tulis spesifikasi PERILAKU yang teramati (input, output, state, protokol, kasus tepi) lalu implementasikan sendiri secara mandiri (clean-room) di stack pengguna. Jangan menyalin kode, aset, atau data terproteksi; ingatkan pengguna memeriksa lisensi dan hukum setempat.
