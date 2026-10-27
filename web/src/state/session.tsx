import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Api, ApiError, setUnauthorizedHandler } from '../api/client';
import type { SessionInfo } from '../api/types';

interface SessionCtx {
  session: SessionInfo | null;
  status: 'loading' | 'anonymous' | 'authenticated' | 'error';
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<boolean>;
  lastSyncAt: string | null;
  setLastSyncAt: (v: string | null) => void;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [status, setStatus] = useState<SessionCtx['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await Api.session();
      setSession(s);
      setStatus('authenticated');
      setError(null);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.isUnauthorized) {
        // akses mungkin kedaluwarsa — coba refresh sekali (rotasi token)
        try {
          await Api.refresh();
          const s = await Api.session();
          setSession(s);
          setStatus('authenticated');
          setError(null);
          return true;
        } catch { /* gagal */ }
      }
      setSession(null);
      setStatus('anonymous');
      return false;
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSession(null);
      setStatus('anonymous');
    });
    void refresh();
    return () => setUnauthorizedHandler(null);
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      const r = await Api.login(email, password);
      sessionIdRef.current = r.sessionId;
      const s = await Api.session();
      setSession(s);
      setStatus('authenticated');
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Gagal masuk.';
      setError(msg);
      throw e;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await Api.logout(sessionIdRef.current || undefined);
    } catch { /* abaikan: tetap keluarkan dari UI */ }
    sessionIdRef.current = null;
    setSession(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo<SessionCtx>(() => ({ session, status, error, login, logout, refresh, lastSyncAt, setLastSyncAt }), [session, status, error, login, logout, refresh, lastSyncAt]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession harus dipakai di dalam SessionProvider');
  return ctx;
}
