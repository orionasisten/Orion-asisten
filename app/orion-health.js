/* ORION Desktop — Cek Sistem: diagnosa lokal, hanya-baca. Dipakai tab "Cek Sistem" dan tool Chat `orion_system_check`.
 * OK = konfigurasi/status lokal terbaca baik; BUKAN bukti fitur berjalan end-to-end. Tidak pernah memuat secret. */
(function () {
  'use strict';
  const X = window.OrionHubExt;
  if (!X) return;
  const { D, DB } = X;
  const { tag, row, card, btn, pre } = X.helpers;

  const ICON = { ok: '✓', warn: '⚠', fail: '✗', info: 'ℹ' };
  const LABEL = { ok: 'OK', warn: 'Perlu perhatian', fail: 'Gagal', info: 'Info' };
  const COLOR = { ok: 'green', warn: 'amber', fail: 'red', info: 'gray' };
  let last = null;

  const hostOf = u => { try { return new URL(u).host; } catch (e) { return String(u || '').slice(0, 40); } };
  const isLocalHost = u => { try { return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(u).hostname); } catch (e) { return false; } };
  const safe = async (fn, dflt) => { try { return await fn(); } catch (e) { return dflt; } };

  async function collect(opts) {
    const o = opts || {};
    const items = []; const add = (group, name, status, detail) => items.push({ group, name, status, detail: String(detail) });
    const [info, ws, det, sk, pl, mc, api] = await Promise.all([
      safe(() => D.info(), {}), safe(() => D.workspace.get(), {}), safe(() => D.tools.detect(), {}), safe(() => D.skills.list(), {}),
      safe(() => D.plugins.list(), {}), safe(() => D.mcp.list(), {}), safe(() => (D.api ? D.api.overview() : null), null)
    ]);

    add('Aplikasi', 'Versi & runtime', 'info', `ORION ${info.version || '?'} · ${D.platform}/${D.arch} · Electron ${info.electron || '?'} · Chromium ${info.chrome || '?'}`);
    add('Aplikasi', 'Penyimpanan data aman OS', info.secureStore ? 'ok' : 'warn', info.secureStore ? 'Keychain/DPAPI tersedia' : 'Tidak tersedia — API key/secret tidak dapat disimpan terenkripsi');
    const up = info.updates || {};
    add('Aplikasi', 'Pembaruan', up.enabled ? 'ok' : 'info', up.enabled ? 'Otomatis lewat GitHub Releases (' + up.repo + ')' : up.repo ? 'Manual (' + up.repo + ')' : 'Belum dikonfigurasi pada build ini');

    await safe(() => {
      let chars = 0; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('orion.')) chars += k.length + (localStorage.getItem(k) || '').length; }
      add('Data', 'Penyimpanan lokal', chars > 3500000 ? 'warn' : 'ok', `${Math.round(chars / 1024)} KB dari ±5 MB · ${State.projects.length} proyek · ${State.missions.length} misi · ${State.convos.length} percakapan` + (chars > 3500000 ? ' — hampir penuh, ekspor cadangan lalu bersihkan data lama' : ''));
    });

    const p = State.settings.provider; const hasKey = !!SS.get('aikey', '');
    if (!AI.ready()) add('AI', 'Provider', 'warn', 'Belum dikonfigurasi (base URL/model kosong) — Chat berjalan dalam mode demo. Atur di Desktop Hub → Connectors.');
    else add('AI', 'Provider', hasKey || isLocalHost(p.base) ? 'ok' : 'warn', `${hostOf(p.base)} · model ${p.model} · API key ${hasKey ? 'terisi (sesi ini)' : isLocalHost(p.base) ? 'tidak diperlukan (lokal)' : 'KOSONG — panggilan kemungkinan ditolak'}`);
    if (o.ping && AI.ready()) { const r = await safe(() => AI.test(), { ok: false, msg: 'uji gagal dijalankan' }); add('AI', 'Koneksi provider (diuji)', r.ok ? 'ok' : 'fail', r.msg); }
    else if (AI.ready()) add('AI', 'Koneksi provider', 'info', 'Tidak diuji (hanya konfigurasi). Jalankan dengan opsi uji koneksi untuk memeriksa.');

    const stt = window.OrionSTT && OrionSTT.ready();
    add('Voice', 'Speech-to-text (cloud)', stt ? 'ok' : 'warn', stt ? 'Terkonfigurasi: ' + OrionSTT.cfg().model + (OrionSTT.getKey() || isLocalHost(OrionSTT.cfg().base) ? '' : ' — API key kosong') : 'Belum dikonfigurasi (Desktop Hub → Voice); fitur suara-ke-teks tidak akan berfungsi di Electron tanpa ini');
    const voices = await safe(() => speechSynthesis.getVoices().length, 0);
    add('Voice', 'Text-to-speech (suara sistem)', 'speechSynthesis' in window ? (voices ? 'ok' : 'info') : 'warn', 'speechSynthesis' in window ? `${voices} suara terdeteksi${voices ? '' : ' (daftar bisa baru terisi setelah beberapa detik)'}` : 'Tidak didukung');
    const mic = await safe(async () => (await navigator.permissions.query({ name: 'microphone' })).state, 'tidak diketahui');
    add('Voice', 'Izin mikrofon', mic === 'granted' ? 'ok' : mic === 'denied' ? 'warn' : 'info', mic === 'denied' ? 'Ditolak — izinkan mikrofon di pengaturan sistem' : mic === 'granted' ? 'Diizinkan' : 'Belum ditentukan/tidak diketahui (akan diminta saat dipakai)');

    add('Workspace', 'Folder kerja', ws.workspace ? 'ok' : 'info', ws.workspace ? 'Terpilih (nama folder: ' + String(ws.workspace).split(/[\\/]/).filter(Boolean).pop() + ')' : 'Belum dipilih — dibutuhkan untuk berkas, git, terminal, dan agent CLI');
    const t = det.tools || {};
    const found = k => t[k] && t[k].found;
    const nodeV = found('node') ? t.node.version : '';
    add('Workspace', 'Node.js', found('node') ? 'ok' : 'info', found('node') ? nodeV : 'Tidak ada di PATH (dibutuhkan server MCP berbasis npx dan REA)');
    add('Workspace', 'Git', found('git') ? 'ok' : 'info', found('git') ? t.git.version : 'Tidak ada di PATH');
    add('Workspace', 'Coding agent CLI', found('claude') || found('codex') ? 'ok' : 'info', [found('claude') ? 'Claude Code ' + t.claude.version : '', found('codex') ? 'Codex ' + t.codex.version : ''].filter(Boolean).join(' · ') || 'Claude Code/Codex tidak terdeteksi');

    const skills = sk.skills || [], plugins = pl.plugins || [];
    const act = DB.get('hubSkills', []);
    add('Skill & plugin', 'Skill', skills.length ? 'ok' : 'warn', `${skills.length} tersedia · ${act.filter(id => skills.some(s => s.id === id)).length} aktif di Chat`);
    const bad = plugins.filter(x => x.invalid);
    add('Skill & plugin', 'Plugin', bad.length ? 'warn' : 'ok', `${plugins.length - bad.length} valid` + (bad.length ? ` · ${bad.length} tidak valid (${bad.map(x => x.name).join(', ')})` : ''));

    const servers = mc.servers || [];
    if (!servers.length) add('MCP', 'Server MCP', 'info', 'Belum ada server terdaftar');
    servers.forEach(s => add('MCP', 'Server ' + s.name, s.status === 'running' ? 'ok' : s.status === 'error' ? 'fail' : 'info', s.status === 'running' ? `${s.tools.length} tool` + (s.strict ? ' · mode ketat' : '') : s.status === 'error' ? 'Error: ' + String(s.error || '').slice(0, 160) : 'Berhenti'));
    add('MCP', 'MCP jarak jauh (eksperimental)', 'info', info.experimental && info.experimental.remoteMcp ? 'Diaktifkan' : 'Mati (default)');
    add('MCP', 'Tool MCP di Chat', 'info', DB.get('hubMcpOn', false) ? 'Aktif' : 'Nonaktif');

    if (api && api.ok) {
      const by = {}; api.connectors.forEach(c => { by[c.status] = (by[c.status] || 0) + 1; });
      add('API Hub', 'Gateway', api.stopped ? 'fail' : 'ok', api.stopped ? 'EMERGENCY STOP aktif — semua panggilan API/MCP dihentikan' : 'Normal');
      add('API Hub', 'Connector', 'info', api.connectors.length ? Object.keys(by).map(k => `${by[k]} ${k}`).join(', ') : 'Belum ada connector');
      const unhealthy = api.connectors.filter(c => c.status === 'enabled' && c.healthStatus !== 'healthy');
      if (unhealthy.length) add('API Hub', 'Kesehatan connector aktif', 'warn', unhealthy.map(c => `${c.name}: ${c.healthStatus}`).join('; '));
      add('API Hub', 'Audit log', api.audit.ok ? 'ok' : 'fail', `${api.audit.count} catatan · rantai hash ${api.audit.ok ? 'valid' : 'RUSAK di #' + api.audit.brokenAt}`);
    }

    const dudu = (typeof toolState !== 'undefined' && toolState.dudu) || {};
    add('Integrasi', 'Dudu Orchestrator', 'info', dudu.connected ? 'Terhubung' : 'Belum terhubung (membutuhkan backend Dudu milik Anda — bukan kerusakan)');

    const n = { ok: 0, warn: 0, fail: 0 }; items.forEach(i => { if (n[i.status] !== undefined) n[i.status]++; });
    return { at: new Date().toISOString(), items, counts: n, ping: !!o.ping };
  }

  function format(r) {
    const groups = []; r.items.forEach(i => { if (!groups.includes(i.group)) groups.push(i.group); });
    return `LAPORAN CEK SISTEM ORION — ${r.at.replace('T', ' ').slice(0, 19)} UTC\nRingkasan: ${r.counts.ok} OK · ${r.counts.warn} perlu perhatian · ${r.counts.fail} gagal\n\n` +
      groups.map(g => `[${g}]\n` + r.items.filter(i => i.group === g).map(i => `  ${ICON[i.status]} ${i.name} — ${i.detail}`).join('\n')).join('\n\n') +
      '\n\nCatatan: pemeriksaan ini lokal dan hanya-baca. "OK" berarti konfigurasi/status terbaca baik, bukan bukti fitur berjalan end-to-end; ' + (r.ping ? 'koneksi provider diuji.' : 'koneksi provider tidak diuji.');
  }

  /* ───── tab Cek Sistem ───── */
  function view() {
    const body = last
      ? `<div class="inline">${tag(last.counts.ok + ' OK', 'green')}${tag(last.counts.warn + ' perlu perhatian', last.counts.warn ? 'amber' : 'gray')}${tag(last.counts.fail + ' gagal', last.counts.fail ? 'red' : 'gray')}<span class="hint">${esc(last.at.replace('T', ' ').slice(0, 19))} UTC</span></div>` +
        [...new Set(last.items.map(i => i.group))].map(g => `<b>${esc(g)}</b><div class="stack">${last.items.filter(i => i.group === g).map(i => row(i.name, i.detail, tag(LABEL[i.status], COLOR[i.status]))).join('')}</div>`).join('')
      : '<div class="empty">Belum dijalankan. Klik “Jalankan cek”.</div>';
    return card('shield', 'Cek Sistem', `<div class="note">Pemeriksaan <b>lokal dan hanya-baca</b> atas komponen Orion Desktop (provider AI, Voice, workspace, tool terdeteksi, MCP, API Hub, penyimpanan, pembaruan). Tidak memuat API key. “OK” berarti konfigurasi terbaca baik — bukan jaminan fitur berjalan end-to-end. Di Chat, tanyakan “cek sistem Orion” agar model memakai pemeriksaan ini.</div>
      <div class="inline">${btn('health-run', 'Jalankan cek', {}, 'primary sm')}<label class="inline" style="gap:6px"><input type="checkbox" id="health-ping"> Uji koneksi ke provider AI (mengirim 1 permintaan kecil)</label></div>
      ${last ? `<div class="inline">${btn('health-copy', 'Salin laporan')}${btn('health-chat', 'Kirim laporan ke Chat')}</div>` : ''}${body}`);
  }

  const actions = {
    'health-run': async () => { toast('Memeriksa sistem…', 'info'); last = await collect({ ping: !!($('#health-ping') || {}).checked }); X.redraw(); },
    'health-copy': async () => { try { await navigator.clipboard.writeText(format(last)); toast('Laporan disalin', 'ok'); } catch (e) { toast('Gagal menyalin: ' + e.message, 'error'); } },
    'health-chat': () => { go('chat'); setTimeout(() => { const i = $('#chat-input'); if (!i) return; i.value = 'Berikut hasil cek sistem Orion. Rangkum dan beri langkah perbaikan untuk yang perlu perhatian/gagal:\n\n' + format(last); i.dispatchEvent(new Event('input')); i.focus(); }, 80); }
  };
  X.register('health', 'Cek Sistem', view, actions);

  /* ───── tool Chat (hanya ditawarkan saat pesan terakhir meminta cek/diagnosa sistem) ───── */
  const ASK = /(cek|periksa|diagnos\w*|health\s*check|system\s*check|status|verifikasi|tes|test)\W+(?:\w+\W+){0,3}(sistem|system|orion|aplikasi|konektor|koneksi|fitur)|(sistem|orion|aplikasi).{0,30}(berfungsi|sehat|normal|error|jalan)|apakah semua berfungsi/i;
  X.addChatProvider(ctx => {
    const ms = (ctx && ctx.messages) || []; const lastUser = [...ms].reverse().find(m => m.role === 'user');
    if (!lastUser || !ASK.test(String(lastUser.content || ''))) return null;
    return {
      tools: [{ type: 'function', function: { name: 'orion_system_check', description: 'Periksa kondisi sistem Orion Desktop secara lokal dan hanya-baca: versi, provider AI, Voice, workspace, tool terdeteksi, skill/plugin, server MCP, API Hub, penyimpanan, pembaruan. Gunakan saat pengguna meminta cek/diagnosa sistem Orion.', parameters: { type: 'object', properties: { ping_provider: { type: 'boolean', description: 'true untuk juga menguji koneksi ke provider AI (mengirim satu permintaan kecil)' } } } } }],
      note: 'Anda dapat memeriksa kondisi sistem Orion lewat orion_system_check. Laporkan hasilnya apa adanya (OK / perlu perhatian / gagal) dan jangan mengarang komponen yang tidak ada di laporan. Jelaskan bahwa OK berarti konfigurasi terbaca baik, bukan bukti fitur berjalan end-to-end, lalu beri langkah perbaikan yang spesifik.',
      handle: async (_name, a) => { last = await collect({ ping: !!(a && a.ping_provider) }); X.redraw(); return format(last); }
    };
  });

  window.OrionHealth = { collect, format };
})();
