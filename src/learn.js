import { API_LIMITS } from './apikeys.js';

const hash = async s => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), x => x.toString(16).padStart(2, '0')).join('');
const random = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), x => x.toString(16).padStart(2, '0')).join('');
const bearer = request => (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
const allowedCode = /^[A-F0-9]{12}$/;
const allowedProof = /^[a-f0-9]{64}$/;
const allowedToken = /^gly_learn_[a-f0-9]{64}$/;
const SCENARIOS = new Map([
  ['cafe', 'A1. You are a friendly café barista helping the learner order a drink.'],
  ['travel', 'A2. You are a helpful local near a station. Practise asking for directions.'],
  ['interview', 'B1. You are a friendly job interviewer. Ask about experience and skills.'],
  ['daily', 'A1. Have a friendly everyday conversation about the learner’s day.'],
]);

export async function learn(request, route, { db, acc, json, fail, readJSON, blocked, open }) {
  const now = Date.now();
  if (request.method !== 'POST') return fail(405, 'Bu yöntem desteklenmiyor.');
  const b = await readJSON(request, 14000);
  if (!b || typeof b !== 'object' || Array.isArray(b)) return fail(400, 'Geçersiz istek.');
  if (route === 'start') {
    if (blocked('start')) return fail(429, 'Bir dakika sonra tekrar dene.');
    if (typeof b.proof !== 'string' || !allowedProof.test(b.proof)) return fail(400, 'Bağlantı doğrulaması geçersiz.');
    const code = random(6).toUpperCase();
    await db.batch([
      ['DELETE FROM learn_links WHERE expires < ? AND (token_exp IS NULL OR token_exp < ?)', now, now],
      ['INSERT INTO learn_links (code, proof, expires) VALUES (?, ?, ?)', code, b.proof, now + 300000],
    ]);
    return json(201, { code, expiresIn: 300 });
  }
  if (route === 'approve') {
    if (!allowedCode.test(String(b.code))) return fail(400, 'Bağlantı kodu geçersiz.');
    const me = await acc.userOf(request);
    if (!me) return fail(401, 'Önce Glassly hesabına giriş yap.', 'auth');
    if (blocked('approve')) return fail(429, 'Bir dakika sonra tekrar dene.');
    const row = await db.one(`UPDATE learn_links SET uid = ?, parent = ? WHERE code = ? AND uid IS NULL AND expires > ? RETURNING code`, me.id, await hash(bearer(request)), b.code, now);
    return row ? json(200, { ok:true }) : fail(404, 'Kodun süresi dolmuş veya zaten kullanılmış.');
  }
  if (route === 'exchange') {
    if (!allowedCode.test(String(b.code)) || !allowedProof.test(String(b.verifier))) return fail(400, 'Bağlantı doğrulaması geçersiz.');
    const proof = await hash(b.verifier);
    const row = await db.one(`SELECT l.uid FROM learn_links l LEFT JOIN sessions s ON s.h = l.parent AND s.uid = l.uid AND s.exp > ?
      WHERE l.code = ? AND l.proof = ? AND l.expires > ? AND l.token IS NULL AND (l.uid IS NULL OR s.h IS NOT NULL)`, now, b.code, proof, now);
    if (!row) return fail(404, 'Kod bulunamadı, süresi doldu veya kullanıldı.');
    if (!row.uid) return json(202, { pending:true });
    const token = 'gly_learn_' + random(32);
    const tokenExp = now + 86400000;
    const issued = await db.one(`UPDATE learn_links SET token = ?, token_exp = ? WHERE code = ? AND proof = ? AND expires > ? AND token IS NULL
      AND EXISTS (SELECT 1 FROM sessions WHERE h = learn_links.parent AND uid = learn_links.uid AND exp > ?) RETURNING uid`, await hash(token), tokenExp, b.code, proof, now, now);
    return issued ? json(200, { token, tokenExp }) : fail(409, 'Bağlantı artık geçerli değil. Tekrar başlat.');
  }
  if (route !== 'coach' && route !== 'disconnect') return fail(404, 'Bulunamadı.');
  const token = bearer(request);
  if (!allowedToken.test(token)) return fail(401, 'Öğrenme bağlantısı geçersiz.', 'auth');
  const h = await hash(token);
  if (route === 'disconnect') {
    await db.run('DELETE FROM learn_links WHERE token = ?', h);
    return json(200, {ok:true});
  }
  const scenario = SCENARIOS.get(b.scenario);
  const m = b.messages;
  if (!scenario || !Array.isArray(m) || !m.length || m.length > 9 || m.at(-1)?.role !== 'user' ||
    m.some(x => !x || !['user','assistant'].includes(x.role) || typeof x.content !== 'string' || !x.content.trim() || x.content.length > 1400)) return fail(400, 'Pratik mesajı geçersiz.');
  const linked = await db.one(`SELECT l.uid FROM learn_links l JOIN sessions s ON s.h = l.parent AND s.uid = l.uid AND s.exp > ?
    WHERE l.token = ? AND l.token_exp > ?`, now, h, now);
  if (!linked) return fail(401, 'Glassly bağlantısının süresi doldu. Yeniden bağlan.', 'auth');
  const minute = Math.floor(now / 60000);
  const used = await db.one(`INSERT INTO api_usage (uid, day, n, minute, mn) SELECT ?, ?, 1, ?, 1
    WHERE EXISTS (SELECT 1 FROM learn_links l JOIN sessions s ON s.h = l.parent AND s.uid = l.uid AND s.exp > ?
      WHERE l.token = ? AND l.uid = ? AND l.token_exp > ?)
    ON CONFLICT(uid) DO UPDATE SET n = CASE WHEN api_usage.day = excluded.day THEN api_usage.n+1 ELSE 1 END, day = excluded.day,
      mn = CASE WHEN api_usage.minute = excluded.minute THEN api_usage.mn+1 ELSE 1 END, minute = excluded.minute
    WHERE (api_usage.day != excluded.day OR api_usage.n < ?) AND (api_usage.minute != excluded.minute OR api_usage.mn < ?) RETURNING n`,
    linked.uid, acc.today(), minute, now, h, linked.uid, now, API_LIMITS.daily, API_LIMITS.perMinute);
  if (!used) return fail(429, 'Pratik sınırına ulaştın: hesap başına günlük 10, dakikada 2 istek.', 'rate_limit');
  const system = `You are Glassly, an English tutor for Turkish speakers. Scenario: ${scenario} Only do English practice in this scenario. First give 1–2 natural English sentences that advance the role-play, then a separate short Turkish correction if the learner made a meaningful error. End with at most one simple English follow-up question. Do not identify underlying providers or models. Do not use tools or emojis.`;
  try {
    const r = await open({model:'auto', stream:false, max_tokens:384, temperature:.65, messages:[{role:'system',content:system}, ...m.map(({role,content})=>({role,content}))]});
    if (!r.ok) throw new Error('upstream');
    const data = await r.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('empty');
    return json(200, {content:content.trim().slice(0,1400)});
  } catch { return fail(503, 'Glassly koçu şu an yanıt veremiyor. Biraz sonra tekrar dene.', 'unavailable'); }
}
