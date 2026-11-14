// Glassly hesapları: e-posta + şifre ile kayıt/giriş, oturumlar ve misafir mesaj hakkı.
// Şifreler PBKDF2-SHA256 ile tuzlanıp saklanır (Workers'ta scrypt yok), oturum belirteçlerinin sadece özeti tutulur.

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const DEVICE_RE = /^[A-Za-z0-9-]{16,64}$/;
const enc = new TextEncoder();

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const today = () => new Date().toISOString().slice(0, 10);
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, created: u.created });

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Bellekte kısa süreli deneme sayaçları (her Worker kopyasında ayrı; kaba kuvvete karşı ek katman)
class Window {
  constructor(ms, max) { this.ms = ms; this.max = max; this.m = new Map(); }
  recent(k) { const now = Date.now(); return (this.m.get(k) || []).filter((t) => now - t < this.ms); }
  hit(k) {
    const a = this.recent(k); a.push(Date.now()); this.m.set(k, a);
    if (this.m.size > 5000) for (const [key] of this.m) if (!this.recent(key).length) this.m.delete(key);
    return a.length;
  }
  over(k) { return this.recent(k).length >= this.max; }
  clear(k) { this.m.delete(k); }
}

export function createAuth(db, env) {
  // Hesapsız (misafir) toplam hak: varsayılan 1 mesaj, sonra kayıt/giriş gerekir.
  const GUEST_LIMIT = Number(env.GLASSLY_GUEST_LIMIT ?? 1);
  const GUEST_IP_DAILY = Number(env.GLASSLY_GUEST_IP_DAILY || 40);
  // Hesap açanların günlük mesaj kotası (gece UTC 00:00'da sıfırlanır). 0 = sınırsız.
  const DAILY_LIMIT = Number(env.GLASSLY_DAILY_LIMIT ?? 50);
  const SESSION_DAYS = Number(env.GLASSLY_SESSION_DAYS || 90);
  const ITER = Math.min(100000, Number(env.GLASSLY_PBKDF2_ITER || 100000)); // Workers üst sınırı 100000

  const loginFails = new Window(15 * 60e3, 8);
  const ipFails = new Window(15 * 60e3, 30);
  const registers = new Window(60 * 60e3, 5);

  async function hashPassword(password, salt = randomHex(16), iter = ITER) {
    const key = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: iter }, key, 512);
    return { salt, hash: hex(bits), iter };
  }
  async function checkPassword(password, user) {
    const { hash } = await hashPassword(password, user.salt, user.iter || ITER);
    return safeEqual(hash, user.hash);
  }

  async function newSession(user) {
    const token = 'gls_' + b64url(crypto.getRandomValues(new Uint8Array(32)));
    const h = await sha(token);
    const now = Date.now();
    await db.put('sessions', h, { email: user.email, created: now, seen: now, exp: now + SESSION_DAYS * 864e5 }, SESSION_DAYS * 86400);
    user.sessions = [...(user.sessions || []).slice(-19), h];
    await db.put('users', user.email, user);
    return token;
  }

  // Bearer belirtecinden kimlik: { kind: 'user', user } | { kind: 'guest', deviceId, guest } | null
  async function identify(token) {
    if (!token) return null;
    if (token.startsWith('gls_')) {
      const h = await sha(token);
      const s = await db.get('sessions', h);
      if (!s || s.exp < Date.now()) { if (s) await db.del('sessions', h); return null; }
      const user = await db.get('users', s.email);
      if (!user) { await db.del('sessions', h); return null; }
      if (Date.now() - s.seen > 864e5) {
        s.seen = Date.now(); s.exp = Date.now() + SESSION_DAYS * 864e5;
        await db.put('sessions', h, s, SESSION_DAYS * 86400);
      }
      return { kind: 'user', user, sessionHash: h };
    }
    if (token.startsWith('guest_')) {
      const deviceId = token.slice(6);
      if (!DEVICE_RE.test(deviceId)) return null;
      const guest = (await db.get('guests', deviceId)) || { used: 0, first: Date.now() };
      return { kind: 'guest', deviceId, guest };
    }
    return null;
  }

  const guestMayUseCloud = (id) => id?.kind === 'guest' && id.guest.used > 0 && id.guest.used <= GUEST_LIMIT;

  async function guestStatus(deviceId) {
    const g = (await db.get('guests', deviceId)) || { used: 0 };
    return { limit: GUEST_LIMIT, used: Math.min(g.used, GUEST_LIMIT), remaining: Math.max(0, GUEST_LIMIT - g.used) };
  }

  async function guestUse(deviceId, ip) {
    const g = (await db.get('guests', deviceId)) || { used: 0, first: Date.now() };
    if (g.used >= GUEST_LIMIT) return { ok: false, reason: 'limit', limit: GUEST_LIMIT, used: GUEST_LIMIT, remaining: 0 };
    const ipKey = `${ip}|${today()}`;
    const ipRec = (await db.get('guest_ip', ipKey)) || { n: 0 };
    if (GUEST_IP_DAILY && ipRec.n >= GUEST_IP_DAILY) return { ok: false, reason: 'ip', limit: GUEST_LIMIT, used: g.used, remaining: GUEST_LIMIT - g.used };
    g.used++; g.last = Date.now();
    ipRec.n++;
    await db.put('guests', deviceId, g);
    await db.put('guest_ip', ipKey, ipRec, 2 * 86400);
    return { ok: true, limit: GUEST_LIMIT, used: g.used, remaining: GUEST_LIMIT - g.used };
  }

  // Hesaplı kullanıcının günlük mesaj kotası (KV'de "daily:<userId>|<tarih>" olarak tutulur, 2 gün sonra kendi silinir)
  async function dailyStatus(userId) {
    const d = (await db.get('daily', `${userId}|${today()}`)) || { n: 0 };
    return { limit: DAILY_LIMIT, used: d.n, remaining: DAILY_LIMIT ? Math.max(0, DAILY_LIMIT - d.n) : null };
  }
  async function dailyUse(userId) {
    if (!DAILY_LIMIT) return { ok: true, limit: 0, used: 0, remaining: null };
    const key = `${userId}|${today()}`;
    const d = (await db.get('daily', key)) || { n: 0 };
    if (d.n >= DAILY_LIMIT) return { ok: false, limit: DAILY_LIMIT, used: d.n, remaining: 0 };
    d.n++;
    await db.put('daily', key, d, 2 * 86400);
    return { ok: true, limit: DAILY_LIMIT, used: d.n, remaining: DAILY_LIMIT - d.n };
  }

  // ------------------------------------------------------------ /auth/... uç noktaları
  // Yanıt (Response) döndürür; yol /auth/ ile başlamıyorsa null.
  async function handle(request, p, ip, { json, fail, readJSON }) {
    if (!p.startsWith('/auth/')) return null;
    const route = p.slice(6);
    const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');

    if (request.method === 'POST' && route === 'register') {
      const b = await readJSON(request);
      const name = String(b.name || '').trim().replace(/\s+/g, ' ');
      const email = String(b.email || '').trim().toLowerCase();
      const password = String(b.password || '');
      if (!name || name.length > 60) return fail(400, 'Adını yaz (en fazla 60 karakter).', 'invalid_name');
      if (!EMAIL_RE.test(email)) return fail(400, 'Geçerli bir e-posta adresi yaz.', 'invalid_email');
      if (password.length < 8) return fail(400, 'Şifre en az 8 karakter olmalı.', 'weak_password');
      if (password.length > 200) return fail(400, 'Şifre çok uzun.', 'weak_password');
      if (registers.over(ip)) return fail(429, 'Çok fazla kayıt denemesi. Biraz sonra tekrar dene.', 'rate_limit');
      if (await db.get('users', email)) return fail(409, 'Bu e-posta ile zaten bir hesap var. Giriş yapmayı dene.', 'email_taken');
      registers.hit(ip);
      const { salt, hash, iter } = await hashPassword(password);
      const user = { id: crypto.randomUUID(), email, name, salt, hash, iter, created: Date.now(), sessions: [] };
      const token = await newSession(user);
      return json(201, { token, user: publicUser(user) });
    }

    if (request.method === 'POST' && route === 'login') {
      const b = await readJSON(request);
      const email = String(b.email || '').trim().toLowerCase();
      const password = String(b.password || '');
      const k = `${ip}|${email}`;
      if (loginFails.over(k) || ipFails.over(ip)) return fail(429, 'Çok fazla hatalı deneme. 15 dakika sonra tekrar dene.', 'rate_limit');
      const user = email ? await db.get('users', email) : null;
      const ok = user ? await checkPassword(password, user) : (await hashPassword(password || 'x'), false);
      if (!ok) { loginFails.hit(k); ipFails.hit(ip); return fail(401, 'E-posta veya şifre hatalı.', 'bad_credentials'); }
      loginFails.clear(k);
      const token = await newSession(user);
      return json(200, { token, user: publicUser(user) });
    }

    if (route === 'guest' || route === 'guest/use') {
      const b = request.method === 'POST' ? await readJSON(request) : {};
      const deviceId = String(b.deviceId || '');
      if (!DEVICE_RE.test(deviceId)) return fail(400, 'Geçersiz cihaz kimliği.', 'invalid_device');
      if (route === 'guest') return json(200, await guestStatus(deviceId));
      if (request.method !== 'POST') return fail(405, 'POST kullan.');
      const r = await guestUse(deviceId, ip);
      return json(r.ok ? 200 : 402, r);
    }

    // Buradan sonrası oturum ister
    const id = await identify(bearer);
    if (!id || id.kind !== 'user') return fail(401, 'Oturum geçersiz. Yeniden giriş yap.', 'auth');
    const user = id.user;

    if (request.method === 'GET' && route === 'me') return json(200, { user: publicUser(user), daily: await dailyStatus(user.id) });

    if (request.method === 'POST' && route === 'logout') {
      await db.del('sessions', id.sessionHash);
      user.sessions = (user.sessions || []).filter((h) => h !== id.sessionHash);
      await db.put('users', user.email, user);
      return json(200, { ok: true });
    }

    if (request.method === 'POST' && route === 'update') {
      const b = await readJSON(request);
      const name = String(b.name || '').trim().replace(/\s+/g, ' ');
      if (!name || name.length > 60) return fail(400, 'Adını yaz (en fazla 60 karakter).', 'invalid_name');
      user.name = name;
      await db.put('users', user.email, user);
      return json(200, { user: publicUser(user) });
    }

    if (request.method === 'POST' && (route === 'password' || route === 'delete')) {
      const b = await readJSON(request);
      if (!(await checkPassword(String(b.password || ''), user))) return fail(401, 'Şifre hatalı.', 'bad_credentials');
      if (route === 'password') {
        const next = String(b.newPassword || '');
        if (next.length < 8 || next.length > 200) return fail(400, 'Yeni şifre en az 8 karakter olmalı.', 'weak_password');
        Object.assign(user, await hashPassword(next));
        for (const h of user.sessions || []) if (h !== id.sessionHash) await db.del('sessions', h);
        user.sessions = [id.sessionHash];
        await db.put('users', user.email, user);
        return json(200, { ok: true });
      }
      for (const h of user.sessions || []) await db.del('sessions', h);
      await db.del('users', user.email);
      return json(200, { ok: true });
    }

    return fail(404, 'Bulunamadı');
  }

  return { handle, identify, guestMayUseCloud, dailyUse, dailyStatus, GUEST_LIMIT, DAILY_LIMIT };
}
