import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Api, ApiError, normalizeApiUrl, setApiBaseUrl, setTokenProvider } from '../api/client';
import { secureStore } from '../storage/stores';
import type { SessionInfo } from '../api/types';

interface SessionState {
  status: 'loading' | 'anonymous' | 'authenticated' | 'expired' | 'revoked' | 'error';
  session: SessionInfo | null;
  error: string | null;
  apiUrl: string;
  pair: (apiUrl: string, deviceToken: string) => Promise<void>;
  logout: () => Promise<void>;
  reauth: () => void;
  refresh: () => Promise<boolean>;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children, initialApiUrl }: { children: React.ReactNode; initialApiUrl: string }) {
  const [status, setStatus] = useState<SessionState['status']>('loading');
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiUrl, setApiUrl] = useState(initialApiUrl);
  const [hydrated, setHydrated] = useState(false);
  const tokenRef = useRef<string | null>(null);
  const baseUrlRef = useRef<string | null>(null);

  // Hidrasi HARUS selesai sebelum refresh/auth state dievaluasi. Ini menutup race
  // cold start: token valid di SecureStore tidak boleh terbaca sebagai "anonymous".
  useEffect(() => {
    let cancelled = false;
    setTokenProvider(() => tokenRef.current);
    (async () => {
      const token = await secureStore.getToken();
      const saved = await secureStore.getApiUrl();
      let activeUrl = '';
      for (const candidate of [saved, initialApiUrl]){
        if (!candidate) continue;
        try { activeUrl = normalizeApiUrl(candidate); break; } catch { /* coba kandidat berikutnya */ }
      }
      tokenRef.current = token;
      baseUrlRef.current = activeUrl || null;
      setApiBaseUrl(activeUrl || null);
      setApiUrl(activeUrl);
      if (!cancelled) setHydrated(true);
    })();
    return () => { cancelled = true; setTokenProvider(() => null); };
  }, [initialApiUrl]);

  const refresh = useCallback(async (): Promise<boolean> => {
    if (tokenRef.current && !baseUrlRef.current){
      setError('URL Orion Central belum diatur. Masukkan URL pairing.');
      setStatus('error');
      return false;
    }
    if (!tokenRef.current){
      setSession(null);
      setStatus('anonymous');
      return false;
    }
    try {
      const s = await Api.session();
      setSession(s);
      setStatus('authenticated');
      setError(null);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.isUnauthorized) {
        const code = e.code || '';
        if (/SESSION_REVOKED|TOKEN_REVOKED|DEVICE_REVOKED|DEVICE_UNKNOWN|TOKEN_INACTIVE|OWNER_INACTIVE/.test(code)) {
          setStatus('revoked');
          setSession(null);
          await secureStore.clearToken().catch(() => undefined);
          tokenRef.current = null;
          return false;
        }
        if (/SESSION_EXPIRED|TOKEN_EXPIRED/.test(code)) {
          setStatus('expired');
          setSession(null);
          await secureStore.clearToken().catch(() => undefined);
          tokenRef.current = null;
          return false;
        }
        setStatus('anonymous'); setSession(null);
      } else if (e instanceof ApiError && e.isOffline) {
        // offline: jangan logout, tampilkan state offline
        setError('Tidak dapat menghubungi Orion Central.');
        setStatus((s) => (s === 'authenticated' ? 'authenticated' : 'anonymous'));
      } else {
        setError(e instanceof Error ? e.message : 'Gagal memverifikasi sesi.');
        setStatus('error');
      }
      return false;
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    void refresh();
  }, [hydrated, refresh]);

  const pair = useCallback(async (url: string, deviceToken: string) => {
    setError(null);
    let normalized: string;
    try { normalized = normalizeApiUrl(url); }
    catch (e) { setError((e as Error).message); throw e; }
    if (!deviceToken.trim()) throw new Error('Token perangkat wajib diisi.');
    const prevBase = baseUrlRef.current;
    const prevToken = tokenRef.current;
    try {
      // URL harus diterapkan sebelum request; token hanya di header (bukan URL/log).
      baseUrlRef.current = normalized;
      setApiBaseUrl(normalized);
      tokenRef.current = deviceToken.trim();
      const s = await Api.session();
      // Simpan hanya setelah server memverifikasi token. Status pairing = URL aktif.
      await secureStore.setToken(tokenRef.current);
      await secureStore.setApiUrl(normalized);
      setApiUrl(normalized);
      setSession(s);
      setStatus('authenticated');
    } catch (e) {
      // Kembalikan konfigurasi sebelumnya agar kegagalan pairing tidak merusak sesi lama.
      baseUrlRef.current = prevBase;
      setApiBaseUrl(prevBase);
      tokenRef.current = prevToken;
      const msg = e instanceof ApiError ? e.message : (e instanceof Error ? e.message : 'Gagal menghubungkan perangkat.');
      setError(msg);
      setStatus('error');
      throw e;
    }
  }, []);

  const logout = useCallback(async () => {
    // Cabut sesi/token di server dulu (best effort), lalu hapus kredensial lokal.
    try { if (tokenRef.current) await Api.logout(); } catch { /* offline/revoked: tetap logout lokal */ }
    await secureStore.clearToken();
    tokenRef.current = null;
    setSession(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo<SessionState>(() => ({ status, session, error, apiUrl, pair, logout, reauth: refresh, refresh }), [status, session, error, apiUrl, pair, logout, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession harus dipakai di dalam SessionProvider');
  return ctx;
}
