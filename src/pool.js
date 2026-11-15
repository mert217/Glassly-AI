// Glassly model havuzu: birden çok sağlayıcıyı (Cloudflare Workers AI, anahtarsız ve anahtarlı
// OpenAI uyumlu servisler) tek yerde toplar. Limit dolan yuvayı soğumaya alır, isteği sıradakine verir.

import defaultConfig from './config.json';

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-max-age': '86400',
};
const log = (...a) => console.log(...a);

// ---- Bir kez kurulan durum (Worker kopyası yaşadığı sürece bellekte kalır)
let state;
export function setupPool(env) {
  if (state) return state;
  let cfg = defaultConfig;
  if (env.GLASSLY_CONFIG_JSON) { try { cfg = JSON.parse(env.GLASSLY_CONFIG_JSON); } catch { log('GLASSLY_CONFIG_JSON geçersiz, varsayılan kullanılıyor'); } }

  const slots = [];
  const pending = [];
  for (const u of cfg.upstreams || []) {
    if (u.type === 'workers-ai') {
      // Cloudflare Workers AI: "AI" bağlantısı üzerinden çalışır, anahtar gerekmez
      if (!env.AI) { log('Uyarı: AI bağlantısı yok, workers-ai atlandı'); continue; }
      for (const model of u.models || []) slots.push({ id: `${u.name}/${model}#ai`, upstream: u.name, model, ai: true, tier: Number(u.tier || 2), coolUntil: 0, fails: 0 });
      continue;
    }
    // "keyless": true olan sağlayıcılar anahtar istemez (Authorization başlığı gönderilmez)
    const keys = u.keyless ? [null] : (u.keys || []).map((k) => (k.startsWith('$') ? env[k.slice(1)] : k)).filter(Boolean);
    // "discover": true → model listesi sağlayıcının /models adresinden ilk istekte otomatik çekilir
    if (u.discover) for (const [ki, key] of keys.entries()) pending.push({ u, key, ki, baseURL: u.baseURL.replace(/\/$/, '') });
    for (const model of u.models || []) {
      for (const [ki, key] of keys.entries()) {
        slots.push({ id: `${u.name}/${model}#${ki}`, upstream: u.name, baseURL: u.baseURL.replace(/\/$/, ''), key, model, headers: u.headers || {}, tier: Number(u.tier || 2), coolUntil: 0, fails: 0 });
      }
    }
  }
  if (!slots.length) log('Uyarı: kullanılabilir model yok (ne anahtar ne anahtarsız sağlayıcı).');

  const access = new Set([...(cfg.accessKeys || []), ...String(env.GLASSLY_ACCESS_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean)]);
  state = {
    cfg, slots, pending, discoverAt: 0, discoveredOnce: false, access, ai: env.AI,
    rpm: Number(cfg.rateLimitPerMinute ?? 30),
    maxTries: Number(cfg.maxTries ?? 14),
    timeoutStream: Number(cfg.timeoutStreamMs ?? 9000),
    timeoutPlain: Number(cfg.timeoutPlainMs ?? 20000),
    budgetMs: Number(cfg.budgetMs ?? 45000),
    requireAuth: String(env.GLASSLY_REQUIRE_AUTH ?? cfg.requireAuth ?? 'true') !== 'false',
    cursor: 0,
    hits: new Map(),
  };
  return state;
}

export const publicModels = (S) => ['auto', ...new Set(S.slots.map((s) => `${s.upstream}/${s.model}`))];

function candidates(S, requested) {
  const now = Date.now();
  const ready = (s) => s.coolUntil <= now;
  const rr0 = (list) => { const n = list.length; if (!n) return []; const start = S.cursor++ % n; return [...list.slice(start), ...list.slice(0, start)]; };
  // Önce hiç hata yapmamış, iyi katmandaki (tier 1) modeller; her katmanın içinde sırayla dağıt
  const rr = (list) => [...new Set(list.map((s) => s.tier || 2))].sort((a, b) => a - b).flatMap((t) => { const g = list.filter((s) => (s.tier || 2) === t); return [...rr0(g.filter((s) => !s.fails)), ...rr0(g.filter((s) => s.fails))]; });
  if (requested && requested !== 'auto') {
    const exact = S.slots.filter((s) => `${s.upstream}/${s.model}` === requested && ready(s));
    const rest = S.cfg.fallback === false ? [] : S.slots.filter((s) => `${s.upstream}/${s.model}` !== requested && ready(s));
    return [...rr(exact), ...rr(rest)];
  }
  return rr(S.slots.filter(ready));
}

function coolDown(slot, status, retryAfter) {
  slot.fails++;
  let ms = status === 429 ? 60e3 : status === 402 || status === 403 || status === 401 ? 30 * 60e3 : 20e3;
  const ra = Number(retryAfter);
  if (ra > 0) ms = Math.min(ra * 1000, 6 * 3600e3);
  slot.coolUntil = Date.now() + ms * Math.min(slot.fails, 4);
  log(`soğumada: ${slot.id} (${status}) ${Math.round((slot.coolUntil - Date.now()) / 1000)} sn`);
}

export function limited(S, who) {
  if (!S.rpm) return false;
  const now = Date.now();
  const arr = (S.hits.get(who) || []).filter((t) => now - t < 60e3);
  arr.push(now); S.hits.set(who, arr);
  if (S.hits.size > 5000) for (const [k, a] of S.hits) if (!a.some((t) => now - t < 60e3)) S.hits.delete(k);
  return arr.length > S.rpm;
}

// ---- Otomatik model keşfi: model adları eskidiğinde elle düzeltmek gerekmez
const NOT_CHAT = /embed|whisper|tts|guard|moderat|rerank|image|ocr|transcri|audio|speech|dall|flux|sdxl|stable-diff|video|vision-only|clip|safety|bge-|e5-|minilm|nomic|gte-/i;
export async function ensureDiscovery(S) {
  if (!S.pending.length) return;
  const now = Date.now();
  if (now - S.discoverAt < (S.discoveredOnce ? 6 * 3600e3 : 5 * 60e3)) return;
  S.discoverAt = now;
  const found = (await Promise.all(S.pending.map(async (p) => {
    try {
      const r = await fetch(`${p.baseURL}/models`, { headers: p.key ? { authorization: `Bearer ${p.key}` } : {}, signal: AbortSignal.timeout(5000) });
      if (!r.ok) { log(`keşif başarısız: ${p.u.name} HTTP ${r.status}`); return []; }
      const j = await r.json();
      let list = (j.data || j.models || []).map((m) => (typeof m === 'string' ? { id: m } : { ...m, id: m.id || m.name || m.model })).filter((m) => m.id && !NOT_CHAT.test(m.id));
      if (p.u.free) list = list.filter((m) => /:free$|-free$/i.test(m.id) || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0));
      const prefer = (p.u.prefer || []).map((x) => x.toLowerCase());
      const rank = (id) => { const i = prefer.findIndex((x) => id.toLowerCase().includes(x)); return i < 0 ? 999 : i; };
      list.sort((a, b) => rank(a.id) - rank(b.id));
      return list.slice(0, Number(p.u.limit || 6)).map((m) => ({ p, model: m.id }));
    } catch (e) { log(`keşif hatası: ${p.u.name} ${e.message}`); return []; }
  }))).flat();
  if (!found.length) return;
  const old = new Map(S.slots.filter((x) => x.disc).map((x) => [x.id, x.coolUntil]));
  const have = new Set(S.slots.filter((x) => !x.disc).map((x) => x.id));
  S.slots = S.slots.filter((x) => !x.disc);
  for (const { p, model } of found) {
    const id = `${p.u.name}/${model}#${p.ki}`;
    if (have.has(id) || S.slots.some((x) => x.id === id)) continue;
    S.slots.push({ id, upstream: p.u.name, baseURL: p.baseURL, key: p.key, model, headers: p.u.headers || {}, coolUntil: old.get(id) || 0, fails: 0, disc: true, tier: Number(p.u.tier || 2) });
  }
  S.discoveredOnce = true;
  log(`keşif tamam: ${S.slots.length} model yuvası`);
}

// ---- Workers AI yardımcıları (OpenAI biçimine çevirir)
const completionId = () => 'chatcmpl-' + crypto.randomUUID();
function aiStreamToOpenAI(stream, model) {
  const dec = new TextDecoder(), enc = new TextEncoder(), id = completionId();
  let buf = '', sentRole = false, sawChoices = false;
  const chunk = (delta, finish = null) => enc.encode('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
  return stream.pipeThrough(new TransformStream({
    transform(raw, ctl) {
      buf += dec.decode(raw, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') { if (!sawChoices) ctl.enqueue(chunk({}, 'stop')); ctl.enqueue(enc.encode('data: [DONE]\n\n')); continue; }
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (j.choices) { sawChoices = true; ctl.enqueue(enc.encode('data: ' + data + '\n\n')); continue; }
        if (typeof j.response === 'string' && j.response) {
          ctl.enqueue(chunk(sentRole ? { content: j.response } : { role: 'assistant', content: j.response }));
          sentRole = true;
        }
      }
    },
  }));
}
async function runWorkersAI(S, slot, body) {
  const input = { messages: body.messages || [], stream: !!body.stream };
  for (const k of ['max_tokens', 'temperature', 'top_p']) if (body[k] != null) input[k] = body[k];
  const out = await S.ai.run(slot.model, input);
  const headers = { 'x-glassly-upstream': `${slot.upstream}/${slot.model}`, ...CORS };
  if (body.stream) {
    return new Response(aiStreamToOpenAI(out, slot.model), { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers } });
  }
  const text = out?.response ?? out?.choices?.[0]?.message?.content ?? '';
  return new Response(JSON.stringify({
    id: completionId(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: slot.model,
    choices: [{ index: 0, message: { role: 'assistant', content: typeof text === 'string' ? text : JSON.stringify(text) }, finish_reason: 'stop' }],
    usage: out?.usage || {},
  }), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
}

const withTimeout = (promise, ms, label) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`zaman aşımı (${label})`)), ms))]);
const DEAD_MODEL = /not.?found|no such model|unknown model|does not exist|deprecat|decommission|retired|invalid model|model.*(not|unavailable|unsupported)/i;
function killSlot(slot, hours = 6) { slot.fails = 4; slot.coolUntil = Date.now() + hours * 3600e3; log(`devre dışı: ${slot.id} (${hours} sa)`); }

// Havuzdan çalışan ilk yuvanın yanıtını döndürür (OpenAI biçiminde); hiçbiri olmazsa hata fırlatır
export async function openUpstream(S, body, signal, route = '/chat/completions') {
  const request = { signal: signal || new AbortController().signal };
  const list = candidates(S, body.model);
  if (!list.length) throw Object.assign(new Error('Tüm modeller şu an soğumada, biraz sonra tekrar dene.'), { status: 503 });
  const firstByteMs = body.stream ? S.timeoutStream : S.timeoutPlain; // takılan sağlayıcıyı beklemeden sıradakine geç
  const deadline = Date.now() + S.budgetMs;
  let lastErr = '';
  for (const slot of list.slice(0, S.maxTries)) {
    if (Date.now() > deadline) break;
    if (slot.ai) {
      try { const resp = await withTimeout(runWorkersAI(S, slot, body), firstByteMs, slot.id); slot.fails = 0; log(`→ ${slot.id} 200`); return resp; }
      catch (e) {
        lastErr = `${slot.upstream}: ${String(e.message || e).slice(0, 200)}`;
        if (DEAD_MODEL.test(lastErr)) killSlot(slot); else coolDown(slot, /allocation|limit|4006|quota/i.test(lastErr) ? 402 : 500);
        continue;
      }
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), firstByteMs);
    const onAbort = () => ac.abort();
    request.signal.addEventListener('abort', onAbort, { once: true });
    let r;
    try {
      r = await fetch(`${slot.baseURL}${route}`, {
        method: 'POST', signal: ac.signal,
        headers: { 'content-type': 'application/json', ...(slot.key ? { authorization: `Bearer ${slot.key}` } : {}), ...slot.headers },
        body: JSON.stringify({ ...body, model: slot.model }),
      });
    } catch (e) {
      clearTimeout(timer);
      if (request.signal.aborted) throw Object.assign(new Error('iptal'), { status: 499 });
      lastErr = `${slot.upstream}: ${e.message || 'zaman aşımı'}`; coolDown(slot, 0); continue;
    }
    clearTimeout(timer); // ilk yanıt geldi; akış başladıktan sonra süre sınırı yok
    if ([400, 410, 422].includes(r.status)) {
      const t = (await r.clone().text().catch(() => '')).slice(0, 300);
      if (DEAD_MODEL.test(t)) { lastErr = `${slot.upstream}: HTTP ${r.status} ${t}`; killSlot(slot); continue; }
    }
    if ([401, 402, 403, 404, 408, 409, 429].includes(r.status) || r.status >= 500) {
      lastErr = `${slot.upstream}: HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`;
      if (r.status === 404) killSlot(slot); else coolDown(slot, r.status, r.headers.get('retry-after'));
      continue;
    }
    slot.fails = 0;
    log(`→ ${slot.id} ${r.status}`);
    const headers = { 'content-type': r.headers.get('content-type') || 'application/json', 'x-glassly-upstream': `${slot.upstream}/${slot.model}`, ...CORS };
    if (body.stream) headers['cache-control'] = 'no-cache';
    return new Response(r.body, { status: r.status, headers });
  }
  throw Object.assign(new Error('Şu an uygun model yok, birazdan tekrar dene. Son hata: ' + lastErr), { status: 503 });
}

