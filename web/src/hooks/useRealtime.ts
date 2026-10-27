import { useCallback, useEffect, useRef, useState } from 'react';
import { Api } from '../api/client';

interface RealtimeState {
  connected: boolean;
  lastEventAt: string | null;
  cursor: number;
  /** dipanggil saat ada perubahan yang relevan (klien deciding refresh) */
  onChange: (types: string[]) => void;
}

const MAX_BACKOFF_MS = 30000;

/**
 * Realtime: SSE untuk notifikasi + catch-up berbasis cursor (delta feed) saat reconnect.
 * SSE BUKAN sumber kebenaran: setiap reconnect menarik semua perubahan yang terlewat
 * lewat /v1/sync/changes?since=<cursor>.
 */
export function useRealtime(onChange: (types: string[]) => void, enabled: boolean) {
  const [state, setState] = useState<RealtimeState>({ connected: false, lastEventAt: null, cursor: 0, onChange });
  const cursorRef = useRef(0);
  const onChangeRef = useRef(onChange);
  const esRef = useRef<EventSource | null>(null);
  const timerRef = useRef<number | null>(null);
  const attemptRef = useRef(0);

  onChangeRef.current = onChange;

  const catchUp = useCallback(async () => {
    try {
      let since = cursorRef.current;
      // maksimal 20 halaman per siklus agar tidak membanjiri
      for (let i = 0; i < 20; i++) {
        const res = await Api.changes(since, 200);
        if (res.changes.length) {
          cursorRef.current = res.cursor;
          since = res.cursor;
          onChangeRef.current(res.changes.map(c => c.type));
        }
        if (!res.hasMore) break;
      }
      setState(s => ({ ...s, cursor: cursorRef.current, lastEventAt: new Date().toISOString() }));
    } catch {
      /* offline — akan dicoba lagi pada reconnect berikutnya */
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      esRef.current?.close();
      esRef.current = null;
      return;
    }
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      try {
        // EventSource memakai cookie sesi (same-origin) atau token via ?access_token (tidak dipakai di web).
        const base = (import.meta.env?.VITE_API_URL || '').replace(/\/+$/, '');
        const es = new EventSource(base + '/v1/stream', { withCredentials: true });
        esRef.current = es;
        es.addEventListener('ready', () => {
          attemptRef.current = 0;
          setState(s => ({ ...s, connected: true }));
          void catchUp();
        });
        es.addEventListener('change', (ev) => {
          try {
            const data = JSON.parse((ev as MessageEvent).data);
            if (data && typeof data.cursor === 'number') cursorRef.current = Math.max(cursorRef.current, data.cursor);
            setState(s => ({ ...s, lastEventAt: new Date().toISOString(), cursor: cursorRef.current }));
            onChangeRef.current([data?.type || 'change']);
          } catch { /* abaikan payload rusak */ }
        });
        es.onerror = () => {
          es.close();
          esRef.current = null;
          setState(s => ({ ...s, connected: false }));
          // backoff eksponensial (5s → 10s → 20s → 30s)
          const delay = Math.min(5000 * Math.pow(2, attemptRef.current++), MAX_BACKOFF_MS);
          timerRef.current = window.setTimeout(() => { void catchUp(); connect(); }, delay);
        };
      } catch {
        attemptRef.current++;
        timerRef.current = window.setTimeout(connect, 8000);
      }
    };

    connect();
    // polling cadangan: tetap sinkron walau SSE diblokir proxy
    const poll = window.setInterval(() => { if (document.visibilityState === 'visible') void catchUp(); }, 30000);

    return () => {
      disposed = true;
      esRef.current?.close();
      esRef.current = null;
      if (timerRef.current) window.clearTimeout(timerRef.current);
      window.clearInterval(poll);
    };
  }, [enabled, catchUp]);

  return { ...state, catchUp };
}
