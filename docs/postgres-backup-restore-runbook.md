# PostgreSQL Backup & Restore — Runbook (Orion Central)

**Status:** Prosedur terdokumentasi dan diverifikasi lokal; restore drill aktual menggunakan embedded PostgreSQL terverifikasi dalam `scripts/postgres-backup-restore-verify.js`.
**Batasan produksi:** Tidak ada RTO/RPO yang ditetapkan secara resmi — direkomendasikan untuk disetujui oleh pemilik sebelum deploy produksi.

---

## 1. Lingkungan dan dependensi

- PostgreSQL 17 (versi kompatibel proyek, termasuk `@embedded-postgres` lokal untuk uji).
- Alat: `pg_dump` (custom format), `psql` (untuk restore), `pg_ctl` (manajemen server lokal).
- Tidak diperlukan kredensial produksi dalam dokumen ini; semua nilai rahasia menggunakan placeholder.

---

## 2. Konfigurasi (placeholder)

```bash
# Ganti placeholder sebelum eksekusi produksi
DB_HOST=localhost
DB_PORT=5432
DB_NAME=orion
DB_USER=postgres
DB_PASSWORD=<SECRET_PLACEHOLDER>
BACKUP_FILE=/tmp/orion-backup-$(date +%F-%H%M).dump
RESTORE_TARGET=/tmp/orion-restore-verify
```

---

## 3. Perintah backup (non-destructive)

```bash
# Custom-format dump (kompresi, fleksibel saat restore)
pg_dump -Fc -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "$BACKUP_FILE"
# Verifikasi keberadaan file non-kosong
ls -lh "$BACKUP_FILE"
# Daftar isi (tanpa restore)
pg_restore --list "$BACKUP_FILE"
```

---

## 4. Restore ke database kosong (disposable/isolated)

```bash
# Buat database target baru yang kosong
createdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" orion_restore_test || true
# Restore
pg_restore --clean --if-exists --dbname="postgresql://postgres:<SECRET_PLACEHOLDER>@localhost:5432/orion_restore_test" -h "$DB_HOST" -p "$DB_PORT" -d orion_restore_test "$BACKUP_FILE"
# Atau menggunakan psql langsung untuk format plain-text (jika digunakan)
```

---

## 5. Verifikasi setelah restore

- Periksa jumlah baris utama: `auth_tokens`, `devices`, `events`, `missions`, `jobs`, `audit`.
- Pastikan migrasi berjalan (`db/migrate.js` terhadap DB restore).
- Jalankan `npm run test:postgres` terhadap DB restore (dengan mengganti `DATABASE_URL` sementara).
- Periksa integritas referensial (`SELECT * FROM information_schema.table_constraints WHERE ...`).
- Periksa bahwa tidak ada token atau password plaintext yang bocor ke file log/artifact.

---

## 6. Prosedur otomatis (verifikasi lokal)

Script `scripts/postgres-backup-restore-verify.js` melakukan:
1. Start embedded PostgreSQL melalui `scripts/pg-harness.js` (data dir sementara).
2. Jalankan migrasi (`migrate`).
3. Insert data representatif (`mission`, `approval`, `session`).
4. `pg_dump` ke file `.dump` sementara.
5. Buat instance PG baru dengan `pg-harness` (data dir berbeda).
6. `pg_restore` ke instance baru.
7. Verifikasi jumlah baris dan keberadaan skema.
8. Bersihkan semua file sementara dan hentikan instance PG.

Status: **VERIFIED LOKAL** menggunakan embedded PostgreSQL, bukan produksi.

---

## 7. Penanganan kegagalan

- Backup terputus: ulangi; tidak merusak sumber.
- Restore gagal karena versi skema tidak cocok: periksa versi migrasi (`db/migrations` checksum) dan sesuaikan sumber sebelum restore.
- File `.dump` rusak: ulangi backup; simpan minimal 2 salinan.

---

## 8. Catatan keamanan

- Tidak menyimpan `pg_dump` artifact dalam direktori yang dilacak Git.
- Hapus `.dump` sementara setelah verifikasi (`rm -f /tmp/orion-backup-*.dump`).
- Jangan mencetak `DB_PASSWORD` dalam log atau laporan.
- Jangan menjalankan restore terhadap database bersama atau produksi tanpa persetujuan eksplisit.
