import React, { useCallback, useEffect, useState } from 'react';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { TabBar, type TabKey } from './src/components/TabBar';
import { LoginScreen } from './src/screens/LoginScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { MissionsScreen } from './src/screens/MissionsScreen';
import { ApprovalsScreen } from './src/screens/ApprovalsScreen';
import { DevicesScreen } from './src/screens/DevicesScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { SessionProvider, useSession } from './src/state/session';
import { apiBaseUrl } from './src/api/client';
import { theme } from './src/theme';

function Shell() {
  const { status, session } = useSession();
  const [tab, setTab] = useState<TabKey>('chat');
  const [approvalTick, setApprovalTick] = useState(0);

  const onChanged = useCallback(() => setApprovalTick(t => t + 1), []);

  useEffect(() => {
    // refresh badge approval saat tab dibuka
    if (tab === 'approvals') onChanged();
  }, [tab, onChanged]);

  if (status === 'loading') {
    return (
      <View style={s.center}>
        <ActivityIndicator color={theme.gold} />
        <Text style={s.wait}>Memeriksa sesi dengan Orion Central…</Text>
      </View>
    );
  }
  if (status !== 'authenticated' || !session) return <LoginScreen />;

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        {tab === 'chat' && <ChatScreen onChanged={onChanged} />}
        {tab === 'missions' && <MissionsScreen />}
        {tab === 'approvals' && <ApprovalsScreen refreshKey={approvalTick} />}
        {tab === 'devices' && <DevicesScreen />}
        {tab === 'settings' && <SettingsScreen />}
      </View>
      <TabBar tab={tab} onChange={setTab} />
    </View>
  );
}

export default function App() {
  const url = apiBaseUrl();
  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
        <StatusBar style="light" />
        <SessionProvider initialApiUrl={url}>
          <Shell />
        </SessionProvider>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bg, gap: 10 },
  wait: { color: theme.tx3, fontSize: 12 }
});
