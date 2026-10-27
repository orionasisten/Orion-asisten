import { useCallback, useEffect, useState } from 'react';
import { Layout, type ViewKey } from './components/Layout';
import { Loading, OfflineBanner } from './components/States';
import { useSession } from './state/session';
import { useRealtime } from './hooks/useRealtime';
import { Api } from './api/client';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { ChatPage } from './pages/Chat';
import { MissionsPage } from './pages/Missions';
import { ApprovalsPage } from './pages/Approvals';
import { MemoryPage } from './pages/Memory';
import { DevicesPage } from './pages/Devices';
import { SettingsPage } from './pages/Settings';

export function App() {
  const { status, session, lastSyncAt, setLastSyncAt } = useSession();
  const [view, setView] = useState<ViewKey>('dashboard');
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [tick, setTick] = useState(0);

  const refreshCounts = useCallback(async () => {
    try {
      const r = await Api.listApprovals('pending');
      setPendingApprovals((r.approvals || []).length);
    } catch { /* diam — state offline ditangani banner */ }
  }, []);

  const realtime = useRealtime(useCallback(() => {
    void refreshCounts();
    setTick(t => t + 1);
  }, [refreshCounts]), status === 'authenticated');

  useEffect(() => { if (status === 'authenticated') void refreshCounts(); }, [status, refreshCounts]);

  useEffect(() => {
    if (realtime.lastEventAt) setLastSyncAt(realtime.lastEventAt);
  }, [realtime.lastEventAt, setLastSyncAt]);

  if (status === 'loading') {
    return <div className="login-wrap"><Loading label="Memeriksa sesi dengan Orion Central…" /></div>;
  }
  if (status !== 'authenticated' || !session) {
    return <LoginPage />;
  }

  return (
    <Layout
      view={view}
      onNavigate={setView}
      connected={realtime.connected}
      pendingApprovals={pendingApprovals}
    >
      <OfflineBanner online={realtime.connected} />
      {view === 'dashboard' && <DashboardPage onNavigate={setView} connected={realtime.connected} />}
      {view === 'chat' && <ChatPage key={tick} />}
      {view === 'missions' && <MissionsPage key={tick} />}
      {view === 'approvals' && <ApprovalsPage refreshKey={tick} />}
      {view === 'memory' && <MemoryPage key={tick} />}
      {view === 'devices' && <DevicesPage key={tick} />}
      {view === 'settings' && <SettingsPage connected={realtime.connected} lastSyncAt={lastSyncAt} />}
    </Layout>
  );
}
