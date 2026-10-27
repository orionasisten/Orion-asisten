import { useCallback, useEffect, useState } from 'react';
import { Api, ApiError } from '../api/client';
import { EmptyState, ErrorState, Loading } from '../components/States';

const VERIF: Record<string, { label: string; cls: string }> = {
  verified: { label: 'Terverifikasi', cls: 'teal' },
  unverified: { label: 'Belum diverifikasi', cls: 'gray' },
  inferred: { label: 'Inferensi (bukan fakta)', cls: 'gold' },
  conflicting: { label: 'Berkonflik', cls: 'red' }
};
const ORIGIN: Record<string, string> = {
  user: 'Pernyataan Owner', import: 'Dokumen impor', tool: 'Hasil tool', agent: 'Inferensi Orion', external: 'Sumber eksternal'
};

export function MemoryPage() {
  const [records, setRecords] = useState<any[] | null>(null);
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<any | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await Api.listMemory({ q: q || undefined, type: type || undefined, status: 'active' });
      setRecords(r.records || []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal memuat memory.');
    }
  }, [q, type]);

  useEffect(() => { void load(); }, [load]);

  async function open(id: string) {
    try { setDetail(await Api.getMemory(id)); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Gagal memuat detail memory.'); }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>Memory Viewer</h2>
        <p>Memory dengan provenance: asal, status verifikasi, cakupan, dan integritasnya. Menampilkan memory
          tidak berarti memory terverifikasi.</p>
      </div>
      {error && <ErrorState message={error} onRetry={load} />}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="rbody">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input className="inp" style={{ flex: 2, minWidth: 180 }} placeholder="Cari memory…" value={q} onChange={e => setQ(e.target.value)} aria-label="Cari memory" />
            <select className="inp" style={{ flex: 1, minWidth: 150 }} value={type} onChange={e => setType(e.target.value)} aria-label="Tipe memory">
              <option value="">Semua tipe</option>
              {Object.keys({ fact: 1, user_assertion: 1, verified_fact: 1, agent_inference: 1, preference: 1, project_decision: 1 }).map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <button className="btn ghost" onClick={() => void load()}>Muat ulang</button>
          </div>
        </div>
      </div>

      {detail && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-h">
            <b>Detail provenance</b>
            <span className="right"><button className="btn sm ghost" onClick={() => setDetail(null)}>Tutup</button></span>
          </div>
          <div className="rbody">
            <div style={{ fontSize: 13, lineHeight: 1.65 }}>{detail.record.content}</div>
            <table className="data">
              <tbody>
                <tr><td>Asal</td><td>{ORIGIN[detail.record.origin] || detail.record.origin}</td></tr>
                <tr><td>Sumber</td><td className="mono">{detail.record.source_ref || '—'}</td></tr>
                <tr><td>Bukti</td><td>{detail.record.excerpt || '—'}</td></tr>
                <tr><td>Status verifikasi</td><td><span className={'tag ' + (VERIF[detail.record.verification_status]?.cls || 'gray')}>{VERIF[detail.record.verification_status]?.label || detail.record.verification_status}</span></td></tr>
                <tr><td>Keyakinan</td><td className="mono">{Math.round((detail.record.confidence || 0) * 100)}%</td></tr>
                <tr><td>Cakupan / sensitivitas</td><td>{detail.record.scope} · {detail.record.sensitivity}</td></tr>
                <tr><td>Versi / hash</td><td className="mono">v{detail.record.content_version} · {(detail.record.integrity_hash || '').slice(0, 24)}…</td></tr>
                <tr><td>Dibuat / diperbarui</td><td>{new Date(detail.record.created).toLocaleString('id-ID')} → {new Date(detail.record.updated).toLocaleString('id-ID')}</td></tr>
              </tbody>
            </table>
            {detail.versions?.length > 0 && (
              <div>
                <label className="lbl">Riwayat versi</label>
                <table className="data">
                  <thead><tr><th>v</th><th>Verifikasi</th><th>Alasan</th><th>Waktu</th></tr></thead>
                  <tbody>
                    {detail.versions.map((v: any) => (
                      <tr key={v.id}>
                        <td className="mono">{v.content_version}</td>
                        <td>{v.verification_status}</td>
                        <td className="hint">{v.reason || '—'}</td>
                        <td className="hint">{new Date(v.created_at).toLocaleString('id-ID')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {records === null ? <Loading label="Memuat memory…" /> : records.length === 0 ? (
        <EmptyState title="Tidak ada memory" hint="Belum ada memory aktif yang dapat Anda baca." />
      ) : (
        <div className="card">
          <div className="card-h">Memory ({records.length})</div>
          <div className="rbody">
            <table className="data">
              <thead><tr><th>Isi</th><th>Asal</th><th>Verifikasi</th><th>Cakupan</th><th /></tr></thead>
              <tbody>
                {records.map(m => (
                  <tr key={m.id}>
                    <td>{m.content.slice(0, 140)}{m.content.length > 140 ? '…' : ''}</td>
                    <td className="hint">{ORIGIN[m.origin] || m.origin}</td>
                    <td><span className={'tag ' + (VERIF[m.verification_status]?.cls || 'gray')}>{VERIF[m.verification_status]?.label || m.verification_status}</span></td>
                    <td className="hint">{m.scope} · {m.sensitivity}</td>
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
