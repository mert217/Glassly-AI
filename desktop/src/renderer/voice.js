// Glassly ses: mikrofondan dinleme (sessizlikte kendiliğinden durur), yazıya çevirme ve sesli okuma.
(() => {
  const G = window.glassly;
  let worker = null;
  let seq = 0;
  const waits = new Map();
  const listeners = new Set();

  function getWorker() {
    if (worker) return worker;
    worker = new Worker(new URL('./stt-worker.js', location.href), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') { listeners.forEach((f) => f(m)); return; }
      const w = waits.get(m.id);
      if (!w) return;
      waits.delete(m.id);
      if (m.type === 'error') w.reject(new Error(m.error)); else w.resolve(m.text ?? true);
    };
    worker.onerror = (e) => { for (const w of waits.values()) w.reject(new Error(e.message || 'Ses modülü yüklenemedi')); waits.clear(); worker = null; };
    return worker;
  }
  function call(msg, transfer) {
    const id = ++seq;
    return new Promise((resolve, reject) => { waits.set(id, { resolve, reject }); getWorker().postMessage({ id, ...msg }, transfer || []); });
  }

  // --------------------------------------------------- kayıt
  const micId = () => localStorage.getItem('glassly.mic') || '';
  function micError(e) {
    const n = e?.name || '';
    if (n === 'NotAllowedError' || n === 'SecurityError') return new Error('Mikrofon izni verilmedi. Sistem ayarlarından mikrofon erişimine izin ver.');
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return new Error('Mikrofon bulunamadı. Ayarlar → Ses bölümünden mikrofonu seç.');
    if (n === 'NotReadableError' || n === 'AbortError') return new Error('Mikrofon başka bir uygulama tarafından kullanılıyor ya da açılamadı.');
    return new Error('Mikrofon açılamadı: ' + (e?.message || n || 'bilinmeyen hata'));
  }
  async function openMic() {
    const base = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const id = micId();
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: id ? { ...base, deviceId: { exact: id } } : base });
    } catch (e) {
      if (id && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) { localStorage.removeItem('glassly.mic'); return navigator.mediaDevices.getUserMedia({ audio: base }).catch((x) => { throw micError(x); }); }
      throw micError(e);
    }
  }
  async function devices() {
    try {
      let list = await navigator.mediaDevices.enumerateDevices();
      if (!list.some((d) => d.kind === 'audioinput' && d.label)) {
        const s = await openMic().catch(() => null);
        s?.getTracks().forEach((t) => t.stop());
        list = await navigator.mediaDevices.enumerateDevices();
      }
      return list.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Mikrofon ${i + 1}` }));
    } catch { return []; }
  }
  // Doğrusal yeniden örnekleme (cihazın hızından 16 kHz'e)
  function resample(data, from, to = 16000) {
    if (from === to) return data;
    const ratio = from / to, n = Math.floor(data.length / ratio), out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i * ratio, k = Math.floor(x), f = x - k;
      out[i] = (data[k] || 0) * (1 - f) + (data[k + 1] || 0) * f;
    }
    return out;
  }

  let rec = null;
  async function listen({ onLevel, maxMs = 30000, silenceMs = 1300, onStart, keepSilent = false } = {}) {
    if (rec) throw new Error('Zaten dinleniyor');
    const stream = await openMic();
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain(); mute.gain.value = 0;
    const chunks = [];
    let spoke = false, peak = 0, lastVoice = performance.now(), started = performance.now();
    let noise = 0.003;
    return new Promise((resolve) => {
      const finish = (cancel) => {
        if (!rec) return;
        rec = null;
        try { proc.disconnect(); src.disconnect(); mute.disconnect(); } catch { /* */ }
        stream.getTracks().forEach((t) => t.stop());
        const rate = ctx.sampleRate;
        ctx.close().catch(() => {});
        // Hiç ses yoksa boş dön; çok kısık ama bir şey varsa yine de çevir
        if (cancel || (!spoke && peak < 0.004 && !keepSilent)) return resolve(null);
        const len = chunks.reduce((a, c) => a + c.length, 0);
        const out = new Float32Array(len);
        let o = 0;
        for (const c of chunks) { out.set(c, o); o += c.length; }
        resolve(resample(out, rate));
      };
      rec = { stop: () => finish(false), cancel: () => finish(true), peak: () => peak };
      proc.onaudioprocess = (e) => {
        const d = new Float32Array(e.inputBuffer.getChannelData(0));
        chunks.push(d);
        let sum = 0;
        for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
        const rms = Math.sqrt(sum / d.length);
        peak = Math.max(peak, rms);
        const now = performance.now();
        if (now - started < 350) noise = Math.min(0.012, Math.max(noise, rms * 1.4));
        const thr = Math.max(0.006, noise * 1.8);
        if (rms > thr) { spoke = true; lastVoice = now; }
        onLevel && onLevel(Math.min(1, rms / 0.08), rms > thr);
        if ((spoke && now - lastVoice > silenceMs) || now - started > maxMs || (!spoke && now - started > 10000)) finish(false);
      };
      src.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      onStart && onStart();
    });
  }
  const stop = () => rec && rec.stop();
  const cancel = () => rec && rec.cancel();
  const listening = () => !!rec;

  async function transcribe(audio, model) {
    if (!audio || audio.length < 16000 * 0.3) return '';
    return call({ type: 'run', audio, model }, [audio.buffer]);
  }
  const preload = (model) => call({ type: 'load', model });
  const onProgress = (f) => { listeners.add(f); return () => listeners.delete(f); };

  // --------------------------------------------------- sesli okuma
  let audioEl = null;
  let speakToken = 0;
  function stopSpeaking() {
    speakToken++;
    if (audioEl) { audioEl.pause(); audioEl.src = ''; audioEl = null; }
    try { speechSynthesis.cancel(); } catch { /* */ }
  }
  // Uzun metni cümle gruplarına bölüp sırayla okur; ilk parça hemen başlar
  function splitText(t) {
    const s = String(t).replace(/```[\s\S]*?```/g, ' ').split(/(?<=[.!?…:])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
    const out = [];
    let cur = '';
    for (const x of s) {
      if ((cur + ' ' + x).length > (out.length ? 420 : 160) && cur) { out.push(cur); cur = x; } else cur = cur ? cur + ' ' + x : x;
    }
    if (cur) out.push(cur);
    return out;
  }
  async function speak(text, { voice, rate = 0, onEnd, onError } = {}) {
    stopSpeaking();
    const my = ++speakToken;
    const parts = splitText(text);
    let lastErr = null;
    const fetchPart = (t) => G.voice.speak({ text: t, voice, rate }).catch((e) => { lastErr = e; return null; });
    let next = parts.length ? fetchPart(parts[0]) : null;
    for (let i = 0; i < parts.length; i++) {
      const b64 = await next;
      if (my !== speakToken) return;
      next = i + 1 < parts.length ? fetchPart(parts[i + 1]) : null;
      if (b64) {
        const src = typeof b64 === 'string' ? 'data:audio/mpeg;base64,' + b64 : `data:${b64.mime || 'audio/mpeg'};base64,${b64.data}`;
        await new Promise((res) => {
          audioEl = new Audio(src);
          audioEl.onended = res; audioEl.onerror = res; audioEl.onpause = res;
          audioEl.play().catch(res);
        });
      } else {
        // Çevrim içi ses alınamadıysa sistem sesi (Linux'ta çoğu zaman yoktur)
        const voices = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
        if (!voices.length) { if (my === speakToken) { audioEl = null; onError && onError(new Error(String(lastErr?.message || 'Sesli okuma yapılamadı.').replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))); onEnd && onEnd(); } return; }
        await new Promise((res) => {
          const u = new SpeechSynthesisUtterance(parts[i]);
          u.lang = 'tr-TR'; u.onend = res; u.onerror = res;
          speechSynthesis.speak(u);
          setTimeout(res, 2000 + parts[i].length * 120);
        });
      }
      if (my !== speakToken) return;
    }
    if (my === speakToken) { audioEl = null; onEnd && onEnd(); }
  }
  const speaking = () => !!audioEl || (window.speechSynthesis && speechSynthesis.speaking);

  window.GlasslyVoice = { devices, micId, listen, stop, cancel, listening, transcribe, preload, onProgress, speak, stopSpeaking, speaking };
})();
