import { completionEvents } from './stream.js';

export const API_LIMITS = Object.freeze({ daily: 10, perMinute: 2, maxTokens: 512, maxInput: 16000 });
const hash = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
const bearer = r => (r.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
export const hasApiKey = r => bearer(r).startsWith('gly_api_');
const publicKey = (r, day) => ({
  id: r.id, name: r.name, prefix: r.prefix, created: r.created, revoked: !!r.revoked,
  lastUsed: r.last_used, used: r.day === day ? r.n : 0, ...API_LIMITS,
});

export async function manageKeys(request, route, { db, acc, json, fail, readJSON }) {
  if (route !== '/api-keys' && !route.startsWith('/api-keys/')) return null;
  // Her hesap kendi anahtarını yönetir; API anahtarları oturum yerine geçmez.
  const me = await acc.userOf(request);
  if (!me) return fail(401, 'API anahtarı oluşturmak için hesabına giriş yap.', 'auth');
  if (route === '/api-keys' && request.method === 'GET') {
    const rows = await db.all(`SELECT k.id, k.prefix, k.name, k.created, k.revoked, k.last_used, u.day, COALESCE(u.n, 0) AS n
      FROM api_keys k LEFT JOIN api_usage u ON u.uid = k.uid WHERE k.uid = ? ORDER BY k.created DESC LIMIT 50`, me.id);
    return json(200, { keys: rows.map(r => publicKey(r, acc.today())), limits: API_LIMITS });
  }
  if (route === '/api-keys' && request.method === 'POST') {
    const b = await readJSON(request, 2000);
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) return fail(400, 'Anahtar için bir ad yaz.');
    const active = await db.one('SELECT COUNT(*) AS n FROM api_keys WHERE uid = ? AND revoked = 0', me.id);
    if (active.n) return fail(409, 'Hesap başına bir etkin anahtar olabilir. Önce mevcut anahtarını iptal et.');
    const recent = await db.one('SELECT COUNT(*) AS n FROM api_keys WHERE uid = ? AND created > ?', me.id, Date.now() - 864e5);
    if (recent.n >= 5) return fail(429, '24 saat içinde en fazla 5 anahtar oluşturabilirsin.');
    const key = 'gly_api_' + [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join('');
    const id = crypto.randomUUID(), created = Date.now(), prefix = key.slice(0, 16);
    try { await db.run('INSERT INTO api_keys (id, h, prefix, name, uid, created) VALUES (?, ?, ?, ?, ?, ?)', id, await hash(key), prefix, name, me.id, created); }
    catch (e) { if (/UNIQUE/i.test(e.message)) return fail(409, 'Zaten etkin bir API anahtarın var.'); throw e; }
    return json(201, { key, item: { id, name, prefix, created, revoked: false, used: 0, ...API_LIMITS } });
  }
  const m = route.match(/^\/api-keys\/([\w-]{36})$/);
  if (m && request.method === 'DELETE') {
    await db.run('UPDATE api_keys SET revoked = 1 WHERE id = ? AND uid = ?', m[1], me.id);
    return json(200, { ok: true });
  }
  return fail(404, 'Bulunamadı.');
}

export function validateApiBody(b) {
  if (!b || !Array.isArray(b.messages) || b.messages.length < 1 || b.messages.length > 40) throw new Error('1 ile 40 arasında mesaj gönder.');
  if (b.model && b.model !== 'glassly' && b.model !== 'auto') throw new Error('Model adı glassly olmalı.');
  if (b.tools || b.functions || b.n > 1) throw new Error('Bu API yalnızca metin sohbetini destekler.');
  let size = 0;
  for (const m of b.messages) {
    if (!m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string') throw new Error('Mesajlar metin olmalı; roller system, user veya assistant olabilir.');
    size += m.content.length;
  }
  if (size > API_LIMITS.maxInput) throw new Error('Toplam girdi en fazla 16000 karakter olabilir.');
  if (b.stream !== undefined && typeof b.stream !== 'boolean') throw new Error('stream değeri true veya false olmalı.');
  const max = b.max_tokens ?? API_LIMITS.maxTokens;
  if (!Number.isInteger(max) || max < 1 || max > API_LIMITS.maxTokens) throw new Error('max_tokens 1 ile 512 arasında olmalı.');
  const temp = b.temperature ?? 0.7;
  if (typeof temp !== 'number' || !Number.isFinite(temp) || temp < 0 || temp > 2) throw new Error('temperature 0 ile 2 arasında olmalı.');
  // İzin verilen alanlar dışında sağlayıcıya hiçbir parametre aktarılmaz.
  return { model: 'auto', messages: b.messages.map(m => ({ role: m.role, content: m.content })), stream: !!b.stream, max_tokens: max, temperature: temp };
}

export async function externalApi(request, path, { db, acc, json, fail, readJSON, open }) {
  const token = bearer(request);
  if (!/^gly_api_[a-f0-9]{64}$/.test(token)) return fail(401, 'API anahtarı geçersiz.', 'invalid_api_key');
  const key = await db.one('SELECT * FROM api_keys WHERE h = ? AND revoked = 0', await hash(token));
  if (!key) return fail(401, 'API anahtarı geçersiz veya iptal edilmiş.', 'invalid_api_key');
  if ((path === '/v1/models' || path === '/v1') && request.method === 'GET') {
    return json(200, { object: 'list', data: [{ id: 'glassly', object: 'model', owned_by: 'glassly' }] });
  }
  if (path !== '/v1/chat/completions' || request.method !== 'POST') return fail(404, 'Bu API anahtarı yalnızca metin sohbetinde kullanılabilir.');
  let body;
  try { body = validateApiBody(await readJSON(request, 24000)); }
  catch (e) { return fail(e.status || 400, e.message, 'invalid_request_error'); }
  const now = Date.now(), day = acc.today(), minute = Math.floor(now / 60000);
  // Tek SQL ifadesi ile kota ayır: paralel istekler farklı Worker'larda bile sınırı aşamaz.
  const used = await db.one(`INSERT INTO api_usage (uid, day, n, minute, mn)
    SELECT ?, ?, 1, ?, 1 WHERE EXISTS (SELECT 1 FROM api_keys WHERE id = ? AND revoked = 0)
    ON CONFLICT(uid) DO UPDATE SET
      n = CASE WHEN api_usage.day = excluded.day THEN api_usage.n + 1 ELSE 1 END, day = excluded.day,
      mn = CASE WHEN api_usage.minute = excluded.minute THEN api_usage.mn + 1 ELSE 1 END, minute = excluded.minute
    WHERE (api_usage.day != excluded.day OR api_usage.n < ?)
      AND (api_usage.minute != excluded.minute OR api_usage.mn < ?)
    RETURNING n, mn`, key.uid, day, minute, key.id, API_LIMITS.daily, API_LIMITS.perMinute);
  if (!used) return json(429, { error: { message: 'API sınırına ulaştın: hesap başına günlük 10, dakikada 2 istek.', type: 'rate_limit_error' } }, { 'retry-after': String(60 - Math.floor(now / 1000) % 60) });
  await db.run('UPDATE api_keys SET last_used = ? WHERE id = ?', now, key.id);
  const headers = {
    'x-ratelimit-limit-requests': String(API_LIMITS.daily),
    'x-ratelimit-remaining-requests': String(API_LIMITS.daily - used.n),
    'cache-control': 'no-store',
  };
  try {
    const r = await open(body);
    if (!r.ok) throw new Error('Sağlayıcı yanıt vermedi.');
    if (!body.stream) {
      const data = await r.json();
      if (data.error || !data.choices?.length) throw new Error('Boş yanıt.');
      // Sağlayıcı adı, ham hata veya gizli alanlar dışarı aktarılmaz.
      return json(200, { id: 'chatcmpl-' + crypto.randomUUID(), object: 'chat.completion', created: Math.floor(now / 1000), model: 'glassly',
        choices: data.choices.map(c => ({ index: c.index ?? 0, message: { role: 'assistant', content: c.message?.content || '' }, finish_reason: c.finish_reason || 'stop' })),
        usage: data.usage || {},
      }, headers);
    }
    if (!r.body) throw new Error('Boş yanıt.');
    const id = 'chatcmpl-' + crypto.randomUUID(), created = Math.floor(now / 1000), enc = new TextEncoder();
    const iterator = completionEvents(r.body);
    let finished = false, sentTerminal = false;
    const stream = new ReadableStream({
      async pull(c) {
        try {
          const { value: ev, done } = await iterator.next();
          if (done || ev?.done) {
            if (!finished) throw new Error('Akış kesildi.');
            c.enqueue(enc.encode('data: [DONE]\n\n')); c.close(); return;
          }
          if (ev.interrupted) throw new Error('Akış kesildi.');
          if (ev.finish) finished = true;
          c.enqueue(enc.encode('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'glassly',
            choices: [{ index: 0, delta: ev.text ? { content: ev.text } : {}, finish_reason: ev.finish || null }],
          }) + '\n\n'));
        } catch {
          if (!sentTerminal) c.enqueue(enc.encode('data: ' + JSON.stringify({ error: { message: 'Yanıt akışı tamamlanamadı.', type: 'api_error' } }) + '\n\n'));
          c.close();
          await iterator.return().catch(() => {});
        }
      },
      async cancel() { sentTerminal = true; await iterator.return().catch(() => {}); },
    });
    return new Response(stream, { headers: { ...headers, 'content-type': 'text/event-stream; charset=utf-8', 'access-control-allow-origin': '*' } });
  } catch {
    // Başarısız denemeler de kotaya dahildir; sınırsız yeniden deneme ile kaynak tüketilemez.
    return fail(503, 'Glassly API şu an yanıt veremiyor. Daha sonra tekrar dene.', 'api_error');
  }
}
