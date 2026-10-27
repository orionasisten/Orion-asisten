import type { Approval, Change, Conversation, Device, Message, Mission, MissionTask, SessionInfo } from './types';

/**
 * Klien API Orion Central untuk mobile.
 *
 * - Autentikasi: **device token** (bearer) — sama seperti Desktop (Phase C).
 *   Cookie sesi web TIDAK dipakai di native (butuh CSRF + SameSite; tidak cocok untuk native).
 * - Tidak pernah menaruh token di URL, log, atau AsyncStorage.
 * - Semua error dinormalisasi (kode server) untuk handling 401/403/404/409/429/5xx.
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
  get isForbidden() { return this.status === 403; }
  get isConflict() { return this.status === 409; }
  get isNotFound() { return this.status === 404; }
  get isRateLimited() { return this.status === 429; }
  get isServer() { return this.status >= 500; }
  get isOffline() { return this.status === 0; }
}

/**
 * Validasi URL Orion Central sebelum dipakai. Aturan:
 * - hanya http/https, tanpa userinfo/query/hash;
 * - endpoint non-local wajib HTTPS (token bearer tidak boleh lewat HTTP);
 * - localhost/loopback/emulator boleh HTTP untuk pengembangan.
 */
export function normalizeApiUrl(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) throw new Error('URL Orion Central wajib diisi.');
  let u: URL;
  try { u = new URL(value); } catch { throw new Error('URL Orion Central tidak valid.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('URL harus memakai http atau https.');
  if (u.username || u.password) throw new Error('URL tidak boleh memuat kredensial.');
  if (u.search || u.hash) throw new Error('URL tidak boleh memuat query atau fragment.');
  const host = u.hostname.toLowerCase();
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === '10.0.2.2';
  if (u.protocol === 'http:' && !local) throw new Error('URL produksi wajib HTTPS.');
  const path = u.pathname && u.pathname !== '/' ? u.pathname.replace(/\/+$/, '') : '';
  return u.origin + path;
}

/** Base URL dari environment (EXPO_PUBLIC_ORION_API_URL). Tidak ada secret di sini. */
let baseUrlOverride: string | null = null;
export function setApiBaseUrl(url: string | null) {
  baseUrlOverride = url === null || url === '' ? null : normalizeApiUrl(url);
}
export function apiBaseUrl(): string {
  const raw = baseUrlOverride || process.env.EXPO_PUBLIC_ORION_API_URL || '';
  return raw ? normalizeApiUrl(raw) : '';
}

export type TokenProvider = () => string | null;

let tokenProvider: TokenProvider = () => null;
export function setTokenProvider(fn: TokenProvider) { tokenProvider = fn; }

const TIMEOUT_MS = 20000;

export async function api<T>(path: string, opts: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const method = opts.method || 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const token = tokenProvider();
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || TIMEOUT_MS);
  try {
    const res = await fetch(apiBaseUrl() + path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) {
      const code = (json && json.error && json.error.code) || 'HTTP_' + res.status;
      const message = (json && json.error && json.error.message) || ('Permintaan gagal (' + res.status + ')');
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

export const Api = {
  session: () => api<SessionInfo>('/v1/session'),
  logout: () => api<{ ok: boolean }>('/v1/sessions/current', { method: 'DELETE' }),
  health: () => api<{ status: string }>('/v1/health'),

  listConversations: (limit = 30) => api<{ conversations: Conversation[]; nextCursor: string | null; hasMore: boolean }>('/v1/conversations?limit=' + limit),
  createConversation: (title: string, clientKey: string) =>
    api<{ conversation: Conversation; duplicate: boolean }>('/v1/conversations', { method: 'POST', body: { title, clientKey } }),
  getConversation: (id: string) => api<{ conversation: Conversation; messages: Message[] }>('/v1/conversations/' + encodeURIComponent(id)),
  listMessages: (id: string, after = 0, limit = 50) =>
    api<{ messages: Message[]; nextSeq: number; hasMore: boolean }>('/v1/conversations/' + encodeURIComponent(id) + '/messages?after=' + after + '&limit=' + limit),
  sendMessage: (id: string, body: { role: string; content: string; clientMessageId: string }) =>
    api<{ message: Message; duplicate: boolean }>('/v1/conversations/' + encodeURIComponent(id) + '/messages', { method: 'POST', body }),
  updateConversation: (id: string, body: { title?: string; pinned?: boolean }) =>
    api<{ conversation: Conversation }>('/v1/conversations/' + encodeURIComponent(id), { method: 'PATCH', body }),

  listMissions: () => api<{ missions: Mission[] }>('/v1/missions'),
  getMission: (id: string) => api<{ mission: Mission; tasks: MissionTask[]; approvals: Approval[] }>('/v1/missions/' + encodeURIComponent(id)),
  cancelMission: (id: string) => api<any>('/v1/missions/' + encodeURIComponent(id) + '/cancel', { method: 'POST', body: {} }),

  listApprovals: (status = 'pending') => api<{ approvals: Approval[] }>('/v1/approvals?status=' + status),
  decideApproval: (id: string, decision: 'approved' | 'rejected') =>
    api<any>('/v1/approvals/' + encodeURIComponent(id) + '/decision', { method: 'POST', body: { decision } }),

  listDevices: () => api<{ devices: Device[] }>('/v1/devices'),
  revokeDevice: (id: string) => api<any>('/v1/devices/' + encodeURIComponent(id), { method: 'DELETE' }),

  changes: (since: number, limit = 100) => api<{ changes: Change[]; cursor: number; hasMore: boolean }>('/v1/sync/changes?since=' + since + '&limit=' + limit),

  registerPushToken: (token: string, platform: 'android' | 'ios') =>
    api<{ ok: boolean }>('/v1/push/register', { method: 'POST', body: { token, platform } }),
  revokePushToken: (token: string) => api<{ ok: boolean }>('/v1/push/revoke', { method: 'POST', body: { token } })
};
