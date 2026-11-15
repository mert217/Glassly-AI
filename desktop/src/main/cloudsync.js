'use strict';
// Glassly Bulut eşitlemesi: masaüstündeki sohbetler glassly.biz hesabına gönderilir (web ve telefonda görünür),
// web ve telefondaki sohbetler masaüstünde açılıp devam ettirilebilir, buluttaki hatırlatıcılar bildirim olarak gelir.

class CloudSync {
  constructor({ store, engine, accounts, notify }) {
    Object.assign(this, { store, engine, accounts, notify });
    this.timer = null;
  }
  on() { const u = this.accounts.current(); return !!(u && u.mode === 'bulut' && this.accounts.token()); }
  map() { return this.store.get('cloudMap') || {}; }
  link(sid, cloudId) { this.store.set('cloudMap', { ...this.map(), [sid]: cloudId }); }

  // Tamamlanan bir masaüstü sohbetini buluta yollar (yalnızca görünen yazılar; gizli bağlam ve araç çıktıları gitmez)
  async push(sid, directory) {
    if (!this.on() || !sid) return { ok: false };
    const [s, m] = await Promise.all([this.engine.request({ path: `/session/${sid}`, directory }), this.engine.request({ path: `/session/${sid}/message`, directory })]);
    if (!m.ok || !Array.isArray(m.data)) return { ok: false };
    const messages = m.data.map((x) => ({
      ext: x.info.id, role: x.info.role, t: x.info.time?.created,
      content: (x.parts || []).filter((p) => p.type === 'text' && !p.synthetic && !p.ignored && p.text).map((p) => p.text).join('\n\n'),
    })).filter((x) => x.content.trim() && (x.role === 'user' || x.role === 'assistant'));
    if (!messages.length) return { ok: false };
    const title = s.data?.title && !/^New session - /.test(s.data.title) ? s.data.title : messages[0].content.slice(0, 60);
    const chat = { ext: sid, id: this.map()[sid], title, created: s.data?.time?.created, updated: s.data?.time?.updated || Date.now(), messages };
    try { await this.accounts.remote('POST', '/api/sync', { chats: [chat] }); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
  // Web ve telefonda açılmış sohbetler (masaüstünden gelenler hariç)
  async list() {
    if (!this.on()) return [];
    const j = await this.accounts.remote('GET', '/api/chats');
    const linked = new Set(Object.values(this.map()));
    return (j.chats || []).filter((c) => c.src !== 'masaustu' && !linked.has(c.id)).slice(0, 60);
  }
  async get(id) { return this.accounts.remote('GET', '/api/chats/' + encodeURIComponent(id)); }

  // Buluttaki hatırlatıcılar: zamanı gelince masaüstü bildirimi
  start() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick().catch(() => {}), 60e3);
    setTimeout(() => this.tick().catch(() => {}), 15e3);
  }
  async tick() {
    if (!this.on()) return;
    const now = Date.now();
    if (!this.rems || now - this.remsAt > 5 * 60e3) { this.rems = (await this.accounts.remote('GET', '/api/reminders')).reminders || []; this.remsAt = now; }
    const shown = new Set(this.store.get('cloudRemShown') || []);
    let changed = false;
    for (const r of this.rems) {
      if (r.done || r.at > now || now - r.at > 30 * 60e3 || shown.has(r.id)) continue;
      shown.add(r.id); changed = true;
      this.notify('Glassly hatırlatıyor', r.text);
    }
    if (changed) this.store.set('cloudRemShown', [...shown].slice(-300));
  }
}
module.exports = { CloudSync };
