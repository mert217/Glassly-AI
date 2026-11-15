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
];

let ready = null;
export function openDB(d1) {
  if (!ready) ready = d1.batch(SCHEMA.map((q) => d1.prepare(q))).catch((e) => { ready = null; throw e; });
  const run = async (q, ...a) => { await ready; return d1.prepare(q).bind(...a).run(); };
  const one = async (q, ...a) => { await ready; return d1.prepare(q).bind(...a).first(); };
  const all = async (q, ...a) => { await ready; return (await d1.prepare(q).bind(...a).all()).results || []; };
  return {
    run, one, all,
    batch: async (list) => { await ready; return d1.batch(list.map(([q, ...a]) => d1.prepare(q).bind(...a))); },
    async setting(k, fallback = null) { const r = await one('SELECT v FROM settings WHERE k = ?', k); return r ? JSON.parse(r.v) : fallback; },
    async setSetting(k, v) { await run('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v)); },
  };
}
