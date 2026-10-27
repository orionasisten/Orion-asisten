# ORION Competitive Benchmark

Tanggal audit: 21 Okt 2026. Ruang lingkup: implementasi nyata di repo `C:\Users\DIGIUM\Documents\Orion` (versi 4.0.0), dibandingkan dengan dokumentasi/repo upstream yang tersedia. Semua klaim status disusun dari kode dan tes yang benar-benar dijalankan, bukan dari marketing.

## Metode

1. Inspeksi penuh struktur repo, `package.json`, `src/`, `app-src/`, `scripts/`, `resources/`, `docs/`.
2. Menjalankan `npm test` (5 suite) dan `npm run smoke` (Electron asli) — hasil di `docs/orion-evolution-test-report.md`.
3. Menelusuri fitur dari UI (`source/Orion_v_4_0.html`) ke backend/runtime (`src/`, `app-src/`, `src/connectors/`) untuk memverifikasi implementasi.
4. Membandingkan konsep dengan proyek rujukan. Karena akses jaringan tidak dijamin, perbandingan memakai pengetahuan umum arsitektur proyek-proyek tersebut dan catatan yang sudah ada di repo; setiap perbandingan ditandai sebagai `konseptual`, bukan hasil audit langsung upstream.

## Klasifikasi status

- `IMPLEMENTED_AND_VERIFIED` — kode ada, tes otomatis/lintas-modul dijalankan dan lulus.
- `IMPLEMENTED_BUT_UNVERIFIED` — kode ada, belum ada tes native/nyata yang membuktikannya.
- `PARTIAL` — sebagian jalur diimplementasikan, gap nyata.
- `MISSING` — tidak ada implementasi.
- `NOT_APPLICABLE` — tidak relevan untuk identitas produk Orion saat ini.

## Ringkasan proyek rujukan (konseptual)

| Proyek | Tujuan utama | Model eksekusi | Memori/skill | Orkestrasi multi-agent | MCP/plugin | Browser/computer-use | Persistensi/jadwal/recovery | Approval/sandbox | Desktop/web/mobile/remote | Lisensi/kendala | Reuse konseptual | Yang tidak diadopsi | Biaya/risiko integrasi |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Hermes Agent | Agent umum dengan tool loop | Loop model→tool→model | Memori & skill berbasis file | Satu agent + sub-agent terbatas | Tool registry internal | Tool browser terbatas | Lokal, sesi | Izin per tool | CLI/desktop | Periksa lisensi upstream | Pola skill file, loop tool | Arsitektur agent penuh yang tidak cocok desktop lokal | M |
| OpenClaw | Agent desktop/lokal dengan tools | Tool loop + sandbox | Skill/prompt | Multi-agent terbatas | Plugin internal | Browser automation | Lokal | Sandbox proses | Desktop | Periksa lisensi | Sandbox proses, izin | Runtime berat | L |
| Orca | Orkestrasi coding agent | Delegasi ke CLI coding | Konteks repo | Paralel agent | MCP/CLI | Terminal | Lokal | Persetujuan perintah | Desktop (Electron) | Periksa lisensi | Delegasi CLI, paralel terisolasi | Coupling ke ekosistem Stably | M |
| WorkBuddy | Workspace agent | Task + scheduled tasks | Memori workspace | Agent tunggal | Connector | Browser | Lokal/cloud | Persetujuan | Desktop/web | Komersial | UX scheduled tasks, kartu katalog | Backend tertutup | M |
| AionUI | UI agent | UI-driven | Prompt/skill | Terbatas | Plugin | Browser | Lokal | Persetujuan | Desktop/web | Periksa lisensi | Pola UI kartu | Ketergantungan UI | M |
| UI-TARS Desktop | Computer-use agent | Screenshot→aksi | Konteks visual | Terbatas | Tool registry | Screenshot GUI automation | Lokal | Persetujuan | Desktop | Periksa lisensi | Urutan eksekusi API→DOM→GUI | Model vision berat | L |
| Browser Use | Browser automation | DOM+vision | Konteks halaman | Terbatas | Python tool | Browser DOM | Sesi | Persetujuan | Python library | MIT (periksa versi) | Kontrak aksi, verifikasi hasil | Runtime Python terpisah | M |
| LangGraph | Orkestrasi stateful | Graf node/edge | Checkpoint state | Multi-agent graf | Tool node | Tergantung integrasi | Checkpoint durable | Tergantung implementasi | Library | MIT | Pola checkpoint & state transition | Overhead framework untuk stack JS lokal | L |
| OpenHands | Software engineering agent | Runtime container | Memori percakapan | Multi-agent | Tool/MCP | Browser/terminal | Container | Sandbox | Web | MIT (periksa) | Isolasi workspace, verifikasi build | Container runtime berat | XL |
| Microsoft Agent Framework | Framework enterprise | Orkestrasi workflow | Memori & knowledge | Multi-agent | Plugin/MCP | Tergantung integrasi | Durable | Policy | Cloud/desktop | MIT (periksa) | Policy engine, observability | Enterprise complexity | XL |

Catatan lisensi: Orion saat ini `UNLICENSED` (privat). Sebelum mengadopsi kode upstream, lisensi harus diverifikasi per versi; dokumen ini tidak mengklaim lisensi final.

## Matrix kemampuan Orion vs rujukan (klasifikasi Orion)

| # | Kapabilitas | Status Orion | Bukti di repo | Gap utama |
|---|---|---|---|---|
| 1 | General agent loop & tool calling | IMPLEMENTED_AND_VERIFIED | `app-src/orion-desktop.js` `chatWithTools`, loop MCP, selftest 58 lulus | Hanya format OpenAI function-calling; tidak ada adapter capability-based |
| 2 | Mission planning & dependency graph | PARTIAL | `State.missions`, UI Mission Control; tidak ada task graph/dependency | Tidak ada `mission_tasks`, `mission_dependencies` |
| 3 | Parallel specialist agents | MISSING | Agent Factory hanya katalog; CLI agent bridge membutuhkan workspace | Tidak ada scheduler paralel/isolasi workspace |
| 4 | Persistent execution & checkpointing | PARTIAL | `localStorage` untuk proyek/misi/chat/memori; `State.schedule` | Tidak ada backend durable, checkpoint transaksi, recovery |
| 5 | Retry, recovery, idempotency, cancellation | PARTIAL | Emergency stop, retry chat; connector retry 429/5xx | Tidak ada idempotency key, checkpoint eksternal |
| 6 | Cross-session memory & historical retrieval | PARTIAL | Memory Brain lokal, pencarian web/knowledge | Tidak ada provenance/retention/ranking lintas sesi |
| 7 | Skill creation, versioning, evaluation, approval | PARTIAL | 10 skill bawaan, install dari folder, toggle aktif | Tidak ada versioning, evaluasi, approval skill baru |
| 8 | Model routing, fallback, rate limit, cost budget | PARTIAL | Satu provider + preset, validasi mode, test connection | Tidak ada fallback, kuota, anggaran, pelacakan biaya |
| 9 | MCP discovery & execution | IMPLEMENTED_AND_VERIFIED | `src/mcp.js` stdio+HTTP, test lulus; UI MCP | Discovery otomatis terbatas; remote MCP default mati |
| 10 | Browser DOM automation | MISSING | Hanya webtools (fetch/search) | Tidak ada kontrol DOM, form, klik terverifikasi |
| 11 | Computer vision & native desktop automation | MISSING | Tidak ada | Belum ada |
| 12 | Local & remote execution | PARTIAL | Desktop lokal; cloud worker belum ada | Tidak ada Orion Central |
| 13 | Human approval & policy enforcement | IMPLEMENTED_AND_VERIFIED (lokal) | Dialog native, policy connector `decide()`, audit hash | Policy terpusat belum ada; approval per-proses lokal |
| 14 | Connector isolation & secret management | IMPLEMENTED_AND_VERIFIED (Node) | `src/connectors/*`, safeStorage, SSRF guard, audit chain | Belum ada backend/rotasi secret, OAuth ditolak |
| 15 | Mission observability & artifact verification | PARTIAL | Log event lokal, analytics dari data lokal | Tidak ada artifact tracking/verifikasi hasil |
| 16 | Scheduled tasks | IMPLEMENTED_AND_VERIFIED (lokal) | Menu Schedule baru, 6 template, scheduler 20 dtk, smoke lulus | Hanya berjalan saat app terbuka; tidak ada backend durable |
| 17 | Desktop/web/mobile state sync | MISSING | Tidak ada | Belum ada backend sinkronisasi |
| 18 | Product-building workflows | PARTIAL | Quick actions (meeting/terminal belum terhubung) | Tidak ada workflow end-to-end dengan quality gate |
| 19 | Release engineering & upgrade safety | IMPLEMENTED_AND_VERIFIED (Windows) | Installer+portable, checksum, manifest, verify 15/15, CI workflow | macOS/Linux belum diverifikasi di mesin target; code signing belum ada |
| 20 | Testing & security verification | IMPLEMENTED_AND_VERIFIED | 128 tes Node + smoke Electron + verify runtime | Belum ada E2E browser, native dialog, backend, fuzzing |

## Gap analysis prioritas (dengan bukti)

| Gap | Bukti | Dampak pengguna | Severity | Dependensi | Rekomendasi | Acceptance | Kompleksitas |
|---|---|---|---|---|---|---|---|
| Tidak ada backend durable (Orion Central) | `src/main.js` hanya lokal; `docs/audit-blueprint-v1.1.md` menyatakan backend belum ada | Misi tidak bertahan lintas mesin/restart backend; tidak ada sinkronisasi | High | Keputusan infra (Railway/Postgres/queue) | Fase 5: tambahkan API + DB + queue | Misi survive restart worker | XL |
| Tidak ada mission task graph & checkpoint | `State.missions` array di `source/Orion_v_4_0.html`; tidak ada `mission_tasks` | Tidak bisa melacak progres granular, retry aman | High | Backend/schema | Spesifikasi di `docs/mission-runtime.md`, implementasi bertahap | Mission resume setelah restart | L |
| Tidak ada model routing/fallback/budget | `State.settings.provider` tunggal; `AI.test()` | Tidak bisa mengoptimalkan biaya/kualitas, tidak ada no-spend mode | Medium | Provider API | Router terpisah dari mission logic | Routing decision dapat diaudit | M |
| Tidak ada browser DOM automation | `src/webtools.js` hanya fetch/search | Tidak bisa mengoperasikan aplikasi web | Medium | Playwright/CDP | Urutan API→MCP→DOM→GUI | Aksi browser terverifikasi | M |
| Tidak ada parallel specialist agents | Agent Factory hanya katalog | Tidak bisa mempercepat pekerjaan besar | Medium | Runtime isolasi workspace | Adapter capability-based | Task paralel terisolasi | L |
| Tidak ada versioning/evaluasi skill | Skill install dari folder, toggle aktif | Skill baru bisa merusak perilaku tanpa rollback | Medium | Registry skill | Versioning + approval + rollback | Rollback skill teruji | M |
| Tidak ada sinkronisasi desktop/web/mobile | Tidak ada backend | Tidak bisa mengontrol dari mobile | Medium | Orion Central | Kontrak API & event | State sync terverifikasi | XL |
| Tidak ada workflow produk end-to-end | Quick actions belum terhubung | Belum ada jalur bisnis nyata | Medium | Mission runtime | Workflow dengan quality gate | Satu workflow E2E | L |

## Kesimpulan benchmark

Orion sudah kuat di area: keamanan connector lokal (SSRF, audit hash, safeStorage, policy murni), MCP stdio/HTTP teruji, skill/plugin validation, release engineering Windows (installer+portable+checksum+verify), UI desktop hub, scheduled tasks lokal, dan AI adapter protokol-aware. Gap terbesar adalah **durability dan orkestrasi**: tidak ada backend pusat, mission task graph, checkpoint, routing model, dan browser/computer-use. Prioritas implementasi harus mengikuti Phase 0–7 di `docs/orion-evolution-roadmap.md` agar tidak merusak baseline yang sudah terverifikasi.
