import { Api, ApiError, apiBaseUrl, setApiBaseUrl, setTokenProvider } from '../src/api/client';
import { catchUp, enqueueMessage, flushOutbox } from '../src/state/sync';
import type { OutboxEntry } from '../src/storage/stores';

function mockFetch(status: number, body: unknown) {
  const fn = jest.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  (global as any).fetch = fn;
  return fn;
}

describe('mobile api client', () => {
  beforeEach(() => {
    setApiBaseUrl('https://orion.example');
    setTokenProvider(() => 'device-token-abcdefghijklmnop');
    jest.restoreAllMocks();
  });

  it('menyertakan device token sebagai header Authorization', async () => {
    const fn = mockFetch(200, { ownerId: 'own-1' });
    await Api.session();
    const [, init] = fn.mock.calls[0] as any;
    expect(init.headers['Authorization']).toBe('Bearer device-token-abcdefghijklmnop');
  });

  it('tidak pernah menaruh token di URL', async () => {
    const fn = mockFetch(200, { conversations: [] });
    await Api.listConversations(10);
    const [url] = fn.mock.calls[0] as any;
    expect(String(url)).not.toContain('device-token');
    expect(String(url)).toContain('limit=10');
  });

  it('memetakan 401 → ApiError unauthorized', async () => {
    mockFetch(401, { error: { code: 'SESSION_EXPIRED', message: 'Sesi kedaluwarsa.' } });
    const e = (await Api.session().catch(x => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.isUnauthorized).toBe(true);
    expect(e.code).toBe('SESSION_EXPIRED');
  });

  it('memetakan 409 → konflik dan 429 → rate limited', async () => {
    mockFetch(409, { error: { code: 'CONFLICT' } });
    expect(((await Api.decideApproval('a', 'approved').catch(x => x)) as ApiError).isConflict).toBe(true);
    mockFetch(429, { error: { code: 'RATE_LIMITED' } });
    expect(((await Api.listMissions().catch(x => x)) as ApiError).isRateLimited).toBe(true);
  });

  it('memetakan 404 → not found dan 5xx → server error', async () => {
    mockFetch(404, { error: { code: 'NOT_FOUND_OR_FORBIDDEN' } });
    expect(((await Api.getMission('x').catch(x => x)) as ApiError).isNotFound).toBe(true);
    mockFetch(503, { error: { code: 'DEPENDENCY_UNAVAILABLE' } });
    expect(((await Api.listMissions().catch(x => x)) as ApiError).isServer).toBe(true);
  });

  it('gagal jaringan → ApiError offline (bukan crash)', async () => {
    (global as any).fetch = jest.fn(async () => { throw new TypeError('Network request failed'); });
    const e = (await Api.health().catch(x => x)) as ApiError;
    expect(e.isOffline).toBe(true);
    expect(e.code).toBe('NETWORK_ERROR');
  });

  it('base URL dibaca dari environment, tanpa hardcode', () => {
    setApiBaseUrl(null);
    const prev = process.env.EXPO_PUBLIC_ORION_API_URL;
    process.env.EXPO_PUBLIC_ORION_API_URL = 'https://central.example/';
    expect(apiBaseUrl()).toBe('https://central.example');
    process.env.EXPO_PUBLIC_ORION_API_URL = prev;
  });

  it('URL yang dimasukkan pengguna divalidasi & benar-benar dipakai', async () => {
    setApiBaseUrl('https://central-baru.example/');
    const fn = mockFetch(200, { ownerId: 'own-1' });
    await Api.session();
    expect(String((fn.mock.calls as any[])[0][0])).toBe('https://central-baru.example/v1/session');
    // local/emulator boleh HTTP
    setApiBaseUrl('http://10.0.2.2:8787/');
    expect(apiBaseUrl()).toBe('http://10.0.2.2:8787');
    // URL non-lokal lewat HTTP, kredensial, query, dan fragment ditolak
    expect(() => setApiBaseUrl('http://central.example')).toThrow();
    expect(() => setApiBaseUrl('https://user:pass@central.example')).toThrow();
    expect(() => setApiBaseUrl('https://central.example/?x=1')).toThrow();
    expect(() => setApiBaseUrl('https://central.example/#frag')).toThrow();
    expect(() => setApiBaseUrl('ftp://central.example')).toThrow();
  });
});

describe('mobile outbox & sync', () => {
  beforeEach(() => {
    setApiBaseUrl('https://orion.example');
    setTokenProvider(() => 'device-token-abcdefghijklmnop');
    jest.restoreAllMocks();
  });

  it('enqueue membuat idempotency key yang stabil', () => {
    const entries = enqueueMessage([] as OutboxEntry[], 'cnv-1', 'user', 'halo');
    expect(entries).toHaveLength(1);
    expect(entries[0].eventId).toBe('msg-' + entries[0].clientMessageId);
    expect(entries[0].state).toBe('pending');
  });

  it('retry dengan clientMessageId sama tidak menggandakan entri outbox', async () => {
    mockFetch(200, { message: { id: 'm1' }, duplicate: false });
    const first = enqueueMessage([] as OutboxEntry[], 'cnv-1', 'user', 'halo');
    const res = await flushOutbox(first);
    expect(res.sent).toBe(1);
    expect(res.entries).toHaveLength(0);
    // flush lagi dengan entri yang sama (mis. respons hilang) → server dedupe
    mockFetch(200, { message: { id: 'm1' }, duplicate: true });
    const res2 = await flushOutbox(first);
    expect(res2.sent).toBe(1);
    expect(res2.entries).toHaveLength(0);
  });

  it('gagal offline → entri tetap pending di outbox (tidak hilang)', async () => {
    (global as any).fetch = jest.fn(async () => { throw new TypeError('Network request failed'); });
    const entries = enqueueMessage([] as OutboxEntry[], 'cnv-1', 'user', 'halo');
    const res = await flushOutbox(entries);
    expect(res.sent).toBe(0);
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0].state).toBe('pending');
  });

  it('401 → outbox berhenti & ditandai failed (identitas dicabut)', async () => {
    mockFetch(401, { error: { code: 'SESSION_REVOKED', message: 'Sesi telah dicabut.' } });
    const entries = enqueueMessage([] as OutboxEntry[], 'cnv-1', 'user', 'halo');
    const res = await flushOutbox(entries);
    expect(res.revoked).toBe(true);
    expect(res.entries[0].state).toBe('failed');
  });

  it('entri permanen gagal (404) tetap tersimpan sebagai failed & tidak memblokir antrean', async () => {
    const a = enqueueMessage([], 'cnv-hilang', 'user', 'tujuan hilang')[0];
    const b = enqueueMessage([] as OutboxEntry[], 'cnv-1', 'user', 'masih bisa')[0];
    (global as any).fetch = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'NOT_FOUND_OR_FORBIDDEN', message: 'tidak ada' } }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { id: 'm-ok' }, duplicate: false }), { status: 201 }));

    const res = await flushOutbox([a, b]);
    expect(res.sent).toBe(1);
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0].clientMessageId).toBe(a.clientMessageId);
    expect(res.entries[0].state).toBe('failed');

    // tidak di-retry otomatis (mencegah loop tanpa akhir)
    (global as any).fetch = jest.fn();
    const res2 = await flushOutbox(res.entries);
    expect((global as any).fetch).not.toHaveBeenCalled();
    expect(res2.sent).toBe(0);
    expect(res2.entries).toHaveLength(1);
  });

  it('catch-up memakai delta cursor dan mengembalikan cursor terbaru', async () => {
    mockFetch(200, { changes: [{ id: 'e1', cursor: 12, type: 'message.created', payload: '{}', received_at: '' }], cursor: 12, hasMore: false });
    const res = await catchUp(5);
    expect(res.cursor).toBe(12);
    expect(res.changes).toHaveLength(1);
  });

  it('outbox tidak pernah memuat token/secret', () => {
    const entries = enqueueMessage([] as OutboxEntry[], 'cnv-1', 'user', 'halo');
    const dump = JSON.stringify(entries);
    expect(dump).not.toMatch(/Authorization|Bearer|token/i);
  });
});
