'use strict';
// Glassly bağlantıları: Gmail, Google Drive ve GitHub'ı ajana araç olarak sunar.
// Uygulama içinde 127.0.0.1 üzerinde küçük bir MCP sunucusu çalışır; opencode buna
// "uzak MCP" olarak bağlanır. Anahtarlar ana süreçte kalır, diske şifreli yazılır.

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { safeStorage, shell } = require('electron');

// İki izin profili:
//  tam   : gelen kutusunu okuma dahil her şey (Google'ın "kısıtlı" izinleri; herkese açık yayında
//          Google doğrulaması + yıllık güvenlik denetimi gerekir, o zamana kadar en çok 100 kullanıcı)
//  hafif : sadece e-posta gönderme, Glassly'nin oluşturduğu Drive dosyaları ve Takvim
//          (sadece "hassas" izinler; doğrulama daha kolay, güvenlik denetimi gerekmez)
const G = 'https://www.googleapis.com/auth/';
const GOOGLE_PROFILES = {
  tam: [G + 'gmail.modify', G + 'drive', G + 'calendar.events'],
  hafif: [G + 'gmail.send', G + 'drive.file', G + 'calendar.events'],
};
const GITHUB_SCOPES = 'repo read:user';
const PERSONAL = new Set(['google', 'github']);
const GAPI = () => process.env.GLASSLY_GOOGLE_API || 'https://www.googleapis.com';
const GMAIL = () => process.env.GLASSLY_GMAIL_API || 'https://gmail.googleapis.com';
const GHAPI = () => process.env.GLASSLY_GITHUB_API || 'https://api.github.com';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const encHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
const stripHtml = (h) => String(h || '').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();

class Connections {
  constructor({ store, resourcesDir, confirm, assistant, onChange }) {
    this.store = store;
    this.assistant = assistant;
    this.onChange = onChange || (() => {});
    this.resourcesDir = resourcesDir;
    this.confirm = confirm; // async ({title, fields, text}) => boolean
    this.server = null;
    this.port = 0;
    this.token = crypto.randomBytes(24).toString('base64url');
    this.access = null; // { token, exp }
    this.scope = () => null; // giriş yapan Glassly hesabının kimliği (main.js bağlar)
    // Hesaplardan önceki sürümde bağlanan Google/GitHub kimlikleri hiçbir hesaba devredilmez
    const all = this.store.get('secrets') || {};
    if (all.google || all.github || all.mail) {
      const next = { ...all }; delete next.google; delete next.github; delete next.mail;
      this.store.set('secrets', next);
    }
    this.dropOrphans();
  }

  // Hiçbir hesaba ait olmayan (giriş ekranında alınmış) bağlantılar kimseyle paylaşılmaz
  dropOrphans() {
    const all = this.store.get('secrets') || {};
    const keys = Object.keys(all).filter((k) => k.startsWith('hesap:_:'));
    if (!keys.length) return;
    const next = { ...all };
    for (const k of keys) delete next[k];
    this.store.set('secrets', next);
  }
  // Google ile girişte alınan bağlantıyı yalnızca giriş yapan hesaba taşır
  adoptGoogle(id) {
    const all = { ...(this.store.get('secrets') || {}) };
    if (all['hesap:_:google'] && id) all[`hesap:${id}:google`] = all['hesap:_:google'];
    this.store.set('secrets', all);
    this.dropOrphans();
    this.lastGoogle = null;
  }
  forget() { this.access = null; this.lastGoogle = null; this.dropOrphans(); }

  // Google ve GitHub bağlantıları hesaba özeldir; istemci ayarları ve hesap belirteci ortaktır
  secretKey(name) {
    return PERSONAL.has(name) ? `hesap:${this.scope() || '_'}:${name}` : name;
  }

  // ------------------------------------------------------------ gizli bilgiler
  secret(name) {
    const all = this.store.get('secrets') || {};
    const v = all[this.secretKey(name)];
    if (!v) return null;
    try {
      const buf = Buffer.from(v.data, 'base64');
      return JSON.parse(v.enc && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8'));
    } catch { return null; }
  }

  setSecret(name, value) {
    const all = { ...(this.store.get('secrets') || {}) };
    name = this.secretKey(name);
    if (value == null) delete all[name];
    else {
      const json = JSON.stringify(value);
      const enc = safeStorage.isEncryptionAvailable();
      all[name] = { enc, data: (enc ? safeStorage.encryptString(json) : Buffer.from(json)).toString('base64') };
    }
    this.store.set('secrets', all);
  }

  bundled(name) {
    try { return JSON.parse(fs.readFileSync(path.join(this.resourcesDir, name), 'utf8')); } catch { return null; }
  }

  // Google OAuth istemcisi: önce kullanıcının girdiği, yoksa uygulamaya gömülü olan (resources/google-oauth.json)
  googleClient() {
    const user = this.secret('google-client');
    if (user?.client_id) return { ...user, profile: user.profile || 'tam', bundled: false };
    const f = this.bundled('google-oauth.json');
    const c = f && (f.installed || f.web || f);
    if (c?.client_id) return { client_id: c.client_id, client_secret: c.client_secret || '', profile: f.profile || c.profile || 'tam', bundled: true };
    return null;
  }

  githubClient() {
    const user = this.secret('github-client');
    if (user?.client_id) return user.client_id;
    return this.bundled('github-oauth.json')?.client_id || null;
  }

  status() {
    const g = this.secret('google');
    const gh = this.secret('github');
    const sc = String(g?.scope || '').split(' ');
    const has = (x) => sc.includes(G + x);
    const client = this.googleClient();
    return {
      googleClient: !!client,
      googleBundled: !!client?.bundled,
      googleProfile: client?.profile || 'tam',
      githubClient: !!this.githubClient(),
      google: g ? {
        email: g.email || '',
        gmailRead: has('gmail.modify') || has('gmail.readonly'),
        gmailSend: has('gmail.modify') || has('gmail.send'),
        gmail: has('gmail.modify') || has('gmail.send') || has('gmail.readonly'),
        drive: has('drive') || has('drive.file'),
        driveFull: has('drive'),
        calendar: has('calendar.events') || has('calendar'),
      } : null,
      github: gh ? { login: gh.login || '' } : null,
      custom: this.store.get('mcpServers') || [],
    };
  }

  // ------------------------------------------------------------ Google OAuth (PKCE + yerel yönlendirme)
  async connectGoogle({ hint = '' } = {}) {
    const client = this.googleClient();
    if (!client) throw new Error('Google bağlantısı bu sürümde ayarlanmamış. Gelişmiş bölümünden istemci kimliği gir.');
    const prev = this.secret('google');
    const want = new Set(['openid', 'email', 'profile', ...(GOOGLE_PROFILES[client.profile] || GOOGLE_PROFILES.tam)]);
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const st = b64url(crypto.randomBytes(12));

    const { code, redirect } = await new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname !== '/callback') { res.writeHead(404); return res.end(); }
        const ok = u.searchParams.get('state') === st && u.searchParams.get('code');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Glassly</title><body style="font-family:system-ui;background:#0b0d26;color:#e8ebff;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${ok ? 'Bağlantı tamam' : 'Bağlantı başarısız'}</h2><p>Bu sekmeyi kapatıp Glassly'ye dönebilirsin.</p></div>`);
        const port = srv.address()?.port;
        clearTimeout(timer); srv.close();
        if (ok) resolve({ code: u.searchParams.get('code'), redirect: `http://127.0.0.1:${port}/callback` });
        else reject(new Error(u.searchParams.get('error') || 'İzin verilmedi'));
      });
      const timer = setTimeout(() => { srv.close(); reject(new Error('Zaman aşımı')); }, 5 * 60e3);
      srv.listen(0, '127.0.0.1', () => {
        const redirect = `http://127.0.0.1:${srv.address().port}/callback`;
        const q = new URLSearchParams({
          client_id: client.client_id, redirect_uri: redirect, response_type: 'code', scope: [...want].join(' '),
          access_type: 'offline', prompt: 'select_account consent', include_granted_scopes: 'true', state: st,
          ...(hint ? { login_hint: hint } : {}),
          code_challenge: challenge, code_challenge_method: 'S256',
        });
        shell.openExternal(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
      });
    });

    const r = await fetch(process.env.GLASSLY_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: client.client_id, client_secret: client.client_secret || '', redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }),
    });
    const tok = await r.json();
    if (!r.ok) throw new Error(tok.error_description || tok.error || 'Belirteç alınamadı');
    let email = prev?.email || '';
    let name = '';
    try {
      const me = await (await fetch(process.env.GLASSLY_GOOGLE_USERINFO_URL || 'https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` } })).json();
      email = me.email || email;
      name = me.name || me.given_name || '';
    } catch { /* önemli değil */ }
    // Hesap girişi için (Google ile devam et) kısa süreli tutulur
    this.lastGoogle = { email, name, id_token: tok.id_token || '', access_token: tok.access_token };
    this.setSecret('google', { refresh_token: tok.refresh_token || prev?.refresh_token, scope: tok.scope || [...want].join(' '), email });
    this.access = { token: tok.access_token, exp: Date.now() + (tok.expires_in || 3600) * 1000 - 60e3 };
    return this.status();
  }

  async disconnectGoogle() {
    const g = this.secret('google');
    this.setSecret('google', null);
    this.access = null;
    if (g?.refresh_token) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(g.refresh_token), { method: 'POST' }).catch(() => {});
    return this.status();
  }

  async googleToken() {
    if (process.env.GLASSLY_GOOGLE_TOKEN) return process.env.GLASSLY_GOOGLE_TOKEN; // test
    if (this.access && this.access.exp > Date.now()) return this.access.token;
    const g = this.secret('google');
    const client = this.googleClient();
    if (!g?.refresh_token || !client) throw new Error('Google hesabı bağlı değil. Ayarlar → Bağlantılar bölümünden bağla.');
    const r = await fetch(process.env.GLASSLY_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: g.refresh_token, client_id: client.client_id, client_secret: client.client_secret || '', grant_type: 'refresh_token' }),
    });
    const tok = await r.json();
    if (!r.ok) throw new Error('Google oturumu yenilenemedi, yeniden bağlan. (' + (tok.error || r.status) + ')');
    this.access = { token: tok.access_token, exp: Date.now() + (tok.expires_in || 3600) * 1000 - 60e3 };
    return this.access.token;
  }

  async gfetch(url, opts = {}) {
    const r = await fetch(url, { ...opts, headers: { authorization: `Bearer ${await this.googleToken()}`, ...(opts.headers || {}) } });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      let m = t; try { m = JSON.parse(t).error?.message || t; } catch { /* düz metin */ }
      throw new Error(`Google: ${r.status} ${String(m).slice(0, 300)}`);
    }
    return opts.raw ? r : r.status === 204 ? {} : r.json();
  }

  // ------------------------------------------------------------ GitHub
  async connectGithub(token) {
    const r = await fetch(`${GHAPI()}/user`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'Glassly' } });
    if (!r.ok) throw new Error('Belirteç geçersiz (' + r.status + ')');
    const me = await r.json();
    this.setSecret('github', { token, login: me.login });
    return this.status();
  }

  // Tek tık GitHub: cihaz akışı (istemci gizli anahtarı gerekmez)
  async startGithubDevice() {
    const client_id = this.githubClient();
    if (!client_id) throw new Error('GitHub bağlantısı bu sürümde ayarlanmamış. Erişim belirteciyle bağlanabilirsin.');
    const base = process.env.GLASSLY_GITHUB_WEB || 'https://github.com';
    const r = await fetch(`${base}/login/device/code`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id, scope: GITHUB_SCOPES }) });
    const d = await r.json();
    if (!r.ok || !d.device_code) throw new Error('GitHub kodu alınamadı (' + (d.error_description || d.error || r.status) + ')');
    const flow = { cancelled: false };
    this.ghFlow = flow;
    const until = Date.now() + (d.expires_in || 900) * 1000;
    let interval = Math.max(5, d.interval || 5) * 1000;
    (async () => {
      while (!flow.cancelled && Date.now() < until) {
        await new Promise((res) => setTimeout(res, interval));
        if (flow.cancelled) return;
        try {
          const t = await (await fetch(`${base}/login/oauth/access_token`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id, device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) })).json();
          if (t.access_token) { await this.connectGithub(t.access_token); this.onChange('github'); return; }
          if (t.error === 'slow_down') interval += 5000;
          else if (t.error && t.error !== 'authorization_pending') { this.onChange('github-error', t.error_description || t.error); return; }
        } catch { /* ağ hatası: tekrar dene */ }
      }
      if (!flow.cancelled) this.onChange('github-error', 'Süre doldu, tekrar dene.');
    })();
    shell.openExternal(d.verification_uri || `${base}/login/device`);
    return { user_code: d.user_code, verification_uri: d.verification_uri || `${base}/login/device` };
  }

  cancelGithubDevice() { if (this.ghFlow) this.ghFlow.cancelled = true; }

  disconnectGithub() { this.setSecret('github', null); return this.status(); }

  async gh(pathname, opts = {}) {
    const s = this.secret('github');
    if (!s?.token) throw new Error('GitHub bağlı değil. Ayarlar → Bağlantılar bölümünden bağla.');
    const r = await fetch(`${GHAPI()}${pathname}`, {
      ...opts,
      headers: { authorization: `Bearer ${s.token}`, accept: 'application/vnd.github+json', 'user-agent': 'Glassly', 'x-github-api-version': '2022-11-28', ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
    });
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`GitHub: ${r.status} ${t.slice(0, 300)}`); }
    return r.status === 204 ? {} : r.json();
  }

  // ------------------------------------------------------------ araçlar
  tools() {
    const st = this.status();
    const T = [];
    const add = (name, description, properties, required, run) => T.push({ name, description, inputSchema: { type: 'object', properties, required }, run });
    const str = (d) => ({ type: 'string', description: d });
    const num = (d) => ({ type: 'number', description: d });

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (this.assistant) this.assistant.tools(add, str, num);

    if (st.google?.calendar) {
      const CAL = () => `${process.env.GLASSLY_CALENDAR_API || GAPI()}/calendar/v3/calendars/primary`;
      const ev = (e) => ({ id: e.id, title: e.summary, start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, location: e.location, description: e.description?.slice(0, 500), attendees: e.attendees?.map((a) => a.email), link: e.htmlLink });
      const toTime = (v, allDay) => (allDay ? { date: String(v).slice(0, 10) } : { dateTime: /[zZ]|[+-]\d\d:\d\d$/.test(v) ? v : new Date(v).toISOString(), timeZone: tz });
      add('calendar_list', `Google Takvim'deki etkinlikleri listeler. Kullanıcının saat dilimi: ${tz}.`,
        { from: str('Başlangıç (ISO, varsayılan şimdi)'), to: str('Bitiş (ISO, varsayılan 7 gün sonra)'), query: str('Aranacak kelime (isteğe bağlı)'), max: num('En fazla (varsayılan 25)') }, [],
        async ({ from, to, query, max = 25 }) => {
          const tmin = from ? new Date(from) : new Date();
          const tmax = to ? new Date(to) : new Date(tmin.getTime() + 7 * 864e5);
          const q = new URLSearchParams({ timeMin: tmin.toISOString(), timeMax: tmax.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: String(Math.min(Number(max) || 25, 100)), ...(query ? { q: query } : {}) });
          const r = await this.gfetch(`${CAL()}/events?${q}`);
          return r.items?.length ? r.items.map(ev) : 'Bu aralıkta etkinlik yok.';
        });
      add('calendar_create', 'Google Takvim\'e etkinlik ekler. Kullanıcıdan onay alınır.',
        { title: str('Başlık'), start: str('Başlangıç, yerel saatle ISO (ör. 2026-11-14T15:00)'), end: str('Bitiş (yoksa 1 saat sonrası)'), all_day: { type: 'boolean', description: 'Tüm gün etkinliği' }, location: str('Yer'), description: str('Açıklama'), attendees: str('Davetliler, virgülle e-posta') }, ['title', 'start'],
        async (a) => {
          const end = a.end || (a.all_day ? a.start : new Date(new Date(a.start).getTime() + 3600e3).toISOString());
          const when = a.all_day ? new Date(a.start).toLocaleDateString('tr-TR', { dateStyle: 'full' }) : `${new Date(a.start).toLocaleString('tr-TR', { dateStyle: 'full', timeStyle: 'short' })} – ${new Date(end).toLocaleTimeString('tr-TR', { timeStyle: 'short' })}`;
          const ok = await this.confirm({ kind: 'calendar', title: 'Takvime eklensin mi?', fields: [['Başlık', a.title], ['Zaman', when], a.location && ['Yer', a.location], a.attendees && ['Davetliler', a.attendees]].filter(Boolean), text: a.description || '', okLabel: 'Ekle' });
          if (!ok) return 'Kullanıcı iptal etti.';
          const body = { summary: a.title, location: a.location, description: a.description, start: toTime(a.start, a.all_day), end: toTime(end, a.all_day), ...(a.attendees ? { attendees: String(a.attendees).split(',').map((e) => ({ email: e.trim() })).filter((x) => x.email) } : {}) };
          const r = await this.gfetch(`${CAL()}/events${a.attendees ? '?sendUpdates=all' : ''}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          return ev(r);
        });
      add('calendar_delete', 'Takvimden bir etkinliği siler. Kullanıcıdan onay alınır.', { id: str('Etkinlik kimliği'), title: str('Etkinlik başlığı (onay için)') }, ['id'],
        async ({ id, title }) => {
          if (!(await this.confirm({ kind: 'calendar', title: 'Etkinlik silinsin mi?', fields: [['Etkinlik', title || id]], okLabel: 'Sil' }))) return 'Kullanıcı iptal etti.';
          await this.gfetch(`${CAL()}/events/${encodeURIComponent(id)}`, { method: 'DELETE' });
          return 'Silindi.';
        });
    }

    if (st.google?.gmailRead) {
      add('gmail_search', 'Gmail kutusunda e-posta arar (Gmail arama sözdizimi: from:, to:, subject:, is:unread, newer_than:7d ...). Kimden, konu, tarih ve özet döndürür.',
        { query: str('Gmail arama sorgusu. Boş bırakılırsa gelen kutusu.'), max: num('En fazla kaç sonuç (varsayılan 10, en çok 25)') }, [],
        async ({ query = 'in:inbox', max = 10 }) => {
          const list = await this.gfetch(`${GMAIL()}/gmail/v1/users/me/messages?${new URLSearchParams({ q: query, maxResults: String(Math.min(Number(max) || 10, 25)) })}`);
          const out = [];
          for (const m of list.messages || []) {
            const d = await this.gfetch(`${GMAIL()}/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);
            const h = Object.fromEntries((d.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
            out.push({ id: d.id, threadId: d.threadId, from: h.from, to: h.to, subject: h.subject, date: h.date, unread: (d.labelIds || []).includes('UNREAD'), snippet: d.snippet });
          }
          return out.length ? out : 'Sonuç yok.';
        });
      add('gmail_read', 'Bir e-postanın tamamını okur (metin gövdesi ve ek adları).', { id: str('Mesaj kimliği (gmail_search sonucundaki id)') }, ['id'],
        async ({ id }) => {
          const d = await this.gfetch(`${GMAIL()}/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`);
          const h = Object.fromEntries((d.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
          let text = '', html = ''; const files = [];
          const walk = (p) => {
            if (!p) return;
            if (p.filename) files.push(p.filename);
            if (p.mimeType === 'text/plain' && p.body?.data) text += fromB64url(p.body.data);
            else if (p.mimeType === 'text/html' && p.body?.data) html += fromB64url(p.body.data);
            (p.parts || []).forEach(walk);
          };
          walk(d.payload);
          return { id: d.id, threadId: d.threadId, from: h.from, to: h.to, cc: h.cc, subject: h.subject, date: h.date, messageId: h['message-id'], body: (text || stripHtml(html)).slice(0, 20000), attachments: files };
        });
    }

    if (st.google?.gmailSend) {
      const canRead = !!st.google.gmailRead;
      const compose = async ({ to, subject = '', body = '', cc, bcc, reply_to_id }) => {
        let threadId, inReply, refs;
        if (reply_to_id && canRead) {
          const o = await this.gfetch(`${GMAIL()}/gmail/v1/users/me/messages/${encodeURIComponent(reply_to_id)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject`);
          const h = Object.fromEntries((o.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
          threadId = o.threadId; inReply = h['message-id']; refs = [h.references, h['message-id']].filter(Boolean).join(' ');
          if (!subject) subject = /^re:/i.test(h.subject || '') ? h.subject : `Re: ${h.subject || ''}`;
        }
        const lines = [`To: ${to}`, cc && `Cc: ${cc}`, bcc && `Bcc: ${bcc}`, `Subject: ${encHeader(subject)}`, inReply && `In-Reply-To: ${inReply}`, refs && `References: ${refs}`,
          'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', Buffer.from(body).toString('base64').replace(/.{76}/g, '$&\r\n')].filter((x) => x !== undefined && x !== null && x !== false);
        return { raw: b64url(lines.join('\r\n')), threadId, subject };
      };
      add('gmail_send', 'E-posta gönderir. Göndermeden önce kullanıcıdan onay alınır.',
        { to: str('Alıcı(lar), virgülle'), subject: str('Konu'), body: str('Düz metin gövde'), cc: str('Bilgi (isteğe bağlı)'), bcc: str('Gizli bilgi (isteğe bağlı)'), reply_to_id: str('Yanıtlanan mesajın kimliği (isteğe bağlı)') }, ['to', 'body'],
        async (a) => {
          const m = await compose(a);
          const ok = await this.confirm({ kind: 'mail', title: 'E-posta gönderilsin mi?', fields: [['Kime', a.to], a.cc && ['Bilgi', a.cc], a.bcc && ['Gizli', a.bcc], ['Konu', m.subject]].filter(Boolean), text: a.body, okLabel: 'Gönder' });
          if (!ok) return 'Kullanıcı gönderimi iptal etti. Tekrar deneme; kullanıcıya ne değiştirmek istediğini sor.';
          const r = await this.gfetch(`${GMAIL()}/gmail/v1/users/me/messages/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw: m.raw, ...(m.threadId ? { threadId: m.threadId } : {}) }) });
          return { sent: true, id: r.id, threadId: r.threadId };
        });
      if (canRead) add('gmail_draft', 'Göndermeden taslak e-posta oluşturur (kullanıcı Gmail\'den gözden geçirip gönderebilir).',
        { to: str('Alıcı(lar)'), subject: str('Konu'), body: str('Düz metin gövde'), cc: str('Bilgi'), reply_to_id: str('Yanıtlanan mesaj kimliği') }, ['to', 'body'],
        async (a) => {
          const m = await compose(a);
          const r = await this.gfetch(`${GMAIL()}/gmail/v1/users/me/drafts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: { raw: m.raw, ...(m.threadId ? { threadId: m.threadId } : {}) } }) });
          return { draft: true, id: r.id };
        });
    }

    if (st.google?.drive) {
      add('drive_search', 'Google Drive\'da dosya arar (ada veya içeriğe göre). Kimlik, ad, tür, değiştirilme tarihi ve bağlantı döndürür.',
        { query: str('Aranacak kelime(ler). Boşsa son değişen dosyalar.'), max: num('En fazla kaç sonuç (varsayılan 15)') }, [],
        async ({ query = '', max = 15 }) => {
          const qq = String(query).replace(/'/g, "\\'");
          const q = [`trashed = false`, qq && `(name contains '${qq}' or fullText contains '${qq}')`].filter(Boolean).join(' and ');
          const r = await this.gfetch(`${GAPI()}/drive/v3/files?${new URLSearchParams({ q, pageSize: String(Math.min(Number(max) || 15, 50)), orderBy: qq ? '' : 'modifiedTime desc', fields: 'files(id,name,mimeType,modifiedTime,webViewLink,size)' })}`.replace('&orderBy=&', '&'));
          return r.files?.length ? r.files : 'Sonuç yok.';
        });
      add('drive_read', 'Drive dosyasının içeriğini metin olarak okur (Google Dokümanlar, E-Tablolar, Sunular ve metin dosyaları).', { id: str('Dosya kimliği') }, ['id'],
        async ({ id }) => {
          const meta = await this.gfetch(`${GAPI()}/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,size`);
          const exp = { 'application/vnd.google-apps.document': 'text/plain', 'application/vnd.google-apps.spreadsheet': 'text/csv', 'application/vnd.google-apps.presentation': 'text/plain' }[meta.mimeType];
          let r;
          if (exp) r = await this.gfetch(`${GAPI()}/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(exp)}`, { raw: true });
          else if (/^text\/|json|xml|csv|markdown|javascript/.test(meta.mimeType)) r = await this.gfetch(`${GAPI()}/drive/v3/files/${encodeURIComponent(id)}?alt=media`, { raw: true });
          else return { name: meta.name, mimeType: meta.mimeType, note: 'Bu dosya türü metin olarak okunamıyor.' };
          return { name: meta.name, mimeType: meta.mimeType, content: (await r.text()).slice(0, 60000) };
        });
      add('drive_create', 'Drive\'a yeni bir metin dosyası veya Google Dokümanı oluşturur. Kullanıcıdan onay alınır.',
        { name: str('Dosya adı'), content: str('İçerik (düz metin)'), as_doc: { type: 'boolean', description: 'true ise Google Dokümanı olarak oluştur' }, folder_id: str('Klasör kimliği (isteğe bağlı)') }, ['name', 'content'],
        async ({ name, content, as_doc, folder_id }) => {
          const ok = await this.confirm({ kind: 'drive', title: 'Drive\'a dosya oluşturulsun mu?', fields: [['Ad', name], ['Tür', as_doc ? 'Google Dokümanı' : 'Metin dosyası']], text: String(content).slice(0, 2000), okLabel: 'Oluştur' });
          if (!ok) return 'Kullanıcı iptal etti.';
          const boundary = 'glassly' + crypto.randomBytes(8).toString('hex');
          const meta = { name, ...(as_doc ? { mimeType: 'application/vnd.google-apps.document' } : {}), ...(folder_id ? { parents: [folder_id] } : {}) };
          const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
          const r = await this.gfetch(`${GAPI()}/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink`, { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body });
          return r;
        });
    }

    if (st.github) {
      add('github_repos', 'Kullanıcının GitHub depolarını listeler.', { max: num('En fazla kaç depo (varsayılan 30)') }, [],
        async ({ max = 30 }) => (await this.gh(`/user/repos?sort=updated&per_page=${Math.min(Number(max) || 30, 100)}`)).map((r) => ({ name: r.full_name, private: r.private, description: r.description, updated: r.updated_at, url: r.html_url })));
      add('github_search', 'GitHub\'da konu (issue) ve çekme isteği (PR) arar. GitHub arama sözdizimi: repo:sahip/ad is:open is:pr author:@me ...', { query: str('Arama sorgusu') }, ['query'],
        async ({ query }) => ((await this.gh(`/search/issues?q=${encodeURIComponent(query)}&per_page=20`)).items || []).map((i) => ({ repo: i.repository_url.split('/repos/')[1], number: i.number, title: i.title, state: i.state, pr: !!i.pull_request, user: i.user?.login, url: i.html_url })));
      add('github_issue', 'Bir konunun veya PR\'ın ayrıntısını ve son yorumlarını getirir.', { repo: str('sahip/ad'), number: num('Numara') }, ['repo', 'number'],
        async ({ repo, number }) => {
          const i = await this.gh(`/repos/${repo}/issues/${number}`);
          const c = await this.gh(`/repos/${repo}/issues/${number}/comments?per_page=20`);
          return { title: i.title, state: i.state, user: i.user?.login, body: i.body, comments: c.map((x) => ({ user: x.user?.login, body: x.body })) };
        });
      add('github_file', 'Depodaki bir dosyanın içeriğini veya klasörün listesini getirir.', { repo: str('sahip/ad'), path: str('Dosya yolu (boşsa kök)'), ref: str('Dal veya commit (isteğe bağlı)') }, ['repo'],
        async ({ repo, path: p = '', ref }) => {
          const d = await this.gh(`/repos/${repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
          if (Array.isArray(d)) return d.map((x) => ({ name: x.name, type: x.type, path: x.path }));
          return { path: d.path, content: Buffer.from(d.content || '', 'base64').toString('utf8').slice(0, 60000) };
        });
      add('github_create_issue', 'Depoda yeni konu (issue) açar. Kullanıcıdan onay alınır.', { repo: str('sahip/ad'), title: str('Başlık'), body: str('Açıklama') }, ['repo', 'title'],
        async ({ repo, title, body = '' }) => {
          if (!(await this.confirm({ kind: 'github', title: 'GitHub\'da konu açılsın mı?', fields: [['Depo', repo], ['Başlık', title]], text: body, okLabel: 'Aç' }))) return 'Kullanıcı iptal etti.';
          const r = await this.gh(`/repos/${repo}/issues`, { method: 'POST', body: JSON.stringify({ title, body }) });
          return { number: r.number, url: r.html_url };
        });
      add('github_comment', 'Bir konuya veya PR\'a yorum yazar. Kullanıcıdan onay alınır.', { repo: str('sahip/ad'), number: num('Numara'), body: str('Yorum') }, ['repo', 'number', 'body'],
        async ({ repo, number, body }) => {
          if (!(await this.confirm({ kind: 'github', title: 'Yorum gönderilsin mi?', fields: [['Depo', repo], ['Numara', '#' + number]], text: body, okLabel: 'Gönder' }))) return 'Kullanıcı iptal etti.';
          const r = await this.gh(`/repos/${repo}/issues/${number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
          return { url: r.html_url };
        });
    }
    return T;
  }

  // ------------------------------------------------------------ MCP sunucusu (Streamable HTTP, JSON yanıt)
  async start() {
    if (this.server) return;
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = this.server.address().port;
  }

  async handle(req, res) {
    if ((req.headers.authorization || '') !== `Bearer ${this.token}`) { res.writeHead(401); return res.end(); }
    if (req.method === 'GET') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
    if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
    let raw = '';
    for await (const c of req) raw += c;
    let msg;
    try { msg = JSON.parse(raw); } catch { res.writeHead(400); return res.end(); }
    const batch = Array.isArray(msg);
    const replies = (await Promise.all((batch ? msg : [msg]).map((m) => this.rpc(m)))).filter(Boolean);
    if (!replies.length) { res.writeHead(202); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'glassly' });
    res.end(JSON.stringify(batch ? replies : replies[0]));
  }

  async rpc(m) {
    if (m.id === undefined || m.id === null) return null; // bildirim
    const ok = (result) => ({ jsonrpc: '2.0', id: m.id, result });
    switch (m.method) {
      case 'initialize':
        return ok({ protocolVersion: m.params?.protocolVersion || '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'glassly', version: '1.0.0' } });
      case 'ping': return ok({});
      case 'tools/list':
        return ok({ tools: this.tools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const t = this.tools().find((x) => x.name === m.params?.name);
        if (!t) return ok({ content: [{ type: 'text', text: 'Bu araç şu an kullanılamıyor (bağlantı kapalı).' }], isError: true });
        try {
          const out = await t.run(m.params?.arguments || {});
          return ok({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] });
        } catch (e) {
          return ok({ content: [{ type: 'text', text: 'Hata: ' + e.message }], isError: true });
        }
      }
      default:
        return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Desteklenmeyen yöntem' } };
    }
  }

  // opencode yapılandırmasına eklenecek MCP girdileri
  mcpConfig() {
    const out = {};
    const st = this.status();
    if (this.port) {
      out.glassly = { type: 'remote', url: `http://127.0.0.1:${this.port}/mcp`, headers: { Authorization: `Bearer ${this.token}` }, enabled: true };
    }
    for (const s of st.custom) {
      if (!s.id || s.enabled === false) continue;
      if (s.type === 'remote' && s.url) out[s.id] = { type: 'remote', url: s.url, ...(s.token ? { headers: { Authorization: `Bearer ${s.token}` } } : {}), enabled: true };
      else if (s.type === 'local' && s.command) out[s.id] = { type: 'local', command: s.command.match(/(?:[^\s"]+|"[^"]*")+/g).map((x) => x.replace(/^"|"$/g, '')), enabled: true };
    }
    return out;
  }
}

module.exports = { Connections };
