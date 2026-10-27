/* ORION Desktop — adaptor sinkronisasi Orion Central (Phase C).
 * Berada di renderer TETAPI tidak memegang secret: token perangkat hanya di main process
 * (safeStorage). Renderer hanya meminta aksi lewat IPC terotorisasi.
 *
 * Kontrak data lokal (State.convos) dipertahankan; setiap percakapan lokal dapat memakai
 * `serverId` = id percakapan di Orion Central. Kalau percakapan hanya ada di server (dibuat
 * dari Web App), id server dipakai langsung sebagai id lokal.
 */
(function () {
  'use strict';
  const D = window.orionDesktop;
  if (!D || !D.central || !D.central.desktopStatus) return;

  const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const fmtTime = (iso) => { try { return new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };

  function toLocalConv(c, messages) {
    return {
      id: c.clientLocalId || c.id,
      serverId: c.id,
      title: c.title || 'Tanpa judul',
      pinned: !!c.pinned,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      messages: (messages || []).map(m => ({
        id: m.client_message_id || m.id,
        serverId: m.id,
        role: m.role === 'assistant' ? 'orion' : m.role,
        text: m.content,
        t: m.created_at,
        status: 'ok',
        fromDevice: m.device_id || null
      }))
    };
  }

  const Cloud = {
    enabled: false,
    status: { connected: false, configured: false, hasToken: false, pending: 0, lastSyncAt: null, revoked: false, lastError: null },
    _unsub: null,
    _listeners: [],

    async init() {
      try {
        const r = await D.central.desktopStatus();
        this.status = Object.assign({}, this.status, r.status || {});
        this.enabled = !!(this.status.configured && this.status.hasToken);
        // Selalu subscribe (even saat belum aktif) agar event login dari main diterima.
        if (D.central.onEvent && !this._unsub) this._unsub = D.central.onEvent(ev => this._onEvent(ev));
        if (this.enabled) {
          await this.refresh();
        }
      } catch (e) { /* Central belum dikonfigurasi — mode lokal */ }
      return this.enabled;
    },

    onChange(fn) { this._listeners.push(fn); },
    _paintStatus(){
      const el=document.querySelector('#chat-cloud-status');
      if(!el)return;
      const st=this.status||{};
      if(!this.enabled){
        el.className='cloud-status';
        el.innerHTML='<span class="dot"></span>Orion lokal';
        return;
      }
      const cls=(st.revoked||st.lastError)?'error':(st.pending>0?'pending':(st.connected?'connected':''));
      el.className='cloud-status '+cls;
      const bits=[];
      bits.push(st.connected?'Central tersambung':'Menyambung…');
      if(st.pending>0)bits.push(st.pending+' tertunda');
      if(st.lastSyncAt)bits.push('sinkron '+new Date(st.lastSyncAt).toLocaleTimeString('id-ID'));
      if(st.revoked)bits.push('perangkat dicabut');
      el.innerHTML='<span class="dot"></span>'+esc(bits.join(' · '));
    },
    _emit(detail) { this._listeners.forEach(f => { try { f(detail); } catch (e) { /* ignore */ } }); },

    async login(url, token) {
      if (url) await D.central.desktopSetUrl(url);
      const r = await D.central.desktopLogin(token);
      const st = await D.central.desktopStatus();
      this.status = Object.assign({}, this.status, st.status || {});
      this.enabled = !!(this.status.configured && this.status.hasToken);
      if (this.enabled && D.central.onEvent && !this._unsub) this._unsub = D.central.onEvent(ev => this._onEvent(ev));
      return r;
    },
    async logout() {
      await D.central.desktopLogout();
      this.enabled = false;
      this.status = Object.assign({}, this.status, { connected: false, hasToken: false, pending: 0 });
      if (this._unsub) { try { this._unsub(); } catch (e) { /* ignore */ } this._unsub = null; }
    },
    async refreshStatus() {
      try {
        const r = await D.central.desktopStatus();
        this.status = Object.assign({}, this.status, r.status || {});
        this.enabled = !!(this.status.configured && this.status.hasToken);
        this._paintStatus();
    this._emit({ type: 'status' });
        return this.status;
      } catch (e) { return this.status; }
    },

    /** Ambil daftar percakapan dari server (server = sumber kebenaran). */
    async list() {
      const r = await D.central.desktopList();
      return (r && r.conversations) || [];
    },
    async messages(serverId) {
      const r = await D.central.desktopGet(serverId);
      return (r && r.messages) || [];
    },
    async create(title, clientKey) {
      const r = await D.central.desktopCreate(title || 'Percakapan baru', clientKey || '');
      return r && r.conversation ? r.conversation : r;
    },
    async send(serverId, msg) {
      return await D.central.desktopSend(serverId, msg);
    },
    async update(serverId, patch) { return await D.central.desktopUpdate(serverId, patch); },
    async remove(serverId) { return await D.central.desktopRemove(serverId); },
    async sync() { return await D.central.desktopSync(); },
    async importLocal(convos) { return await D.central.desktopImport({ conversations: convos || [] }); },

    /** event dari server (SSE) → perbarui cache lokal */
    _onEvent(ev) {
      if (!ev) return;
      if (ev.type === 'central:login'){
        this.refreshStatus().then(()=>{ if(this.enabled) this.refresh().catch(()=>{}); }).catch(()=>{});
        return;
      }
      if (ev.type === 'outbox.failed'){
        // Pesan tidak bisa dikirim (mis. percakapan dihapus di server) → tampilkan status gagal
        // secara jujur, jangan menghilangkannya diam-diam.
        const localId = String(ev.eventId || '').replace(/^msg-/, '');
        if (typeof State !== 'undefined' && State.convos){
          State.convos.forEach(c => {
            (c.messages || []).forEach(m => { if (m.id === localId) m.syncState = 'error'; });
          });
        }
        if (typeof Chat !== 'undefined' && Chat.renderAll) Chat.renderAll();
        if (typeof toast === 'function') toast('Satu pesan gagal disinkronkan: ' + (ev.reason || 'kesalahan server'), 'error');
        this.refreshStatus().catch(() => {});
        return;
      }
      if (ev.type === 'message.created' || ev.type === 'conversation.created' || ev.type === 'conversation.updated' || ev.type === 'conversation.deleted') {
        this.refresh().catch(() => {});
      } else {
        this.refreshStatus().catch(() => {});
      }
    },

    /** Sinkronkan daftar + isi percakapan aktif ke State.convos (server menang). */
    async refresh() {
      if (!this.enabled || typeof State === 'undefined' || !State.convos) return;
      const serverConvos = await this.list();
      const local = State.convos;
      const byServer = new Map();
      local.forEach(c => { if (c.serverId) byServer.set(c.serverId, c); });
      const merged = [];
      for (const sc of serverConvos){
        let lc = byServer.get(sc.id);
        if (!lc){
          lc = { id: sc.id, serverId: sc.id, title: sc.title || 'Tanpa judul', pinned: !!sc.pinned, createdAt: sc.created_at, updatedAt: sc.updated_at, messages: [] };
        } else {
          lc.title = sc.title || lc.title;
          lc.pinned = !!sc.pinned;
          lc.updatedAt = sc.updated_at || lc.updatedAt;
        }
        merged.push(lc);
      }
      // percakapan lokal yang belum punya serverId (belum tersinkron) tetap dipertahankan di akhir
      local.forEach(c => { if (!c.serverId) merged.push(c); });
      State.convos = merged;
      // muat pesan untuk percakapan yang aktif
      const active = State.convos.find(c => c.id === (typeof Chat !== 'undefined' ? Chat.activeId : null)) || State.convos[0];
      if (active && active.serverId){
        const msgs = await this.messages(active.serverId);
        if (msgs && msgs.length){
          active.messages = msgs.map(m => ({
            id: m.client_message_id || m.id,
            serverId: m.id,
            role: m.role === 'assistant' ? 'orion' : m.role,
            text: m.content,
            t: m.created_at,
            status: 'ok',
            fromDevice: m.device_id || null
          }));
          active.updatedAt = msgs[msgs.length - 1].created_at || active.updatedAt;
        }
      }
      try { persist('convos'); } catch (e) { /* cache lokal opsional */ }
      if (typeof Chat !== 'undefined' && Chat.renderAll) Chat.renderAll();
      this._paintStatus();
    this._emit({ type: 'refresh' });
    }
  };

  window.Cloud = Cloud;
  // init otomatis setelah DOM siap (State sudah ada)
  const boot = () => setTimeout(() => Cloud.init().catch(() => {}), 0);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
