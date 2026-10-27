/* ORION Desktop — STT cloud untuk Voice.
 * Electron tidak memiliki layanan Web Speech milik Google, sehingga SpeechRecognition bawaan gagal.
 * File ini menggantinya dengan perekam + deteksi jeda bicara (VAD) yang mengirim audio ke endpoint
 * OpenAI-compatible POST {base}/audio/transcriptions (OpenAI, Groq, atau server lokal). */
(function () {
  'use strict';
  const D = window.orionDesktop;
  if (!D) return;

  const PRESETS = [
    { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'whisper-1' },
    { id: 'groq', name: 'Groq', base: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' },
    { id: 'local', name: 'Server lokal (faster-whisper / LocalAI)', base: 'http://localhost:8000/v1', model: 'Systran/faster-whisper-small' }
  ];
  const CFG = 'orion.sttCfg', KEY = 'orion.sttkey';
  const cfg = () => { try { return JSON.parse(localStorage.getItem(CFG)) || {}; } catch (e) { return {}; } };
  const saveCfg = c => localStorage.setItem(CFG, JSON.stringify(c));
  const getKey = () => { try { return sessionStorage.getItem(KEY) || ''; } catch (e) { return ''; } };
  const setKey = k => { try { sessionStorage.setItem(KEY, k); } catch (e) { /* abaikan */ } };
  const ready = () => { const c = cfg(); return !!(c.base && c.model); };

  async function transcribe(blob, lang, filename) {
    const c = cfg();
    const fd = new FormData();
    const ext = /mp4/.test(blob.type) ? 'mp4' : /ogg/.test(blob.type) ? 'ogg' : 'webm';
    fd.append('file', blob, filename || ('audio.' + ext));
    fd.append('model', c.model);
    if (lang) fd.append('language', String(lang).slice(0, 2));
    fd.append('response_format', 'json');
    const headers = {}; const k = getKey(); if (k) headers.Authorization = 'Bearer ' + k;
    const res = await fetch(c.base.replace(/\/+$/, '') + '/audio/transcriptions', { method: 'POST', headers, body: fd });
    if (!res.ok) {
      let d = ''; try { d = (await res.text()).slice(0, 160); } catch (e) { /* abaikan */ }
      const err = new Error('HTTP ' + res.status + (d ? ' — ' + d : '')); err.status = res.status; throw err;
    }
    const j = await res.json();
    return String(j.text || '').trim();
  }

  const fatal = msg => {
    if (typeof Voice !== 'undefined') { try { Voice.stop(); } catch (e) { /* abaikan */ } Voice.liveState('error', msg); }
    else if (typeof toast === 'function') toast(msg, 'error');
  };
  const pickMime = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m));

  const TICK = 50, SILENCE_MS = 1100, MIN_SPEECH_TICKS = 8, MAX_SEG_MS = 45000, IDLE_RESET_MS = 8000;

  class CloudRecognition {
    constructor() {
      this.continuous = true; this.interimResults = false; this.lang = 'id-ID'; this.maxAlternatives = 1;
      this.onresult = this.onerror = this.onend = this.onstart = null;
      this._run = false; this._gen = 0; this._fails = 0;
    }
    _emit(name, ev) { try { if (typeof this[name] === 'function') this[name](ev || {}); } catch (e) { console.error(e); } }

    start() {
      if (this._run) throw new DOMException('recognition has already started.', 'InvalidStateError');
      if (!ready()) { setTimeout(() => fatal('STT cloud belum dikonfigurasi — buka Desktop Hub → Voice.'), 0); return; }
      this._run = true; const gen = ++this._gen;
      this._begin(gen).catch(e => this._fail(gen, e));
    }

    async _begin(gen) {
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
      catch (e) { this._cleanup(); this._emit('onerror', { error: e && e.name === 'NotFoundError' ? 'audio-capture' : 'not-allowed' }); this._emit('onend'); return; }
      if (gen !== this._gen || !this._run) { stream.getTracks().forEach(t => t.stop()); return; }
      this._stream = stream;
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = this._ctx.createMediaStreamSource(stream);
      this._an = this._ctx.createAnalyser(); this._an.fftSize = 1024; src.connect(this._an);
      this._buf = new Uint8Array(this._an.fftSize);
      this._ticks = 0; this._ambient = 0; this._thr = 0.02;
      this._newSeg();
      this._timer = setInterval(() => this._tick(gen), TICK);
      this._emit('onstart');
    }

    _newSeg() {
      const mime = pickMime();
      const rec = new MediaRecorder(this._stream, mime ? { mimeType: mime } : undefined);
      const seg = { rec, chunks: [], speech: 0, silence: 0, age: 0 };
      rec.ondataavailable = e => { if (e.data && e.data.size) seg.chunks.push(e.data); };
      rec.start();
      this._seg = seg;
    }

    _tick(gen) {
      if (gen !== this._gen || !this._seg) return;
      this._an.getByteTimeDomainData(this._buf);
      let sum = 0; for (let i = 0; i < this._buf.length; i++) { const v = (this._buf[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / this._buf.length);
      if (this._ticks < 10) { this._ambient += rms / 10; this._ticks++; if (this._ticks === 10) this._thr = Math.max(0.02, this._ambient * 3); return; }
      const seg = this._seg; seg.age += TICK;
      if (rms > this._thr) { seg.speech++; seg.silence = 0; } else seg.silence += TICK;
      if (seg.speech >= MIN_SPEECH_TICKS && (seg.silence >= SILENCE_MS || seg.age >= MAX_SEG_MS)) this._finalize(gen, true);
      else if (seg.speech < 3 && seg.age >= IDLE_RESET_MS) this._finalize(gen, false);
    }

    _finalize(gen, send) {
      const seg = this._seg; this._seg = null;
      const type = seg.rec.mimeType || 'audio/webm';
      seg.rec.onstop = () => {
        if (!send || gen !== this._gen) return;
        this._send(gen, new Blob(seg.chunks, { type }));
      };
      try { seg.rec.stop(); } catch (e) { /* sudah berhenti */ }
      if (this._run && gen === this._gen) this._newSeg();
    }

    async _send(gen, blob) {
      try {
        const text = await transcribe(blob, this.lang);
        if (gen !== this._gen || !this._run) return;
        this._fails = 0;
        if (text.length < 2) return;
        const alt = [{ transcript: text, confidence: 1 }]; alt.isFinal = true;
        this._emit('onresult', { resultIndex: 0, results: [alt] });
      } catch (e) {
        if (gen !== this._gen) return;
        if ([400, 401, 403, 404].includes(e.status)) return this._fail(gen, e);
        if (++this._fails >= 3) return this._fail(gen, e);
        if (typeof toast === 'function') toast('STT gagal sesaat: ' + e.message, 'warn');
      }
    }

    _fail(gen, e) {
      if (gen !== this._gen) return;
      this._cleanup();
      fatal('STT cloud gagal: ' + ((e && e.message) || e) + (e && e.status === 401 ? ' (periksa API key di Desktop Hub → Voice)' : ''));
      this._emit('onend');
    }

    _cleanup() {
      this._run = false; this._gen++;
      clearInterval(this._timer);
      if (this._seg) { this._seg.rec.onstop = null; try { this._seg.rec.stop(); } catch (e) { /* abaikan */ } this._seg = null; }
      if (this._stream) { this._stream.getTracks().forEach(t => t.stop()); this._stream = null; }
      if (this._ctx) { try { this._ctx.close(); } catch (e) { /* abaikan */ } this._ctx = null; }
    }

    stop() { if (!this._run) return; this._cleanup(); setTimeout(() => this._emit('onend'), 0); }
    abort() { this.stop(); }
  }

  window.SpeechRecognition = CloudRecognition;
  window.webkitSpeechRecognition = CloudRecognition;

  if (typeof Voice !== 'undefined') {
    const open = Voice.open.bind(Voice);
    Voice.open = function () {
      open();
      const el = document.querySelector('#live-tech');
      if (el && ready()) el.textContent = 'STT: Cloud (' + cfg().model + ') · TTS: suara sistem';
    };
  }

  async function test(seconds) {
    if (!ready()) throw new Error('Isi base URL dan model STT dulu.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    try {
      const mime = pickMime(); const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); const chunks = [];
      rec.ondataavailable = e => e.data && e.data.size && chunks.push(e.data);
      const done = new Promise(r => { rec.onstop = r; });
      rec.start(); await new Promise(r => setTimeout(r, (seconds || 3) * 1000)); rec.stop(); await done;
      return await transcribe(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }), (typeof State !== 'undefined' && State.settings.lang) || 'id-ID');
    } finally { stream.getTracks().forEach(t => t.stop()); }
  }

  async function transcribeFile(file) { // berkas audio dari lampiran Chat
    if (!ready()) throw new Error('STT cloud belum dikonfigurasi (Desktop Hub → Voice)');
    return transcribe(new Blob([file], { type: file.type || 'audio/mpeg' }), (typeof State !== 'undefined' && State.settings.lang) || 'id-ID', file.name);
  }

  window.OrionSTT = { PRESETS, cfg, save: saveCfg, ready, getKey, setKey, test, transcribeFile };
  D.secret.get('sttkey').then(r => { if (r && r.ok && r.value && !getKey()) setKey(r.value); }).catch(() => {});
})();
