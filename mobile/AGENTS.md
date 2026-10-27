# ORION Mobile — panduan untuk AI/agent yang mengerjakan folder ini.

Aplikasi **kliens Owner** untuk Android & iOS (React Native + Expo + TypeScript).

## Aturan penting
1. **Bukan sumber kebenaran.** Mobile HANYA klien API Orion Central. Jangan pernah menentukan
   izin, anggaran, status misi, atau approval di sisi perangkat.
2. **Token hanya di secure store.** `expo-secure-store` untuk token perangkat.
   Dilarang: AsyncStorage, log, URL, bundle, source code.
3. **Outbox tanpa secret.** `AsyncStorage` hanya untuk antrean pesan & cursor sinkronisasi.
4. **Idempotensi.** `clientMessageId` stabil → retry tidak pernah menduplikasi.
5. **Jangan percaya status perangkat.** Server memvalidasi owner/device/approval/budget.
6. **Jangan pakai cookie auth** di native (CSRF + SameSite tidak cocok). Native memakai
   **device token bearer** (alur yang sama dengan Desktop, Phase C).
7. **Expo SDK 58 / RN 0.88.** Jangan memakai API lama; cek versi paket yang terpasang.

## Perintah
```bash
cd mobile
npm install          # sekali
npm run typecheck    # tsc --noEmit
npm test             # jest (unit)
npm run start        # Metro dev server
npm run android      # buka di Android (Expo Go / dev build)
npm run ios          # hanya di macOS
```

## Kontrak API
Semua endpoint ada di `src/central/app.js` (backend). Ringkas:
- `GET /v1/session` — identitas owner (butuh device token).
- `GET/POST /v1/conversations`, `GET/POST /v1/conversations/:id/messages`.
- `GET /v1/missions`, `GET /v1/missions/:id`, `POST /v1/missions/:id/cancel`.
- `GET /v1/approvals`, `POST /v1/approvals/:id/decision`.
- `GET /v1/devices`, `DELETE /v1/devices/:id`.
- `GET /v1/sync/changes?since=<cursor>` — delta feed (catch-up).
- `POST /v1/push/register`, `POST /v1/push/revoke`.

## Environment
`EXPO_PUBLIC_ORION_API_URL` → URL Orion Central (tanpa trailing slash).
`EXPO_PUBLIC_EAS_PROJECT_ID` → hanya untuk push nyata (EAS). Tanpa itu, push berjalan
dalam **mode pengembangan** (tanpa push sungguhan) dan dilaporkan jujur ke Owner.
