import { useCallback, useEffect, useState } from 'react';
import { Api, ApiError } from '../api/client';
import { EmptyState, ErrorState, Loading } from '../components/States';

export function MissionsPage() {
  const [missions, setMissions] = useState<any[] | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await Api.listMissions();
      setMissions(r.missions || []);
      if (detail) {
        const d = await Api.getMission(detail.id);
        setDetail(d);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal memuat misi.');
    }
  }, [detail]);

  useEffect(() => { void load(); }, [load]);

  async function open(id: string) {
    setBusy(true); setError(null);
    try { setDetail(await Api.getMission(id)); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Gagal memuat detail misi.'); }
    finally { setBusy(false); }
  }

  async function cancel(id: string) {
    setBusy(true); setError(null);
    try { await Api.cancelMission(id); await load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Gagal membatalkan misi.'); }
    finally { setBusy(false); }
  }

  if (detail) {
    const m = detail.mission;
    return (
      <div className="page">
        <div className="page-head">
          <h2>{m.title}</h2>
          <p>{m.goal || 'Tanpa goal terdokumentasi.'}</p>
          <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn sm ghost" onClick={() => setDetail(null)}>← Kembali ke daftar</button>
            {['queued', 'running', 'planning'].includes(m.state) && (
              <button className="btn sm danger" disabled={busy} onClick={() => void cancel(m.id)}>Batalkan misi</button>
            )}
          </div>
        </div>
        {error && <ErrorState message={error} />}

        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-h">Status misi</div>
          <div className="rbody">
            <div className="statusbar">
              <span className="tag gold">{m.state}</span>
              <span>eksekusi {m.executions}/{m.max_executions}</span>
              <span>· budget terpakai {m.budget_spent} {m.budget_currency}</span>
              {m.budget_limit != null && <span>· dari {m.budget_limit}</span>}
              <span>· reservasi {m.budget_reserved}</span>
            </div>
            <div className="hint">Misi diperbarui {new Date(m.updated_at).toLocaleString('id-ID')}. Status berasal dari Mission Runtime server — bukan dari browser.</div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-h">Task ({detail.tasks.length})</div>
          <div className="rbody">
            {detail.tasks.length === 0 ? <EmptyState title="Belum ada task" /> : (
              <table className="data">
                <thead><tr><th>Task</th><th>Status</th><th>Attempt</th><th>Catatan</th></tr></thead>
                <tbody>
                  {detail.tasks.map((t: any) => (
                    <tr key={t.id}>
                      <td>{t.title}<div className="hint mono" style={{ fontSize: 10 }}>{t.id}</div></td>
                      <td><span className={'tag ' + (t.state === 'succeeded' ? 'teal' : t.state === 'failed' ? 'red' : 'gold')}>{t.state}</span></td>
                      <td className="mono">{t.attempts}/{t.max_attempts}</td>
                      <td className="hint">{t.last_error || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-h">Persetujuan misi</div>
          <div className="rbody">
            {(!detail.approvals || detail.approvals.length === 0) ? <EmptyState title="Tidak ada persetujuan pada misi ini" /> : (
              <div className="stack">
                {detail.approvals.map((a: any) => (
                  <div className="row-item" key={a.id}>
                    <div className="grow"><b>{a.action}</b><small>{a.resource} · {a.fingerprint.slice(0, 16)}…</small></div>
                    <span className={'tag ' + (a.status === 'approved' ? 'teal' : a.status === 'rejected' ? 'red' : 'gold')}>{a.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>Mission Control</h2>
        <p>Status aktual misi, progres task, dan bukti eksekusi dari Mission Runtime server.</p>
      </div>
      {error && <ErrorState message={error} onRetry={load} />}
      {missions === null ? <Loading label="Memuat misi…" /> : missions.length === 0 ? (
        <EmptyState title="Belum ada misi" hint="Misi dibuat dari desktop, CLI, atau API Orion Central." />
      ) : (
        <div className="card">
          <div className="card-h">Misi ({missions.length})</div>
          <div className="rbody">
            <table className="data">
              <thead><tr><th>Misi</th><th>Status</th><th>Budget</th><th>Diperbarui</th><th /></tr></thead>
              <tbody>
                {missions.map(m => (
                  <tr key={m.id}>
                    <td><b>{m.title}</b><div className="hint">{m.goal?.slice(0, 90) || '—'}</div></td>
                    <td><span className={'tag ' + (m.state === 'completed' ? 'teal' : m.state === 'failed' ? 'red' : 'gold')}>{m.state}</span></td>
                    <td className="mono">{m.budget_spent}{m.budget_limit != null ? ' / ' + m.budget_limit : ''} {m.budget_currency}</td>
                    <td className="hint">{new Date(m.updated_at).toLocaleString('id-ID')}</td>
                    <td><button className="btn sm ghost" onClick={() => void open(m.id)}>Detail</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
