import React from 'react';

export type ViewKey = 'dashboard' | 'chat' | 'missions' | 'approvals' | 'memory' | 'devices' | 'settings';

interface Props {
  view: ViewKey;
  onNavigate: (v: ViewKey) => void;
  connected: boolean;
  pendingApprovals: number;
  children: React.ReactNode;
}

const NAV: { key: ViewKey; label: string; icon: string }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: '◈' },
  { key: 'chat', label: 'Chat', icon: '❯' },
  { key: 'missions', label: 'Misi', icon: '◎' },
  { key: 'approvals', label: 'Persetujuan', icon: '✓' },
  { key: 'memory', label: 'Memory', icon: '▤' },
  { key: 'devices', label: 'Perangkat', icon: '▣' },
  { key: 'settings', label: 'Pengaturan', icon: '⚙' }
];

export function Layout({ view, onNavigate, connected, pendingApprovals, children }: Props) {
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="mark">✦</span>
          <span>
            <b>ORION</b>
            <small>SOVEREIGN INTELLIGENCE OS</small>
          </span>
        </div>
        {NAV.map(n => (
          <button
            key={n.key}
            className={'nav-item' + (view === n.key ? ' active' : '')}
            onClick={() => onNavigate(n.key)}
            aria-current={view === n.key ? 'page' : undefined}
          >
            <span className="ic" aria-hidden="true">{n.icon}</span>
            <span>{n.label}</span>
            {n.key === 'approvals' && pendingApprovals > 0 && <span className="badge">{pendingApprovals}</span>}
          </button>
        ))}
        <div style={{ marginTop: 'auto', paddingTop: 14 }}>
          <div className="statusbar">
            <span className={'dot ' + (connected ? 'green' : 'gold')} />
            <span>{connected ? 'Central tersambung' : 'Menyambung ulang…'}</span>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>Owner Control Center — sistem privat, satu owner.</div>
        </div>
      </aside>

      <main className="main">{children}</main>

      <nav className="mobile-nav" aria-label="Navigasi utama">
        {NAV.map(n => (
          <button
            key={n.key}
            className={view === n.key ? 'active' : ''}
            onClick={() => onNavigate(n.key)}
            aria-current={view === n.key ? 'page' : undefined}
          >
            <span className="ic" aria-hidden="true">{n.icon}</span>
            <span>{n.label}</span>
            {n.key === 'approvals' && pendingApprovals > 0 && <span className="badge">{pendingApprovals}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}
