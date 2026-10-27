import { useCallback, useEffect, useState } from 'react';
import { Api, ApiError } from '../api/client';
import { EmptyState, ErrorState, Loading } from '../components/States';

export function DevicesPage() {
  const [devices, setDevices] = useState<any[] | null>(null);
  const [sessions, setSessions] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([Api.listDevices(), Api.listSessions()]);
      setDevices(d.devices || []);
      setSessions(s.sessions || []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal memuat perangkat.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function revoke(id: string) {
    setBusyId(id); setError(null); setNotice(null);
    try {
      await Api.revokeDevice(id);
      setNotice('Perangkat dicabut di server — token & sesinya langsung tidak berlaku.');
      setConfirmId(null);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal mencabut perangkat.');
    } finally { setBusyId(null); }
  }

  async function createDevice() {
    setError(null); setNotice(null);
    const name = window.prompt('Nama perangkat baru (mis. "Windows Desktop"):', 'Perangkat baru');
    if (!name) return;
    try {
      const r = await Api.createDevice(name);
      setNotice('Token perangkat dibuat (ditampilkan sekali): ' + (r.token || '') + ' — salin ke perangkat tujuan.');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal membuat token perangkat.');
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>Perangkat &amp; Sesi</h2>
        <p>Perangkat yang terhubung ke Orion. Mencabut perangkat mematikan aksesnya di server, bukan hanya di daftar ini.</p>
      </div>
      {error && <ErrorState message={error} onRetry={load} />}
      {notice && <div className="banner ok" role="status">{notice}</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-h">Perangkat ({devices?.length ?? 0})<span className="right"><button className="btn sm primary" onClick={() => void createDevice()}>+ Token perangkat</button></span></div>
        <div className="rbody">
          {devices === null ? <Loading /> : devices.length === 0 ? (
            <EmptyState title="Belum ada perangkat" hint="Daftarkan perangkat dari desktop atau CLI." />
          ) : (
            <table className="data">
              <thead><tr><th>Nama</th><th>Platform</th><th>Status</th><th>Dibuat</th><th /></tr></thead>
              <tbody>
                {devices.map(d => (
                  <tr key={d.id}>
                    <td><b>{d.name || 'Tanpa nama'}</b><div className="hint mono" style={{ fontSize: 10 }}>{d.id}</div></td>
                    <td className="hint">{d.platform || '—'}</td>
                    <td><span className={'tag ' + (d.status === 'active' ? 'teal' : 'red')}>{d.status}</span></td>
                    <td className="hint">{new Date(d.created_at).toLocaleString('id-ID')}</td>
                    <td>
                      {d.status === 'active' && (
                        confirmId === d.id ? (
                          <span style={{ display: 'inline-flex', gap: 6 }}>
                            <button className="btn sm danger" disabled={busyId === d.id} onClick={() => void revoke(d.id)}>Yakin cabut</button>
                            <button className="btn sm ghost" onClick={() => setConfirmId(null)}>Batal</button>
                          </span>
                        ) : (
                          <button className="btn sm ghost" onClick={() => setConfirmId(d.id)}>Cabut akses</button>
                        )
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-h">Sesi browser ({sessions?.length ?? 0})</div>
        <div className="rbody">
          {sessions === null ? <Loading /> : sessions.length === 0 ? (
            <EmptyState title="Tidak ada sesi" hint="Sesi dibuat otomatis saat Anda masuk dari browser." />
          ) : (
            <table className="data">
              <thead><tr><th>Sesi</th><th>Perangkat</th><th>Status</th><th>Kedaluwarsa</th></tr></thead>
              <tbody>
                {sessions.map(s => (
                  <tr key={s.id}>
                    <td className="mono" style={{ fontSize: 10.5 }}>{s.id}<div className="hint">{s.user_agent || '—'}</div></td>
                    <td className="hint mono" style={{ fontSize: 10.5 }}>{s.device_id || '—'}</td>
                    <td><span className={'tag ' + (s.status === 'active' ? 'teal' : 'gray')}>{s.status}</span></td>
                    <td className="hint">{new Date(s.access_expires_at).toLocaleString('id-ID')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="hint">Token tidak pernah ditampilkan di sini — hanya hash yang tersimpan di server.</div>
        </div>
      </div>
    </div>
  );
}
