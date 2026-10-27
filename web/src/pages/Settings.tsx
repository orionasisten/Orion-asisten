import { useCallback, useEffect, useState } from 'react';
import { Api, ApiError } from '../api/client';
import { useSession } from '../state/session';
import { EmptyState, ErrorState, Loading } from '../components/States';

export function SettingsPage({ connected, lastSyncAt }: { connected: boolean; lastSyncAt: string | null }) {
  const { session, logout } = useSession();
  const [audit, setAudit] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, h] = await Promise.all([Api.audit(20), Api.health()]);
      setAudit(a.entries || []);
      setHealth(h.status);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal memuat pengaturan.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="page">
      <div className="page-head">
        <h2>Pengaturan &amp; Status Koneksi</h2>
        <p>Status backend, sesi Owner, dan jejak audit. Tidak ada secret yang ditampilkan di halaman ini.</p>
      </div>
      {error && <ErrorState message={error} onRetry={load} />}

      <div className="grid cols-2">
        <div className="card">
          <div className="card-h">Orion Central</div>
          <div className="rbody">
            <div className="statusbar">
              <span className={'dot ' + (connected ? 'green' : 'gold')} />
              <span>{connected ? 'Tersambung' : 'Menyambung ulang…'}</span>
              <span>· health: {health || 'tidak diketahui'}</span>
            </div>
            <div className="statusbar">
              <span>Sinkron terakhir: {lastSyncAt ? new Date(lastSyncAt).toLocaleString('id-ID') : 'belum ada'}</span>
            </div>
            <div className="statusbar">
              <span>API: {new URL((import.meta.env?.VITE_API_URL as string) || window.location.origin).host}</span>
            </div>
            <div className="hint">
              Sesi memakai cookie HttpOnly + token CSRF (double-submit). Refresh token tidak pernah menyentuh
              localStorage dan tidak pernah dikirim lewat URL.
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-h">Sesi Owner</div>
          <div className="rbody">
            <div className="statusbar">
              <span>{session?.displayName || session?.email || '—'}</span>
              <span>· peran {session?.role || 'owner'}</span>
              <span>· auth {session?.authMethod === 'cookie' ? 'cookie' : 'token'}</span>
            </div>
            <div className="hint">Sesi berakhir otomatis saat kedaluwarsa; aplikasi lalu meminta login kembali.</div>
            <div>
              <button className="btn danger" onClick={() => void logout()}>Keluar dari Orion</button>
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-h">Jejak audit terbaru</div>
        <div className="rbody">
          {audit === null ? <Loading /> : audit.length === 0 ? (
            <EmptyState title="Belum ada aktivitas tercatat" />
          ) : (
            <table className="data">
              <thead><tr><th>Waktu</th><th>Aksi</th><th>Hasil</th><th>Target</th></tr></thead>
              <tbody>
                {audit.map(a => (
                  <tr key={a.id}>
                    <td className="hint">{new Date(a.created_at).toLocaleString('id-ID')}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{a.action}</td>
                    <td><span className={'tag ' + (a.outcome === 'ok' ? 'teal' : 'red')}>{a.outcome}</span></td>
                    <td className="hint">{a.target_type || '—'}{a.target_id ? ' · ' + String(a.target_id).slice(0, 12) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-h">Preferensi antarmuka</div>
        <div className="rbody">
          <div className="hint">
            Preferensi disimpan lokal di peramban (hanya preferensi tampilan, bukan data bisnis). Data Orion
            tetap bersumber dari server.
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
            <input
              type="checkbox"
              defaultChecked={localStorage.getItem('orion.compact') !== '1'}
              onChange={e => localStorage.setItem('orion.compact', e.target.checked ? '1' : '0')}
            />
            Tampilan ringkas (kompak)
          </label>
          <div className="hint">
            Instalasi PWA: gunakan menu Install pada bilah alamat Chrome/Edge (butuh HTTPS).
            Batasan: iOS membatasi PWA di latar belakang & push; data terbaru tetap membutuhkan koneksi.
          </div>
        </div>
      </div>
    </div>
  );
}
