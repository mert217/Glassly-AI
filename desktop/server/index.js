#!/usr/bin/env node
'use strict';
// Glassly Bulut: OpenAI uyumlu, sıfır bağımlılıklı model havuzu.
// Birden çok sağlayıcıyı ve anahtarı tek adreste toplar; limit dolan anahtar/modeli
// soğumaya alır ve isteği otomatik olarak sıradakine yönlendirir.

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_FILE = process.env.GLASSLY_CONFIG || path.join(__dirname, 'config.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const PORT = Number(process.env.PORT || cfg.port || 8787);
const ACCESS = new Set([...(cfg.accessKeys || []), ...(process.env.GLASSLY_ACCESS_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean)]);
const RPM = Number(cfg.rateLimitPerMinute ?? 30);
const MAX_TRIES = Number(cfg.maxTries ?? 12);

// ------------------------------------------------------------------ hesaplar
// accounts: true (varsayılan) ise modelleri yalnızca Glassly'de hesap açıp giriş yapanlar kullanır.
const ACCOUNTS = cfg.accounts !== false;
const USERS_FILE = process.env.GLASSLY_USERS || cfg.usersFile || path.join(__dirname, 'data', 'users.json');
const GOOGLE_IDS = new Set([...(cfg.googleClientIds || []), ...(process.env.GLASSLY_GOOGLE_CLIENT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)]);
const SESSION_DAYS = Number(cfg.sessionDays ?? 90);
let db = { users: [], sessions: {}, settings: {} };
try { db = { users: [], sessions: {}, settings: {}, ...JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) }; } catch { /* ilk çalıştırma */ }
// Geliştirici (yönetici) hesapları: config "admins" e-postaları + "developer" ile hazır gelen hesap
const DEV = cfg.developer?.email ? { email: String(cfg.developer.email).trim().toLowerCase(), name: cfg.developer.name || 'Geliştirici', hash: cfg.developer.passwordHash || '' } : null;
const ADMINS = new Set([...(cfg.admins || []), ...(DEV ? [DEV.email] : [])].map((e) => String(e).trim().toLowerCase()));
const isAdmin = (u) => !!u && ADMINS.has(u.email);
// Günlük mesaj sınırı (geliştiriciler hariç). config "dailyMessages": 0 → sınırsız
const DAILY = cfg.dailyMessages ?? 70;
const TZ = cfg.timezone || 'Europe/Istanbul';
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
const usedToday = (u) => (u.usage && u.usage.day === today() ? u.usage.n : 0);
function resetAt() {
  // TZ'deki bir sonraki gece yarısı
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
  const mid = new Date(local); mid.setHours(24, 0, 0, 0);
  return now.getTime() + (mid - local);
}
const usageOf = (u) => {
  const used = usedToday(u);
  return isAdmin(u) || !DAILY ? { used, limit: null, left: null, unlimited: true, reset: resetAt() } : { used, limit: DAILY, left: Math.max(0, DAILY - used), unlimited: false, reset: resetAt() };
};
const registrationOpen = () => (db.settings.registration ?? cfg.registration) !== false;
let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
    fs.writeFileSync(USERS_FILE + '.tmp', JSON.stringify(db, null, 2), { mode: 0o600 });
    fs.renameSync(USERS_FILE + '.tmp', USERS_FILE);
  }, 100);
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const normEmail = (e) => String(e || '').trim().toLowerCase();
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 60);
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const scrypt = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? no(e) : ok(k))));
async function hashPw(pw) { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString('base64')}$${(await scrypt(pw, salt)).toString('base64')}`; }
async function checkPw(pw, stored) {
  const [k, s, h] = String(stored || '').split('$');
  if (k !== 'scrypt' || !s || !h) return false;
  const want = Buffer.from(h, 'base64'); const got = await scrypt(String(pw || ''), Buffer.from(s, 'base64'));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, provider: u.provider, created: u.created, role: isAdmin(u) ? 'gelistirici' : 'kullanici' });
if (DEV?.hash) {
  const u = db.users.find((x) => x.email === DEV.email);
  if (!u) db.users.push({ id: crypto.randomUUID(), name: DEV.name, email: DEV.email, hash: DEV.hash, provider: 'sifre', created: Date.now(), devSeed: DEV.hash });
  else if (u.devSeed !== DEV.hash) { u.hash = DEV.hash; u.devSeed = DEV.hash; if (u.provider === 'google') u.provider = 'sifre+google'; }
  saveDb();
}
function newSession(u) {
  const token = 'gly_' + crypto.randomBytes(32).toString('base64url');
  db.sessions[sha(token)] = { uid: u.id, exp: Date.now() + SESSION_DAYS * 86400e3 };
  saveDb();
  return { token, user: publicUser(u) };
}
function userOf(req) {
  const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tok.startsWith('gly_')) return null;
  const s = db.sessions[sha(tok)];
  if (!s || s.exp < Date.now()) return null;
  return db.users.find((u) => u.id === s.uid) || null;
}
const authHits = new Map();
function authLimited(ip) {
  const now = Date.now();
  const a = (authHits.get(ip) || []).filter((t) => now - t < 60e3);
  a.push(now); authHits.set(ip, a);
  return a.length > 15;
}
setInterval(() => {
  const now = Date.now(); let dirty = false;
  for (const [k, s] of Object.entries(db.sessions)) if (s.exp < now) { delete db.sessions[k]; dirty = true; }
  for (const [ip, a] of authHits) if (!a.some((t) => now - t < 60e3)) authHits.delete(ip);
  if (dirty) saveDb();
}, 10 * 60e3).unref();

async function auth(req, res, p, ip) {
  const route = p.replace(/^\/(v1\/)?auth/, '');
  let b = {};
  if (req.method !== 'GET') { try { b = JSON.parse((await readBody(req, 64 * 1024)).toString() || '{}'); } catch { return fail(res, 400, 'Geçersiz JSON'); } }
  const me = userOf(req);
  if ((['/register', '/login', '/google', '/password'].includes(route) || (route === '/me' && req.method === 'DELETE')) && authLimited(ip)) return fail(res, 429, 'Çok fazla deneme yaptın. Bir dakika bekleyip tekrar dene.', 'rate_limit');
  if (req.method === 'POST' && route === '/register') {
    if (!registrationOpen()) return fail(res, 403, 'Yeni kayıt şu an kapalı.', 'auth');
    const email = normEmail(b.email); const name = cleanName(b.name);
    if (!name) return fail(res, 400, 'Adını yaz.');
    if (!EMAIL_RE.test(email)) return fail(res, 400, 'Geçerli bir e-posta adresi yaz.');
    if (String(b.password || '').length < 8) return fail(res, 400, 'Şifre en az 8 karakter olmalı.');
    if (db.users.some((u) => u.email === email)) return fail(res, 409, 'Bu e-posta ile zaten bir hesap var. Giriş yapmayı dene.');
    const u = { id: crypto.randomUUID(), name, email, hash: await hashPw(b.password), provider: 'sifre', created: Date.now() };
    db.users.push(u); log(`yeni hesap: ${email}`);
    return json(res, 200, newSession(u));
  }
  if (req.method === 'POST' && route === '/login') {
    const u = db.users.find((x) => x.email === normEmail(b.email));
    if (u && !u.hash) return fail(res, 401, 'Bu hesap Google ile açılmış. "Google ile devam et"e bas.', 'auth');
    if (!u || !(await checkPw(b.password, u.hash))) return fail(res, 401, 'E-posta veya şifre yanlış.', 'auth');
    return json(res, 200, newSession(u));
  }
  if (req.method === 'POST' && route === '/google') {
    let info;
    try {
      const r = await fetch((process.env.GLASSLY_GOOGLE_TOKENINFO || 'https://oauth2.googleapis.com/tokeninfo') + '?id_token=' + encodeURIComponent(b.id_token || ''), { signal: AbortSignal.timeout(10000) });
      info = await r.json(); if (!r.ok) throw new Error(info.error_description || 'geçersiz');
    } catch { return fail(res, 401, 'Google girişi doğrulanamadı. Tekrar dene.', 'auth'); }
    if (GOOGLE_IDS.size && !GOOGLE_IDS.has(info.aud)) return fail(res, 401, 'Bu Google istemcisi bu sunucuda tanımlı değil.', 'auth');
    if (String(info.email_verified) !== 'true' || !info.email) return fail(res, 401, 'Google hesabının e-postası doğrulanmamış.', 'auth');
    const email = normEmail(info.email);
    let u = db.users.find((x) => x.email === email);
    if (!u) { u = { id: crypto.randomUUID(), name: cleanName(info.name) || email.split('@')[0], email, hash: '', provider: 'google', created: Date.now() }; db.users.push(u); log(`yeni hesap (Google): ${email}`); }
    else if (!u.provider.includes('google')) u.provider = u.hash ? 'sifre+google' : 'google';
    return json(res, 200, newSession(u));
  }
  if (!me) return fail(res, 401, 'Oturumun sona ermiş. Tekrar giriş yap.', 'auth');
  if (req.method === 'GET' && route === '/usage') return json(res, 200, usageOf(me));
  if (req.method === 'POST' && route === '/usage') {
    const q = usageOf(me);
    if (!q.unlimited && q.left <= 0) return fail(res, 429, `Bugünkü ${DAILY} mesaj hakkın doldu. Gece yarısı yenilenir.`, 'daily_limit');
    me.usage = { day: today(), n: q.used + 1 };
    saveDb();
    return json(res, 200, usageOf(me));
  }
  if (req.method === 'GET' && route === '/me') return json(res, 200, { user: publicUser(me) });
  if (req.method === 'PATCH' && route === '/me') {
    const name = cleanName(b.name); if (!name) return fail(res, 400, 'Adını yaz.');
    me.name = name; saveDb(); return json(res, 200, { user: publicUser(me) });
  }
  if (req.method === 'POST' && route === '/logout') {
    delete db.sessions[sha((req.headers.authorization || '').replace(/^Bearer\s+/i, ''))]; saveDb();
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && route === '/password') {
    if (String(b.next || '').length < 8) return fail(res, 400, 'Yeni şifre en az 8 karakter olmalı.');
    if (me.hash && !(await checkPw(b.current, me.hash))) return fail(res, 401, 'Mevcut şifre yanlış.', 'auth');
    me.hash = await hashPw(b.next); if (me.provider === 'google') me.provider = 'sifre+google';
    saveDb(); return json(res, 200, { ok: true });
  }
  if (req.method === 'DELETE' && route === '/me') {
    if (isAdmin(me)) return fail(res, 403, 'Geliştirici hesabı silinemez.', 'auth');
    if (me.hash && !(await checkPw(b.password, me.hash))) return fail(res, 401, 'Şifre yanlış.', 'auth');
    db.users = db.users.filter((u) => u.id !== me.id); dropChats(me.id);
    for (const [k, s] of Object.entries(db.sessions)) if (s.uid === me.id) delete db.sessions[k];
    saveDb(); log(`hesap silindi: ${me.email}`);
    return json(res, 200, { ok: true });
  }
  return fail(res, 404, 'Bulunamadı');
}

// Geliştirici paneli: hesapları gör, sil, kaydı aç/kapat, sunucu durumu
async function admin(req, res, p) {
  const me = userOf(req);
  if (!isAdmin(me)) return fail(res, 403, 'Bu işlem için geliştirici hesabı gerekir.', 'auth');
  const route = p.replace(/^\/(v1\/)?admin/, '');
  if (req.method === 'GET' && route === '/users') {
    const active = {};
    for (const s of Object.values(db.sessions)) if (s.exp > Date.now()) active[s.uid] = (active[s.uid] || 0) + 1;
    return json(res, 200, { users: db.users.map((u) => ({ ...publicUser(u), sessions: active[u.id] || 0, requests: u.requests || 0, today: usedToday(u), limit: usageOf(u).limit, lastSeen: u.lastSeen || 0 })) });
  }
  const m = route.match(/^\/users\/([\w-]+)$/);
  if (req.method === 'DELETE' && m) {
    const u = db.users.find((x) => x.id === m[1]);
    if (!u) return fail(res, 404, 'Hesap bulunamadı.');
    if (isAdmin(u)) return fail(res, 403, 'Geliştirici hesabı silinemez.');
    db.users = db.users.filter((x) => x.id !== u.id); dropChats(u.id);
    for (const [k, s] of Object.entries(db.sessions)) if (s.uid === u.id) delete db.sessions[k];
    saveDb(); log(`hesap silindi (geliştirici): ${u.email}`);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && route === '/stats') {
    const now = Date.now();
    return json(res, 200, {
      users: db.users.length, sessions: Object.values(db.sessions).filter((s) => s.exp > now).length,
      registration: registrationOpen(), dailyMessages: DAILY || null, slots: slots.length, ready: slots.filter((s) => s.coolUntil <= now).length,
      cooling: slots.filter((s) => s.coolUntil > now).map((s) => ({ id: `${s.upstream}/${s.model}`, until: s.coolUntil })),
      models: publicModels(),
    });
  }
  if (req.method === 'POST' && route === '/settings') {
    let b = {};
    try { b = JSON.parse((await readBody(req, 16 * 1024)).toString() || '{}'); } catch { return fail(res, 400, 'Geçersiz JSON'); }
    if (typeof b.registration === 'boolean') db.settings.registration = b.registration;
    saveDb();
    return json(res, 200, { ok: true, registration: registrationOpen() });
  }
  return fail(res, 404, 'Bulunamadı');
}

// Her (sağlayıcı, anahtar, model) üçlüsü bir "yuva"dır.
const slots = [];
for (const u of cfg.upstreams || []) {
  const keys = (u.keys || []).map((k) => (k.startsWith('$') ? process.env[k.slice(1)] : k)).filter(Boolean);
  for (const model of u.models || []) {
    for (const [ki, key] of keys.entries()) {
      slots.push({ id: `${u.name}/${model}#${ki}`, upstream: u.name, baseURL: u.baseURL.replace(/\/$/, ''), key, model, headers: u.headers || {}, coolUntil: 0, fails: 0 });
    }
  }
}
if (!slots.length) console.warn('Uyarı: config.json içinde kullanılabilir anahtar yok.');

const publicModels = () => ['auto', ...new Set(slots.map((s) => `${s.upstream}/${s.model}`))];
let cursor = 0;

function candidates(requested) {
  const now = Date.now();
  const ready = (s) => s.coolUntil <= now;
  const rr = (list) => { const n = list.length; if (!n) return []; const start = cursor++ % n; return [...list.slice(start), ...list.slice(0, start)]; };
  if (requested && requested !== 'auto') {
    const exact = slots.filter((s) => `${s.upstream}/${s.model}` === requested && ready(s));
    const rest = cfg.fallback === false ? [] : slots.filter((s) => `${s.upstream}/${s.model}` !== requested && ready(s));
    return [...rr(exact), ...rr(rest)];
  }
  return rr(slots.filter(ready));
}

function coolDown(slot, status, retryAfter) {
  slot.fails++;
  let ms = status === 429 ? 60e3 : status === 402 || status === 403 || status === 401 ? 30 * 60e3 : 20e3;
  const ra = Number(retryAfter);
  if (ra > 0) ms = Math.min(ra * 1000, 6 * 3600e3);
  slot.coolUntil = Date.now() + ms * Math.min(slot.fails, 4);
  log(`soğumada: ${slot.id} (${status}) ${Math.round((slot.coolUntil - Date.now()) / 1000)} sn`);
}

// IP başına basit dakika sınırı (anahtarlarını kötüye kullanıma karşı korur)
const hits = new Map();
function limited(ip) {
  if (!RPM) return false;
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60e3);
  arr.push(now); hits.set(ip, arr);
  return arr.length > RPM;
}
setInterval(() => { const now = Date.now(); for (const [ip, a] of hits) if (!a.some((t) => now - t < 60e3)) hits.delete(ip); }, 60e3).unref();

const log = (...a) => console.log(new Date().toISOString(), ...a);
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const fail = (res, status, message, type = 'glassly_error') => json(res, status, { error: { message, type } });

function readBody(req, max = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Havuzdan çalışan ilk yuvayı bulur; limit/hata alanı soğumaya alıp sıradakine geçer
async function pickUpstream(body, route, signal) {
  const list = candidates(body.model);
  if (!list.length) { const e = new Error('Tüm modeller şu an soğumada, biraz sonra tekrar dene.'); e.status = 503; throw e; }
  let lastErr = '';
  for (const slot of list.slice(0, MAX_TRIES)) {
    let r;
    try {
      r = await fetch(`${slot.baseURL}${route}`, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${slot.key}`, ...slot.headers },
        body: JSON.stringify({ ...body, model: slot.model }),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e.message; coolDown(slot, 0); continue;
    }
    if ([401, 402, 403, 408, 409, 429].includes(r.status) || r.status >= 500) {
      lastErr = `${slot.upstream}: HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`;
      coolDown(slot, r.status, r.headers.get('retry-after'));
      continue;
    }
    slot.fails = 0;
    log(`→ ${slot.id} ${r.status}`);
    return { r, slot };
  }
  const e = new Error('Şu an uygun model yok, birazdan tekrar dene. Son hata: ' + lastErr); e.status = 503; throw e;
}

async function proxy(req, res, route) {
  let body;
  try { body = JSON.parse((await readBody(req)).toString() || '{}'); } catch { return fail(res, 400, 'Geçersiz JSON'); }
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });
  let r, slot;
  try { ({ r, slot } = await pickUpstream(body, route, abort.signal)); }
  catch (e) { if (abort.signal.aborted) return; return fail(res, e.status || 503, e.message, 'overloaded'); }
  const headers = { 'content-type': r.headers.get('content-type') || 'application/json', 'x-glassly-upstream': `${slot.upstream}/${slot.model}` };
  if (body.stream) Object.assign(headers, { 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.writeHead(r.status, headers);
  if (!r.body) return res.end();
  try { for await (const chunk of r.body) res.write(chunk); } catch { /* istemci koptu */ }
  res.end();
}

// ------------------------------------------------------------------ web sürümü
// Tarayıcıdaki Glassly: sohbetler sunucuda hesaba özel tutulur, günlük sınır burada uygulanır.
const DATA_DIR = path.dirname(USERS_FILE);
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const chatFile = (uid) => path.join(CHATS_DIR, uid.replace(/[^\w-]/g, '') + '.json');
function loadChats(uid) { try { return JSON.parse(fs.readFileSync(chatFile(uid), 'utf8')); } catch { return { chats: [] }; } }
function saveChats(uid, d) {
  fs.mkdirSync(CHATS_DIR, { recursive: true });
  fs.writeFileSync(chatFile(uid) + '.tmp', JSON.stringify(d), { mode: 0o600 });
  fs.renameSync(chatFile(uid) + '.tmp', chatFile(uid));
}
function dropChats(uid) { try { fs.unlinkSync(chatFile(uid)); } catch { /* yok */ } }
const SYSTEM = (u) => [
  'Sen Glassly\'sin: kullanıcının günlük işlerine, yazılarına, sorularına ve kodlarına yardım eden, sıcak ve net konuşan bir yapay zeka asistanı.',
  'Kim olduğun sorulursa yalnızca "Ben Glassly\'yim" de. Arka planda hangi modelin, şirketin ya da sağlayıcının çalıştığından asla bahsetme; yanıtların arasında bir değişiklik olduysa bunu söyleme.',
  'Kullanıcı hangi dilde yazıyorsa o dilde cevap ver; varsayılan dil Türkçe. Gereksiz uzatma, gerektiğinde başlık, liste, tablo ve kod bloğu kullan (Markdown).',
  'Bu web sürümünde dosya sistemine, terminale, e-postaya ya da internete erişimin yok; bunlar gerekirse kullanıcıya Glassly masaüstü uygulamasını önerebilirsin.',
  `Kullanıcının adı: ${u.name}. Bugünün tarihi: ${new Date().toLocaleDateString('tr-TR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.`,
].join('\n');
const streaming = new Set();
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

async function webApi(req, res, p, ip) {
  const me = userOf(req);
  if (p === '/api/config') {
    return json(res, 200, { googleClientId: cfg.googleWebClientId || '', registration: registrationOpen(), dailyMessages: DAILY || null, downloads: listDownloads() });
  }
  if (!me) return fail(res, 401, 'Oturumun sona ermiş. Tekrar giriş yap.', 'auth');
  const store = () => loadChats(me.id);
  if (req.method === 'GET' && p === '/api/chats') {
    return json(res, 200, { chats: store().chats.map((c) => ({ id: c.id, title: c.title, updated: c.updated })).sort((a, b) => b.updated - a.updated) });
  }
  const m = p.match(/^\/api\/chats\/([\w-]+)$/);
  if (m) {
    const d = store(); const c = d.chats.find((x) => x.id === m[1]);
    if (!c) return fail(res, 404, 'Sohbet bulunamadı.');
    if (req.method === 'GET') return json(res, 200, c);
    if (req.method === 'DELETE') { d.chats = d.chats.filter((x) => x !== c); saveChats(me.id, d); return json(res, 200, { ok: true }); }
    if (req.method === 'PATCH') {
      let b = {}; try { b = JSON.parse((await readBody(req, 8192)).toString() || '{}'); } catch { return fail(res, 400, 'Geçersiz JSON'); }
      if (b.title) c.title = String(b.title).trim().slice(0, 80) || c.title;
      saveChats(me.id, d); return json(res, 200, { ok: true });
    }
  }
  if (req.method === 'DELETE' && p === '/api/chats') { saveChats(me.id, { chats: [] }); return json(res, 200, { ok: true }); }
  if (req.method === 'POST' && p === '/api/chat') {
    let b = {}; try { b = JSON.parse((await readBody(req, 256 * 1024)).toString() || '{}'); } catch { return fail(res, 400, 'Geçersiz JSON'); }
    const text = String(b.text || '').trim().slice(0, 60000);
    if (!text) return fail(res, 400, 'Mesaj boş.');
    if (streaming.has(me.id)) return fail(res, 409, 'Önceki yanıt hâlâ yazılıyor.');
    if (!isAdmin(me) && limited('u:' + me.id)) return fail(res, 429, 'Çok hızlı istek gönderiyorsun, bir dakika bekle.', 'rate_limit');
    const q = usageOf(me);
    if (!q.unlimited && q.left <= 0) return fail(res, 429, `Bugünkü ${DAILY} mesaj hakkın doldu. Gece yarısı yenilenir.`, 'daily_limit');
    const d = store();
    let c = b.chatId && d.chats.find((x) => x.id === b.chatId);
    if (!c) { c = { id: crypto.randomUUID(), title: text.replace(/\s+/g, ' ').slice(0, 48) + (text.length > 48 ? '…' : ''), created: Date.now(), updated: Date.now(), messages: [] }; d.chats.push(c); }
    if (b.regenerate && c.messages.at(-1)?.role === 'assistant') c.messages.pop();
    if (!b.regenerate || c.messages.at(-1)?.role !== 'user') c.messages.push({ role: 'user', content: text, t: Date.now() });
    // Bağlam: son mesajlar (yaklaşık 48 bin karakter)
    const ctx = []; let size = 0;
    for (const msg of [...c.messages].reverse()) { size += msg.content.length; if (size > 48000 && ctx.length) break; ctx.unshift({ role: msg.role, content: msg.content }); if (ctx.length >= 40) break; }
    me.usage = { day: today(), n: q.used + 1 }; me.requests = (me.requests || 0) + 1; me.lastSeen = Date.now(); saveDb();
    streaming.add(me.id);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    sse(res, { type: 'chat', id: c.id, title: c.title });
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    let out = ''; let ok = false;
    // İlk parça gelmeden düşen bir yuva olursa sessizce sıradakine geçilir
    for (let attempt = 0; attempt < 4 && !ok && !abort.signal.aborted; attempt++) {
      let r;
      try { ({ r } = await pickUpstream({ model: 'auto', stream: true, messages: [{ role: 'system', content: SYSTEM(me) }, ...ctx] }, '/chat/completions', abort.signal)); }
      catch (e) { if (!abort.signal.aborted) sse(res, { type: 'error', message: e.message.startsWith('Tüm') ? e.message : 'Glassly şu an çok yoğun. Birazdan tekrar dene.' }); break; }
      let buf = ''; let got = false;
      try {
        const dec = new TextDecoder();
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            let j; try { j = JSON.parse(data); } catch { continue; }
            const t = j.choices?.[0]?.delta?.content;
            if (t) { got = true; out += t; sse(res, { type: 'delta', text: t }); }
          }
        }
        ok = got || !!out;
      } catch (e) {
        if (abort.signal.aborted) break;
        if (out) { ok = true; break; } // yarım kaldıysa olanı sakla
      }
    }
    streaming.delete(me.id);
    if (out) { c.messages.push({ role: 'assistant', content: out, t: Date.now() }); }
    else if (!ok) { me.usage = { day: today(), n: Math.max(0, usedToday(me) - 1) }; saveDb(); } // yanıt gelmediyse hak geri verilir
    c.updated = Date.now();
    saveChats(me.id, d);
    if (!res.writableEnded) { if (!ok && !abort.signal.aborted && !out) sse(res, { type: 'error', message: 'Glassly şu an çok yoğun. Birazdan tekrar dene.' }); sse(res, { type: 'done', usage: usageOf(me) }); res.end(); }
    return;
  }
  return fail(res, 404, 'Bulunamadı');
}

// ------------------------------------------------------------------ site ve indirmeler
const SITE_DIR = path.join(__dirname, 'site');
const WEB_DIR = path.join(__dirname, 'web');
const DL_DIR = process.env.GLASSLY_DOWNLOADS || cfg.downloadsDir || path.join(DATA_DIR, 'indir');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
function listDownloads() {
  let files = [];
  try { files = fs.readdirSync(DL_DIR).filter((f) => !f.startsWith('.') && fs.statSync(path.join(DL_DIR, f)).isFile()); } catch { return []; }
  const kind = (f) => (/\.exe$/i.test(f) ? 'windows' : /\.AppImage$/i.test(f) ? 'linux-appimage' : /\.deb$/i.test(f) ? 'linux-deb' : /\.dmg$/i.test(f) ? 'mac' : /win.*\.zip$/i.test(f) ? 'windows-zip' : /mac.*\.zip$/i.test(f) ? 'mac-zip' : 'other');
  return files.filter((f) => !/\.(blockmap|yml|yaml)$/i.test(f)).map((f) => { const st = fs.statSync(path.join(DL_DIR, f)); return { file: f, kind: kind(f), size: st.size, date: st.mtimeMs, url: '/indir/' + encodeURIComponent(f) }; });
}
function serveFile(req, res, file, extra = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    const ext = path.extname(file).toLowerCase();
    const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'content-length': st.size, 'x-content-type-options': 'nosniff', ...extra };
    if (ext === '.html') Object.assign(headers, { 'cache-control': 'no-cache', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'DENY' });
    else if (!extra['cache-control']) headers['cache-control'] = 'public, max-age=3600';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}
function notFound(res) {
  const f = path.join(SITE_DIR, '404.html');
  if (fs.existsSync(f)) { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); return fs.createReadStream(f).pipe(res); }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Bulunamadı');
}
function safeJoin(root, rel) {
  const f = path.normalize(path.join(root, decodeURIComponent(rel)));
  return f.startsWith(root + path.sep) || f === root ? f : null;
}
function staticRoute(req, res, p) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (p.startsWith('/indir/')) {
    const f = safeJoin(DL_DIR, p.slice(7));
    if (!f) return notFound(res), true;
    serveFile(req, res, f, { 'content-disposition': `attachment; filename="${path.basename(f).replace(/"/g, '')}"`, 'cache-control': 'no-cache' });
    return true;
  }
  if (p === '/app' || p.startsWith('/app/')) {
    const rel = p.slice(4) || '/index.html';
    const f = safeJoin(WEB_DIR, rel === '/' ? 'index.html' : rel);
    if (f && fs.existsSync(f) && fs.statSync(f).isFile()) serveFile(req, res, f);
    else serveFile(req, res, path.join(WEB_DIR, 'index.html'));
    return true;
  }
  const f = safeJoin(SITE_DIR, p === '' || p === '/' ? 'index.html' : p);
  if (f && fs.existsSync(f) && fs.statSync(f).isFile()) { serveFile(req, res, f); return true; }
  return false;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '');
  if (p === '/health') {
    const now = Date.now();
    return json(res, 200, { ok: true, models: publicModels().length, ready: slots.filter((s) => s.coolUntil <= now).length, total: slots.length });
  }
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (/^\/(v1\/)?admin\//.test(p)) return admin(req, res, p).catch((e) => { log('yönetim hatası', e.message); fail(res, 500, 'Sunucu hatası'); });
  if (p.startsWith('/api/')) return webApi(req, res, p, ip).catch((e) => { log('web hatası', e.message); streaming.clear(); if (!res.headersSent) fail(res, 500, 'Sunucu hatası'); else res.end(); });
  if (/^\/(v1\/)?auth\//.test(p)) return auth(req, res, p, ip).catch((e) => { log('auth hatası', e.message); fail(res, 500, 'Sunucu hatası'); });
  if (!/^\/(v1|models|chat)/.test(p)) {
    if (staticRoute(req, res, p)) return;
    if (req.method === 'GET' || req.method === 'HEAD') return notFound(res);
  }
  const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = userOf(req);
  if ((ACCESS.size || ACCOUNTS) && !ACCESS.has(tok) && !user) {
    return fail(res, 401, ACCOUNTS ? 'Glassly hesabınla giriş yap.' : 'Geçersiz erişim anahtarı', 'auth');
  }
  if (p === '/v1/models' || p === '/models') {
    return json(res, 200, { object: 'list', data: publicModels().map((id) => ({ id, object: 'model', owned_by: 'glassly' })) });
  }
  if (req.method === 'POST' && /\/(v1\/)?chat\/completions$/.test(p)) {
    if (user) { user.requests = (user.requests || 0) + 1; user.lastSeen = Date.now(); saveDb(); }
    if (!isAdmin(user) && limited(user ? 'u:' + user.id : ip)) return fail(res, 429, 'Çok hızlı istek gönderiyorsun, bir dakika bekle.', 'rate_limit');
    return proxy(req, res, '/chat/completions');
  }
  fail(res, 404, 'Bulunamadı');
}).listen(PORT, () => log(`Glassly Bulut ${PORT} portunda · ${slots.length} yuva · hesaplar: ${ACCOUNTS ? `açık (${db.users.length} kullanıcı)` : 'kapalı'} · modeller: ${publicModels().join(', ')}`));
