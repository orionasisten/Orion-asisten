# Agent Runtime & Model Routing

## Tujuan

Memisahkan pemilihan provider/model dari logika misi. Routing mempertimbangkan kapabilitas, biaya, kuota, latensi, privasi, dan izin eksekusi.

## Interface routing (konseptual)

```
route(task, constraints) -> {
  agentProfile, provider, model, reason, estimatedCost, fallbacks[]
}
```

Input: tipe task, kapabilitas wajib, batas biaya, privasi, workspace/execution permission, context limit, preferensi pengguna.

Output: keputusan yang dapat diaudit (alasan, estimasi, fallback).

## Faktor routing

- Tipe task (research, coding, browser, analisis, penulisan).
- Kapabilitas wajib (tool-calling, vision, context window).
- Kompatibilitas format output.
- Latensi.
- Biaya (estimasi vs aktual).
- Rate limit & kuota.
- Ketersediaan provider.
- Privasi (data sensitif → provider lokal/terpercaya).
- Izin workspace/eksekusi.
- Batas context.
- Evaluasi kualitas (opsional, berbasis hasil).

## Preferensi pengguna yang dapat dikonfigurasi

1. Provider gratis/free tier yang memenuhi syarat.
2. Provider murah.
3. Provider berbayar untuk task yang layak.
4. Model lokal bila sesuai.
5. Provider pilihan eksplisit pengguna.

Jangan mengklaim provider/endpoint gratis tanpa verifikasi terms & quota terkini.

## Budget & rate limit

- Anggaran per misi dan per provider (`budget_ledger`).
- Lacak estimasi terpisah dari penggunaan aktual.
- Tangani rate limit & timeout dengan backoff.
- Fallback terkontrol; hindari mengulang aksi tool non-idempoten saat fallback model.
- Mode no-spend/restricted-budget.
- Redaksi secret dari log & artefak.
- Pengguna dapat memeriksa keputusan routing.

## Agent CLI sebagai backend

Perlakukan CLI coding (OpenCode, Claude Code, Codex) sebagai backend eksekusi, bukan model API yang dapat ditukar. Mereka memiliki format output, izin, dan cancellation berbeda. Adapter harus mendukung:

- Deteksi ketersediaan & versi.
- Persetujuan native sebelum eksekusi.
- Isolasi workspace.
- Timeout & cancellation.
- Capture output & artefak.

## Status saat ini

- `IMPLEMENTED_AND_VERIFIED` (lokal): satu provider OpenAI-compatible + preset + validasi mode + test connection.
- `PARTIAL`: tidak ada fallback, kuota, anggaran, pelacakan biaya, routing capability-based.
- `MISSING`: backend central, multi-provider routing.

Roadmap: Phase 3.
