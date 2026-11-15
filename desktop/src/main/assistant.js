'use strict';
// Glassly asistanı: kalıcı hafıza ve hatırlatıcılar (zamanlanmış işler).
// Veriler glassly.json içinde tutulur; zamanlayıcı ana süreçte çalışır.

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const REPEATS = ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'hourly'];
const REPEAT_TR = { none: 'Bir kez', daily: 'Her gün', weekdays: 'Hafta içi her gün', weekly: 'Her hafta', monthly: 'Her ay', hourly: 'Her saat' };

function nextTime(at, repeat, now = Date.now()) {
  if (!repeat || repeat === 'none') return null;
  const d = new Date(at);
  let guard = 0;
  while (d.getTime() <= now && guard++ < 5000) {
    if (repeat === 'hourly') d.setHours(d.getHours() + 1);
    else if (repeat === 'daily') d.setDate(d.getDate() + 1);
    else if (repeat === 'weekly') d.setDate(d.getDate() + 7);
    else if (repeat === 'monthly') d.setMonth(d.getMonth() + 1);
    else if (repeat === 'weekdays') {
      d.setDate(d.getDate() + 1);
      while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    } else return null;
  }
  return d.getTime();
}

function parseWhen(when, inMinutes) {
  if (inMinutes != null && inMinutes !== '' && !Number.isNaN(Number(inMinutes))) return Date.now() + Number(inMinutes) * 60e3;
  if (!when) return NaN;
  const s = String(when).trim();
  // "09:30" -> bugün (geçtiyse yarın)
  const hm = s.match(/^(\d{1,2})[:.](\d{2})$/);
  if (hm) {
    const d = new Date();
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  // "2026-11-14 09:00" biçimini de kabul et (yerel saat)
  const t = new Date(s.replace(/^(\d{4}-\d{2}-\d{2})\s+/, '$1T')).getTime();
  return t;
}

const fmt = (t) => new Date(t).toLocaleString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

class Assistant extends EventEmitter {
  constructor({ store }) {
    super();
    this.store = store;
    this.timer = null;
    this.scope = () => null; // giriş yapan hesabın kimliği; hafıza ve hatırlatıcılar hesaba özeldir
  }
  key(name) { return `hesap.${this.scope() || '_'}.${name}`; }

  // ------------------------------------------------------------ hafıza
  memoryEnabled() { return this.store.get('memoryEnabled') !== false; }
  memories() { return this.store.get(this.key('memory')) || []; }
  remember(text) {
    const t = String(text || '').trim().slice(0, 500);
    if (!t) throw new Error('Boş bilgi kaydedilemez.');
    const list = this.memories();
    const dup = list.find((m) => m.text.toLocaleLowerCase('tr') === t.toLocaleLowerCase('tr'));
    if (dup) return dup;
    const m = { id: crypto.randomBytes(4).toString('hex'), text: t, at: Date.now() };
    this.store.set(this.key('memory'), [...list, m].slice(-200));
    this.emit('changed', 'memory');
    return m;
  }
  forget(id) {
    const list = this.memories();
    const next = list.filter((m) => m.id !== id);
    this.store.set(this.key('memory'), next);
    this.emit('changed', 'memory');
    return list.length !== next.length;
  }
  memoryText() {
    if (!this.memoryEnabled()) return '';
    const list = this.memories();
    if (!list.length) return '';
    return list.map((m) => `- ${m.text}`).join('\n');
  }

  // ------------------------------------------------------------ hatırlatıcılar
  reminders() { return (this.store.get(this.key('reminders')) || []).slice().sort((a, b) => a.at - b.at); }
  addReminder({ text, when, in_minutes, repeat = 'none', task = false }) {
    const at = parseWhen(when, in_minutes);
    if (!Number.isFinite(at)) throw new Error('Zaman anlaşılamadı. ISO biçimi kullan, ör. 2026-11-14T09:00, ya da in_minutes ver.');
    const rep = REPEATS.includes(repeat) ? repeat : 'none';
    let first = at;
    if (first < Date.now() - 60e3) {
      if (rep === 'none') throw new Error('Bu zaman geçmişte kaldı: ' + fmt(at));
      first = nextTime(at, rep);
    }
    const r = { id: crypto.randomBytes(4).toString('hex'), text: String(text || '').trim().slice(0, 1000), at: first, repeat: rep, task: !!task, created: Date.now() };
    if (!r.text) throw new Error('Hatırlatıcı metni boş.');
    this.store.set(this.key('reminders'), [...this.reminders(), r]);
    this.emit('changed', 'reminders');
    return r;
  }
  removeReminder(id) {
    const list = this.reminders();
    const next = list.filter((r) => r.id !== id);
    this.store.set(this.key('reminders'), next);
    this.emit('changed', 'reminders');
    return list.length !== next.length;
  }
  describe(r) {
    return { id: r.id, text: r.text, when: fmt(r.at), iso: new Date(r.at).toISOString(), repeat: REPEAT_TR[r.repeat] || r.repeat, task: r.task };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 15e3);
    setTimeout(() => this.tick(), 3000);
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  tick() {
    const now = Date.now();
    const list = this.reminders();
    let changed = false;
    const keep = [];
    for (const r of list) {
      if (r.at > now) { keep.push(r); continue; }
      changed = true;
      // Uygulama uzun süre kapalı kaldıysa çok eski tek seferlik hatırlatıcıyı yine de bir kez göster
      this.emit('fire', r);
      const nx = nextTime(r.at, r.repeat, now);
      if (nx) keep.push({ ...r, at: nx });
    }
    if (changed) {
      this.store.set(this.key('reminders'), keep);
      this.emit('changed', 'reminders');
    }
  }

  // ------------------------------------------------------------ ajan araçları
  tools(add, str, num) {
    add('reminder_add',
      'Kullanıcıya hatırlatıcı kurar veya ileri bir zamana iş planlar. "task" true ise o zaman geldiğinde Glassly metindeki işi kendisi yapar (ör. "gelen kutumu özetle"); false ise sadece bildirim gösterir. Zamanı kullanıcının yerel saatine göre ISO biçiminde ver (ör. 2026-11-14T09:00) ya da in_minutes kullan.',
      {
        text: str('Hatırlatılacak şey ya da yapılacak işin talimatı'),
        when: str('Yerel saatle ISO tarih-saat (ör. 2026-11-14T09:00) veya sadece "09:30"'),
        in_minutes: num('Şu andan kaç dakika sonra (when yerine)'),
        repeat: { type: 'string', enum: REPEATS, description: 'Tekrar: none, daily, weekdays, weekly, monthly, hourly' },
        task: { type: 'boolean', description: 'true: zamanı gelince işi Glassly yapsın; false: sadece hatırlat' },
      }, ['text'],
      async (a) => {
        const r = this.addReminder(a);
        return { ok: true, ...this.describe(r) };
      });
    add('reminder_list', 'Kurulu hatırlatıcıları ve zamanlanmış işleri listeler.', {}, [],
      async () => ({ now: fmt(Date.now()), reminders: this.reminders().map((r) => this.describe(r)) }));
    add('reminder_delete', 'Bir hatırlatıcıyı siler.', { id: str('Hatırlatıcı kimliği') }, ['id'],
      async ({ id }) => (this.removeReminder(id) ? 'Silindi.' : 'Bu kimlikle hatırlatıcı yok.'));

    if (this.memoryEnabled()) {
      add('memory_save',
        'Kullanıcı hakkında kalıcı bir bilgiyi hafızaya kaydeder (ad, meslek, tercih, sık kullanılan kişi/adres, önemli tarih). Kullanıcı "bunu hatırla" dediğinde ya da gelecekte işe yarayacak kalıcı bir bilgi paylaştığında kullan. Geçici veya hassas bilgileri (şifre, kart numarası) kaydetme.',
        { fact: str('Kısa, tek cümlelik bilgi. Ör: "Kullanıcının adı Ahmet, Konya\'da yaşıyor."') }, ['fact'],
        async ({ fact }) => ({ saved: true, ...this.remember(fact) }));
      add('memory_list', 'Hafızadaki bilgileri listeler.', {}, [], async () => this.memories());
      add('memory_forget', 'Hafızadan bir bilgiyi siler.', { id: str('Bilgi kimliği') }, ['id'],
        async ({ id }) => (this.forget(id) ? 'Silindi.' : 'Bu kimlikle bilgi yok.'));
    }
  }
}

module.exports = { Assistant, REPEAT_TR, nextTime, parseWhen };
