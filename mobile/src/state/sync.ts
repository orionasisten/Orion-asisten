import { Api, ApiError } from '../api/client';
import { localStore, type OutboxEntry } from '../storage/stores';
import type { Change } from '../api/types';

export const MSG_TYPES = ['message.created', 'conversation.created', 'conversation.updated', 'conversation.deleted'];

/**
 * Sinkronisasi mobile:
 * - Delta feed (cursor) = sumber kebenaran; SSE hanya notifikasi & dipakai saat foreground.
 * - Outbox pesan persisten: retry memakai idempotency key stabil → tidak pernah menduplikasi.
 * - Kursor disimpan lokal agar catch-up bisa lanjut setelah app restart.
 */

export function newClientMessageId(): string {
  // id stabil (tidak acak ulang saat retry) → idempotensi di server
  return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function enqueueMessage(entries: OutboxEntry[], conversationId: string, role: 'user' | 'assistant', content: string): OutboxEntry[] {
  const clientMessageId = newClientMessageId();
  const entry: OutboxEntry = {
    eventId: 'msg-' + clientMessageId,
    conversationId,
    role,
    content,
    clientMessageId,
    createdAt: new Date().toISOString(),
    attempts: 0,
    state: 'pending'
  };
  const next = [...entries, entry];
  return next;
}

/** Kirim antrean outbox. Mengembalikan entri yang gagal (untuk ditampilkan jujur). */
export async function flushOutbox(entries: OutboxEntry[]): Promise<{ entries: OutboxEntry[]; sent: number; failed: number; revoked: boolean }> {
  let sent = 0, failed = 0, revoked = false;
  const next: OutboxEntry[] = [];
  for (const e of entries){
    if (e.state === 'failed'){
      // Jangan retry otomatis entri yang sudah gagal permanen — biarkan Owner memutuskan
      // (kirim ulang manual / hapus). Mencegah loop retry tanpa akhir.
      next.push(e);
      continue;
    }
    try {
      await Api.sendMessage(e.conversationId, { role: e.role, content: e.content, clientMessageId: e.clientMessageId });
      sent++;
      // tidak dimasukkan kembali ke antrean (sukses)
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      if (err instanceof ApiError && err.isUnauthorized){
        revoked = true;
        next.push({ ...e, state: 'failed', lastError: err.message, attempts: e.attempts + 1 });
        failed++;
        break; // hentikan: identitas mungkin dicabut / expired
      }
      if (/NOT_FOUND|BAD_|CONFLICT|DUPLICATE|FORBIDDEN/.test(code)){
        // Entri permanen gagal (mis. percakapan sudah dihapus di server).
        // Tetap disimpan sebagai `failed` agar Owner melihatnya, antrean tidak diblokir,
        // dan pesan tidak hilang diam-diam.
        next.push({ ...e, state: 'failed', lastError: err instanceof Error ? err.message : 'Gagal', attempts: e.attempts + 1 });
        failed++;
        continue;
      }
      next.push({ ...e, state: 'pending', lastError: err instanceof Error ? err.message : 'Gagal', attempts: e.attempts + 1 });
      failed++;
    }
  }
  return { entries: next, sent, failed, revoked };
}

/** Ambil perubahan baru sejak cursor (catch-up). */
export async function catchUp(since: number): Promise<{ changes: Change[]; cursor: number }> {
  const res = await Api.changes(since, 200);
  const cursor = res.changes.reduce((m, c) => Math.max(m, Number(c.cursor) || 0), since);
  return { changes: res.changes, cursor };
}
