// Glassly test motoru: opencode sunucu API'sinin küçük bir taklidi.
// Arayüzü modele bağlanmadan geliştirmek/test etmek için:
//   npm run mock            (port 4777)
//   GLASSLY_ENGINE_URL=http://127.0.0.1:4777 npm start
'use strict';
const http = require('node:http');

const PORT = Number(process.env.PORT || 4777);
const clients = new Set();
const sessions = new Map();
const messages = new Map(); // sid -> [{info, parts}]
const pendingPerm = new Map();
let n = 0;
const id = (p) => `${p}_${Date.now().toString(36)}${(n++).toString(36).padStart(4, '0')}`;
const now = () => Date.now();
const DIR = process.env.MOCK_DIR || '/home/ahmet/projeler/hava-durumu';

function emit(type, properties, directory = DIR) {
  const data = JSON.stringify({ directory, payload: { id: id('evt'), type, properties } });
  for (const c of clients) c.write(`data: ${data}\n\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newSession(directory, title) {
  const s = { id: id('ses'), slug: 'demo', projectID: 'global', directory, title: title || `New session - ${new Date().toISOString()}`, version: 'mock', time: { created: now(), updated: now() } };
  sessions.set(s.id, s);
  messages.set(s.id, []);
  return s;
}

// Geçmiş birkaç sohbet
for (const [t, ago] of [['README dosyasını güncelle', 2 * 3600e3], ['API istemcisinde hata ayıklama', 26 * 3600e3], ['Docker yapılandırması', 4 * 864e5], ['Birim testleri ekle', 12 * 864e5]]) {
  const s = newSession(DIR, t); s.time.updated = now() - ago;
}

function upsertPart(sid, mid, part) {
  const m = messages.get(sid).find((x) => x.info.id === mid);
  const i = m.parts.findIndex((p) => p.id === part.id);
  if (i >= 0) m.parts[i] = part; else m.parts.push(part);
  emit('message.part.updated', { sessionID: sid, part, time: now() });
}

async function stream(sid, mid, part, text, field = 'text') {
  upsertPart(sid, mid, { ...part, [field]: '' });
  let acc = '';
  for (const chunk of text.match(/.{1,6}/gs)) {
    acc += chunk;
    emit('message.part.delta', { sessionID: sid, messageID: mid, partID: part.id, field, delta: chunk });
    await sleep(14);
  }
  const m = messages.get(sid).find((x) => x.info.id === mid);
  const p = m.parts.find((x) => x.id === part.id); p[field] = acc;
  return p;
}

async function run(sid, userText, model, synthetic = false) {
  const s = sessions.get(sid);
  const umid = id('msg');
  const uinfo = { id: umid, sessionID: sid, role: 'user', time: { created: now() }, agent: 'build', model };
  messages.get(sid).push({ info: uinfo, parts: [] });
  emit('message.updated', { sessionID: sid, info: uinfo });
  upsertPart(sid, umid, { id: id('prt'), sessionID: sid, messageID: umid, type: 'text', text: userText, ...(synthetic ? { synthetic: true } : {}) });
  emit('session.status', { sessionID: sid, status: { type: 'busy' } });

  if (synthetic) {
    const amid = id('msg');
    const ainfo = { id: amid, sessionID: sid, role: 'assistant', parentID: umid, modelID: model?.modelID, providerID: model?.providerID, mode: 'build', agent: 'build', cost: 0, tokens: { input: 900, output: 60, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: now() } };
    messages.get(sid).push({ info: ainfo, parts: [] });
    emit('message.updated', { sessionID: sid, info: ainfo });
    await sleep(300);
    await stream(sid, amid, { id: id('prt'), sessionID: sid, messageID: amid, type: 'text' }, `Kaldığım yerden devam ediyorum. Limit testi başarıyla atlatıldı; önceki işin sonucu yukarıda.`);
    ainfo.time.completed = now();
    emit('message.updated', { sessionID: sid, info: ainfo });
    emit('session.status', { sessionID: sid, status: { type: 'idle' } });
    emit('session.idle', { sessionID: sid });
    return;
  }

  if (/limit/i.test(userText)) {
    await sleep(600);
    emit('session.status', { sessionID: sid, status: { type: 'retry', attempt: 1, message: 'Free usage exceeded, subscribe to Go', action: { reason: 'free_tier_limit', provider: 'opencode', title: 'Free limit reached', message: 'Subscribe to OpenCode Go', label: 'subscribe', link: 'https://opencode.ai/go' }, next: now() + 3600e3 } });
    return;
  }

  const amid = id('msg');
  const ainfo = { id: amid, sessionID: sid, role: 'assistant', parentID: umid, modelID: model?.modelID, providerID: model?.providerID, mode: 'build', agent: 'build', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: now() } };
  messages.get(sid).push({ info: ainfo, parts: [] });
  emit('message.updated', { sessionID: sid, info: ainfo });
  await sleep(500);

  if (s.title.startsWith('New session')) {
    s.title = 'Hava durumu uygulamasında önbellek';
    s.time.updated = now();
    emit('session.updated', { sessionID: sid, info: s });
  }

  const r = { id: id('prt'), sessionID: sid, messageID: amid, type: 'reasoning', time: { start: now() } };
  const rp = await stream(sid, amid, r, 'Kullanıcı API çağrılarının yavaş olduğundan şikayet ediyor. Önce istemci koduna bakmalıyım, sonra basit bir bellek içi önbellek eklerim. Değişikliği küçük tutup test çalıştırırım.', 'text');
  rp.time.end = now() + 2100; upsertPart(sid, amid, rp);

  const todos = [
    { content: 'API istemcisini incele', status: 'in_progress', priority: 'high' },
    { content: 'Bellek içi önbellek ekle (5 dk TTL)', status: 'pending', priority: 'high' },
    { content: 'Testleri çalıştır', status: 'pending', priority: 'medium' },
  ];
  emit('todo.updated', { sessionID: sid, todos });

  const t1 = { id: id('prt'), sessionID: sid, messageID: amid, type: 'tool', callID: id('call'), tool: 'read', state: { status: 'running', input: { filePath: DIR + '/src/api/weather.ts' }, time: { start: now() } } };
  upsertPart(sid, amid, t1); await sleep(500);
  upsertPart(sid, amid, { ...t1, state: { ...t1.state, status: 'completed', output: '...', title: 'src/api/weather.ts', metadata: {}, time: { start: now(), end: now() } } });

  const t2 = { id: id('prt'), sessionID: sid, messageID: amid, type: 'tool', callID: id('call'), tool: 'grep', state: { status: 'completed', input: { pattern: 'fetchForecast' }, output: 'src/api/weather.ts:12\nsrc/pages/Home.tsx:31\nsrc/pages/City.tsx:18', title: 'fetchForecast', metadata: {}, time: { start: now(), end: now() } } };
  upsertPart(sid, amid, t2); await sleep(300);

  todos[0].status = 'completed'; todos[1].status = 'in_progress';
  emit('todo.updated', { sessionID: sid, todos });

  const diff = `--- a/src/api/weather.ts
+++ b/src/api/weather.ts
@@ -1,12 +1,24 @@
 import { http } from './http';
+
+const cache = new Map<string, { at: number; data: Forecast }>();
+const TTL = 5 * 60_000;
 
 export async function fetchForecast(city: string): Promise<Forecast> {
-  const res = await http.get(\`/forecast?q=\${city}\`);
-  return res.data;
+  const hit = cache.get(city);
+  if (hit && Date.now() - hit.at < TTL) return hit.data;
+  const res = await http.get(\`/forecast?q=\${encodeURIComponent(city)}\`);
+  cache.set(city, { at: Date.now(), data: res.data });
+  return res.data;
 }`;
  const callID = id('call');
  const t3 = { id: id('prt'), sessionID: sid, messageID: amid, type: 'tool', callID, tool: 'edit', state: { status: 'running', input: { filePath: DIR + '/src/api/weather.ts' }, time: { start: now() } } };
  upsertPart(sid, amid, t3);
  const permId = id('per');
  const decision = new Promise((resolve) => pendingPerm.set(permId, resolve));
  emit('permission.asked', { id: permId, sessionID: sid, permission: 'edit', patterns: ['src/api/weather.ts'], always: ['*'], metadata: { filepath: DIR + '/src/api/weather.ts', diff }, tool: { messageID: amid, callID } });
  const reply = await decision;
  if (reply === 'reject') {
    upsertPart(sid, amid, { ...t3, state: { ...t3.state, status: 'error', error: 'Kullanıcı bu değişikliği reddetti.', time: { start: now(), end: now() } } });
  } else {
    upsertPart(sid, amid, { ...t3, state: { ...t3.state, status: 'completed', output: '', title: 'src/api/weather.ts', metadata: { diff }, time: { start: now(), end: now() } } });
    emit('session.diff', { sessionID: sid, diff: [{ file: 'src/api/weather.ts', path: 'src/api/weather.ts', status: 'modified', additions: 8, deletions: 2, patch: diff }] });
  }
  todos[1].status = 'completed'; todos[2].status = 'in_progress';
  emit('todo.updated', { sessionID: sid, todos });

  const t4 = { id: id('prt'), sessionID: sid, messageID: amid, type: 'tool', callID: id('call'), tool: 'bash', state: { status: 'running', input: { command: 'npm test -- weather', description: 'Testleri çalıştır' }, time: { start: now() } } };
  upsertPart(sid, amid, t4); await sleep(900);
  upsertPart(sid, amid, { ...t4, state: { ...t4.state, status: 'completed', output: ' PASS  src/api/weather.test.ts\n  ✓ önbellekten döner (3 ms)\n  ✓ TTL dolunca yeniden ister (2 ms)\n\nTests: 2 passed, 2 total', title: 'npm test', metadata: {}, time: { start: now(), end: now() } } });
  todos[2].status = 'completed';
  emit('todo.updated', { sessionID: sid, todos });

  const text = `Önbelleği ekledim ve testler geçiyor.

## Ne değişti
- \`fetchForecast\` artık sonuçları **5 dakika** boyunca bellekte tutuyor.
- Şehir adı \`encodeURIComponent\` ile kodlanıyor — "İzmir" gibi adlarda bozulma olmuyor.

\`\`\`ts
const hit = cache.get(city);
if (hit && Date.now() - hit.at < TTL) return hit.data;
\`\`\`

| Durum | Önce | Sonra |
|---|---|---|
| Aynı şehir, 2. istek | ~420 ms | **< 1 ms** |
| Farklı şehir | ~420 ms | ~420 ms |

İstersen önbelleği \`localStorage\`'a taşıyıp sayfa yenilemelerinde de koruyabilirim.`;
  await stream(sid, amid, { id: id('prt'), sessionID: sid, messageID: amid, type: 'text' }, text);
  ainfo.time.completed = now();
  ainfo.tokens = { input: 8420, output: 612, reasoning: 120, cache: { read: 3100, write: 0 } };
  emit('message.updated', { sessionID: sid, info: ainfo });
  s.time.updated = now();
  emit('session.updated', { sessionID: sid, info: s });
  emit('session.status', { sessionID: sid, status: { type: 'idle' } });
  emit('session.idle', { sessionID: sid });
}

const free = (name) => ({ name, cost: { input: 0, output: 0 }, tool_call: true });
const PROVIDERS = {
  all: [
    { id: 'opencode', name: 'OpenCode Zen', models: { 'big-pickle': free('Big Pickle'), 'glm-5.3-flash-free': free('GLM 5.3 Flash'), 'deepseek-v4.1-flash-free': free('DeepSeek V4.1 Flash'), 'minimax-m3.1-flash-free': free('MiniMax M3.1 Flash'), 'mimo-v2.6-flash-free': free('MiMo V2.6 Flash') } },
    { id: 'anthropic', name: 'Anthropic', models: { 'claude-sonnet-4-6': { name: 'Claude Sonnet 4.6', cost: { input: 3, output: 15 } } } },
    { id: 'openai', name: 'OpenAI', models: { 'gpt-5.6': { name: 'GPT-5.6', cost: { input: 2, output: 10 } } } },
    { id: 'google', name: 'Google', models: { 'gemini-3-pro': { name: 'Gemini 3 Pro', cost: { input: 2, output: 12 } } } },
    { id: 'openrouter', name: 'OpenRouter', models: {} }, { id: 'deepseek', name: 'DeepSeek', models: {} }, { id: 'groq', name: 'Groq', models: {} },
  ],
  default: { opencode: 'big-pickle' },
  connected: ['opencode', 'anthropic'],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const dir = decodeURIComponent(req.headers['x-opencode-directory'] || '') || DIR;
  let body = '';
  for await (const c of req) body += c;
  const json = body ? JSON.parse(body) : {};
  const send = (data, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  const p = url.pathname;
  let m;
  if (p === '/global/health') return send({ healthy: true, version: 'mock' });
  if (p === '/global/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ payload: { type: 'server.connected', properties: {} } })}\n\n`);
    clients.add(res); req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/provider') return send(PROVIDERS);
  if (p === '/command') return send([{ name: 'init', description: 'AGENTS.md dosyası oluştur', source: 'command' }, { name: 'review', description: 'Değişiklikleri incele', source: 'command' }]);
  if (p === '/find/file') return send(['src/api/weather.ts', 'src/api/http.ts', 'src/pages/Home.tsx', 'src/pages/City.tsx', 'package.json', 'README.md'].filter((f) => f.includes(url.searchParams.get('query') || '')));
  if (p === '/session' && req.method === 'GET') return send([...sessions.values()].filter((s) => s.directory === dir));
  if (p === '/session' && req.method === 'POST') return send(newSession(dir));
  if ((m = p.match(/^\/session\/([^/]+)$/))) {
    const s = sessions.get(m[1]);
    if (req.method === 'DELETE') { sessions.delete(m[1]); emit('session.deleted', { sessionID: m[1], info: s }); return send(true); }
    if (req.method === 'PATCH') { Object.assign(s, json); s.time.updated = now(); emit('session.updated', { sessionID: s.id, info: s }); return send(s); }
    return send(s);
  }
  if ((m = p.match(/^\/session\/([^/]+)\/message$/))) return send(messages.get(m[1]) || []);
  if ((m = p.match(/^\/session\/([^/]+)\/(todo|diff)$/))) return send([]);
  if ((m = p.match(/^\/session\/([^/]+)\/prompt_async$/))) {
    const text = (json.parts || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
    run(m[1], text, json.model, (json.parts || []).some((x) => x.synthetic));
    res.writeHead(204); return res.end();
  }
  if ((m = p.match(/^\/session\/([^/]+)\/abort$/))) { emit('session.status', { sessionID: m[1], status: { type: 'idle' } }); return send(true); }
  if ((m = p.match(/^\/permission\/([^/]+)\/reply$/))) { pendingPerm.get(m[1])?.(json.reply); pendingPerm.delete(m[1]); return send(true); }
  if (p.startsWith('/auth/')) return send(true);
  send({ message: 'bulunamadı: ' + p }, 404);
});
server.listen(PORT, '127.0.0.1', () => console.log(`Glassly test motoru: http://127.0.0.1:${PORT}`));
