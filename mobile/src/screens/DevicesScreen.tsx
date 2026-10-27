import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { Api, ApiError } from '../api/client';
import type { Device } from '../api/types';
import { Button, Card, EmptyState, ErrorState, KeyValue, Loading, Tag } from '../components/ui';
import { theme } from '../theme';

export function DevicesScreen() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await Api.listDevices();
      setDevices(r.devices || []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal memuat perangkat.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function revoke(id: string) {
    setBusy(id); setError(null); setNotice(null);
    try {
      await Api.revokeDevice(id);
      setNotice('Perangkat dicabut di server — aksesnya langsung tidak berlaku.');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal mencabut perangkat.');
    } finally { setBusy(null); }
  }

  if (loading) return <Loading label="Memuat perangkat…" />;

  return (
    <FlatList
      data={devices || []}
      keyExtractor={d => d.id}
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
        <Card title={item.name || 'Tanpa nama'} right={<Tag label={item.status} tone={item.status === 'active' ? 'teal' : 'red'} />}>
          <KeyValue k="Platform" v={item.platform || '—'} />
          <KeyValue k="ID" v={item.id} />
          <KeyValue k="Terakhir terlihat" v={item.last_seen_at ? new Date(item.last_seen_at).toLocaleString('id-ID') : '—'} />
          {item.status === 'active' && (
            <View style={{ marginTop: 10 }}>
              <Button label="Cabut akses" kind="danger" onPress={() => revoke(item.id)} disabled={busy === item.id} small />
            </View>
          )}
        </Card>
      )}
      ListEmptyComponent={<EmptyState title="Belum ada perangkat" hint="Daftarkan perangkat dari Web App (Perangkat → + Token perangkat)." />}
    />
  );
}

const s = StyleSheet.create({
  ok: { borderWidth: 1, borderRadius: 10, padding: 10, marginBottom: 10 }
});
