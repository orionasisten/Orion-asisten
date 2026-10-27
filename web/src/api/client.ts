/**
 * Klien API Orion Central untuk Web App.
 *
 * - Semua request memakai `credentials: 'include'` (sesi cookie HttpOnly).
 * - Header CSRF (double-submit) ditambahkan otomatis untuk request yang mengubah state.
 * - Error dinormalisasi menjadi ApiError dengan kode server (tidak pernah stack trace).
 * - 401 memicu callback `onUnauthorized` (UI mengarahkan ke login).
 * - TIDAK ada secret di frontend: refresh token hanya ada di cookie HttpOnly.
 */

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
  get isUnauthorized() { return this.status === 401; }
  get isConflict() { return this.status === 409; }
  get isCsrf() { return this.code === 'CSRF_FAILED'; }
  get isRateLimited() { return this.status === 429; }
}

const BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/+$/, '');
const TIMEOUT_MS = 20000;

export function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const hit = document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  if (!hit) return null;
  try { return decodeURIComponent(hit.slice(name.length + 1)); } catch { return hit.slice(name.length + 1); }
}

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;
export function setUnauthorizedHandler(fn: UnauthorizedHandler | null) { onUnauthorized = fn; }

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method || 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = readCookie('orion_csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || TIMEOUT_MS);
  if (opts.signal) opts.signal.addEventListener('abort', () => controller.abort());
  try {
    const res = await fetch(BASE + path, {
      method,
      headers,
      credentials: 'include',
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) {
      const code = (json && json.error && json.error.code) || 'HTTP_' + res.status;
      const message = (json && json.error && json.error.message) || ('Permintaan gagal (' + res.status + ')');
      if (res.status === 401 && onUnauthorized) onUnauthorized();
      throw new ApiError(res.status, code, message);
    }
    return json as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if ((e as Error)?.name === 'AbortError') throw new ApiError(0, 'TIMEOUT', 'Permintaan melewati batas waktu.');
    throw new ApiError(0, 'NETWORK_ERROR', 'Tidak dapat terhubung ke Orion Central.');
  } finally {
    clearTimeout(timer);
  }
}

/* ── endpoint wrappers ─────────────────────────────────── */
export const Api = {
  session: () => api<any>('/v1/session'),
  login: (email: string, password: string) =>
    api<{ sessionId: string; ownerId: string; displayName: string; csrfToken: string; accessExpiresAt: string }>(
      '/v1/auth/login', { method: 'POST', body: { email, password } }),
  // Selalu logout "sesi saat ini" agar cookie HttpOnly dibersihkan server, bahkan
  // setelah reload (sessionId tidak diketahui) atau access token sudah kedaluwarsa.
  logout: (_sessionId?: string) => api<any>('/v1/sessions/current', { method: 'DELETE' }),
  refresh: () => api<any>('/v1/sessions/refresh', { method: 'POST', body: {} }),

  listConversations: (limit = 30) => api<{ conversations: any[]; nextCursor: string | null; hasMore: boolean }>('/v1/conversations?limit=' + limit),
  createConversation: (title: string, clientKey: string) =>
    api<{ conversation: any; duplicate: boolean }>('/v1/conversations', { method: 'POST', body: { title, clientKey } }),
  getConversation: (id: string) => api<{ conversation: any; messages: any[] }>('/v1/conversations/' + encodeURIComponent(id)),
  updateConversation: (id: string, body: { title?: string; pinned?: boolean; expectedUpdatedAt?: string }) =>
    api<{ conversation: any }>('/v1/conversations/' + encodeURIComponent(id), { method: 'PATCH', body }),
  deleteConversation: (id: string) => api<any>('/v1/conversations/' + encodeURIComponent(id), { method: 'DELETE' }),
  listMessages: (id: string, after = 0, limit = 50) =>
    api<{ messages: any[]; nextSeq: number; hasMore: boolean }>('/v1/conversations/' + encodeURIComponent(id) + '/messages?after=' + after + '&limit=' + limit),
  sendMessage: (id: string, body: { role: string; content: string; clientMessageId: string }) =>
    api<{ message: any; duplicate: boolean }>('/v1/conversations/' + encodeURIComponent(id) + '/messages', { method: 'POST', body }),
  respond: (id: string, clientMessageId: string) =>
    api<{ message: any; usage?: any; provider?: string; model?: string }>('/v1/conversations/' + encodeURIComponent(id) + '/respond', { method: 'POST', body: { clientMessageId } }),

  listMissions: () => api<{ missions: any[] }>('/v1/missions'),
  getMission: (id: string) => api<{ mission: any; tasks: any[]; approvals: any[] }>('/v1/missions/' + encodeURIComponent(id)),
  cancelMission: (id: string) => api<any>('/v1/missions/' + encodeURIComponent(id) + '/cancel', { method: 'POST', body: {} }),

  listApprovals: (status = 'pending') => api<{ approvals: any[] }>('/v1/approvals?status=' + status),
  decideApproval: (id: string, decision: 'approved' | 'rejected') =>
    api<any>('/v1/approvals/' + encodeURIComponent(id) + '/decision', { method: 'POST', body: { decision } }),

  listMemory: (params: { q?: string; scope?: string; type?: string; status?: string } = {}) => {
    const s = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v) s.set(k, String(v)); });
    const qs = s.toString();
    return api<{ records: any[] }>('/v1/memory' + (qs ? '?' + qs : ''));
  },
  getMemory: (id: string) => api<{ record: any; versions: any[] }>('/v1/memory/' + encodeURIComponent(id)),

  listDevices: () => api<{ devices: any[] }>('/v1/devices'),
  createDevice: (name: string) => api<{ deviceId: string; token: string; expiresAt: string }>('/v1/devices', { method: 'POST', body: { name } }),
  revokeDevice: (id: string) => api<any>('/v1/devices/' + encodeURIComponent(id), { method: 'DELETE' }),
  listSessions: () => api<{ sessions: any[] }>('/v1/sessions'),
  audit: (limit = 30) => api<{ entries: any[] }>('/v1/audit?limit=' + limit),
  changes: (since: number, limit = 100) => api<{ changes: any[]; cursor: number; hasMore: boolean }>('/v1/sync/changes?since=' + since + '&limit=' + limit),
  health: () => api<{ status: string }>('/v1/health')
};
