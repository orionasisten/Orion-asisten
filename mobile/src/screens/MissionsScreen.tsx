import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Api, ApiError } from '../api/client';
import type { Mission, MissionTask } from '../api/types';
import { Card, EmptyState, ErrorState, KeyValue, Loading, Tag } from '../components/ui';
import { theme } from '../theme';

const stateTone = (st: string) => (st === 'completed' ? 'teal' : st === 'failed' ? 'red' : st === 'cancelled' ? 'gray' : 'gold');

export function MissionsScreen() {
  const [missions, setMissions] = useState<Mission[] | null>(null);
  const [detail, setDetail] = useState<{ mission: Mission; tasks: MissionTask[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await Api.listMissions();
      setMissions(r.missions || []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal memuat misi.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function open(id: string) {
    try { setDetail(await Api.getMission(id)); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Gagal memuat detail misi.'); }
  }

  if (detail) {
    const m = detail.mission;
    return (
      <View style={{ flex: 1 }}>
        <View style={{ padding: 12 }}>
          <Text style={s.back} onPress={() => setDetail(null)}>‹ Kembali ke daftar misi</Text>
        </View>
        <FlatList
          data={detail.tasks}
          keyExtractor={t => t.id}
          contentContainerStyle={{ padding: 12, gap: 8 }}
          ListHeaderComponent={
            <Card title={m.title}>
              <Text style={s.goal}>{m.goal || '—'}</Text>
              <KeyValue k="Status" v={m.state} />
              <KeyValue k="Eksekusi" v={m.executions + '/' + m.max_executions} />
              <KeyValue k="Budget" v={m.budget_spent + (m.budget_limit != null ? ' / ' + m.budget_limit : '') + ' ' + m.budget_currency} />
              <KeyValue k="Reservasi" v={String(m.budget_reserved)} />
              <KeyValue k="Diperbarui" v={new Date(m.updated_at).toLocaleString('id-ID')} />
            </Card>
          }
          renderItem={({ item }) => (
            <View style={s.task}>
              <View style={{ flex: 1 }}>
                <Text style={s.taskTitle}>{item.title}</Text>
                <Text style={s.taskMeta}>attempt {item.attempts}/{item.max_attempts}{item.last_error ? ' · ' + item.last_error : ''}</Text>
              </View>
              <Tag label={item.state} tone={stateTone(item.state) as any} />
            </View>
          )}
          ListEmptyComponent={<EmptyState title="Belum ada task" />}
        />
      </View>
    );
  }

  if (loading) return <Loading label="Memuat misi…" />;

  return (
    <FlatList
      data={missions || []}
      keyExtractor={m => m.id}
      contentContainerStyle={{ padding: 12, gap: 8 }}
      ListHeaderComponent={<>{!!error && <ErrorState message={error} onRetry={load} />}</>}
      renderItem={({ item }) => (
        <TouchableOpacity onPress={() => open(item.id)} style={s.mission} accessibilityRole="button">
          <View style={{ flex: 1 }}>
            <Text style={s.missionTitle}>{item.title}</Text>
            <Text style={s.missionMeta}>
              {item.executions}/{item.max_executions} eksekusi · budget {item.budget_spent}{item.budget_limit != null ? '/' + item.budget_limit : ''} {item.budget_currency}
            </Text>
          </View>
          <Tag label={item.state} tone={stateTone(item.state) as any} />
        </TouchableOpacity>
      )}
      ListEmptyComponent={<EmptyState title="Belum ada misi" hint="Misi dibuat dari desktop, web, atau API." />}
    />
  );
}

const s = StyleSheet.create({
  back: { color: theme.gold, fontSize: 12.5, paddingVertical: 4 },
  goal: { color: theme.tx2, fontSize: 12, lineHeight: 18, marginBottom: 10 },
  mission: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: theme.line, backgroundColor: theme.panel },
  missionTitle: { color: theme.text, fontSize: 13, fontWeight: '600' },
  missionMeta: { color: theme.tx3, fontSize: 10, fontFamily: theme.fontMono, marginTop: 3 },
  task: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 11, borderRadius: 11, borderWidth: 1, borderColor: theme.line, backgroundColor: theme.panel },
  taskTitle: { color: theme.text, fontSize: 12.5 },
  taskMeta: { color: theme.tx3, fontSize: 10, fontFamily: theme.fontMono, marginTop: 2 }
});
