// node tests/apikeys.integration.js (wrangler yerelde 8790 ve tests/api-upstream.cjs çalışırken)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const B = 'http://127.0.0.1:8790';
const dir = '/tmp/w2/state/v3/d1/miniflare-D1DatabaseObject/';
const files = readdirSync(dir).filter(x => x.endsWith('.sqlite') && x !== 'metadata.sqlite').map(x => dir + x);
assert.equal(files.length, 1);
const sql = q => execFileSync('sqlite3', [files[0], q], { encoding: 'utf8' }).trim();
// Canlı değil, yalnızca yerel veritabanı. Değişiklikten önce şemayı oku.
assert.match(sql("SELECT sql FROM sqlite_master WHERE name='api_usage'"), /uid TEXT PRIMARY KEY/);
const usersBefore = sql('SELECT COUNT(*) FROM users');
async function req(path, token, method = 'GET', body) {
  const r = await fetch(B + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const raw = await r.text();
  let data; try { data = JSON.parse(raw); } catch { data = raw; }
  return { status: r.status, data, raw };
}
const password = 'Test-' + crypto.randomUUID();
const users = [];
const body = { model: 'glassly', messages: [{ role: 'user', content: 'Merhaba' }] };
try {
  for (let i = 0; i < 2; i++) {
    const r = await req('/auth/register', null, 'POST', { name: 'API Test', email: `api-${crypto.randomUUID()}@example.com`, password });
    assert.equal(r.status, 200); users.push(r.data);
  }
  const [a, b] = users;
  const create = () => req('/auth/api-keys', a.token, 'POST', { name: 'Test anahtarı' });
  assert.equal((await req('/auth/api-keys')).status, 401);
  let k = (await create()).data;
  assert.match(k.key, /^gly_api_[a-f0-9]{64}$/);
  assert.equal((await create()).status, 409);
  assert.equal((await req('/auth/api-keys', b.token)).data.keys.length, 0);
  await req('/auth/api-keys/' + k.item.id, b.token, 'DELETE');
  assert.equal((await req('/v1/models', k.key)).data.data[0].id, 'glassly');
  assert.equal((await req('/api/chats', k.key)).status, 401);
  assert.equal((await req('/admin/stats', k.key)).status, 403);
  const listed = await req('/auth/api-keys', a.token);
  assert.equal(listed.raw.includes(k.key), false);
  assert.equal(sql(`SELECT COUNT(*) FROM api_keys WHERE h='${k.key}'`), '0');
  assert.equal((await req('/v1/chat/completions', k.key, 'POST', { ...body, max_tokens: 999 })).status, 400);
  const r1 = await req('/v1/chat/completions', k.key, 'POST', body);
  assert.equal(r1.status, 200); assert.equal(r1.data.model, 'glassly');
  const r2 = await req('/v1/chat/completions', k.key, 'POST', { ...body, stream: true });
  assert.equal(r2.status, 200); assert.match(r2.raw, /data: \[DONE\]/); assert.equal(r2.raw.includes('private-provider'), false);
  assert.equal((await req('/v1/chat/completions', k.key, 'POST', body)).status, 429);
  await req('/auth/api-keys/' + k.item.id, a.token, 'DELETE');
  assert.equal((await req('/v1/models', k.key)).status, 401);
  k = (await create()).data;
  assert.equal((await req('/v1/chat/completions', k.key, 'POST', body)).status, 429, 'rotation must not reset quota');
  const uid = a.user.id; assert.match(uid, /^[a-f0-9-]+$/);
  sql(`UPDATE api_usage SET n=9, minute=0, mn=0 WHERE uid='${uid}'`);
  let responses = await Promise.all(Array.from({ length: 6 }, () => req('/v1/chat/completions', k.key, 'POST', body)));
  assert.equal(responses.filter(x => x.status === 200).length, 1, 'daily quota must be atomic');
  assert.equal(sql(`SELECT n FROM api_usage WHERE uid='${uid}'`), '10');
  sql(`UPDATE api_usage SET n=0, minute=0, mn=0 WHERE uid='${uid}'`);
  responses = await Promise.all(Array.from({ length: 6 }, () => req('/v1/chat/completions', k.key, 'POST', body)));
  assert.equal(responses.filter(x => x.status === 200).length, 2, 'minute quota must be atomic');
  assert.equal((await req('/auth/me', a.token)).status, 200);
  console.log('PASS: self-service, isolation, hashing, stream/plain, revocation, rotation, atomic daily/minute limits, existing login.');
} finally {
  for (const u of users) assert.equal((await req('/auth/me', u.token, 'DELETE', { password })).status, 200);
  assert.equal(sql('SELECT COUNT(*) FROM users'), usersBefore);
  console.log('Local test accounts removed; existing user count unchanged.');
}
