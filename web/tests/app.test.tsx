import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { App } from '../src/App';
import { LoginPage } from '../src/pages/Login';
import { SessionProvider, useSession } from '../src/state/session';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function routeFetch(routes: Record<string, () => Response>) {
  const fn = vi.fn(async (url: string, init?: any) => {
    const key = String(url).split('?')[0];
    const method = init?.method || 'GET';
    const k = method + ' ' + key;
    if (routes[k]) return routes[k]();
    if (routes[key]) return routes[key]();
    return jsonResponse({ error: { code: 'NOT_FOUND', message: 'tidak ada' } }, 404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('login page', () => {
  beforeEach(() => { document.cookie = 'orion_csrf=csrf'; });

  it('menampilkan form login Owner tanpa registrasi publik', () => {
    render(<SessionProvider><LoginPage /></SessionProvider>);
    expect(screen.getByLabelText('Email Owner')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByText(/tidak ada pendaftaran publik/i)).toBeInTheDocument();
  });

  it('menampilkan error kredensial salah dari server', async () => {
    routeFetch({ 'POST /v1/auth/login': () => jsonResponse({ error: { code: 'INVALID_CREDENTIALS', message: 'Email atau password salah.' } }, 401) });
    render(<SessionProvider><LoginPage /></SessionProvider>);
    fireEvent.change(screen.getByLabelText('Email Owner'), { target: { value: 'owner@orion.id' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'salah' } });
    fireEvent.click(screen.getByText(/Masuk ke Orion Central/i));
    await waitFor(() => expect(screen.getByText(/Email atau password salah/i)).toBeInTheDocument());
  });

  it('validasi input lokal sebelum memanggil server', async () => {
    const fn = routeFetch({});
    render(<SessionProvider><LoginPage /></SessionProvider>);
    fireEvent.click(screen.getByText(/Masuk ke Orion Central/i));
    await waitFor(() => expect(screen.getByText(/Email dan password wajib diisi/i)).toBeInTheDocument());
    // tidak ada request login yang terkirim (hanya probe sesi dari provider)
    const loginCalls = fn.mock.calls.filter(c => String(c[0]).includes('/v1/auth/login'));
    expect(loginCalls.length).toBe(0);
  });
});

describe('app shell', () => {
  beforeEach(() => { document.cookie = 'orion_csrf=csrf'; });

  it('berpindah ke login ketika tidak terautentikasi', async () => {
    routeFetch({ 'GET /v1/session': () => jsonResponse({ error: { code: 'UNAUTHENTICATED' } }, 401) });
    render(<SessionProvider><App /></SessionProvider>);
    await waitFor(() => expect(screen.getByText(/Masuk ke Orion Central/i)).toBeInTheDocument());
  });

  it('menampilkan dashboard dengan data nyata dari server', async () => {
    routeFetch({
      'GET /v1/session': () => jsonResponse({ ownerId: 'own-1', displayName: 'Owner', email: 'o@x.id', role: 'owner', deviceId: null, authMethod: 'cookie', expiresAt: null }),
      'GET /v1/missions': () => jsonResponse({ missions: [{ id: 'ms-1', title: 'Misi Satu', state: 'running', executions: 1, max_executions: 5, budget_spent: 1, budget_limit: 10, budget_reserved: 0, budget_currency: 'unit', created_at: '2026-10-22T00:00:00Z', updated_at: '2026-10-22T00:00:00Z' }] }),
      'GET /v1/approvals': () => jsonResponse({ approvals: [{ id: 'ap-1', action: 'publish', resource: 'res://x' }] }),
      'GET /v1/devices': () => jsonResponse({ devices: [{ id: 'dev-1', name: 'Desktop', platform: 'win32', status: 'active', created_at: '2026-10-22T00:00:00Z' }] }),
      'GET /v1/sync/changes': () => jsonResponse({ changes: [], cursor: 0, hasMore: false }),
      'GET /v1/stream': () => new Response('event: ready\ndata: {}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    });
    render(<SessionProvider><App /></SessionProvider>);
    await waitFor(() => expect(screen.getByText('Misi Satu')).toBeInTheDocument());
    expect(screen.getByText(/1 misi berjalan|Misi berjalan/i)).toBeTruthy();
  });

  it('access token kedaluwarsa → refresh cookie otomatis lalu sesi pulih', async () => {
    let sessionCalls = 0;
    const fn = routeFetch({
      'GET /v1/session': () => {
        sessionCalls++;
        if (sessionCalls === 1) return jsonResponse({ error: { code: 'SESSION_EXPIRED', message: 'Sesi kedaluwarsa.' } }, 401);
        return jsonResponse({ ownerId: 'own-1', displayName: 'Owner', email: 'o@x.id', role: 'owner', deviceId: null, authMethod: 'cookie', expiresAt: null });
      },
      'POST /v1/sessions/refresh': () => jsonResponse({ delivery: 'cookie', csrfToken: 'baru' }),
      'GET /v1/missions': () => jsonResponse({ missions: [] }),
      'GET /v1/approvals': () => jsonResponse({ approvals: [] }),
      'GET /v1/devices': () => jsonResponse({ devices: [] }),
      'GET /v1/sync/changes': () => jsonResponse({ changes: [], cursor: 0, hasMore: false }),
      'GET /v1/stream': () => new Response('event: ready\ndata: {}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    });
    render(<SessionProvider><App /></SessionProvider>);
    await waitFor(() => expect(screen.getByText(/Owner Control Center|Misi berjalan/i)).toBeInTheDocument());
    const paths = fn.mock.calls.map(c => String(c[0]));
    const firstSession = paths.indexOf(paths.find(p => p.includes('/v1/session'))!);
    const refresh = paths.findIndex(p => p.includes('/v1/sessions/refresh'));
    expect(refresh).toBeGreaterThan(firstSession);
    expect(paths.filter(p => p.includes('/v1/session')).length).toBeGreaterThanOrEqual(2);
  });

  it('logout web selalu memanggil endpoint sesi saat ini (revoke server-side)', async () => {
    function Harness(){
      const { status, logout } = useSession();
      return React.createElement('div', null,
        React.createElement('span', null, status),
        React.createElement('button', { onClick: () => { void logout(); } }, 'Keluar'));
    }
    const React = require('react');
    const fn = routeFetch({
      'GET /v1/session': () => jsonResponse({ ownerId: 'own-1', displayName: 'Owner', email: 'o@x.id', role: 'owner', deviceId: null, authMethod: 'cookie', expiresAt: null }),
      'DELETE /v1/sessions/current': () => jsonResponse({ ok: true })
    });
    render(<SessionProvider><Harness /></SessionProvider>);
    await waitFor(() => expect(screen.getByText('authenticated')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Keluar'));
    await waitFor(() => expect(fn.mock.calls.some(c => String(c[0]).includes('/v1/sessions/current') && c[1]?.method === 'DELETE')).toBe(true));
    await waitFor(() => expect(screen.getByText('anonymous')).toBeInTheDocument());
  });
});
