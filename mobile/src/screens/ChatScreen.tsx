import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Api, ApiError } from '../api/client';
import type { Conversation, Message } from '../api/types';
import { Button, EmptyState, ErrorState, Loading, Tag } from '../components/ui';
import { useSession } from '../state/session';
import { catchUp, enqueueMessage, flushOutbox, MSG_TYPES } from '../state/sync';
import { localStore, type OutboxEntry } from '../storage/stores';
import { theme } from '../theme';

interface Row extends Message {
  syncState?: 'pending' | 'syncing' | 'synced' | 'failed' | 'local';
  clientMessageId?: string | null;
}

export function ChatScreen({ onChanged }: { onChanged?: () => void }) {
  const { session } = useSession();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Row[]>([]);
  const [outbox, setOutbox] = useState<OutboxEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [online, setOnline] = useState(true);

  const loadConversations = useCallback(async () => {
    const r = await Api.listConversations(30);
    setConversations(r.conversations || []);
    setActiveId(cur => cur || (r.conversations && r.conversations[0] ? r.conversations[0].id : null));
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    const r = await Api.listMessages(id, 0, 100);
    setMessages((r.messages || []).map(m => ({ ...m, syncState: 'synced' })));
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      setOutbox(await localStore.getOutbox());
      await loadConversations();
      setOnline(true);
    } catch (e) {
      setOnline(false);
      if (e instanceof ApiError && !e.isOffline) setError(e.message);
    } finally { setLoading(false); }
  }, [loadConversations]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => { if (activeId) void loadMessages(activeId).catch(() => {}); }, [activeId, loadMessages]);

  // catch-up berkala (delta cursor) + flush outbox
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const since = await localStore.getCursor();
        const { changes, cursor } = await catchUp(since);
        await localStore.setCursor(cursor);
        if (changes.some(c => MSG_TYPES.includes(c.type))) {
          await loadConversations();
          if (activeId) await loadMessages(activeId);
          onChanged?.();
        }
        setOnline(true);
        const entries = await localStore.getOutbox();
        if (entries.length) {
          const res = await flushOutbox(entries);
          await localStore.setOutbox(res.entries);
          setOutbox(res.entries);
          if (res.sent && activeId) await loadMessages(activeId);
        }
      } catch (e) {
        setOnline(false);
      }
    };
    void tick();
    const iv = setInterval(tick, 12000);
    return () => { stopped = true; clearInterval(iv); };
  }, [activeId, loadConversations, loadMessages, onChanged]);

  async function newConversation() {
    try {
      const r = await Api.createConversation('Percakapan baru', 'mob-' + Date.now().toString(36));
      setConversations(prev => [r.conversation, ...prev]);
      setActiveId(r.conversation.id);
      setMessages([]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal membuat percakapan.');
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || !activeId || sending) return;
    setSending(true);
    setError(null);
    const convId = activeId;
    const next = enqueueMessage(outbox, convId, 'user', text);
    const entry = next[next.length - 1];
    setOutbox(next);
    await localStore.setOutbox(next);
    setDraft('');

    // tampilkan optimistis dengan status jujur (belum tersimpan di server)
    const optimistic: Row = {
      id: 'tmp-' + entry.clientMessageId,
      conversation_id: convId,
      seq: Number.MAX_SAFE_INTEGER,
      role: 'user',
      content: text,
      client_message_id: entry.clientMessageId,
      device_id: null,
      created_at: entry.createdAt,
      syncState: 'syncing'
    };
    setMessages(prev => [...prev, optimistic]);

    const res = await flushOutbox(next);
    await localStore.setOutbox(res.entries);
    setOutbox(res.entries);
    if (res.sent) {
      setMessages(prev => prev.filter(m => m.id !== optimistic.id));
      await loadMessages(convId);
    } else {
      const failedEntry = res.entries.find(x => x.clientMessageId === entry.clientMessageId);
      setMessages(prev => prev.map(m => (m.id === optimistic.id
        ? { ...m, syncState: failedEntry && failedEntry.state === 'failed' ? 'failed' : 'pending' }
        : m)));
      setError(failedEntry && failedEntry.state === 'failed'
        ? 'Pesan gagal: ' + (failedEntry.lastError || 'ditolak server') + ' (tetap tersimpan di antrean lokal)'
        : 'Pesan belum tersimpan di server — aman di antrean lokal dan akan dikirim ulang.');
    }
    setSending(false);
  }

  async function retryFailed() {
    const retried = outbox.map(e => (e.state === 'failed' ? { ...e, state: 'pending' as const, lastError: undefined } : e));
    setOutbox(retried);
    await localStore.setOutbox(retried);
    const res = await flushOutbox(retried);
    await localStore.setOutbox(res.entries);
    setOutbox(res.entries);
    if (res.sent && activeId) await loadMessages(activeId);
    if (!res.sent) setError('Kirim ulang belum berhasil — pesan tetap tersimpan lokal.');
  }

  function discardFailed(id: string) {
    const next = outbox.filter(o => o.eventId !== id);
    setOutbox(next);
    void localStore.setOutbox(next);
  }

  const pendingByConv = useMemo(() => {
    const m: Record<string, number> = {};
    outbox.forEach(o => { m[o.conversationId] = (m[o.conversationId] || 0) + 1; });
    return m;
  }, [outbox]);

  const failedCount = outbox.filter(o => o.state === 'failed').length;

  // Gabungkan pesan server dengan entri outbox yang belum ada di server (anti pesan hilang).
  const visible = useMemo<Row[]>(() => {
    const syncedIds = new Set(messages.map(m => m.client_message_id).filter(Boolean) as string[]);
    const localRows: Row[] = outbox
      .filter(o => o.conversationId === activeId && !syncedIds.has(o.clientMessageId))
      .filter(o => !messages.some(m => m.id.endsWith(o.clientMessageId)))
      .map(o => ({
        id: 'out-' + o.eventId,
        conversation_id: o.conversationId,
        seq: Number.MAX_SAFE_INTEGER,
        role: o.role,
        content: o.content,
        client_message_id: o.clientMessageId,
        device_id: null,
        created_at: o.createdAt,
        syncState: o.state === 'failed' ? 'failed' : 'pending',
        clientMessageId: o.clientMessageId
      }));
    return [...messages, ...localRows];
  }, [messages, outbox, activeId]);

  if (loading) return <Loading label="Memuat percakapan…" />;

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={conversations}
        keyExtractor={c => c.id}
        style={{ maxHeight: 150 }}
        contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 6 }}
        renderItem={({ item }) => (
          <TouchableOpacity
            onPress={() => setActiveId(item.id)}
            style={[s.convo, item.id === activeId && s.convoActive]}
            accessibilityRole="button"
            accessibilityState={{ selected: item.id === activeId }}
          >
            <Text style={s.convoTitle} numberOfLines={1}>{item.title || 'Tanpa judul'}</Text>
            <Text style={s.convoMeta}>{item.message_count} pesan{pendingByConv[item.id] ? ' · ' + pendingByConv[item.id] + ' di antrean' : ''}</Text>
          </TouchableOpacity>
        )}
        ListHeaderComponent={<View style={{ padding: 12, paddingBottom: 4 }}><Button label="+ Percakapan baru" onPress={newConversation} small /></View>}
        ListEmptyComponent={<EmptyState title="Belum ada percakapan" hint="Buat percakapan baru untuk memulai." />}
      />

      {!!error && <View style={{ paddingHorizontal: 12 }}><ErrorState message={error} onRetry={load} /></View>}

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={8}>
        <FlatList
          data={visible}
          keyExtractor={m => m.id}
          contentContainerStyle={{ padding: 12, gap: 8 }}
          renderItem={({ item }) => (
            <View style={[s.msg, item.role === 'user' ? s.msgUser : s.msgOrion]}>
              <Text style={[s.bubble, item.role === 'user' ? s.bubbleUser : s.bubbleOrion]}>{item.content}</Text>
              {item.syncState && item.syncState !== 'synced' && (
                <Text style={[s.sync, item.syncState === 'failed' && { color: theme.red }]}>
                  {item.syncState === 'pending' ? 'Menunggu sinkronisasi (antrean lokal)'
                    : item.syncState === 'syncing' ? 'Mengirim…'
                    : item.syncState === 'failed' ? 'Gagal terkirim — tersimpan lokal'
                    : 'Lokal'}
                </Text>
              )}
            </View>
          )}
          ListEmptyComponent={<EmptyState title="Belum ada pesan" hint="Tulis pesan untuk Owner." />}
        />

        {failedCount > 0 && (
          <View style={s.failedBar}>
            <Text style={s.failedText}>{failedCount} pesan gagal terkirim</Text>
            <Button label="Kirim ulang" onPress={retryFailed} small />
            <Button label="Hapus" kind="danger" onPress={() => {
              outbox.filter(o => o.state === 'failed').forEach(o => discardFailed(o.eventId));
            }} small />
          </View>
        )}

        <View style={s.composer}>
          <TextInput
            style={s.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="Tulis pesan…"
            placeholderTextColor={theme.tx3}
            multiline
            accessibilityLabel="Pesan"
          />
          <Button label={sending ? '…' : 'Kirim'} kind="primary" onPress={send} disabled={sending || !draft.trim()} />
        </View>
        <View style={s.footer}>
          <Tag label={online ? 'Tersambung' : 'Offline'} tone={online ? 'teal' : 'gold'} />
          <Text style={s.footerText}>
            Sumber data: Orion Central · {outbox.length ? outbox.length + ' di antrean' : 'antrean kosong'}
            {session?.deviceId ? ' · perangkat ' + String(session.deviceId).slice(0, 8) : ''}
          </Text>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const s = StyleSheet.create({
  convo: { padding: 9, borderRadius: 10, borderWidth: 1, borderColor: theme.line, backgroundColor: theme.surf, marginBottom: 6 },
  convoActive: { borderColor: theme.goldline, backgroundColor: theme.goldglow },
  convoTitle: { color: theme.text, fontSize: 12.5, fontWeight: '600' },
  convoMeta: { color: theme.tx3, fontSize: 10, fontFamily: theme.fontMono, marginTop: 2 },
  msg: { maxWidth: '88%', gap: 3 },
  msgUser: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  msgOrion: { alignSelf: 'flex-start' },
  bubble: { paddingVertical: 9, paddingHorizontal: 11, borderRadius: 12, fontSize: 13, lineHeight: 18 },
  bubbleUser: { backgroundColor: theme.gold, color: '#1A1200' },
  bubbleOrion: { backgroundColor: theme.surf, color: theme.text, borderWidth: 1, borderColor: theme.line },
  sync: { color: theme.amber, fontSize: 9.5, fontFamily: theme.fontMono },
  failedBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: 'rgba(242,84,91,.3)', backgroundColor: 'rgba(242,84,91,.06)' },
  failedText: { color: theme.red, fontSize: 11, flex: 1 },
  composer: { flexDirection: 'row', gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: theme.line },
  input: { flex: 1, maxHeight: 110, backgroundColor: theme.surf, borderWidth: 1, borderColor: theme.line, borderRadius: 10, padding: 10, color: theme.text, fontSize: 13 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  footerText: { color: theme.tx3, fontSize: 10, fontFamily: theme.fontMono }
});
