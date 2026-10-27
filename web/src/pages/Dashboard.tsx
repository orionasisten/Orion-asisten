import { useCallback, useEffect, useState } from 'react';
import { Api, ApiError } from '../api/client';
import { useSession } from '../state/session';
import { EmptyState, ErrorState, Loading } from '../components/States';

interface Props { onNavigate: (v: any) => void; connected: boolean; }

export function DashboardPage({ onNavigate, connected }: Props) {
  const { session, lastSyncAt } = useSession();
  const [missions, setMissions] = useState<any[] | null>(null);
  const [approvals, setApprovals] = useState<any[] | null>(null);
  const [devices, setDevices] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [m, a, d] = await Promise.all([Api.listMissions(), Api.listApprovals('pending'), Api.listDevices()]);
      setMissions(m.missions || []);
      setApprovals(a.approvals || []);
      setDevices(d.devices || []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal memuat data dashboard.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const active = (missions || []).filter(m => ['queued', 'running', 'planning', 'waiting-approval', 'paused'].includes(m.state));
  const done = (missions || []).filter(m => m.state === 'completed');
  const failed = (missions || []).filter(m => m.state === 'failed');
  const desktop = (devices || []).filter(d => /desktop|windows|win/i.test((d.name || '') + ' ' + (d.platform || '')));

  return (
    <div className="page">
      <div className="page-head">
        <h2>Dashboard</h2>
        <p>Ringkasan status Orion, pekerjaan berjalan, dan hal yang butuh perhatian Anda.</p>
      </div>

      {error && <ErrorState message={error} onRetry={load} />}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-h">
          <span className={'dot ' + (connected ? 'green' : 'gold')} />
          <b>Orion Central</b>
          <span className="right statusbar">
            <span>{connected ? 'Tersambung' : 'Menyambung ulang…'}</span>
            {lastSyncAt && <span>· sinkron {new Date(lastSyncAt).toLocaleTimeString('id-ID')}</span>}
          </span>
        </div>
        <div className="rbody">
          <div className="statusbar">
            <span>Owner: {session?.displayName || session?.email || '—'}</span>
            <span>· metode auth: {session?.authMethod === 'cookie' ? 'sesi cookie' : 'bearer token'}</span>
            <span>· perangkat terdaftar: {(devices || []).length}</span>
          </div>
        </div>
      </div>

      {missions === null && approvals === null ? <Loading label="Memuat ringkasan…" /> : (
        <>
          <div className="grid cols-3" style={{ marginBottom: 14 }}>
            <div className="stat"><b>{active.length}</b><small>Misi berjalan</small></div>
            <div className="stat"><b style={{ color: 'var(--gold)' }}>{(approvals || []).length}</b><small>Menunggu persetujuan</small></div>
            <div className="stat"><b>{done.length}</b><small>Misi selesai</small></div>
          </div>

          <div className="grid cols-2" style={{ marginBottom: 14 }}>
            <div className="card">
              <div className="card-h">◎ Misi terbaru</div>
              <div className="rbody">
                {(missions || []).length === 0 ? <EmptyState title="Belum ada misi" hint="Misi yang dibuat Owner akan tampil di sini." /> : (
                  <div className="stack">
                    {(missions || []).slice(0, 5).map(m => (
                      <div className="row-item" key={m.id}>
                        <div className="grow"><b>{m.title}</b><small>{m.state} · {m.executions}/{m.max_executions} eksekusi</small></div>
                        <span className={'tag ' + (m.state === 'completed' ? 'teal' : m.state === 'failed' ? 'red' : 'gold')}>{m.state}</span>
                      </div>
                    ))}
                  </div>
                )}
                <button className="btn sm ghost" onClick={() => onNavigate('missions')}>Buka Mission Control</button>
              </div>
            </div>

            <div className="card">
              <div className="card-h">✓ Persetujuan menunggu</div>
              <div className="rbody">
                {(approvals || []).length === 0 ? <EmptyState title="Tidak ada persetujuan tertunda" hint="Tidak ada tindakan yang menunggu keputusan Anda." /> : (
                  <div className="stack">
                    {(approvals || []).slice(0, 5).map(a => (
                      <div className="row-item" key={a.id}>
                        <div className="grow"><b>{a.action}</b><small>{a.resource}</small></div>
                        <span className="tag gold">menunggu</span>
                      </div>
                    ))}
                  </div>
                )}
                <button className="btn sm ghost" onClick={() => onNavigate('approvals')}>Buka Approval Center</button>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-h">▣ Agent &amp; perangkat</div>
            <div className="rbody">
              <div className="statusbar">
                <span className={'dot ' + (desktop.length ? 'green' : 'gold')} />
                <span>
                  {desktop.length
                    ? desktop.length + ' perangkat desktop terdaftar'
                    : 'Tidak ada perangkat desktop terdeteksi — pekerjaan yang butuh file lokal tidak bisa berjalan.'}
                </span>
              </div>
              <div className="hint">
                Tugas cloud berjalan di server. Tugas yang butuh berkas, workspace, atau aplikasi lokal
                memerlukan desktop Agent aktif dan terautentikasi.
              </div>
              <button className="btn sm ghost" onClick={() => onNavigate('devices')}>Kelola perangkat</button>
            </div>
          </div>
        </>
      )}

      {failed.length > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-h">⚠ Misi bermasalah ({failed.length})</div>
          <div className="rbody">
            {failed.map(m => (
              <div className="row-item" key={m.id}>
                <div className="grow"><b>{m.title}</b><small>{m.state} · terakhir {new Date(m.updated_at).toLocaleString('id-ID')}</small></div>
                <span className="tag red">gagal</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
