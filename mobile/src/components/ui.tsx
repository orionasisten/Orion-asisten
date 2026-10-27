import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View, type ViewStyle } from 'react-native';
import { theme } from '../theme';

export function Card({ title, right, children, style }: { title?: string; right?: React.ReactNode; children?: React.ReactNode; style?: ViewStyle }) {
  return (
    <View style={[s.card, style]}>
      {(title || right) && (
        <View style={s.cardH}>
          {!!title && <Text style={s.cardTitle}>{title}</Text>}
          {right ? <View style={{ marginLeft: 'auto' }}>{right}</View> : null}
        </View>
      )}
      {children}
    </View>
  );
}

export function Button({ label, onPress, kind = 'ghost', disabled, small }: { label: string; onPress?: () => void; kind?: 'primary' | 'ghost' | 'danger'; disabled?: boolean; small?: boolean }) {
  const bg = kind === 'primary' ? theme.gold : kind === 'danger' ? 'transparent' : theme.surf;
  const color = kind === 'primary' ? '#1A1200' : kind === 'danger' ? theme.red : theme.text;
  return (
    <TouchableOpacity
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[
        s.btn,
        { backgroundColor: bg, borderColor: kind === 'danger' ? 'rgba(242,84,91,.4)' : theme.line2, opacity: disabled ? 0.5 : 1 },
        small && { paddingVertical: 7, paddingHorizontal: 10 }
      ]}
    >
      <Text style={[s.btnText, { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

export function Field({ label, value, onChangeText, placeholder, secure, autoCapitalize }: { label: string; value: string; onChangeText: (v: string) => void; placeholder?: string; secure?: boolean; autoCapitalize?: 'none' | 'sentences' }) {
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        style={s.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.tx3}
        secureTextEntry={secure}
        autoCapitalize={autoCapitalize || 'none'}
        autoCorrect={false}
        accessibilityLabel={label}
      />
    </View>
  );
}

export function Tag({ label, tone = 'gray' }: { label: string; tone?: 'gray' | 'gold' | 'teal' | 'red' }) {
  const color = tone === 'gold' ? theme.gold : tone === 'teal' ? theme.teal : tone === 'red' ? theme.red : theme.tx3;
  return (
    <View style={[s.tag, { borderColor: tone === 'gray' ? theme.line2 : color + '66' }]}>
      <Text style={[s.tagText, { color }]}>{label}</Text>
    </View>
  );
}

export function Loading({ label = 'Memuat…' }: { label?: string }) {
  return (
    <View style={s.state} accessibilityRole="progressbar">
      <ActivityIndicator color={theme.gold} />
      <Text style={s.stateText}>{label}</Text>
    </View>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={s.state}>
      <Text style={{ color: theme.tx2, fontFamily: theme.fontDisplay, fontSize: 14, textAlign: 'center' }}>{title}</Text>
      {!!hint && <Text style={[s.stateText, { textAlign: 'center' }]}>{hint}</Text>}
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={[s.banner, { borderColor: 'rgba(242,84,91,.4)', backgroundColor: 'rgba(242,84,91,.08)' }]}>
      <Text style={{ color: theme.red, fontSize: 12, flex: 1 }}>{message}</Text>
      {!!onRetry && <Button label="Coba lagi" onPress={onRetry} small />}
    </View>
  );
}

export function OfflineBanner({ online }: { online: boolean }) {
  if (online) return null;
  return (
    <View style={[s.banner, { borderColor: theme.goldline, backgroundColor: theme.goldglow }]}>
      <Text style={{ color: theme.amber, fontSize: 12, flex: 1 }}>
        Offline — data terbaru butuh koneksi. Pesan yang belum terkirim aman di antrean lokal.
      </Text>
    </View>
  );
}

export function Row({ children }: { children: React.ReactNode }) {
  return <View style={s.row}>{children}</View>;
}

export function KeyValue({ k, v }: { k: string; v: string }) {
  return (
    <View style={s.kv}>
      <Text style={s.kvKey}>{k}</Text>
      <Text style={s.kvVal}>{v}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: theme.panel, borderColor: theme.line, borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 12 },
  cardH: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  cardTitle: { color: theme.text, fontFamily: theme.fontDisplay, fontSize: 13.5, fontWeight: '600' },
  btn: { borderRadius: 10, borderWidth: 1, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontSize: 12.5, fontWeight: '600' },
  label: { color: theme.tx3, fontSize: 10, fontFamily: theme.fontMono, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 5 },
  input: { backgroundColor: theme.surf, borderColor: theme.line, borderWidth: 1, borderRadius: 9, paddingHorizontal: 11, paddingVertical: 10, color: theme.text, fontSize: 13 },
  tag: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2, alignSelf: 'flex-start' },
  tagText: { fontSize: 10, fontFamily: theme.fontMono },
  state: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  stateText: { color: theme.tx3, fontSize: 12, fontFamily: theme.fontBody },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 10, padding: 10, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: theme.line },
  kvKey: { color: theme.tx3, fontSize: 11, fontFamily: theme.fontMono },
  kvVal: { color: theme.text, fontSize: 11.5, flexShrink: 1, textAlign: 'right' }
});
