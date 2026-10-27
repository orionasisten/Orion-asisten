import React, { useState } from 'react';
import { useSession } from '../state/session';
import { ErrorState } from '../components/States';

export function LoginPage() {
  const { login, error } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (!email.trim() || !password) { setLocalError('Email dan password wajib diisi.'); return; }
    setBusy(true);
    try { await login(email.trim(), password); }
    catch (err) { setLocalError((err as Error).message || 'Gagal masuk.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit} noValidate>
        <div>
          <h1>ORION</h1>
          <div className="sub">SOVEREIGN INTELLIGENCE OS · OWNER CONTROL CENTER</div>
        </div>
        <div className="hint">
          Sistem privat milik Owner. Tidak ada pendaftaran publik — masuk dengan kredensial Owner Anda.
        </div>
        {(localError || error) && <ErrorState message={localError || error || 'Gagal masuk.'} />}
        <div>
          <label className="lbl" htmlFor="login-email">Email Owner</label>
          <input
            id="login-email"
            className="inp"
            type="email"
            autoComplete="username"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="owner@contoh.com"
            required
          />
        </div>
        <div>
          <label className="lbl" htmlFor="login-password">Password</label>
          <input
            id="login-password"
            className="inp"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
          />
        </div>
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? <><span className="spinner" /> Memverifikasi…</> : 'Masuk ke Orion Central'}
        </button>
        <div className="hint">
          Sesi disimpan di cookie HttpOnly server (bukan di localStorage). Menutup browser mengakhiri sesi.
        </div>
      </form>
    </div>
  );
}
