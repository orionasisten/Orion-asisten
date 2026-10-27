import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ChatPage } from '../src/pages/Chat';
import { ApprovalsPage } from '../src/pages/Approvals';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function routeFetch(routes: Record<string, () => Response>) {
  const fn = vi.fn(async (url: string, init?: any) => {
    const key = String(url).split('?')[0];
    const k = (init?.method || 'GET') + ' ' + key;
    if (routes[k]) return routes[k]();
    if (routes[key]) return routes[key]();
    return jsonResponse({ error: { code: 'NOT_FOUND' } }, 404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('chat', () => {
  beforeEach(() => { document.cookie = 'orion_csrf=csrf'; });

  it('memuat daftar percakapan dari server (bukan localStorage)', async () => {
    routeFetch({
      'GET /v1/conversations': () => jsonResponse({ conversations: [{ id: 'cnv-1', title: 'Penting Sekali', message_count: 2, updated_at: '2026-10-22T00:00:00Z' }], hasMore: false })
    });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getAllByText('Penting Sekali').length).toBeGreaterThan(0));
  });

  it('menampilkan empty state bila belum ada percakapan', async () => {
    routeFetch({ 'GET /v1/conversations': () => jsonResponse({ conversations: [], hasMore: false }) });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByText(/Belum ada percakapan/i)).toBeInTheDocument());
  });

  it('rollback UI optimistis & pesan dikembalikan bila server menolak', async () => {
    const fn = routeFetch({
      'GET /v1/conversations': () => jsonResponse({ conversations: [{ id: 'cnv-1', title: 'C', message_count: 0, updated_at: '2026-10-22T00:00:00Z' }], hasMore: false }),
      'GET /v1/conversations/cnv-1/messages': () => jsonResponse({ messages: [], nextSeq: 0, hasMore: false }),
      'POST /v1/conversations/cnv-1/messages': () => jsonResponse({ error: { code: 'BAD_ROLE', message: 'Role tidak valid.' } }, 400)
    });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getAllByText('C').length).toBeGreaterThan(0));
    const box = screen.getByLabelText('Pesan') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'halo' } });
    fireEvent.click(screen.getByText('Kirim'));
    await waitFor(() => expect(screen.getByText(/Role tidak valid/i)).toBeInTheDocument());
    expect((screen.getByLabelText('Pesan') as HTMLTextAreaElement).value).toBe('halo');
    expect(fn).toHaveBeenCalled();
  });

  it('mengirim pesan dengan idempotency key (clientMessageId)', async () => {
    let sentBody: any = null;
    const routes: Record<string, () => Response> = {
      'GET /v1/conversations': () => jsonResponse({ conversations: [{ id: 'cnv-1', title: 'C', message_count: 0, updated_at: '2026-10-22T00:00:00Z' }], hasMore: false }),
      'GET /v1/conversations/cnv-1/messages': () => jsonResponse({ messages: [], nextSeq: 0, hasMore: false }),
      'POST /v1/conversations/cnv-1/messages': () => jsonResponse({ message: { id: 'msg-1', role: 'user', content: 'halo', seq: 1, created_at: '2026-10-22T00:00:00Z' }, duplicate: false })
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      const key = String(url).split('?')[0];
      const k = (init?.method || 'GET') + ' ' + key;
      if (k === 'POST /v1/conversations/cnv-1/messages') { sentBody = JSON.parse(init.body); return routes[k](); }
      if (routes[k]) return routes[k]();
      return jsonResponse({ error: { code: 'NOT_FOUND' } }, 404);
    }));
    render(<ChatPage />);
    await waitFor(() => expect(screen.getAllByText('C').length).toBeGreaterThan(0));
    fireEvent.change(screen.getByLabelText('Pesan'), { target: { value: 'halo' } });
    fireEvent.click(screen.getByText('Kirim'));
    await waitFor(() => expect(sentBody).not.toBeNull());
    expect(sentBody.role).toBe('user');
    expect(sentBody.content).toBe('halo');
    expect(typeof sentBody.clientMessageId).toBe('string');
    expect(sentBody.clientMessageId.length).toBeGreaterThan(8);
  });
});

describe('approval center', () => {
  beforeEach(() => { document.cookie = 'orion_csrf=csrf'; });

  it('menampilkan permintaan approval dengan parameter & target', async () => {
    routeFetch({
      'GET /v1/approvals': () => jsonResponse({ approvals: [{ id: 'ap-1', action: 'publish', resource: 'res://x', mission_id: 'ms-1', task_id: 'tk-1', params: '{"v":1}', scope: 'mission', fingerprint: 'fp1234567890abcdef', status: 'pending', created_at: '2026-10-22T00:00:00Z', expires_at: '2026-10-23T00:00:00Z' }] })
    });
    render(<ApprovalsPage refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('publish')).toBeInTheDocument());
    expect(screen.getByText(/res:\/\/x/)).toBeInTheDocument();
    expect(screen.getByText('Setujui')).toBeInTheDocument();
    expect(screen.getByText('Tolak')).toBeInTheDocument();
  });

  it('menampilkan konflik bila server menolak keputusan', async () => {
    routeFetch({
      'GET /v1/approvals': () => jsonResponse({ approvals: [{ id: 'ap-1', action: 'publish', resource: 'res://x', params: '{}', scope: 'mission', fingerprint: 'fp1', status: 'pending', created_at: '2026-10-22T00:00:00Z', expires_at: '2026-10-23T00:00:00Z' }] }),
      'POST /v1/approvals/ap-1/decision': () => jsonResponse({ error: { code: 'CONFLICT', message: 'Persetujuan sudah diputuskan.' } }, 409)
    });
    render(<ApprovalsPage refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Setujui')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Setujui'));
    await waitFor(() => expect(screen.getByText(/sudah diputuskan atau kedaluwarsa/i)).toBeInTheDocument());
  });

  it('empty state bila tidak ada approval tertunda', async () => {
    routeFetch({ 'GET /v1/approvals': () => jsonResponse({ approvals: [] }) });
    render(<ApprovalsPage refreshKey={0} />);
    await waitFor(() => expect(screen.getByText(/Tidak ada persetujuan tertunda/i)).toBeInTheDocument());
  });
});
