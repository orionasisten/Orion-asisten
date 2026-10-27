# Browser & Computer Use

## Urutan eksekusi yang disarankan

1. API resmi / connector.
2. MCP tool.
3. Browser DOM automation.
4. Screenshot-based GUI automation.
5. Intervensi manual bila tidak dapat diverifikasi dengan aman.

## Kontrak aksi umum

Setiap aksi memiliki:

- Capability yang diperlukan.
- Timeout.
- Cancellation.
- Screenshot/log bila sesuai.
- Hasil terstruktur (status, evidence, error).

## Dukungan yang diperlukan

- Sesi browser & batas autentikasi.
- Validasi unduhan/unggahan.
- Pembatasan navigasi.
- Penanganan konten web yang tahan prompt injection.
- Konfirmasi sebelum publish, hapus, beli, atau ubah pengaturan akun.
- Verifikasi pasca-aksi.
- Pemeriksaan ketersediaan desktop lokal.
- Eksekusi remote hanya di lingkungan yang diotorisasi secara eksplisit.

## Aturan verifikasi

Jangan klaim klik/form submission berhasil hanya karena perintah aksi return tanpa error. Wajib verifikasi hasil (DOM state, screenshot, API response, atau receipt).

## Status saat ini

- `MISSING`: browser DOM automation, computer-use.
- `IMPLEMENTED_AND_VERIFIED` (lokal): web fetch/search (read-only) lewat gateway dengan SSRF guard dan persetujuan.

Roadmap: Phase 6.
