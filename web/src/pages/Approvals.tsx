import { useCallback, useEffect, useState } from 'react';
import { Api, ApiError } from '../api/client';
import { EmptyState, ErrorState, Loading } from '../components/States';

export function ApprovalsPage({ refreshKey }: { refreshKey: number }) {
  const [approvals, setApprovals] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await Api.listApprovals('pending');
      setApprovals(r.approvals || []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal memuat persetujuan.');
    }
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);

  async function decide(id: string, decision: 'approved' | 'rejected') {
    setBusyId(id); setError(null); setNotice(null);
    try {
      const r = await Api.decideApproval(id, decision);
      setNotice('Keputusan tercatat di server: ' + (r.status || decision));
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.isConflict) setError('Persetujuan sudah diputuskan atau kedaluwarsa — muat ulang daftar.');
      else setError(e instanceof ApiError ? e.message : 'Gagal menyimpan keputusan.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>Approval Center</h2>
        <p>Setiap keputusan diverifikasi ulang di server. Parameter yang berubah membatalkan persetujuan lama.</p>
      </div>
      {error && <ErrorState message={error} onRetry={load} />}
      {notice && <div className="banner ok" role="status">{notice}</div>}

      {approvals === null ? <Loading label="Memuat persetujuan…" /> : approvals.length === 0 ? (
        <EmptyState title="Tidak ada persetujuan tertunda" hint="Tidak ada tindakan yang menunggu keputusan Anda." />
      ) : (
        <div className="stack">
          {approvals.map(a => (
            <div className="card" key={a.id}>
              <div className="card-h">
                <b>{a.action}</b>
                <span className="right statusbar">
                  <span className="tag gold">{a.status}</span>
                  <span>· diminta {new Date(a.created_at).toLocaleString('id-ID')}</span>
                </span>
              </div>
              <div className="rbody">
                <div className="statusbar">
                  <span>Target: {a.resource}</span>
                  {a.mission_id && <span>· misi {a.mission_id}</span>}
                  {a.task_id && <span>· task {a.task_id}</span>}
                  <span>· scope {a.scope}</span>
                </div>
                <div>
                  <label className="lbl">Parameter</label>
                  <pre className="code">{safeJson(a.params)}</pre>
                </div>
                <div className="hint">
                  Fingerprint: <code className="mono">{a.fingerprint.slice(0, 32)}…</code> · berlaku sampai {new Date(a.expires_at).toLocaleString('id-ID')}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn primary" disabled={busyId === a.id} onClick={() => void decide(a.id, 'approved')}>
                    {busyId === a.id ? <span className="spinner" /> : 'Setujui'}
                  </button>
                  <button className="btn danger" disabled={busyId === a.id} onClick={() => void decide(a.id, 'rejected')}>Tolak</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function safeJson(v: string): string {
  try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return String(v); }
}
