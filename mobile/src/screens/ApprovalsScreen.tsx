import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { Api, ApiError } from '../api/client';
import type { Approval } from '../api/types';
import { Button, Card, EmptyState, ErrorState, KeyValue, Loading, Tag } from '../components/ui';
import { theme } from '../theme';

function prettyParams(raw: string): string {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return String(raw); }
}

export function ApprovalsScreen({ refreshKey }: { refreshKey?: number }) {
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await Api.listApprovals('pending');
      setApprovals(r.approvals || []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal memuat persetujuan.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);

  async function decide(id: string, decision: 'approved' | 'rejected') {
    setBusy(id); setError(null); setNotice(null);
    try {
      const r = await Api.decideApproval(id, decision);
      setNotice('Keputusan tercatat di server: ' + (r.status || decision));
      await load();
    } catch (e) {
      if (e instanceof ApiError && (e.isConflict || e.code === 'EXPIRED')) setError('Persetujuan sudah diputuskan atau kedaluwarsa — daftar dimuat ulang.');
      else setError(e instanceof ApiError ? e.message : 'Gagal menyimpan keputusan.');
    } finally { setBusy(null); }
  }

  if (loading) return <Loading label="Memuat persetujuan…" />;

  return (
    <FlatList
      data={approvals || []}
      keyExtractor={a => a.id}
      contentContainerStyle={{ padding: 12, gap: 10 }}
      ListHeaderComponent={
        <View>
          {!!error && <ErrorState message={error} onRetry={load} />}
          {!!notice && (
            <View style={[s.ok, { borderColor: 'rgba(57,224,206,.35)', backgroundColor: 'rgba(57,224,206,.08)' }]}>
              <Text style={{ color: theme.teal, fontSize: 12 }}>{notice}</Text>
            </View>
          )}
        </View>
      }
      renderItem={({ item }) => (
        <Card title={item.action} right={<Tag label={item.status} tone="gold" />}>
          <KeyValue k="Target" v={item.resource} />
          {!!item.mission_id && <KeyValue k="Misi" v={item.mission_id} />}
          <KeyValue k="Scope" v={item.scope} />
          <KeyValue k="Diminta" v={new Date(item.created_at).toLocaleString('id-ID')} />
          <KeyValue k="Berlaku s/d" v={new Date(item.expires_at).toLocaleString('id-ID')} />
          <Text style={s.lbl}>Parameter</Text>
          <Text style={s.params}>{prettyParams(item.params)}</Text>
          <View style={s.acts}>
            <Button label="Setujui" kind="primary" onPress={() => decide(item.id, 'approved')} disabled={busy === item.id} />
            <Button label="Tolak" kind="danger" onPress={() => decide(item.id, 'rejected')} disabled={busy === item.id} />
          </View>
        </Card>
      )}
      ListEmptyComponent={<EmptyState title="Tidak ada persetujuan tertunda" hint="Tidak ada tindakan yang menunggu keputusan Anda." />}
    />
  );
}

const s = StyleSheet.create({
  ok: { borderWidth: 1, borderRadius: 10, padding: 10, marginBottom: 10 },
  lbl: { color: theme.tx3, fontSize: 10, fontFamily: theme.fontMono, textTransform: 'uppercase', marginTop: 8, marginBottom: 4 },
  params: { color: theme.tx2, fontFamily: theme.fontMono, fontSize: 10.5, backgroundColor: theme.bg, borderRadius: 8, padding: 8, marginBottom: 10 },
  acts: { flexDirection: 'row', gap: 8 }
});
