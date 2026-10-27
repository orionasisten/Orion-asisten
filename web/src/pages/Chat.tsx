import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Api, ApiError } from '../api/client';
import { EmptyState, ErrorState, Loading } from '../components/States';

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

export function ChatPage() {
  const [conversations, setConversations] = useState<any[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const msgRef = useRef<HTMLDivElement | null>(null);
  // idempotency key per draft (anti double-submit & anti duplikasi saat retry)
  const pendingKey = useRef<string>(uuid());

  const loadConversations = useCallback(async () => {
    try {
      const r = await Api.listConversations(40);
      setConversations(r.conversations || []);
      setActiveId(cur => cur || (r.conversations && r.conversations[0] ? r.conversations[0].id : null));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal memuat percakapan.');
    }
  }, []);

  useEffect(() => { void loadConversations(); }, [loadConversations]);

  const loadMessages = useCallback(async (id: string) => {
    try {
      const r = await Api.listMessages(id, 0, 200);
      setMessages(r.messages || []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal memuat riwayat.');
    }
  }, []);

  useEffect(() => { if (activeId) void loadMessages(activeId); }, [activeId, loadMessages]);

  const scrollDown = useCallback(() => {
    if (msgRef.current) msgRef.current.scrollTop = msgRef.current.scrollHeight;
  }, []);
  useEffect(() => { scrollDown(); }, [messages.length, scrollDown]);

  async function newConversation() {
    setError(null);
    try {
      const key = uuid();
      const r = await Api.createConversation('Percakapan baru', key);
      setConversations(prev => [{ ...r.conversation }, ...(prev || [])]);
      setActiveId(r.conversation.id);
      setMessages([]);
      pendingKey.current = uuid();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal membuat percakapan.');
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || !activeId || sending) return;
    setSending(true);
    setError(null);
    setStatus('Mengirim…');
    const clientMessageId = pendingKey.current;
    const optimistic = { id: 'tmp-' + clientMessageId, role: 'user', content: text, seq: Date.now(), created_at: new Date().toISOString(), pending: true };
    setMessages(prev => [...prev, optimistic]);
    setDraft('');
    try {
      const r = await Api.sendMessage(activeId, { role: 'user', content: text, clientMessageId });
      setMessages(prev => prev.map(m => (m.id === optimistic.id ? { ...r.message, pending: false } : m)));
      pendingKey.current = uuid();
      setStatus('Menunggu respons Orion…');
      // Minta respons AI NYATA dari server (bukan simulasi). Bila provider belum dikonfigurasi
      // server membalas 503 → kami tampilkan pesan jujur, bukan mengarang jawaban.
      try {
        const resp = await Api.respond(activeId, 'ai-' + clientMessageId);
        if (resp && resp.message) setMessages(prev => [...prev, resp.message]);
        setStatus(null);
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : 'Provider AI tidak tersedia.';
        setStatus('Orion tidak dapat menjawab: ' + msg);
      }
      void loadConversations();
    } catch (e) {
      setMessages(prev => prev.filter(m => m.id !== optimistic.id)); // rollback UI optimistis
      setDraft(text);
      setError(e instanceof ApiError ? e.message : 'Gagal mengirim pesan.');
      setStatus(null);
    } finally {
      setSending(false);
    }
  }

  const active = useMemo(() => (conversations || []).find(c => c.id === activeId) || null, [conversations, activeId]);

  return (
    <div className="page">
      <div className="page-head">
        <h2>Chat</h2>
        <p>Riwayat percakapan tersimpan di Orion Central — dapat dilanjutkan dari desktop, web, atau ponsel.</p>
      </div>

      {error && <ErrorState message={error} />}

      <div className="chat-layout">
        <div className="card">
          <div className="card-h">
            <b>Percakapan</b>
            <span className="right"><button className="btn sm primary" onClick={newConversation}>+ Baru</button></span>
          </div>
          <div className="rbody">
            {conversations === null ? <Loading /> : conversations.length === 0 ? (
              <EmptyState title="Belum ada percakapan" hint="Buat percakapan baru untuk memulai."
                action={<button className="btn sm primary" onClick={newConversation}>Buat percakapan</button>} />
            ) : (
              <div className="chat-list" ref={listRef}>
                {conversations.map(c => (
                  <button key={c.id} className={'chat-item' + (c.id === activeId ? ' active' : '')} onClick={() => setActiveId(c.id)}>
                    <b>{c.title || 'Tanpa judul'}</b>
                    <small>{c.message_count} pesan · {new Date(c.updated_at).toLocaleDateString('id-ID')}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <b>{active ? (active.title || 'Tanpa judul') : 'Pilih percakapan'}</b>
            <span className="right statusbar">{status && <span>{status}</span>}</span>
          </div>
          <div className="rbody">
            {!activeId ? <EmptyState title="Belum ada percakapan aktif" hint="Pilih percakapan di kiri atau buat baru." /> : (
              <>
                <div className="messages" ref={msgRef}>
                  {messages.length === 0 ? <EmptyState title="Belum ada pesan" hint="Tulis pesan pertama Anda." /> : messages.map(m => (
                    <div key={m.id} className={'msg ' + (m.role === 'user' ? 'user' : '')}>
                      <div className="msg-ava" aria-hidden="true">{m.role === 'user' ? 'OWN' : '✦'}</div>
                      <div className="msg-bubble">
                        {m.content}
                        {m.pending && <div style={{ fontSize: 10, opacity: .6, marginTop: 4, fontFamily: 'var(--fm)' }}>mengirim…</div>}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="composer">
                  <textarea
                    className="inp"
                    rows={2}
                    placeholder="Tulis pesan untuk Orion…"
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
                    aria-label="Pesan"
                  />
                  <button className="btn primary" onClick={() => void send()} disabled={sending || !draft.trim()}>
                    {sending ? <span className="spinner" /> : 'Kirim'}
                  </button>
                </div>
                <div className="hint">Enter untuk kirim · Shift+Enter untuk baris baru. Pesan memakai idempotency key agar retry tidak menduplikasi.</div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
