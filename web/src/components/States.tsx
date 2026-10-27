import React from 'react';

export function Loading({ label = 'Memuat…' }: { label?: string }) {
  return (
    <div className="state-box" role="status" aria-live="polite">
      <span className="spinner" /> <span style={{ marginLeft: 8 }}>{label}</span>
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <div style={{ color: 'var(--tx2)', fontFamily: 'var(--fd)', marginBottom: 6 }}>{title}</div>
      {hint && <div style={{ fontSize: 11.5 }}>{hint}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="banner error" role="alert">
      <span aria-hidden="true">⚠</span>
      <span style={{ flex: 1 }}>{message}</span>
      {onRetry && <button className="btn sm ghost" onClick={onRetry}>Coba lagi</button>}
    </div>
  );
}

export function OfflineBanner({ online }: { online: boolean }) {
  if (online) return null;
  return (
    <div className="banner warn" role="status">
      <span aria-hidden="true">⛅</span>
      <span>Koneksi ke Orion Central terputus. Menampilkan data terakhir yang diketahui — perubahan baru menunggu koneksi.</span>
    </div>
  );
}
