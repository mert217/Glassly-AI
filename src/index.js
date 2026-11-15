// Glassly — glassly.biz
// Tek bir Cloudflare Worker: tanıtım sayfası + web uygulaması (public/), hesaplar (/auth),
// geliştirici paneli (/admin), web sohbeti (/api) ve masaüstü uygulamasının bağlandığı
// OpenAI uyumlu bulut (/v1). Veriler Cloudflare D1'de durur.

import { CORS, setupPool, publicModels, limited, ensureDiscovery, openUpstream } from './pool.js';
import { openDB } from './db.js';
import { createAccounts } from './auth.js';

const log = (...a) => console.log(...a);
const json = (status, obj, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS, ...extra } });
const fail = (status, message, type = 'glassly_error') => json(status, { error: { message, type } });
async function readJSON(request) {
  const t = await request.text();
  if (t.length > 2e6) throw Object.assign(new Error('İstek çok büyük'), { status: 413 });
  try { return t ? JSON.parse(t) : {}; } catch { return {}; }
}
const helpers = { json, fail, readJSON };

const SYSTEM = (u, TZ) => [
  'Sen Glassly\'sin: kullanıcının günlük işlerine, yazılarına, sorularına ve kodlarına yardım eden, sıcak ve net konuşan bir yapay zeka asistanı.',
  'Kim olduğun sorulursa yalnızca "Ben Glassly\'yim" de. Arka planda hangi modelin, şirketin ya da sağlayıcının çalıştığından asla bahsetme; yanıtların arasında bir değişiklik olduysa bunu söyleme.',
  'Kullanıcı hangi dilde yazıyorsa o dilde cevap ver; varsayılan dil Türkçe. Gereksiz uzatma, gerektiğinde başlık, liste, tablo ve kod bloğu kullan (Markdown).',
  'Bu web sürümünde dosya sistemine, terminale, e-postaya ya da internete erişimin yok; bunlar gerekirse kullanıcıya Glassly masaüstü uygulamasını önerebilirsin.',
  `Kullanıcının adı: ${u.name}. Bugünün tarihi: ${new Date().toLocaleDateString('tr-TR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.`,
].join('\n');

const REPO = 'mert217/Glassly-AI';
const DL = (f) => `https://github.com/${REPO}/releases/latest/download/${f}`;
const DOWNLOADS = [
  { os: 'windows', label: 'Windows', file: 'Glassly-Setup.exe', url: DL('Glassly-Setup.exe') },
  { os: 'linux', label: 'Linux (AppImage)', file: 'Glassly.AppImage', url: DL('Glassly.AppImage') },
  { os: 'linux-deb', label: 'Ubuntu / Debian (.deb)', file: 'Glassly.deb', url: DL('Glassly.deb') },
  { os: 'mac', label: 'macOS', file: 'Glassly.dmg', url: DL('Glassly.dmg') },
];

const streaming = new Set(); // aynı anda kullanıcı başına tek yanıt
const title = (t) => { const s = String(t).replace(/\s+/g, ' ').trim(); return s.length > 48 ? s.slice(0, 46) + '…' : s || 'Yeni sohbet'; };

// OpenAI SSE akışından metin parçalarını çıkarır
async function* deltas(body) {
  const reader = body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (d === '[DONE]') return;
      try { const j = JSON.parse(d); const t = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content; if (t) yield t; } catch { /* parça */ }
    }
  }
}

async function webApi(request, p, ctx, { db, acc, S, env }) {
  if (p === '/api/config') {
    return json(200, { googleClientId: env.GLASSLY_GOOGLE_WEB_CLIENT_ID || '', registration: await acc.registrationOpen(), dailyMessages: acc.DAILY || null, downloads: DOWNLOADS, repo: `https://github.com/${REPO}` });
  }
  const me = await acc.userOf(request);
  if (!me) return fail(401, 'Oturumun sona ermiş. Tekrar giriş yap.', 'auth');

  if (p === '/api/chats' && request.method === 'GET') {
    return json(200, { chats: await db.all('SELECT id, title, updated FROM chats WHERE uid = ? ORDER BY updated DESC LIMIT 300', me.id) });
  }
  if (p === '/api/chats' && request.method === 'DELETE') {
    await db.batch([['DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE uid = ?)', me.id], ['DELETE FROM chats WHERE uid = ?', me.id]]);
    return json(200, { ok: true });
  }
  const m = p.match(/^\/api\/chats\/([\w-]{8,64})$/);
  if (m) {
    const c = await db.one('SELECT * FROM chats WHERE id = ? AND uid = ?', m[1], me.id);
    if (!c) return fail(404, 'Sohbet bulunamadı.');
    if (request.method === 'GET') {
      const messages = await db.all('SELECT role, content, t FROM messages WHERE chat_id = ? ORDER BY id', c.id);
      return json(200, { id: c.id, title: c.title, updated: c.updated, messages });
    }
    if (request.method === 'PATCH') {
      const b = await readJSON(request); const t = title(b.title || '');
      await db.run('UPDATE chats SET title = ? WHERE id = ?', t, c.id);
      return json(200, { ok: true, title: t });
    }
    if (request.method === 'DELETE') {
      await db.batch([['DELETE FROM messages WHERE chat_id = ?', c.id], ['DELETE FROM chats WHERE id = ?', c.id]]);
      return json(200, { ok: true });
    }
  }

  if (p === '/api/chat' && request.method === 'POST') {
    const b = await readJSON(request);
    const text = String(b.text || '').trim().slice(0, 32000);
    let chat = b.chatId ? await db.one('SELECT * FROM chats WHERE id = ? AND uid = ?', String(b.chatId), me.id) : null;
    if (b.chatId && !chat) return fail(404, 'Sohbet bulunamadı.');
    if (!b.regenerate && !text) return fail(400, 'Bir mesaj yaz.');
    if (b.regenerate && !chat) return fail(400, 'Yeniden yazılacak sohbet yok.');
    if (streaming.has(me.id)) return fail(429, 'Önceki yanıt hâlâ yazılıyor, bitmesini bekle.', 'busy');
    if (!acc.isAdmin(me) && limited(S, 'user:' + me.id)) return fail(429, 'Çok hızlı mesaj gönderiyorsun, bir dakika bekle.', 'rate_limit');
    const usage = await acc.consume(me);
    if (!usage) return fail(429, acc.limitMsg(), 'daily_limit');

    const now = Date.now();
    if (!chat) {
      chat = { id: crypto.randomUUID(), title: title(text), created: now, updated: now };
      await db.run('INSERT INTO chats (id, uid, title, created, updated) VALUES (?, ?, ?, ?, ?)', chat.id, me.id, chat.title, now, now);
    }
    let history = await db.all('SELECT id, role, content FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 41', chat.id);
    history.reverse();
    if (b.regenerate) {
      const last = history[history.length - 1];
      if (last?.role === 'assistant') { await db.run('DELETE FROM messages WHERE id = ?', last.id); history.pop(); }
      if (!history.length || history[history.length - 1].role !== 'user') { await acc.refund(me); return fail(400, 'Yeniden yazılacak mesaj yok.'); }
    } else {
      await db.run('INSERT INTO messages (chat_id, role, content, t) VALUES (?, ?, ?, ?)', chat.id, 'user', text, now);
      history.push({ role: 'user', content: text });
    }
    // Bağlam: son 40 mesaj, en fazla ~48 bin karakter
    const ctxMsgs = []; let size = 0;
    for (let i = history.length - 1; i >= 0 && ctxMsgs.length < 40; i--) {
      size += history[i].content.length; if (size > 48000 && ctxMsgs.length) break;
      ctxMsgs.unshift({ role: history[i].role, content: history[i].content });
    }

    const { readable, writable } = new TransformStream();
    const w = writable.getWriter(); const enc = new TextEncoder();
    const send = (o) => w.write(enc.encode(`data: ${JSON.stringify(o)}\n\n`)).catch(() => {});
    streaming.add(me.id);
    const work = (async () => {
      let out = '';
      try {
        await send({ type: 'chat', id: chat.id, title: chat.title });
        const r = await openUpstream(S, { model: 'auto', stream: true, messages: [{ role: 'system', content: SYSTEM(me, acc.TZ) }, ...ctxMsgs] }, request.signal);
        if (!r.body) throw new Error('boş yanıt');
        for await (const t of deltas(r.body)) { out += t; await send({ type: 'delta', text: t }); if (request.signal?.aborted) break; }
        if (!out.trim()) throw new Error('boş yanıt');
      } catch (e) {
        log('sohbet hatası', e.message);
        if (!out.trim()) { await acc.refund(me).catch(() => {}); await send({ type: 'error', message: request.signal?.aborted ? 'Durduruldu.' : 'Şu an yanıt veremiyorum, birazdan tekrar dene.' }); }
      } finally {
        streaming.delete(me.id);
        if (out.trim()) {
          await db.batch([
            ['INSERT INTO messages (chat_id, role, content, t) VALUES (?, ?, ?, ?)', chat.id, 'assistant', out, Date.now()],
            ['UPDATE chats SET updated = ? WHERE id = ?', Date.now(), chat.id],
          ]).catch((e) => log('kayıt hatası', e.message));
        }
        await send({ type: 'done', usage: await acc.usageOf(me).catch(() => usage) });
        await w.close().catch(() => {});
      }
    })();
    ctx.waitUntil(work);
    return new Response(readable, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no', ...CORS } });
  }
  return fail(404, 'Bulunamadı');
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  if (url.hostname.startsWith('www.')) { url.hostname = url.hostname.slice(4); return Response.redirect(url.toString(), 301); }
  const p = url.pathname.replace(/\/+$/, '') || '/';
  if (!env.DB) return fail(500, 'Veritabanı (DB) bağlı değil. wrangler.jsonc içindeki d1_databases ayarını kontrol et.');
  const db = openDB(env.DB);
  const S = setupPool(env);
  const acc = createAccounts(db, env);
  const ip = request.headers.get('cf-connecting-ip') || '';

  if (p === '/health') {
    await ensureDiscovery(S);
    const now = Date.now();
    return json(200, { ok: true, runtime: 'cloudflare', ready: S.slots.filter((s) => s.coolUntil <= now).length, total: S.slots.length });
  }
  if (/^\/(v1\/)?auth\//.test(p)) return acc.auth(request, p, ip, helpers);
  if (/^\/(v1\/)?admin\//.test(p)) { await ensureDiscovery(S); return acc.admin(request, p, helpers, S); }
  if (p.startsWith('/api/')) { await ensureDiscovery(S); return webApi(request, p, ctx, { db, acc, S, env }); }

  // ---- Masaüstü uygulamasının bağlandığı OpenAI uyumlu uç
  if (p === '/v1/models' || p === '/v1') {
    await ensureDiscovery(S);
    return json(200, { object: 'list', data: publicModels(S).map((id) => ({ id, object: 'model', owned_by: 'glassly' })) });
  }
  if (request.method === 'POST' && p === '/v1/chat/completions') {
    const me = await acc.userOf(request);
    if (!me && env.GLASSLY_OPEN_PROXY !== 'true') return fail(401, 'Glassly Bulut için giriş yapman gerekiyor.', 'auth');
    if (!acc.isAdmin(me) && limited(S, me ? 'user:' + me.id : 'ip:' + ip)) return fail(429, 'Çok hızlı istek gönderiyorsun, bir dakika bekle.', 'rate_limit');
    // Masaüstü uygulaması hakkı /auth/usage ile düşer; burada yalnızca hakkın bitip bitmediğine bakılır
    if (me) { const q = await acc.usageOf(me); if (!q.unlimited && q.left <= 0) return fail(429, acc.limitMsg(), 'daily_limit'); }
    await ensureDiscovery(S);
    let body;
    try { body = await readJSON(request); } catch (e) { return fail(e.status || 400, e.message); }
    try { return await openUpstream(S, body, request.signal); }
    catch (e) { return fail(e.status || 503, e.message, 'overloaded'); }
  }
  if (p.startsWith('/v1/')) return fail(404, 'Bulunamadı');
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try { return await handle(request, env, ctx); } catch (e) {
      log('hata', e.stack || e.message);
      return fail(e.status || 500, e.status ? e.message : 'Sunucu hatası');
    }
  },
};
