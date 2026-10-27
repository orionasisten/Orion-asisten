/* ORION — pemilih Skill, Plugin, Connector dari menu input Chat + penemuan online (GitHub). Tidak ada yang dipasang otomatis. */
(function () {
  'use strict';
  const X = window.OrionHubExt, D = window.orionDesktop;
  if (!X || !D || !window.OrionComposer) return;
  const { DB, H } = X; const { tag } = X.helpers;
  const S = { tab: 'skills', root: null, api: null, found: null, busy: false };
  const TABS = { skills: 'Skill', plugins: 'Plugin', connectors: 'Connector', discover: 'Temukan online' };
  const act = () => new Set(DB.get('hubSkills', []));
  const apiOn = () => !!(D.api && S.api && S.api.connectors);

  const C = window.OrionCapabilities = {
    summary: () => `${DB.get('hubSkills', []).length} skill aktif · ${(H.plugins || []).filter(p => !p.invalid).length} plugin · ${(H.mcp || []).filter(s => s.status === 'running').length} MCP berjalan`,
    async open(tab) {
      if (tab && TABS[tab]) S.tab = tab;
      try { await X.reload(); if (D.api) { const r = await D.api.overview(); S.api = r && r.ok ? r : null; } } catch (e) { /* tampilkan yang ada */ }
      openModal('<div id="cp-root"></div>', { title: 'Skill, plugin & connector', width: '780px', onOpen: el => { S.root = el.querySelector('#cp-root'); render(); } });
    }
  };

  const row = (title, sub, left, right) => `<div class="row-item">${left || ''}<div class="grow"><b>${esc(title)}</b><small>${esc(sub || '')}</small></div>${right || ''}</div>`;
  const b = (a, l, d, c) => `<button class="btn ${c || 'ghost sm'}" data-cp="${a}" ${Object.keys(d || {}).map(k => `data-${k}="${esc(d[k])}"`).join(' ')}>${esc(l)}</button>`;

  function view() {
    if (S.tab === 'skills') {
      const a = act();
      return `<div class="note">Skill aktif disisipkan sebagai instruksi sistem pada setiap pesan (batas total 12.000 karakter). Skill hanya teks — tidak menjalankan kode. Pasang hanya dari sumber tepercaya.</div>
        <div class="stack" style="max-height:340px;overflow:auto">${(H.skills || []).map(s => row(s.name + (s.plugin ? ' · ' + s.plugin : ''), s.description || '(tanpa deskripsi)', `<input type="checkbox" data-sk="${esc(s.id)}" ${a.has(s.id) ? 'checked' : ''} aria-label="Aktifkan ${esc(s.name)}">`, tag(s.source === 'user' ? 'pengguna' : s.plugin ? 'plugin' : 'bawaan', s.source === 'user' ? 'gold' : 'gray') + b('sk-view', 'Lihat', { id: s.id }))).join('') || '<div class="empty">Belum ada skill.</div>'}</div>
        <div class="inline">${b('sk-install-folder', 'Pasang dari folder…', {}, 'primary sm')}${b('sk-install-file', 'Pasang dari berkas SKILL.md…')}${b('sk-folder', 'Buka folder skill')}</div>`;
    }
    if (S.tab === 'plugins') {
      return `<div class="note">Plugin bersifat deklaratif: kumpulan prompt dan skill (tidak menjalankan kode). “Jalankan” memasukkan prompt ke kotak chat; Anda yang menekan Enter.</div>
        <div class="stack" style="max-height:340px;overflow:auto">${(H.plugins || []).filter(p => !p.invalid).map(p => `<div class="card" style="background:var(--surf)"><div class="card-h"><b>${esc(p.name)}</b><small>v${esc(p.version)}</small><span class="right">${tag(p.source === 'user' ? 'pengguna' : 'bawaan', p.source === 'user' ? 'gold' : 'gray')}</span></div><div class="rbody"><div class="hint">${esc(p.description)}</div>${p.commands.map(c => row(c.title, c.input ? 'meminta input' : 'langsung', '', b('pl-run', 'Jalankan', { p: p.id, c: c.id }, 'primary sm'))).join('')}</div></div>`).join('') || '<div class="empty">Belum ada plugin.</div>'}</div>
        <div class="inline">${b('pl-install', 'Pasang dari folder…', {}, 'primary sm')}${b('pl-folder', 'Buka folder plugin')}</div>`;
    }
    if (S.tab === 'connectors') {
      const en = apiOn() ? S.api.connectors.filter(c => c.status === 'enabled') : []; const sc = new Set(DB.get('apiScope', []));
      return `<b>API connector</b><div class="stack">${en.map(c => row(c.name, `${c.allowedMethods.join('/')} · risiko ${c.riskLevel}`, `<input type="checkbox" data-sc="${esc(c.id)}" ${sc.has(c.id) ? 'checked' : ''} aria-label="Izinkan ${esc(c.name)}">`, '')).join('') || '<div class="empty">Belum ada connector aktif. Tinjau, uji, dan aktifkan di API Hub.</div>'}</div>
        <div class="inline"><label class="inline" style="gap:6px"><input type="checkbox" id="cp-apion" ${DB.get('apiChatOn', false) ? 'checked' : ''}> Pakai API connector di Chat</label>${b('go-hub', 'Kelola di API Hub', { t: 'api' })}</div>
        <b>Server MCP</b><div class="stack">${(H.mcp || []).map(s => row(s.name, s.status === 'running' ? `${s.tools.length} tool` : s.status === 'error' ? 'error: ' + String(s.error).slice(0, 100) : 'berhenti', '', tag(s.status, s.status === 'running' ? 'green' : s.status === 'error' ? 'red' : 'gray') + (s.status === 'running' ? b('mcp-stop', 'Stop', { id: s.id }) : b('mcp-start', 'Jalankan', { id: s.id }, 'primary sm')))).join('') || '<div class="empty">Belum ada server MCP.</div>'}</div>
        <div class="inline"><label class="inline" style="gap:6px"><input type="checkbox" id="cp-mcpon" ${DB.get('hubMcpOn', false) ? 'checked' : ''}> Pakai tool MCP di Chat</label>${b('go-hub', 'Tambah/kelola MCP', { t: 'mcp' })}${b('go-hub', 'REA (reverse engineering)', { t: 'rea' })}</div>
        <b>Pencarian web</b><div class="inline">${b('web-setup', 'Atur penyedia pencarian…')}<span class="hint">Aktifkan pencarian/riset dari menu “+” di kotak chat.</span></div>`;
    }
    const f = S.found;
    return `<div class="note">Mencari repositori di GitHub (tanpa login). <b>Hanya penemuan</b>: tidak ada yang dipasang otomatis dan belum diperiksa keamanannya. Periksa kode, lisensi, dan izinnya sebelum memasang: MCP lewat tab MCP (perintah dari README), skill/plugin lewat “Pasang dari folder”.</div>
      <div class="inline"><select class="inp sm" id="dc-kind"><option value="mcp">MCP server</option><option value="skill">Skill</option><option value="plugin">Plugin</option><option value="any">Semua</option></select><input class="inp sm" id="dc-q" placeholder="kata kunci, mis. weather, postgres, seo" style="flex:1;min-width:180px">${b('dc-go', 'Cari', {}, 'primary sm')}</div>
      ${f ? `<div class="hint">Kueri GitHub: ${esc(f.query)} · ${esc(f.fetchedAt.slice(0, 19).replace('T', ' '))} UTC</div><div class="stack" style="max-height:320px;overflow:auto">${f.items.map(i => row(i.name, `${i.description || '(tanpa deskripsi)'} · ⭐ ${i.stars} · lisensi ${i.license} · aktif ${String(i.updatedAt).slice(0, 10)}`, '', (i.archived ? tag('diarsipkan', 'amber') : '') + (i.license === 'tidak diketahui' ? tag('lisensi?', 'amber') : '') + b('dc-open', 'Buka di GitHub', { u: i.url }))).join('') || '<div class="empty">Tidak ada hasil.</div>'}</div>` : ''}`;
  }

  function render() {
    if (!S.root) return;
    S.root.innerHTML = `<div class="hub-tabs" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">${Object.keys(TABS).map(k => `<button class="fchip ${S.tab === k ? 'on' : ''}" data-cp="tab" data-t="${k}">${TABS[k]}</button>`).join('')}</div><div class="stack">${view()}</div>`;
  }
  const reload = async () => { await X.reload().catch(() => {}); if (D.api) { const r = await D.api.overview().catch(() => null); S.api = r && r.ok ? r : S.api; } OrionComposer.refreshBar(); render(); };
  const handlers = {
    tab: d => { S.tab = d.t; render(); },
    'sk-view': async d => { const t = await X.skillBody(d.id); openModal(`<pre class="hub-pre" style="white-space:pre-wrap;max-height:420px;overflow:auto">${esc(t || '(kosong)')}</pre>`, { title: 'Skill', width: '680px' }); },
    'sk-install-folder': async () => { const r = await D.skills.install('folder'); if (r.ok === false) return toast(r.error, r.code === 'USER_REJECTED' ? 'warn' : 'error'); if (r.installed) toast('Skill terpasang: ' + r.installed, 'ok'); await reload(); },
    'sk-install-file': async () => { const r = await D.skills.install('file'); if (r.ok === false) return toast(r.error, r.code === 'USER_REJECTED' ? 'warn' : 'error'); if (r.installed) toast('Skill terpasang: ' + r.installed, 'ok'); await reload(); },
    'sk-folder': () => D.openFolder('skills'), 'pl-folder': () => D.openFolder('plugins'),
    'pl-install': async () => { const r = await D.plugins.install(); if (r.ok === false) return toast(r.error, r.error === 'Ditolak oleh pengguna.' ? 'warn' : 'error'); if (r.installed) toast('Plugin terpasang: ' + r.installed, 'ok'); await reload(); },
    'pl-run': d => { closeModal(); X.runCommand(d.p, d.c, 'chat'); },
    'mcp-start': async d => { toast('Memulai server…', 'info'); const r = await D.mcp.start(d.id); if (r.ok === false) toast(r.error, 'error'); await reload(); },
    'mcp-stop': async d => { await D.mcp.stop(d.id); await new Promise(r => setTimeout(r, 400)); await reload(); },
    'go-hub': d => { closeModal(); H.tab = d.t; go('hub'); },
    'web-setup': () => { closeModal(); window.OrionWeb && OrionWeb.setup(); },
    'dc-go': async () => {
      const q = S.root.querySelector('#dc-q').value, kind = S.root.querySelector('#dc-kind').value; toast('Mencari di GitHub…', 'info');
      const r = await D.discover.search({ kind, q }); if (r.ok === false) return toast(r.error, r.code === 'USER_REJECTED' ? 'warn' : 'error');
      S.found = r; render(); S.root.querySelector('#dc-q').value = q; S.root.querySelector('#dc-kind').value = kind;
    },
    'dc-open': async d => { const r = await D.discover.open(d.u); if (r.ok === false) toast(r.error, 'error'); }
  };
  document.addEventListener('click', e => { const t = e.target.closest('#cp-root [data-cp]'); if (!t) return; const h = handlers[t.dataset.cp]; if (h) h(t.dataset); });
  document.addEventListener('change', e => {
    const t = e.target; if (!t.closest || !t.closest('#cp-root')) return;
    if (t.dataset.sk) { const a = act(); if (t.checked) { a.add(t.dataset.sk); X.skillBody(t.dataset.sk); } else a.delete(t.dataset.sk); DB.set('hubSkills', [...a]); X.syncAgents(); OrionComposer.refreshBar(); }
    else if (t.dataset.sc) { const a = new Set(DB.get('apiScope', [])); if (t.checked) a.add(t.dataset.sc); else a.delete(t.dataset.sc); DB.set('apiScope', [...a]); }
    else if (t.id === 'cp-apion') { DB.set('apiChatOn', t.checked); OrionComposer.refreshBar(); }
    else if (t.id === 'cp-mcpon') { DB.set('hubMcpOn', t.checked); OrionComposer.refreshBar(); }
  });
})();
