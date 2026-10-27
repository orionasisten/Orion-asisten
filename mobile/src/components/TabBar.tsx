import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { theme } from '../theme';

export type TabKey = 'chat' | 'missions' | 'approvals' | 'devices' | 'settings';

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: 'chat', label: 'Chat', icon: '❯' },
  { key: 'missions', label: 'Misi', icon: '◎' },
  { key: 'approvals', label: 'Setuju', icon: '✓' },
  { key: 'devices', label: 'Perangkat', icon: '▣' },
  { key: 'settings', label: 'Atur', icon: '⚙' }
];

export function TabBar({ tab, onChange, badge }: { tab: TabKey; onChange: (t: TabKey) => void; badge?: number }) {
  return (
    <View style={s.bar} accessibilityRole="tablist">
      {TABS.map(t => (
        <TouchableOpacity
          key={t.key}
          onPress={() => onChange(t.key)}
          style={s.tab}
          accessibilityRole="tab"
          accessibilityState={{ selected: tab === t.key }}
          accessibilityLabel={t.label}
        >
          <Text style={[s.icon, tab === t.key && { color: theme.gold }]}>{t.icon}</Text>
          <Text style={[s.label, tab === t.key && { color: theme.gold }]}>{t.label}</Text>
          {t.key === 'approvals' && !!badge && badge > 0 && (
            <View style={s.badge}><Text style={s.badgeText}>{badge}</Text></View>
          )}
        </TouchableOpacity>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  bar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: theme.line, backgroundColor: theme.panel, paddingBottom: 6, paddingTop: 6 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 4, gap: 2 },
  icon: { fontSize: 16, color: theme.tx3 },
  label: { fontSize: 9.5, color: theme.tx3, fontFamily: theme.fontBody },
  badge: { position: 'absolute', top: 0, right: '32%', backgroundColor: theme.gold, borderRadius: 8, paddingHorizontal: 4, minWidth: 14, alignItems: 'center' },
  badgeText: { color: '#1A1200', fontSize: 9, fontWeight: '700' }
});
