// Glassly hesapları: kayıt/giriş (e-posta + şifre ya da Google), oturumlar, günlük mesaj hakkı
// ve geliştirici paneli. Uç noktalar Glassly masaüstü uygulamasıyla birebir uyumludur.
// Şifreler PBKDF2-SHA256 ile tuzlanıp özetlenir; oturum belirteçlerinin yalnızca SHA-256 özeti saklanır.

const enc = new TextEncoder();
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const normEmail = (e) => String(e || '').trim().toLowerCase();
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 60);
const ITER = 100000; // Workers'ta PBKDF2 için üst sınır
let NEW_ITER = ITER; // yeni şifreler için (GLASSLY_PBKDF2_ITER ile düşürülebilir)

export async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16)), iter = NEW_ITER) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password).normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return `pbkdf2$${iter}$${b64(salt)}$${b64(bits)}`;
}
async function checkPassword(password, stored) {
  const [kind, iter, salt, want] = String(stored || '').split('$');
  if (kind !== 'pbkdf2' || !salt || !want) return false;
  const got = (await hashPassword(password || '', unb64(salt), Math.min(ITER, Number(iter) || ITER))).split('$')[3];
  if (got.length !== want.length) return false;
  let d = 0; for (let i = 0; i < got.length; i++) d |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return d === 0;
}

class Window {
  constructor(ms, max) { this.ms = ms; this.max = max; this.m = new Map(); }
  hit(k) {
    const now = Date.now(); const a = (this.m.get(k) || []).filter((t) => now - t < this.ms); a.push(now); this.m.set(k, a);
    if (this.m.size > 5000) for (const [key, v] of this.m) if (!v.some((t) => now - t < this.ms)) this.m.delete(key);
    return a.length > this.max;
  }
}

const authHits = new Window(60e3, 15);
let seeded = '';

export function createAccounts(db, env) {
  // GLASSLY_DEVELOPER (gizli değişken): "eposta|pbkdf2$...". Bu hesap geliştiricidir, silinemez, sınırsızdır.
  const [devEmail, devHash] = String(env.GLASSLY_DEVELOPER || '').split('|').map((s) => s.trim());
  // GLASSLY_ADMINS: virgülle ayrılmış e-postalar. Bu hesaplar yalnızca Google ile doğrulanmışsa geliştirici sayılır.
  const ADMINS = new Set(String(env.GLASSLY_ADMINS || '').split(',').map(normEmail).filter(Boolean));
  const isAdmin = (u) => !!u && ((devEmail && devHash && u.email === normEmail(devEmail)) || (ADMINS.has(u.email) && String(u.provider).includes('google')));
  const DAILY0 = Number(env.GLASSLY_DAILY_LIMIT ?? 70);
  let DAILY = DAILY0; let dailyAt = 0;
  async function loadDaily() {
    if (Date.now() - dailyAt < 30e3) return DAILY;
    const v = await db.setting('daily', null).catch(() => null);
    DAILY = v == null ? DAILY0 : Number(v); dailyAt = Date.now();
    return DAILY;
  }
  const TZ = env.GLASSLY_TIMEZONE || 'Europe/Istanbul';
  const SESSION_DAYS = Number(env.GLASSLY_SESSION_DAYS || 90);
  const GOOGLE_IDS = new Set(String(env.GLASSLY_GOOGLE_CLIENT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));
  NEW_ITER = Math.max(10000, Math.min(ITER, Number(env.GLASSLY_PBKDF2_ITER) || ITER));

  const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date());
  function resetAt() {
    const now = new Date();
    const local = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
    const mid = new Date(local); mid.setHours(24, 0, 0, 0);
    return now.getTime() + (mid - local);
  }
  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, provider: u.provider, created: u.created, role: isAdmin(u) ? 'gelistirici' : 'kullanici', hasPassword: !!u.hash });

  async function seed() {
    if (seeded === devHash || !devEmail || !devHash) return;
    const u = await db.one('SELECT * FROM users WHERE email = ?', normEmail(devEmail));
    if (!u) await db.run('INSERT INTO users (id, email, name, hash, provider, created, dev_seed) VALUES (?, ?, ?, ?, ?, ?, ?)', crypto.randomUUID(), normEmail(devEmail), 'Ahmet', devHash, 'sifre', Date.now(), devHash);
    else if (u.dev_seed !== devHash) await db.run('UPDATE users SET hash = ?, dev_seed = ?, provider = ? WHERE id = ?', devHash, devHash, u.provider === 'google' ? 'sifre+google' : u.provider, u.id);
    seeded = devHash;
  }

  async function newSession(u) {
    const token = 'gly_' + b64url(crypto.getRandomValues(new Uint8Array(32)));
    await db.run('INSERT INTO sessions (h, uid, exp) VALUES (?, ?, ?)', await sha(token), u.id, Date.now() + SESSION_DAYS * 864e5);
    return { token, user: publicUser(u) };
  }
  const bearer = (request) => (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  async function userOf(request) {
    const tok = bearer(request);
    if (!tok.startsWith('gly_')) return null;
    await seed();
    return db.one('SELECT u.* FROM sessions s JOIN users u ON u.id = s.uid WHERE s.h = ? AND s.exp > ?', await sha(tok), Date.now());
  }

  // ---- günlük mesaj hakkı
  async function usedToday(u) { return (await db.one('SELECT n FROM usage WHERE uid = ? AND day = ?', u.id, today()))?.n || 0; }
  async function usageOf(u, used) {
    used ??= await usedToday(u);
    await loadDaily();
    return isAdmin(u) || !DAILY ? { used, limit: null, left: null, unlimited: true, reset: resetAt() } : { used, limit: DAILY, left: Math.max(0, DAILY - used), unlimited: false, reset: resetAt() };
  }
  // Hak varsa bir mesaj düşer ve güncel durum döner; yoksa null
  async function consume(u) {
    const q = await usageOf(u);
    if (!q.unlimited && q.left <= 0) return null;
    await db.batch([
      ['INSERT INTO usage (uid, day, n) VALUES (?, ?, 1) ON CONFLICT(uid, day) DO UPDATE SET n = n + 1', u.id, today()],
      ['UPDATE users SET requests = requests + 1, last_seen = ? WHERE id = ?', Date.now(), u.id],
      ['DELETE FROM usage WHERE day < ?', new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10)],
      ["INSERT INTO daily (day, kind, n) VALUES (?, 'msg', 1) ON CONFLICT(day, kind) DO UPDATE SET n = n + 1", today()],
    ]);
    return usageOf(u, q.used + 1);
  }
  // Ek kotalar (görsel oluşturma vb.): hak varsa düşer ve true döner
  async function consumeExtra(u, kind, max) {
    const d = today();
    if (!isAdmin(u)) {
      const n = (await db.one('SELECT n FROM extra WHERE uid = ? AND day = ? AND kind = ?', u.id, d, kind))?.n || 0;
      if (n >= max) return false;
    }
    await db.batch([
      ['INSERT INTO extra (uid, day, kind, n) VALUES (?, ?, ?, 1) ON CONFLICT(uid, day, kind) DO UPDATE SET n = n + 1', u.id, d, kind],
      ['INSERT INTO daily (day, kind, n) VALUES (?, ?, 1) ON CONFLICT(day, kind) DO UPDATE SET n = n + 1', d, kind],
      ['DELETE FROM extra WHERE day < ?', new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10)],
    ]);
    return true;
  }
  async function refund(u) { await db.run('UPDATE usage SET n = MAX(0, n - 1) WHERE uid = ? AND day = ?', u.id, today()); }
  const limitMsg = () => DAILY <= 0 ? 'Mesaj hakkın doldu.' : `Bugünkü ${DAILY} mesaj hakkın doldu. Gece yarısı yenilenir.`;
  const registrationOpen = async () => (await db.setting('registration', String(env.GLASSLY_REGISTRATION ?? 'true') !== 'false')) !== false;

  async function deleteUser(id) {
    await db.batch([
      ['DELETE FROM api_keys WHERE uid = ?', id],
      ['DELETE FROM api_usage WHERE uid = ?', id],
      ['DELETE FROM images WHERE uid = ?', id],
      ['DELETE FROM reminders WHERE uid = ?', id],
      ['DELETE FROM extra WHERE uid = ?', id],
      ['DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE uid = ?)', id],
      ['DELETE FROM chats WHERE uid = ?', id],
      ['DELETE FROM usage WHERE uid = ?', id],
      ['DELETE FROM sessions WHERE uid = ?', id],
      ['DELETE FROM users WHERE id = ?', id],
    ]);
  }

  // ------------------------------------------------------------ /auth/...
  async function auth(request, p, ip, { json, fail, readJSON }) {
    const route = p.replace(/^\/(v1\/)?auth/, '');
    const b = request.method === 'GET' ? {} : await readJSON(request);
    await seed();
    if ((['/register', '/login', '/google', '/password'].includes(route) || route === '/exchange' || (route === '/me' && request.method === 'DELETE')) && authHits.hit(ip)) {
      return fail(429, 'Çok fazla deneme yaptın. Bir dakika bekleyip tekrar dene.', 'rate_limit');
    }
    if (request.method === 'POST' && route === '/register') {
      if (!(await registrationOpen())) return fail(403, 'Yeni kayıt şu an kapalı.', 'auth');
      const email = normEmail(b.email); const name = cleanName(b.name);
      if (!name) return fail(400, 'Adını yaz.');
      if (!EMAIL_RE.test(email)) return fail(400, 'Geçerli bir e-posta adresi yaz.');
      if (String(b.password || '').length < 8) return fail(400, 'Şifre en az 8 karakter olmalı.');
      if (String(b.password).length > 200) return fail(400, 'Şifre çok uzun.');
      if (await db.one('SELECT id FROM users WHERE email = ?', email)) return fail(409, 'Bu e-posta ile zaten bir hesap var. Giriş yapmayı dene.');
      const u = { id: crypto.randomUUID(), name, email, hash: await hashPassword(b.password), provider: 'sifre', created: Date.now() };
      await db.run('INSERT INTO users (id, email, name, hash, provider, created) VALUES (?, ?, ?, ?, ?, ?)', u.id, u.email, u.name, u.hash, u.provider, u.created);
      return json(200, await newSession(u));
    }
    if (request.method === 'POST' && route === '/login') {
      const u = await db.one('SELECT * FROM users WHERE email = ?', normEmail(b.email));
      if (u && !u.hash) return fail(401, 'Bu hesap Google ile açılmış. "Google ile devam et"e bas.', 'auth');
      if (!u || !(await checkPassword(b.password, u.hash))) return fail(401, 'E-posta veya şifre yanlış.', 'auth');
      return json(200, await newSession(u));
    }
    if (request.method === 'POST' && route === '/google') {
      let info;
      try {
        const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(b.id_token || b.credential || ''), { signal: AbortSignal.timeout(10000) });
        info = await r.json(); if (!r.ok) throw new Error('geçersiz');
      } catch { return fail(401, 'Google girişi doğrulanamadı. Tekrar dene.', 'auth'); }
      if (GOOGLE_IDS.size && !GOOGLE_IDS.has(info.aud)) return fail(401, 'Bu Google istemcisi bu sunucuda tanımlı değil.', 'auth');
      if (String(info.email_verified) !== 'true' || !info.email) return fail(401, 'Google hesabının e-postası doğrulanmamış.', 'auth');
      const email = normEmail(info.email);
      let u = await db.one('SELECT * FROM users WHERE email = ?', email);
      if (!u) {
        if (!(await registrationOpen())) return fail(403, 'Yeni kayıt şu an kapalı.', 'auth');
        u = { id: crypto.randomUUID(), name: cleanName(info.name) || email.split('@')[0], email, hash: '', provider: 'google', created: Date.now() };
        await db.run('INSERT INTO users (id, email, name, hash, provider, created) VALUES (?, ?, ?, ?, ?, ?)', u.id, u.email, u.name, '', 'google', u.created);
      } else if (!u.provider.includes('google')) {
        // Bu e-postanın gerçek sahibi Google ile doğrulandı. Hesap daha önce başkası tarafından şifreyle
        // açılmış olabileceği için o şifre ve açık oturumlar geçersiz kılınır (geliştirici hesabı hariç).
        if (u.dev_seed) u.provider = 'sifre+google';
        else { u.provider = 'google'; u.hash = ''; await db.run('DELETE FROM sessions WHERE uid = ?', u.id); }
        await db.run('UPDATE users SET provider = ?, hash = ? WHERE id = ?', u.provider, u.hash, u.id);
      }
      const s = await newSession(u);
      // Telefon uygulaması: belirteç doğrudan verilmez, tek kullanımlık kodla ve doğrulayıcıyla alınır
      if (b.challenge) {
        const ch = String(b.challenge).slice(0, 100);
        const code = b64url(crypto.getRandomValues(new Uint8Array(24)));
        await db.batch([['DELETE FROM codes WHERE exp < ?', Date.now()], ['INSERT INTO codes (c, token, ch, exp) VALUES (?, ?, ?, ?)', code, s.token, ch, Date.now() + 5 * 60e3]]);
        return json(200, { code });
      }
      return json(200, s);
    }
    if (request.method === 'POST' && route === '/exchange') {
      const row = await db.one('SELECT * FROM codes WHERE c = ? AND exp > ?', String(b.code || ''), Date.now());
      if (!row) return fail(401, 'Giriş kodunun süresi doldu. Tekrar dene.', 'auth');
      const ch = b64url(await crypto.subtle.digest('SHA-256', enc.encode(String(b.verifier || ''))));
      if (ch !== row.ch) return fail(401, 'Giriş doğrulanamadı.', 'auth');
      await db.run('DELETE FROM codes WHERE c = ?', row.c);
      const u = await db.one('SELECT u.* FROM sessions s JOIN users u ON u.id = s.uid WHERE s.h = ?', await sha(row.token));
      if (!u) return fail(401, 'Giriş doğrulanamadı.', 'auth');
      return json(200, { token: row.token, user: publicUser(u) });
    }
    const me = await userOf(request);
    if (!me) return fail(401, 'Oturumun sona ermiş. Tekrar giriş yap.', 'auth');
    if (request.method === 'GET' && route === '/usage') return json(200, await usageOf(me));
    if (request.method === 'POST' && route === '/usage') {
      const q = await consume(me);
      return q ? json(200, q) : fail(429, limitMsg(), 'daily_limit');
    }
    if (request.method === 'GET' && route === '/me') return json(200, { user: publicUser(me), usage: await usageOf(me) });
    if (request.method === 'PATCH' && route === '/me') {
      const name = cleanName(b.name); if (!name) return fail(400, 'Adını yaz.');
      await db.run('UPDATE users SET name = ? WHERE id = ?', name, me.id);
      return json(200, { user: publicUser({ ...me, name }) });
    }
    if (request.method === 'POST' && route === '/logout') {
      await db.run('DELETE FROM sessions WHERE h = ?', await sha(bearer(request)));
      return json(200, { ok: true });
    }
    if (request.method === 'POST' && route === '/password') {
      if (String(b.next || '').length < 8) return fail(400, 'Yeni şifre en az 8 karakter olmalı.');
      if (me.hash && !(await checkPassword(b.current, me.hash))) return fail(401, 'Mevcut şifre yanlış.', 'auth');
      const h = await hashPassword(b.next);
      await db.batch([
        ['UPDATE users SET hash = ?, provider = ? WHERE id = ?', h, me.provider === 'google' ? 'sifre+google' : me.provider, me.id],
        ['DELETE FROM sessions WHERE uid = ? AND h != ?', me.id, await sha(bearer(request))],
      ]);
      return json(200, { ok: true });
    }
    if (request.method === 'DELETE' && route === '/me') {
      if (isAdmin(me)) return fail(403, 'Geliştirici hesabı silinemez.', 'auth');
      if (me.hash && !(await checkPassword(b.password, me.hash))) return fail(401, 'Şifre yanlış.', 'auth');
      await deleteUser(me.id);
      return json(200, { ok: true });
    }
    return fail(404, 'Bulunamadı');
  }

  // ------------------------------------------------------------ /admin/... (yalnızca geliştirici)
  async function admin(request, p, { json, fail, readJSON }, pool) {
    const me = await userOf(request);
    if (!isAdmin(me)) return fail(403, 'Bu işlem için geliştirici hesabı gerekir.', 'auth');
    const route = p.replace(/^\/(v1\/)?admin/, '');
    if (request.method === 'GET' && route === '/users') {
      const now = Date.now();
      const rows = await db.all(`SELECT u.*, (SELECT COUNT(*) FROM sessions s WHERE s.uid = u.id AND s.exp > ?) AS sessions,
        (SELECT n FROM usage g WHERE g.uid = u.id AND g.day = ?) AS today, (SELECT COUNT(*) FROM chats c WHERE c.uid = u.id) AS chats
        FROM users u ORDER BY u.created DESC LIMIT 1000`, now, today());
      await loadDaily();
      return json(200, { users: rows.map((u) => ({ ...publicUser(u), sessions: u.sessions, requests: u.requests, lastSeen: u.last_seen, today: u.today || 0, chats: u.chats, limit: isAdmin(u) || !DAILY ? null : DAILY })) });
    }
    const m = route.match(/^\/users\/([\w-]+)$/);
    if (request.method === 'DELETE' && m) {
      const u = await db.one('SELECT * FROM users WHERE id = ?', m[1]);
      if (!u) return fail(404, 'Hesap bulunamadı.');
      if (isAdmin(u)) return fail(403, 'Geliştirici hesabı silinemez.');
      await deleteUser(u.id);
      return json(200, { ok: true });
    }
    if (request.method === 'GET' && route === '/stats') {
      const now = Date.now();
      const since = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date(now - 13 * 864e5));
      const [users, sessions, msgs, days, newUsers] = await Promise.all([
        db.one('SELECT COUNT(*) AS n FROM users'), db.one('SELECT COUNT(*) AS n FROM sessions WHERE exp > ?', now),
        db.one('SELECT COALESCE(SUM(n), 0) AS n FROM usage WHERE day = ?', today()),
        db.all('SELECT day, kind, n FROM daily WHERE day >= ? ORDER BY day', since),
        db.one('SELECT COUNT(*) AS n FROM users WHERE created > ?', now - 7 * 864e5),
      ]);
      await loadDaily();
      return json(200, {
        users: users.n, sessions: sessions.n, messagesToday: msgs.n, newUsers7: newUsers.n, days, registration: await registrationOpen(), dailyMessages: DAILY || null, dailyDefault: DAILY0,
        slots: pool.slots.length, ready: pool.slots.filter((s) => s.coolUntil <= now).length,
        cooling: pool.slots.filter((s) => s.coolUntil > now).slice(0, 30).map((s) => ({ id: `${s.upstream}/${s.model}`, until: s.coolUntil })),
        models: [...new Set(pool.slots.map((s) => `${s.upstream}/${s.model}`))],
      });
    }
    if (request.method === 'POST' && route === '/settings') {
      const b = await readJSON(request);
      if (typeof b.registration === 'boolean') await db.setSetting('registration', b.registration);
      if (b.daily !== undefined) {
        const n = Math.round(Number(b.daily));
        if (!(n >= 0 && n <= 100000)) return fail(400, 'Günlük sınır 0 ile 100000 arasında olmalı (0 = sınırsız).');
        await db.setSetting('daily', n); dailyAt = 0;
      }
      await loadDaily();
      return json(200, { ok: true, registration: await registrationOpen(), dailyMessages: DAILY || null });
    }
    return fail(404, 'Bulunamadı');
  }

  return { auth, admin, userOf, consume, consumeExtra, refund, usageOf, limitMsg, isAdmin, registrationOpen, today, TZ, loadDaily, get DAILY() { return DAILY; } };
}
