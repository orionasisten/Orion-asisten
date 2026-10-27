import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Api, ApiError, api, readCookie, setUnauthorizedHandler } from '../src/api/client';

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('api client', () => {
  beforeEach(() => {
    document.cookie = 'orion_csrf=csrf-token-123';
  });

  it('mengirim cookie sesi (credentials include) dan header CSRF untuk POST', async () => {
    const fn = mockFetch(201, { ok: true });
    await api('/v1/conversations', { method: 'POST', body: { title: 'x' } });
    const [, init] = fn.mock.calls[0] as any;
    expect(init.credentials).toBe('include');
    expect(init.headers['X-CSRF-Token']).toBe('csrf-token-123');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('tidak mengirim header CSRF pada GET', async () => {
    const fn = mockFetch(200, { ok: true });
    await api('/v1/missions');
    const [, init] = fn.mock.calls[0] as any;
    expect(init.headers['X-CSRF-Token']).toBeUndefined();
  });

  it('memetakan error server ke ApiError dengan kode & status', async () => {
    mockFetch(409, { error: { code: 'CONFLICT', message: 'Perubahan di perangkat lain.' } });
    await expect(api('/v1/conversations/x', { method: 'PATCH', body: {} })).rejects.toMatchObject({
      status: 409, code: 'CONFLICT', message: 'Perubahan di perangkat lain.'
    });
  });

  it('menjalankan handler unauthorized saat 401', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    mockFetch(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } });
    await expect(api('/v1/missions')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalled();
    setUnauthorizedHandler(null);
  });

  it('menandai error 429 sebagai rate limited dan 409 sebagai konflik', async () => {
    mockFetch(429, { error: { code: 'RATE_LIMITED' } });
    const e1 = (await api('/v1/missions').catch(e => e)) as ApiError;
    expect(e1.isRateLimited).toBe(true);
    mockFetch(409, { error: { code: 'CONFLICT' } });
    const e2 = (await api('/v1/missions').catch(e => e)) as ApiError;
    expect(e2.isConflict).toBe(true);
  });

  it('mengubah kegagalan jaringan menjadi ApiError (bukan crash)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const e = (await api('/v1/health').catch(x => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe('NETWORK_ERROR');
  });

  it('membaca cookie CSRF dengan benar', () => {
    expect(readCookie('orion_csrf')).toBe('csrf-token-123');
    expect(readCookie('tidak-ada')).toBeNull();
  });

  it('endpoint wrapper memakai path yang benar', async () => {
    const fn1 = mockFetch(200, { missions: [] });
    await Api.listMissions();
    expect(String((fn1.mock.calls[0] as unknown[])[0])).toContain('/v1/missions');
    const fn2 = mockFetch(200, { conversations: [] });
    await Api.listConversations(10);
    expect(String((fn2.mock.calls[0] as unknown[])[0])).toContain('limit=10');
  });
});
