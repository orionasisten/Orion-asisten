# Security & Authority Model

## Prinsip

- Least privilege.
- Trusted code menegakkan setiap tool invocation, bukan hanya prompt LLM.
- Approval terikat pada aksi, resource, scope, dan parameter relevan; jika parameter berubah, approval lama tidak boleh dipakai (fingerprint) bila policy menuntut.
- Sandboxed execution untuk kode/skill tidak tepercaya.
- Pisahkan identitas cloud dan desktop; worker cloud tidak menerima semua secret desktop.

## Izin eksplisit

- Read workspace.
- Write workspace.
- Run terminal commands.
- Execute coding agents.
- Access browser profiles.
- Access network resources.
- Call external APIs.
- Access credentials.
- Deploy applications.
- Publish content.
- Spend money.
- Modify permissions/security settings.

## Kontrol yang sudah ada (repo)

- `src/connectors/policy.js` `decide()` murni (read-public/read-private/write/high-impact).
- `src/connectors/netguard.js` SSRF guard (blokir privat/loopback/link-local/metadata/mapped/NAT64/6to4).
- `src/connectors/secrets.js` + safeStorage (DPAPI/Keychain).
- `src/connectors/audit.js` audit chain hash tamper-evident.
- Approval dialog native + emergency stop.
- Redaksi secret dari teks/URL/header.
- Validasi path (anti traversal/symlink).
- MCP remote default mati (eksperimental).

## Pengujian keamanan yang diperlukan

- Prompt injection.
- Unauthorized IPC.
- Path traversal.
- Symlink escape.
- Secret exfiltration.
- SSRF.
- Privilege escalation.
- Unauthorized tool invocation.
- Approval bypass.
- Budget bypass.
- Cross-mission data leakage.
- Replay stale approval token.

## Status

- `IMPLEMENTED_AND_VERIFIED` (Node): connector policy, SSRF, secret store, audit chain, path validation, redaction.
- `IMPLEMENTED_BUT_UNVERIFIED`: dialog native, emergency stop native, sandbox proses.
- `MISSING`: policy engine terpusat, sandbox skill, separasi identitas cloud/desktop, budget bypass tests.

Roadmap: Phase 1 & 5.
