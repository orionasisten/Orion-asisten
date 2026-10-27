import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { Api, ApiError, apiBaseUrl } from '../api/client';
import { Button, Card, ErrorState, KeyValue, Tag } from '../components/ui';
import { useSession } from '../state/session';
import { theme } from '../theme';

export function SettingsScreen() {
  const { session, status, apiUrl, logout, refresh } = useSession();
  const [pushState, setPushState] = useState<string>('tidak diaktifkan');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const enablePush = useCallback(async () => {
    setError(null); setBusy(true);
    try {
      if (!Device.isDevice){
        setPushState('mode pengembangan: perangkat virtual tidak menerima push');
        return;
      }
      // Mode pengembangan yang aman: tanpa kredensial provider, token didaftarkan ke server
      // sebagai placeholder sehingga alur tercatat, tetapi tidak ada push nyata.
      const perm = await Notifications.getPermissionsAsync();
      let statusPerm = perm.status;
      if (statusPerm !== 'granted'){
        const req = await Notifications.requestPermissionsAsync();
        statusPerm = req.status;
      }
      if (statusPerm !== 'granted'){ setPushState('izin notifikasi ditolak'); return; }
      const projectId = (process.env.EXPO_PUBLIC_EAS_PROJECT_ID || '').trim();
      if (!projectId){
        setPushState('mode pengembangan: EXPO_PUBLIC_EAS_PROJECT_ID belum diset (tidak ada push nyata)');
        return;
      }
      const token = await Notifications.getExpoPushTokenAsync({ projectId });
      await Api.registerPushToken(token.data, Platform.OS === 'ios' ? 'ios' : 'android');
      setPushState('token push terdaftar di server');
    } catch (e) {
      setPushState('gagal: ' + (e instanceof ApiError ? e.message : (e as Error).message));
    } finally { setBusy(false); }
  }, []);

  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 10 }}>
      <Card title="Sesi Owner">
        <KeyValue k="Owner" v={session?.displayName || session?.email || '—'} />
        <KeyValue k="Peran" v={session?.role || 'owner'} />
        <KeyValue k="Autentikasi" v="token perangkat (bearer)" />
        <KeyValue k="Perangkat" v={session?.deviceId || '—'} />
        <KeyValue k="Status" v={status} />
        <View style={{ marginTop: 10, flexDirection: 'row', gap: 8 }}>
          <Button label="Perbarui" onPress={() => void refresh()} small />
          <Button label="Putuskan" kind="danger" onPress={() => void logout()} small />
        </View>
      </Card>

      <Card title="Orion Central">
        <KeyValue k="URL" v={apiUrl || apiBaseUrl() || '(belum diatur)'} />
        <Text style={s.hint}>
          Token perangkat disimpan di penyimpanan aman perangkat (Keychain / EncryptedSharedPreferences) dan
          tidak pernah masuk log, URL, atau penyimpanan tidak terenkripsi.
        </Text>
      </Card>

      <Card title="Notifikasi Push">
        <Text style={s.hint}>
          Notifikasi push hanya memberi tahu (misi selesai/gagal, approval baru, perangkat dicabut).
          Isi percakapan tidak dikirim lewat push, dan status tetap dibaca ulang dari server.
        </Text>
        <View style={{ marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Tag label={pushState} tone="gray" />
          <Button label="Aktifkan notifikasi" onPress={enablePush} disabled={busy} small />
        </View>
        {!!error && <View style={{ marginTop: 8 }}><ErrorState message={error} /></View>}
      </Card>

      <Card title="Tentang">
        <Text style={s.hint}>
          ORION — Sovereign Intelligence OS · klien mobile Owner (Android & iOS).
          Sumber data tetap Orion Central; aplikasi ini tidak menentukan izin, anggaran, atau approval.
        </Text>
      </Card>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  hint: { color: theme.tx3, fontSize: 11.5, lineHeight: 17 }
});
