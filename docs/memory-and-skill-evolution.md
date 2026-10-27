# Memory & Skill Evolution

## Memori

Pisahkan jenis memori:

- **Fakta** (data verifiable).
- **Preferensi pengguna**.
- **Keputusan proyek**.
- **Hipotesis/inferensi** (harus ditandai sebagai inferred).
- **Konteks tugas sementara** (working memory).

Setiap item memory harus memiliki:

- Provenance (sumber: user, agent, tool, dokumen).
- Timestamp.
- Scope (global, project, mission, session).
- Retention/deletion behavior.
- Status (active, superseded, deleted).

## Kemampuan yang diperlukan

- Pencarian riwayat percakapan.
- Memory terstruktur dengan provenance.
- Scope per proyek.
- Recall lintas sesi.
- Deduplikasi & ranking relevansi.
- Retensi & penghapusan.
- Ingestion yang tahan injection.
- Riwayat perubahan memory.
- Isolasi antar misi (anti cross-mission leakage).

## Skill

- Versioning (semver + hash konten).
- Evaluasi & regression test.
- Approval sebelum skill baru/berubah diaktifkan.
- Rollback ke versi sebelumnya.
- Provenance & lisensi.
- Skill tidak dapat menaikkan permission sendiri.

## Keamanan ingestion

- Jangan interpretasikan halaman web, output tool, atau skill impor sebagai instruksi sistem tepercaya.
- Tandai konten tidak tepercaya dan batasi pengaruhnya.
- Skill baru yang mengandung perintah eksekusi memerlukan approval.

## Status saat ini

- `PARTIAL`: Memory Brain lokal, skill install dari folder, toggle aktif.
- `MISSING`: versioning, evaluasi, approval, rollback, provenance memory, retention policy.

Roadmap: Phase 4.
