import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Card, ErrorState, Field } from '../components/ui';
import { useSession } from '../state/session';
import { theme } from '../theme';

/**
 * Pairing perangkat: Owner mengambil "Token perangkat" di Web App (Perangkat → + Token
 * perangkat) lalu menempelkannya di sini. Token disimpan di secure store native
 * (Keychain / EncryptedSharedPreferences) — tidak di AsyncStorage, log, atau URL.
 */
export function LoginScreen() {
  const { pair, error, status, apiUrl } = useSession();
  // URL aktif (dari SecureStore/AsyncStorage) ditampilkan sebagai status, bukan
  // ditebak dari input yang belum diverifikasi.
  const [url, setUrl] = useState(apiUrl || '');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  async function submit() {
    setLocalError(null);
    if (!url.trim()) return setLocalError('URL Orion Central wajib diisi.');
    if (!token.trim()) return setLocalError('Token perangkat wajib diisi.');
    setBusy(true);
    try { await pair(url.trim(), token.trim()); }
    catch (e) { setLocalError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
        <View style={s.brand}>
          <Text style={s.mark}>✦</Text>
          <Text style={s.title}>ORION</Text>
          <Text style={s.sub}>SOVEREIGN INTELLIGENCE OS · MOBILE</Text>
        </View>
        <Card title="Hubungkan perangkat">
          <Text style={s.hint}>
            Sistem privat milik Owner. Ambil token perangkat dari Web App (Perangkat → “+ Token perangkat”),
            lalu tempel URL Orion Central dan tokennya di bawah.
          </Text>
          {(localError || error) && <ErrorState message={localError || error || ''} />}
          <Field label="URL Orion Central" value={url} onChangeText={setUrl} placeholder="https://orion-central.up.railway.app" />
          <Text style={[s.hint, { marginTop: -4 }]}>
            {apiUrl ? 'URL aktif: ' + apiUrl : 'Belum ada URL aktif.'}
          </Text>
          <Field label="Token perangkat" value={token} onChangeText={setToken} placeholder="••••••" secure />
          <Button label={busy ? 'Menghubungkan…' : 'Hubungkan'} kind="primary" onPress={submit} disabled={busy} />
          <Text style={[s.hint, { marginTop: 10 }]}>
            Token disimpan terenkripsi di penyimpanan aman perangkat (Keychain iOS / EncryptedSharedPreferences Android).
            {status === 'revoked' ? ' Perangkat ini dicabut — buat token baru di Web App.' : ''}
            {status === 'expired' ? ' Sesi kedaluwarsa — hubungkan ulang dengan token baru.' : ''}
          </Text>
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  wrap: { padding: 18, paddingTop: 42, flexGrow: 1, justifyContent: 'center' },
  brand: { alignItems: 'center', marginBottom: 22 },
  mark: { color: theme.gold, fontSize: 34 },
  title: { color: theme.text, fontFamily: theme.fontDisplay, fontSize: 20, letterSpacing: 4, marginTop: 2 },
  sub: { color: theme.tx3, fontFamily: theme.fontMono, fontSize: 9, letterSpacing: 1.4, marginTop: 3 },
  hint: { color: theme.tx3, fontSize: 11.5, lineHeight: 17, marginBottom: 12 }
});
