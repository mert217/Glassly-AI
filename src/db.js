// Glassly veri katmanı: Cloudflare D1 (SQLite). Tablolar ilk istekte kendiliğinden kurulur.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT 'sifre', created INTEGER NOT NULL, requests INTEGER NOT NULL DEFAULT 0,
    last_seen INTEGER NOT NULL DEFAULT 0, dev_seed TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS sessions (h TEXT PRIMARY KEY, uid TEXT NOT NULL, exp INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sessions_uid ON sessions(uid)`,
  `CREATE TABLE IF NOT EXISTS usage (uid TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (uid, day))`,
  `CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, uid TEXT NOT NULL, title TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS chats_uid ON chats(uid, updated)`,
  `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, t INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, id)`,
  `CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, uid TEXT NOT NULL, mime TEXT NOT NULL, data TEXT NOT NULL, t INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS images_uid ON images(uid)`,
  `CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, uid TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS reminders_uid ON reminders(uid, at)`,
  `CREATE TABLE IF NOT EXISTS extra (uid TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (uid, day, kind))`,
  `CREATE TABLE IF NOT EXISTS daily (day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, kind))`,
  `CREATE TABLE IF NOT EXISTS codes (c TEXT PRIMARY KEY, token TEXT NOT NULL, ch TEXT NOT NULL, exp INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY, h TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL, name TEXT NOT NULL,
    uid TEXT NOT NULL, created INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
    day TEXT NOT NULL DEFAULT '', n INTEGER NOT NULL DEFAULT 0,
    minute INTEGER NOT NULL DEFAULT 0, mn INTEGER NOT NULL DEFAULT 0,
    last_used INTEGER NOT NULL DEFAULT 0)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS api_key_active_owner ON api_keys(uid) WHERE revoked = 0`,
  `CREATE TABLE IF NOT EXISTS api_usage (
    uid TEXT PRIMARY KEY, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
    minute INTEGER NOT NULL DEFAULT 0, mn INTEGER NOT NULL DEFAULT 0)`,
];
// Sonradan eklenen sütunlar (varsa hata verir, yok sayılır)
const COLUMNS = [
  `ALTER TABLE messages ADD COLUMN meta TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE messages ADD COLUMN ext TEXT`,
];
const AFTER = [`CREATE UNIQUE INDEX IF NOT EXISTS messages_ext ON messages(chat_id, ext) WHERE ext IS NOT NULL`];

// Kurulum her istekte kendi bağlamında yapılır (Workers'ta bir isteğin başlattığı G/Ç başka istekte beklenemez);
// başarıyla bitince bir daha çalışmaz.
let done = false;
async function init(d1) {
  await d1.batch(SCHEMA.map((q) => d1.prepare(q)));
  for (const q of COLUMNS) await d1.prepare(q).run().catch(() => {});
  for (const q of AFTER) await d1.prepare(q).run();
  done = true;
}
export function openDB(d1) {
  let p = null;
  const ready = () => (done ? null : (p ||= init(d1)));
  const run = async (q, ...a) => { await ready(); return d1.prepare(q).bind(...a).run(); };
  const one = async (q, ...a) => { await ready(); return d1.prepare(q).bind(...a).first(); };
  const all = async (q, ...a) => { await ready(); return (await d1.prepare(q).bind(...a).all()).results || []; };
  return {
    run, one, all,
    batch: async (list) => { await ready(); return d1.batch(list.map(([q, ...a]) => d1.prepare(q).bind(...a))); },
    async setting(k, fallback = null) { const r = await one('SELECT v FROM settings WHERE k = ?', k); return r ? JSON.parse(r.v) : fallback; },
    async setSetting(k, v) { await run('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v)); },
  };
}
