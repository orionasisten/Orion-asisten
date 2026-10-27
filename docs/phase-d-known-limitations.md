# Phase D — Known Limitations

Tanggal: 22 Okt 2026. Daftar jujur: apa yang **tidak** terbukti pada fase ini.

## 1. Build & distribusi
| Batasan | Status | Dampak / jalur alternatif |
|---|---|---|
| **APK Android native di mesin ini** | **BLOCKED (lingkungan, bukan kode)** | Codegen New Architecture menembus batas `MAX_PATH` 260 Windows; `LongPathsEnabled=0` dan tanpa hak admin; tidak ada WSL/Docker. Yang **sudah terbukti**: `expo prebuild` sukses, semua modul Kotlin/Java terkompilasi, dan bundel Hermes 1,77 MB dihasilkan. Jalur: EAS Build / CI ubuntu / Windows long-path / macOS. Detail: `docs/phase-d-testing.md` §4a. |
| **IPA iOS** | **BLOCKED** | Butuh macOS + Xcode; lingkungan ini Windows. Tidak ada klaim build/test iOS. Jalur: `npx expo prebuild --platform ios` + `eas build -p ios` di macOS/CI. |
| **Emulator/simulator** | **BLOCKED** | Virtualisasi firmware dinonaktifkan → emulator Android tidak bisa dijalankan di mesin ini. Jalur: CI (macOS/Android emulator) atau perangkat fisik. |
| **Perangkat fisik** | **BLOCKED** | Tidak ada perangkat Android/iOS. Semua pengujian dilakukan pada level API + logika + build. |
| **EAS Build (cloud)** | **BELUM DIJALANKAN** | Butuh akun EAS + `EXPO_PUBLIC_EAS_PROJECT_ID`. Build lokal Android tersedia (lihat `docs/phase-d-testing.md` §4). |
| **Play Store / App Store** | **BELUM** | Butuh signing key (tidak disimpan di repo), privacy disclosure, data-safety form, review. |
| **Signing** |.release memakai debug keystore bawaan Expo | Untuk distribusi internal sah perlu keystore sendiri (`mobile/android/app/build.gradle` + `credentials.json` yang **tidak** di-commit). |

## 2. Push notification
| Batasan | Status |
|---|---|
| Push **nyata** (FCM/APNs) | **BELUM AKTIF** — butuh kredensial provider (`EXPO_PUBLIC_EAS_PROJECT_ID` + project EAS). Aplikasi berjalan dalam **mode pengembangan** dan melaporkan status itu secara jujur ke Owner. |
| Notifikasi ke perangkat dicabut | **Belum ada** (butuh endpoint push + penghapusan token saat revoke device). |
| Isi notifikasi | Saat ini hanya jenis peristiwa ("Misi selesai", "Approval perlu keputusan") — **tanpa** isi percakapan/token. |

## 3. Fungsional
| Batasan | Status |
|---|---|
| Sinkronisasi saat background | **Tidak ada** — polling 12 detik hanya saat aplikasi aktif. Push (belum aktif) akan menjadi pemicunya. |
| SSE di mobile | **Tidak dipakai** ( koneksi panjang tidak diandalkan di mobile; delta feed + polling dipakai). |
| Lampiran/attachment | **Belum didukung** di mobile (chat mobile teks saja). |
| Voice (STT/TTS) | **Belum** di mobile (Desktop & Web punya voice; mobile perlu-modul STT). |
| Migrasi percakapan lokal → Central | **Belum** untuk mobile (Desktop punya; mobile adalah klien baru). |
| Notifikasi approval real-time | Bergantung push (belum aktif); saat ini Owner membuka layar Setuju. |

## 4. Keamanan & otorisasi
| Batasan | Status |
|---|---|
| Pairing | Token perangkat ditampilkan sekali (rahasia bersama). **Belum** pairing berkode sekali pakai. Token yang bocor harus dicabut manual di Web App. |
| Scope per-perangkat | **Belum** — satu device token = akses penuh owner. Mitigasi: cabut perangkat. |
| Biometri / passcode aplikasi | **Belum** (bergantung keystore perangkat). |
| Push token | Disimpan sebagai identifier, bukan rahasia; tetap terautentikasi & ter-scope owner. |

## 5. Teknis
| Batasan | Status |
|---|---|
| `npm audit` di `mobile/` | 15 advisory high **di pohon build Expo/RN** (dev tooling), bukan kode aplikasi yang berjalan. Perlu ditinjau berkala; `npm audit fix --force` dapat merusak kompatibilitas Expo — **tidak** diterapkan otomatis. |
|Ukuran APK | Standar Expo/RN (~50–80 MB) — belum dioptimasikan (Hermes/Proguard belum dikonfigurasi). |
| Multi-owner | **Tidak** ada (sesuai desain: sistem privat satu Owner). |
| Offline read | Data terakhir tetap tampil dari cache memori; belum ada cache disk untuk riwayat. |
| Retry ganda | Dicegah idempotency key; timeout ≠ gagal (server dedupe). |
| Backend load test | **Belum** dilakukan. |
| Multi-instance sync | **Belum** diuji (>1 desktop/mobile). |

## 6. Yang TIDAK berubah (regresi nol)
Desktop (Electron), Web App, Orion Central, skema PostgreSQL (kecuali migrasi `010_push_tokens` yang
aditif), runtime misi, budget ledger, approval, memory provenance, dan registry skill tetap utuh —
dibuktikan oleh 265 tes regresi + 88 tes integrasi PostgreSQL + 29 E2E yang semuanya hijau.
