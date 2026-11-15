'use strict';
// Glassly hesapları: kaydol, giriş yap, Google ile devam et.
// Glassly Bulut ayarlıysa hesaplar sunucuda tutulur (her bilgisayardan aynı hesap);
// ayarlı değilse bu bilgisayarda, şifreler scrypt ile özetlenmiş olarak saklanır.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const normEmail = (e) => String(e || '').trim().toLocaleLowerCase('en');
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 60);

function scrypt(password, salt) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? reject(e) : resolve(k))));
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scrypt(password, salt)).toString('base64')}`;
}
async function checkPassword(password, stored) {
  const [kind, s, h] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !s || !h) return false;
  const want = Buffer.from(h, 'base64');
  const got = await scrypt(password, Buffer.from(s, 'base64'));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function validate({ name, email, password }, needName = true) {
  if (needName && !cleanName(name)) throw new Error('Adını yaz.');
  if (!EMAIL_RE.test(normEmail(email))) throw new Error('Geçerli bir e-posta adresi yaz.');
  if (password !== undefined && String(password).length < 8) throw new Error('Şifre en az 8 karakter olmalı.');
}

class Accounts {
  constructor({ store, dataDir, engine, connections }) {
    this.store = store;
    this.file = path.join(dataDir, 'hesaplar.json');
    this.engine = engine;
    this.connections = connections;
    this.tries = [];
    // "Beni hatırla" seçilmediyse oturum uygulama kapanınca biter
    // Eski sürümlerde "Beni hatırla" varsayılan açıktı: güncellemeden sonra herkes bir kez yeniden giriş yapar
    if (!this.store.get('rememberV2')) {
      this.store.set('account', null);
      this.connections.setSecret('account-token', null);
      this.store.set('rememberV2', true);
    }
    const s = this.store.get('account');
    if (s && s.remember !== true) { this.store.set('account', null); this.connections.setSecret('account-token', null); }
  }

  // ---------------------------------------------------------------- geliştirici
  // resources/gelistirici.json: { email, name, hash } — şifre değil, yalnızca scrypt özeti
  dev() {
    const d = this.connections.bundled('gelistirici.json');
    return d?.email ? { email: normEmail(d.email), name: cleanName(d.name) || 'Geliştirici', hash: d.hash || '' } : null;
  }
  isDev(email) { const d = this.dev(); return !!d && normEmail(email) === d.email; }
  requireDev() { if (this.current()?.role !== 'gelistirici') throw new Error('Bu işlem için geliştirici hesabı gerekir.'); }
  // Bir hesabın bu bilgisayardaki bağlantıları, hafızası ve hatırlatıcıları
  wipeLocal(id) {
    const all = { ...(this.store.get('secrets') || {}) };
    for (const k of Object.keys(all)) if (k.startsWith(`hesap:${id}:`)) delete all[k];
    this.store.set('secrets', all);
    const h = { ...(this.store.get('hesap') || {}) };
    delete h[id];
    this.store.set('hesap', h);
  }

  // ---------------------------------------------------------------- günlük mesaj sınırı
  // Herkese günde DAILY mesaj; geliştirici hesabı sınırsız. Gün, bilgisayarın yerel saatiyle gece yarısı yenilenir.
  static get DAILY() { return 70; }
  today() { return new Date().toLocaleDateString('sv-SE'); }
  resetAt() { const d = new Date(); d.setHours(24, 0, 0, 0); return d.getTime(); }
  usedLocal(id) { const r = (this.store.get('usage') || {})[id]; return r && r.day === this.today() ? r.n : 0; }
  usageOut(used, unlimited, limit = Accounts.DAILY, reset = this.resetAt()) {
    return unlimited ? { used, limit: null, left: null, unlimited: true, reset } : { used, limit, left: Math.max(0, limit - used), unlimited: false, reset };
  }
  async usage() {
    const u = this.current();
    if (!u) return null;
    if (u.mode === 'bulut') return this.remote('GET', '/auth/usage');
    return this.usageOut(this.usedLocal(u.id), u.role === 'gelistirici');
  }
  // Bir mesaj gönderilmeden önce çağrılır; hak dolduysa hata fırlatır
  async consume() {
    const u = this.current();
    if (!u) throw new Error('Önce giriş yap.');
    if (u.mode === 'bulut') return this.remote('POST', '/auth/usage', {});
    const dev = u.role === 'gelistirici';
    const used = this.usedLocal(u.id);
    if (!dev && used >= Accounts.DAILY) throw new Error(`Bugünkü ${Accounts.DAILY} mesaj hakkın doldu. Gece yarısı yenilenir.`);
    this.store.set('usage', { ...(this.store.get('usage') || {}), [u.id]: { day: this.today(), n: used + 1 } });
    return this.usageOut(used + 1, dev);
  }

  // ---------------------------------------------------------------- ortak
  remoteBase() {
    const url = this.engine.cloudConfig().url;
    return url ? url.replace(/\/v1$/, '') : '';
  }
  mode() { return this.remoteBase() ? 'bulut' : 'yerel'; }
  token() { return this.connections.secret('account-token')?.token || ''; }
  current() {
    const s = this.store.get('account');
    if (!s?.email) return null;
    return { id: s.id, name: s.name, email: s.email, provider: s.provider || 'sifre', mode: s.mode || 'yerel', created: s.created, role: s.role || (this.isDev(s.email) && s.mode !== 'bulut' ? 'gelistirici' : 'kullanici') };
  }
  status() {
    return { user: this.current(), mode: this.mode(), google: !!this.connections.googleClient() };
  }
  setSession(user, { remember = false, token = '', mode }) {
    const role = mode === 'bulut' ? (user.role || 'kullanici') : (this.isDev(user.email) ? 'gelistirici' : 'kullanici');
    this.store.set('account', { id: user.id, name: user.name, email: user.email, provider: user.provider || 'sifre', created: user.created, mode, remember, role });
    this.connections.setSecret('account-token', token ? { token } : null);
    return this.status();
  }
  // Giriş denemesi sınırı (kaba kuvvete karşı): dakikada 10
  throttle() {
    const now = Date.now();
    this.tries = this.tries.filter((t) => now - t < 60e3);
    if (this.tries.length >= 10) throw new Error('Çok fazla deneme yaptın. Bir dakika bekleyip tekrar dene.');
    this.tries.push(now);
  }

  async remote(method, route, body, auth = true) {
    const base = this.remoteBase();
    let r;
    try {
      r = await fetch(base + route, {
        method,
        headers: { 'content-type': 'application/json', ...(auth && this.token() ? { authorization: `Bearer ${this.token()}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error('Glassly sunucusuna ulaşılamadı. İnternet bağlantını kontrol et.');
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(j.error?.message || `Sunucu hatası (${r.status})`);
      e.status = r.status;
      throw e;
    }
    return j;
  }

  // ---------------------------------------------------------------- yerel kayıtlar
  users() {
    let users = [];
    try { users = JSON.parse(fs.readFileSync(this.file, 'utf8')).users || []; } catch { /* ilk açılış */ }
    // Geliştirici hesabı her bilgisayarda hazır gelir; şifresi ilk seferde gömülü özetle eşitlenir
    const d = this.dev();
    if (d?.hash) {
      const u = users.find((x) => x.email === d.email);
      if (!u) {
        users.push({ id: crypto.randomUUID(), name: d.name, email: d.email, hash: d.hash, provider: 'sifre', created: Date.now(), devSeed: d.hash });
        this.saveUsers(users);
      } else if (u.devSeed !== d.hash) {
        u.hash = d.hash; u.devSeed = d.hash;
        if (u.provider === 'google') u.provider = 'sifre+google';
        this.saveUsers(users);
      }
    }
    return users;
  }
  saveUsers(users) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ users }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  publicUser(u) { return { id: u.id, name: u.name, email: u.email, provider: u.provider, created: u.created, role: this.isDev(u.email) ? 'gelistirici' : 'kullanici' }; }

  // ---------------------------------------------------------------- işlemler
  async register({ name, email, password, remember = false }) {
    validate({ name, email, password });
    this.throttle();
    if (this.mode() === 'bulut') {
      const j = await this.remote('POST', '/auth/register', { name: cleanName(name), email: normEmail(email), password }, false);
      return this.setSession(j.user, { remember, token: j.token, mode: 'bulut' });
    }
    const users = this.users();
    if (users.some((u) => u.email === normEmail(email))) throw new Error('Bu e-posta ile zaten bir hesap var. Giriş yapmayı dene.');
    const u = { id: crypto.randomUUID(), name: cleanName(name), email: normEmail(email), hash: await hashPassword(password), provider: 'sifre', created: Date.now() };
    this.saveUsers([...users, u]);
    return this.setSession(this.publicUser(u), { remember, mode: 'yerel' });
  }

  async login({ email, password, remember = false }) {
    validate({ email }, false);
    if (!password) throw new Error('Şifreni yaz.');
    this.throttle();
    if (this.mode() === 'bulut') {
      const j = await this.remote('POST', '/auth/login', { email: normEmail(email), password }, false);
      return this.setSession(j.user, { remember, token: j.token, mode: 'bulut' });
    }
    const u = this.users().find((x) => x.email === normEmail(email));
    if (!u || !u.hash || !(await checkPassword(password, u.hash))) {
      if (u && !u.hash) throw new Error('Bu hesap Google ile açılmış. "Google ile devam et"e bas.');
      throw new Error('E-posta veya şifre yanlış.');
    }
    return this.setSession(this.publicUser(u), { remember, mode: 'yerel' });
  }

  // Google ile devam et: aynı girişte Gmail, Takvim ve Drive da bağlanır
  async google({ remember = false } = {}) {
    // Giriş ekranında hiçbir hesap açık değil: önceki kişinin erişimi kullanılmaz, Google her seferinde hesap sorar
    this.store.set('account', null);
    this.connections.setSecret('account-token', null);
    this.connections.forget();
    try { await this.connections.connectGoogle(); } catch (e) { this.connections.forget(); throw e; }
    const g = this.connections.lastGoogle || {};
    const email = normEmail(g.email || this.connections.secret('google')?.email);
    if (!email) throw new Error('Google hesabının e-posta adresi alınamadı.');
    const name = cleanName(g.name) || email.split('@')[0];
    if (this.mode() === 'bulut') {
      let j;
      try { j = await this.remote('POST', '/auth/google', { id_token: g.id_token, access_token: g.access_token }, false); }
      catch (e) { this.connections.forget(); throw e; }
      const out = this.setSession(j.user, { remember, token: j.token, mode: 'bulut' });
      this.connections.adoptGoogle(j.user.id);
      return out;
    }
    const users = this.users();
    let u = users.find((x) => x.email === email);
    if (!u) {
      u = { id: crypto.randomUUID(), name, email, hash: '', provider: 'google', created: Date.now() };
      users.push(u);
    } else if (!u.provider?.includes('google')) {
      u.provider = u.hash ? 'sifre+google' : 'google';
    }
    this.saveUsers(users);
    const out = this.setSession(this.publicUser(u), { remember, mode: 'yerel' });
    this.connections.adoptGoogle(u.id);
    return out;
  }

  async logout() {
    if (this.current()?.mode === 'bulut' && this.token()) await this.remote('POST', '/auth/logout').catch(() => {});
    this.store.set('account', null);
    this.connections.setSecret('account-token', null);
    this.connections.forget();
    return this.status();
  }

  async rename(name) {
    const me = this.current();
    if (!me) throw new Error('Önce giriş yap.');
    if (!cleanName(name)) throw new Error('Adını yaz.');
    if (me.mode === 'bulut') {
      const j = await this.remote('PATCH', '/auth/me', { name: cleanName(name) });
      return this.setSession(j.user, { remember: this.store.get('account')?.remember === true, token: this.token(), mode: 'bulut' });
    }
    const users = this.users();
    const u = users.find((x) => x.id === me.id);
    if (!u) throw new Error('Hesap bulunamadı.');
    u.name = cleanName(name);
    this.saveUsers(users);
    return this.setSession(this.publicUser(u), { remember: this.store.get('account')?.remember === true, mode: 'yerel' });
  }

  async changePassword({ current, next }) {
    const me = this.current();
    if (!me) throw new Error('Önce giriş yap.');
    if (String(next || '').length < 8) throw new Error('Yeni şifre en az 8 karakter olmalı.');
    this.throttle();
    if (me.mode === 'bulut') { await this.remote('POST', '/auth/password', { current, next }); return this.status(); }
    const users = this.users();
    const u = users.find((x) => x.id === me.id);
    if (!u) throw new Error('Hesap bulunamadı.');
    if (u.hash && !(await checkPassword(current || '', u.hash))) throw new Error('Mevcut şifre yanlış.');
    u.hash = await hashPassword(next);
    if (u.provider === 'google') u.provider = 'sifre+google';
    this.saveUsers(users);
    return this.status();
  }

  async remove({ password }) {
    const me = this.current();
    if (!me) throw new Error('Önce giriş yap.');
    if (me.role === 'gelistirici') throw new Error('Geliştirici hesabı silinemez.');
    this.throttle();
    if (me.mode === 'bulut') {
      await this.remote('DELETE', '/auth/me', { password });
    } else {
      const users = this.users();
      const u = users.find((x) => x.id === me.id);
      if (u?.hash && !(await checkPassword(password || '', u.hash))) throw new Error('Şifre yanlış.');
      this.saveUsers(users.filter((x) => x.id !== me.id));
      this.wipeLocal(me.id);
    }
    this.store.set('account', null);
    this.connections.setSecret('account-token', null);
    return this.status();
  }

  // ---------------------------------------------------------------- geliştirici paneli
  async adminOverview() {
    this.requireDev();
    if (this.current().mode === 'bulut') {
      const [u, st] = await Promise.all([this.remote('GET', '/admin/users'), this.remote('GET', '/admin/stats')]);
      return { mode: 'bulut', users: u.users, stats: st };
    }
    const secrets = this.store.get('secrets') || {};
    const owners = this.store.get('sessionOwners') || {};
    const users = this.users().map((u) => {
      const h = this.store.get(`hesap.${u.id}`) || {};
      return {
        ...this.publicUser(u),
        google: !!secrets[`hesap:${u.id}:google`], github: !!secrets[`hesap:${u.id}:github`],
        chats: Object.values(owners).filter((o) => o === u.id).length,
        memory: (h.memory || []).length, reminders: (h.reminders || []).length,
        today: this.usedLocal(u.id), limit: this.isDev(u.email) ? null : Accounts.DAILY,
      };
    });
    return { mode: 'yerel', users, stats: { users: users.length, file: this.file } };
  }

  async adminDelete(id) {
    this.requireDev();
    if (id === this.current().id) throw new Error('Kendi hesabını buradan silemezsin.');
    if (this.current().mode === 'bulut') { await this.remote('DELETE', '/admin/users/' + encodeURIComponent(id)); return this.adminOverview(); }
    const users = this.users();
    const u = users.find((x) => x.id === id);
    if (!u) throw new Error('Hesap bulunamadı.');
    if (this.isDev(u.email)) throw new Error('Geliştirici hesabı silinemez.');
    this.saveUsers(users.filter((x) => x.id !== id));
    this.wipeLocal(id);
    return this.adminOverview();
  }

  async adminSettings(patch) {
    this.requireDev();
    if (this.current().mode !== 'bulut') throw new Error('Bu ayar yalnızca Glassly Bulut sunucusunda geçerli.');
    await this.remote('POST', '/admin/settings', patch);
    return this.adminOverview();
  }
}

module.exports = { Accounts, hashPassword, checkPassword };
