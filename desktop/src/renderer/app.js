// Glassly arayüz mantığı
const G = window.glassly;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => window.Markdown.escape(String(s ?? ''));
const icon = (n, s) => window.Icons.svg(n, s);
const lower = (s) => String(s || '').toLocaleLowerCase('tr');

const state = {
  cfg: {},
  engine: { state: 'idle' },
  project: null,
  scratch: null,
  sessions: [],
  current: null,
  data: new Map(),          // sessionID -> { msgs: Map, order: [], busy, todos, diffs, error }
  providers: [],
  connected: [],
  models: [],               // { key, providerID, modelID, name, provider, free }
  commands: [],
  pendingPermissions: [],
  attachments: [],
  uploads: [],              // eklenen dosyalar: { name, kind: text|image, text?, url?, mime?, loading?, error? }
  voiceChat: false,
  taskSessions: new Map(),  // hatırlatıcıdan başlayan işler: sid -> başlık
  suggest: null,
};

// ================================================================ yardımcılar
const isDaily = () => state.cfg.mode !== 'kod';
const curDir = () => (isDaily() ? state.daily || state.scratch : state.project || state.scratch);
const agentName = () => (isDaily() ? 'gunluk' : state.cfg.agent || 'build');
// Ücretsiz / Glassly modelleri kullanıcıya tek bir asistan olarak görünür
const brandName = (m) => (!m ? 'Model seç' : m.free || m.providerID === 'glassly' ? 'Glassly' : m.name);
async function api(method, path, body, directory = curDir()) {
  const r = await G.api({ method, path, body, directory });
  if (!r.ok) throw new Error(r.error || 'İstek başarısız');
  return r.data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3600);
  setTimeout(() => el.remove(), 4000);
}

const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
const fmtNum = (n) => (n >= 1e6 ? (n / 1e6).toLocaleString('tr-TR', { maximumFractionDigits: 1 }) + ' mn' : n >= 1000 ? (n / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 1 }) + ' bin' : String(n));
const fileUrl = (abs) => {
  const p = abs.replace(/\\/g, '/');
  return 'file://' + (p.startsWith('/') ? '' : '/') + encodeURI(p);
};
const joinPath = (dir, rel) => (/^([a-zA-Z]:)?[\\/]/.test(rel) ? rel : dir.replace(/[\\/]$/, '') + (dir.includes('\\') ? '\\' : '/') + rel);

function sessionData(id) {
  if (!state.data.has(id)) state.data.set(id, { msgs: new Map(), order: [], busy: false, todos: [], diffs: [], loaded: false });
  return state.data.get(id);
}

function relTime(ms) {
  const d = new Date(ms); const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= startToday) return 'Bugün';
  if (ms >= startToday - 864e5) return 'Dün';
  if (ms >= startToday - 6 * 864e5) return 'Bu hafta';
  if (ms >= startToday - 29 * 864e5) return 'Bu ay';
  return d.toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' });
}

// ================================================================ tema
function applyTheme() {
  const c = state.cfg;
  const apply = (mode) => {
    document.documentElement.dataset.theme = mode;
    const dark = mode === 'aurora';
    G.setOverlay({ color: '#00000000', symbolColor: dark ? '#c9d2ff' : '#3d4266' });
    $('#btnTheme').innerHTML = icon(dark ? 'moon' : 'sun');
  };
  if (c.theme === 'system') G.nativeTheme().then((t) => apply(t === 'dark' ? 'aurora' : 'frost'));
  else apply(c.theme || 'aurora');
  document.documentElement.dataset.accent = c.accent || 'iris';
  document.documentElement.dataset.motion = c.motion === false ? 'off' : 'on';
  document.documentElement.style.setProperty('--blur', (c.blur ?? 28) + 'px');
}

async function setCfg(key, value) {
  state.cfg[key] = value;
  await G.store.set(key, value);
}

// ================================================================ motor
function renderEngine() {
  const s = state.engine;
  const pill = $('#enginePill');
  pill.className = 'engine-pill ' + s.state;
  const label = { ready: 'Motor hazır', installing: s.message || 'Kuruluyor', starting: 'Başlatılıyor', error: 'Motor hatası', idle: 'Durdu' }[s.state] || s.message;
  $('.label', pill).textContent = label;
  pill.title = s.message || '';
  $('#send').disabled = s.state !== 'ready' && !isBusy();
}

async function onEngineReady() {
  await Promise.all([loadModels(), loadCommands()]);
  if (state.project || state.current) await loadSessions();
  if (state.current) await openSession(state.current, true);
}

async function loadModels() {
  try {
    const d = await api('GET', '/provider');
    state.providers = d.all || [];
    state.connected = d.connected || [];
    const models = [];
    for (const p of state.providers) {
      const customIds = (state.cfg.customProviders || []).map((c) => c.id);
      if (!state.connected.includes(p.id) && p.id !== 'glassly' && !customIds.includes(p.id)) continue;
      for (const [id, m] of Object.entries(p.models || {})) {
        if (m.status === 'deprecated') continue;
        const free = p.id === 'glassly' || !m.cost || (m.cost.input === 0 && m.cost.output === 0);
        models.push({ key: `${p.id}/${id}`, providerID: p.id, modelID: id, name: m.name || id, provider: p.name || p.id, free, reasoning: !!m.reasoning, vision: !!(m.attachment || m.modalities?.input?.includes('image') || m.capabilities?.input?.image) });
      }
    }
    // Ücretsiz Zen modelleri her zaman en üstte
    const rank = (m) => (m.providerID === 'glassly' ? (m.modelID === 'auto' ? 3 : 2) : m.providerID === 'opencode' ? 1 : 0);
    models.sort((a, b) => rank(b) - rank(a) || (b.free - a.free) || a.name.localeCompare(b.name, 'tr'));
    state.models = models;
    const cur = state.cfg.model;
    if (!cur || !models.some((m) => m.key === cur) || isLocked(cur)) {
      const pick = models.find((m) => m.free && !isLocked(m.key)) || models[0];
      if (pick) await setCfg('model', pick.key);
    }
    renderModelChip();
  } catch (e) { console.warn(e); }
}

async function loadCommands() {
  try {
    const list = await api('GET', '/command');
    state.commands = (list || []).map((c) => ({ name: c.name, description: c.description || '', source: c.source }));
  } catch { state.commands = []; }
}

function isLocked(key) {
  const until = (state.cfg.lockedModels || {})[key];
  return until && until > Date.now();
}

function currentModel() {
  return state.models.find((m) => m.key === state.cfg.model) || null;
}

function renderModelChip() {
  const m = currentModel();
  $('#modelLabel').textContent = brandName(m);
  $('#modelChip').title = m && !(m.free || m.providerID === 'glassly') ? `${m.provider} · ${m.modelID}` : '';
}

// ================================================================ proje & oturumlar
async function setProject(dir) {
  state.project = dir;
  if (dir) {
    const list = [dir, ...(state.cfg.projects || []).filter((p) => p !== dir)].slice(0, 8);
    await setCfg('projects', list);
  }
  await setCfg('currentProject', dir);
  $('#projectName').textContent = dir ? baseName(dir) : 'Hızlı sohbet';
  $('#projectChip').title = dir || 'Klasörsüz sohbet';
  state.current = null;
  showWelcome();
  await loadSessions();
}

// Sohbetler hesaba özeldir: her sohbetin sahibi kaydedilir, başka hesabın sohbeti listelenmez
const sessionOwners = () => state.cfg.sessionOwners || {};
function ownSession(id) {
  const uid = acct.status?.user?.id;
  if (!uid || !id) return;
  state.cfg.sessionOwners = { ...sessionOwners(), [id]: uid };
  G.store.set('sessionOwners', state.cfg.sessionOwners);
}
const mySession = (s) => sessionOwners()[s.id] === acct.status?.user?.id;

async function loadSessions() {
  if (state.engine.state !== 'ready') return;
  const dir = curDir();
  try {
    const list = await api('GET', '/session', undefined, dir);
    state.sessions = (list || [])
      .filter((s) => !s.parentID && (!s.directory || s.directory === dir) && mySession(s))
      .sort((a, b) => b.time.updated - a.time.updated);
  } catch { state.sessions = []; }
  renderSessions();
}

function renderSessions() {
  const box = $('#sessionList');
  const q = lower($('#sessionFilter').value);
  const items = state.sessions.filter((s) => !q || lower(s.title).includes(q));
  if (!items.length) {
    box.innerHTML = `<div class="list-empty">${q ? 'Eşleşen sohbet yok.' : 'Henüz sohbet yok.<br>Aşağıdan bir iş ver, başlasın.'}</div>`;
    return;
  }
  let html = '', last = '';
  for (const s of items) {
    const g = relTime(s.time.updated);
    if (g !== last) { html += `<div class="group-label">${g}</div>`; last = g; }
    const busy = state.data.get(s.id)?.busy;
    html += `<div class="session-item ${s.id === state.current ? 'active' : ''}" data-id="${s.id}" role="button" tabindex="0">
      ${busy ? '<span class="busy"></span>' : ''}<span class="t">${esc(cleanTitle(s.title))}</span>
      <span class="acts"><button data-act="rename" title="Yeniden adlandır">${icon('edit', 14)}</button><button data-act="delete" title="Sil">${icon('trash', 14)}</button></span>
    </div>`;
  }
  box.innerHTML = html;
}

const cleanTitle = (t) => (!t || /^New session - /.test(t) ? 'Yeni sohbet' : t);

async function newSession() {
  state.current = null;
  $('#sessionTitle').value = '';
  showWelcome();
  renderSessions();
  renderInspector();
  $('#input').focus();
}

async function ensureSession() {
  if (state.current) return state.current;
  const s = await api('POST', '/session', {});
  ownSession(s.id);
  state.sessions.unshift(s);
  state.current = s.id;
  sessionData(s.id).loaded = true;
  renderSessions();
  showThread();
  return s.id;
}

async function openSession(id, force = false) {
  state.current = id;
  const s = state.sessions.find((x) => x.id === id);
  $('#sessionTitle').value = s ? cleanTitle(s.title) : '';
  renderSessions();
  showThread();
  const d = sessionData(id);
  if (!d.loaded || force) {
    try {
      const msgs = await api('GET', `/session/${id}/message`);
      d.msgs.clear(); d.order = [];
      for (const m of msgs || []) {
        d.msgs.set(m.info.id, { info: m.info, parts: new Map(m.parts.map((p) => [p.id, p])) });
        d.order.push(m.info.id);
      }
      d.loaded = true;
      api('GET', `/session/${id}/todo`).then((t) => { d.todos = t || []; renderInspector(); }).catch(() => {});
      api('GET', `/session/${id}/diff`).then((t) => { d.diffs = t || []; renderInspector(); }).catch(() => {});
    } catch (e) { toast('Sohbet yüklenemedi: ' + e.message, 'err'); }
  }
  renderThread();
  renderInspector();
  scrollToEnd(true);
}

function showWelcome() {
  $('#welcome').hidden = false;
  $('#thread').hidden = true;
  $('#banner').hidden = true;
  renderWelcome();
  updateComposer();
}

function showThread() {
  $('#welcome').hidden = true;
  $('#thread').hidden = false;
}

function renderWelcome() {
  const rec = (state.cfg.projects || []).slice(0, 5);
  $('#recentProjects').innerHTML = rec.map((p) => `<button data-project="${esc(p)}" title="${esc(p)}">${icon('folder', 14)}<span>${esc(baseName(p))}</span></button>`).join('');
  $('#welcomeLede').textContent = isDaily()
    ? 'Günlük işlerinde yanındayım: e-postanı yazar, takvimini düzenler, sana hatırlatır, belgelerini okur. İstersen konuşarak sor.'
    : 'Kodunu berrak görür. Dosya okur, düzenler, komut çalıştırır — ücretsiz, anahtar gerekmeden.';
  const ideas = isDaily()
    ? [
        ['mail', 'Gelen kutum', 'Okunmamış e-postalarımı özetle.'],
        ['calendar', 'Bu hafta', 'Bu haftaki toplantılarımı listele, boş zamanlarımı söyle.'],
        ['bell', 'Hatırlat', 'Yarın sabah 9\'da faturayı ödemeyi bana hatırlat.'],
      ]
    : state.project
    ? [
        ['book', 'Projeyi tanı', 'Bu projenin yapısını ve nasıl çalıştığını kısaca anlat.'],
        ['shield', 'Hata avı', 'Koddaki olası hataları ve güvenlik açıklarını bul, önem sırasına göre listele.'],
        ['bolt', 'Test yaz', 'En kritik modül için anlamlı birim testleri yaz ve çalıştır.'],
      ]
    : [
        ['spark', 'Fikir taşla', 'Hafta sonu yapabileceğim küçük ama etkileyici bir yazılım projesi öner.'],
        ['terminal', 'Komut açıkla', 'git rebase -i HEAD~3 komutu tam olarak ne yapar?'],
        ['book', 'Kavram öğren', 'Event loop nedir? Basit bir örnekle anlat.'],
      ];
  if (isDaily()) renderConnChips();
  $('#ideas').innerHTML = ideas.map(([ic, t, p]) => `<button class="idea glass" data-prompt="${esc(p)}">${icon(ic)}<b>${t}</b><span>${esc(p)}</span></button>`).join('');
}

// ================================================================ konuşma çizimi
const TOOL_META = {
  bash: ['terminal', 'Komut'], read: ['file', 'Okudu'], edit: ['pencil', 'Düzenledi'], write: ['pencil', 'Yazdı'],
  patch: ['pencil', 'Yama'], grep: ['search', 'Aradı'], glob: ['search', 'Dosya aradı'], list: ['list', 'Listeledi'],
  webfetch: ['globe', 'Web'], websearch: ['globe', 'Web araması'], todowrite: ['check', 'Planı güncelledi'],
  todoread: ['check', 'Planı okudu'], task: ['layers', 'Alt ajan'], skill: ['book', 'Yetenek'], question: ['question', 'Soru'],
};

const CONN_META = {
  gmail_search: ['mail', 'Gmail\'de aradı'], gmail_read: ['mail', 'E-postayı okudu'], gmail_send: ['mail', 'E-posta gönderdi'], gmail_draft: ['mail', 'Taslak oluşturdu'],
  drive_search: ['drive', 'Drive\'da aradı'], drive_read: ['drive', 'Drive dosyasını okudu'], drive_create: ['drive', 'Drive\'da oluşturdu'],
  github_repos: ['github', 'Depoları listeledi'], github_search: ['github', 'GitHub\'da aradı'], github_issue: ['github', 'Issue okudu'], github_file: ['github', 'Dosya okudu'],
  github_create_issue: ['github', 'Issue açtı'], github_comment: ['github', 'Yorum yazdı'],
  calendar_list: ['calendar', 'Takvime baktı'], calendar_create: ['calendar', 'Takvime ekledi'], calendar_delete: ['calendar', 'Takvimden sildi'],
  reminder_add: ['bell', 'Hatırlatıcı kurdu'], reminder_list: ['bell', 'Hatırlatıcılara baktı'], reminder_delete: ['bell', 'Hatırlatıcı sildi'],
  memory_save: ['memory', 'Hafızaya kaydetti'], memory_list: ['memory', 'Hafızaya baktı'], memory_forget: ['memory', 'Hafızadan sildi'],
};
function toolMeta(name) {
  if (TOOL_META[name]) return TOOL_META[name];
  const k = Object.keys(CONN_META).find((x) => name === x || name.endsWith('_' + x));
  if (k) return CONN_META[k];
  return ['plug', String(name).replace(/^[a-z0-9-]+_/, '').replace(/_/g, ' ')];
}

function toolArg(part) {
  const i = part.state?.input || {};
  if (i.to || i.subject) return [i.to, i.subject].filter(Boolean).join(' · ');
  if (i.fact) return i.fact;
  if (/reminder_add$/.test(part.tool) && i.text) return i.text;
  if (i.title && i.start) return `${i.title} · ${new Date(i.start).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })}`;
  if (i.repo) return i.repo + (i.number ? ' #' + i.number : i.path ? '/' + i.path : i.title ? ' · ' + i.title : '');
  const rel = (p) => (p && state.project && p.startsWith(state.project) ? p.slice(state.project.length + 1) : p);
  return i.command || rel(i.filePath) || i.pattern || i.url || i.query || rel(i.path) || i.description || i.name || part.state?.title || '';
}

function renderDiffText(diff) {
  return diff.split('\n').map((l) => {
    const cls = l.startsWith('+++') || l.startsWith('---') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : '';
    return `<span class="diff-line ${cls}">${esc(l) || ' '}</span>`;
  }).join('');
}

function toolHTML(part) {
  const st = part.state || {};
  const [ic, label] = toolMeta(part.tool);
  const status = st.status;
  const stHTML = status === 'completed' ? `<span class="st ok">${icon('check', 14)}</span>`
    : status === 'error' ? `<span class="st err">${icon('x', 14)} hata</span>`
    : `<span class="st"><span class="spin"></span></span>`;
  let body = '';
  const diff = st.metadata?.diff;
  if (diff) body = `<div class="tool-body"><pre style="padding:8px 0">${renderDiffText(diff)}</pre></div>`;
  else if (part.tool === 'bash' && (st.input?.command || st.output || st.metadata?.output)) {
    body = `<div class="tool-body"><pre>$ ${esc(st.input?.command || '')}\n${esc(st.output ?? st.metadata?.output ?? '')}</pre></div>`;
  } else if (status === 'error') body = `<div class="tool-body"><pre>${esc(st.error || '')}</pre></div>`;
  else if (st.output && !['read', 'todowrite', 'todoread'].includes(part.tool)) body = `<div class="tool-body"><pre>${esc(String(st.output).slice(0, 8000))}</pre></div>`;
  const open = part._open ? 'true' : '';
  return `<div class="tool ${status === 'error' ? 'error' : ''}" data-part="${part.id}">
    <button class="tool-head" data-toggle="${part.id}" ${body ? '' : 'disabled style="cursor:default"'}>
      <span class="kind">${icon(ic, 15)}</span><span class="label">${esc(label)}</span>
      <span class="arg">${esc(toolArg(part))}</span>${stHTML}
    </button>${body ? `<div class="tool-collapse" ${open ? '' : 'hidden'}>${body}</div>` : ''}
  </div>`;
}

function partHTML(part, streaming) {
  if (part.type === 'text') {
    if (part.synthetic || part.ignored || !part.text) return '';
    return `<div class="prose ${streaming ? 'caret' : ''}" data-part="${part.id}">${window.Markdown.render(part.text)}</div>`;
  }
  if (part.type === 'reasoning') {
    // Düşünme metni gösterilmez; yalnızca sürerken kısa bir gösterge çıkar
    if (part.time?.end || !streaming) return '';
    return `<div class="reasoning thinking-now" data-part="${part.id}">${icon('brain', 15)}<span>Düşünüyor…</span></div>`;
  }
  if (part.type === 'tool') return toolHTML(part);
  if (part.type === 'file') return `<span class="chip" data-part="${part.id}">${icon('file', 12)}${esc(part.filename || 'dosya')}</span>`;
  return '';
}

function rawError(err) {
  if (!err) return '';
  if (err.name === 'MessageAbortedError') return '';
  return err.data?.message || err.message || err.name || 'Bilinmeyen hata';
}

// Sohbette görünen hata: limit / model hataları gizlenir, Glassly kendisi başka yoldan devam eder
function errorText(err) {
  const t = rawError(err);
  if (!t || LIMIT_RE.test(t)) return '';
  if (/model|provider|api key|unauthorized|401|403|overloaded|503|502|timeout/i.test(t)) return 'Glassly bu yanıtı tamamlayamadı. Tekrar dener misin?';
  return t;
}

// Mesajları anahtarlı parçalara böler; çizimde sadece değişen düğümler yenilenir (titreme olmaz).
function messageModel(m, prevRole, nextRole) {
  const { info } = m;
  const parts = [...m.parts.values()];
  if (info.role === 'user') {
    const text = parts.filter((p) => p.type === 'text' && !p.synthetic && !isDocPart(p)).map((p) => p.text).join('\n');
    const docs = parts.filter(isDocPart).map((p) => (p.text.match(/^<dosya ad="([^"]*)"/) || [])[1] || 'dosya');
    const files = parts.filter((p) => p.type === 'file');
    const imgs = files.filter((f) => /^image\//.test(f.mime) && /^data:/.test(f.url || ''));
    const others = files.filter((f) => !imgs.includes(f));
    if (!text && !files.length && !docs.length) return null;
    return { key: info.id, html: `<div class="msg user" data-msg="${info.id}">
      ${imgs.length ? `<div class="att-imgs">${imgs.map((f) => `<img src="${esc(f.url)}" alt="${esc(f.filename || 'görsel')}" />`).join('')}</div>` : ''}
      ${others.length || docs.length ? `<div class="files">${docs.map((n) => `<span class="chip doc">${icon(/\.pdf$/i.test(n) ? 'file' : 'book', 12)}${esc(n)}</span>`).join('')}${others.map((f) => `<span class="chip">${icon('file', 12)}${esc(f.filename || 'dosya')}</span>`).join('')}</div>` : ''}
      ${text ? `<div class="bubble">${esc(text)}</div>` : ''}</div>` };
  }
  const streaming = !info.time?.completed && !info.error;
  const visible = parts.filter((p) => ['text', 'reasoning', 'tool', 'file'].includes(p.type));
  const lastText = [...visible].reverse().find((p) => p.type === 'text');
  const children = [];
  for (const p of visible) {
    const h = partHTML(p, p.type === 'reasoning' ? streaming && p === visible.at(-1) : streaming && p === lastText && p === visible.at(-1));
    if (h) children.push({ key: p.id, html: h });
  }
  const err = errorText(info.error);
  if (err) children.push({ key: 'err', html: `<div class="err-card">${esc(err)}</div>` });
  if (!streaming && nextRole !== 'assistant' && info.finish !== 'tool-calls' && lastText?.text?.trim()) {
    const on = state.speakingMsg === info.id;
    children.push({ key: 'acts', html: `<div class="msg-acts"><button class="act ${on ? 'on' : ''}" data-speak="${info.id}" title="${on ? 'Durdur' : 'Sesli oku'}">${icon(on ? 'stop' : 'speaker', 14)}<span>${on ? 'Durdur' : 'Sesli oku'}</span></button><button class="act" data-copy-msg="${info.id}" title="Kopyala">${icon('copy', 14)}<span>Kopyala</span></button></div>` });
  }
  const cont = prevRole === 'assistant';
  return { key: info.id, shell: `<div class="msg assistant ${cont ? 'cont' : ''}" data-msg="${info.id}">
    <div class="avatar" ${cont ? 'style="visibility:hidden"' : ''}><svg width="18" height="18"><use href="#logo"/></svg></div>
    <div class="body"></div></div>`, children };
}

const isDocPart = (p) => p.type === 'text' && typeof p.text === 'string' && p.text.startsWith('<dosya ad="');

function htmlToEl(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild || document.createElement('div');
}

// Yerinde güncelleme: aynı etiket ve sınıfsa içeriği değiştir, değilse düğümü değiştir.
function patchNode(el, html) {
  const n = htmlToEl(html);
  if (el.tagName === n.tagName && el.tagName !== 'DETAILS' && !el.classList.contains('tool')) {
    if (el.className !== n.className) el.className = n.className;
    if (el.innerHTML !== n.innerHTML) el.innerHTML = n.innerHTML;
    return el;
  }
  el.replaceWith(n);
  return n;
}

function patchList(container, items, animate) {
  const existing = new Map();
  for (const c of [...container.children]) existing.set(c.dataset.key, c);
  let i = 0;
  for (const it of items) {
    let el = existing.get(it.key);
    if (el) existing.delete(it.key);
    if (it.children) {
      if (!el || el._shell !== it.shell) {
        const n = htmlToEl(it.shell);
        n._shell = it.shell;
        if (el) { const body = el.querySelector(':scope > .body'); if (body) n.querySelector('.body').replaceWith(body); el.replaceWith(n); }
        else if (!animate) n.classList.add('settled');
        el = n;
      }
      patchList(el.querySelector(':scope > .body'), it.children, false);
    } else if (!el) {
      el = htmlToEl(it.html);
      el._h = it.html;
      if (!animate) el.classList.add('settled');
    } else if (el._h !== it.html) {
      const wasSettled = el.classList.contains('settled');
      el = patchNode(el, it.html);
      el._h = it.html;
      if (wasSettled) el.classList.add('settled');
    }
    el.dataset.key = it.key;
    const at = container.children[i];
    if (at !== el) container.insertBefore(el, at || null);
    i++;
  }
  for (const el of existing.values()) el.remove();
}

function renderThread() {
  const box = $('#threadInner');
  if (!state.current) { box.innerHTML = ''; box.dataset.sid = ''; return; }
  const fresh = box.dataset.sid !== state.current;
  if (fresh) { box.innerHTML = ''; box.dataset.sid = state.current; }
  const d = sessionData(state.current);
  const items = [];
  let prev = null;
  for (const id of d.order) {
    const m = d.msgs.get(id);
    if (!m) continue;
    const nx = d.msgs.get(d.order[d.order.indexOf(id) + 1]);
    const it = messageModel(m, prev, nx?.info.role);
    if (it) { items.push(it); prev = m.info.role; }
  }
  if (d.busy && needsThinking(d)) {
    const c = prev === 'assistant';
    items.push({ key: 'thinking', html: `<div class="msg assistant ${c ? 'cont' : ''}" id="thinking"><div class="avatar" ${c ? 'style="visibility:hidden"' : ''}><svg width="18" height="18"><use href="#logo"/></svg></div><div class="body"><div class="thinking"><i></i><i></i><i></i></div></div></div>` });
  }
  patchList(box, items, !fresh);
  updateComposer();
}

function needsThinking(d) {
  const last = d.msgs.get(d.order.at(-1));
  if (!last || last.info.role === 'user') return true;
  const parts = [...last.parts.values()].filter((p) => ['text', 'reasoning', 'tool'].includes(p.type) && (p.type !== 'text' || p.text));
  if (!parts.length) return true;
  const lp = parts.at(-1);
  return lp.type === 'tool' && lp.state?.status === 'completed';
}

let rafPending = false;
function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const th = $('#thread');
    const nearEnd = th.scrollHeight - th.scrollTop - th.clientHeight < 160;
    renderThread();
    if (nearEnd) scrollToEnd();
  });
}

function scrollToEnd(force) {
  const th = $('#thread');
  if (force || th.scrollHeight - th.scrollTop - th.clientHeight < 400) th.scrollTop = th.scrollHeight;
}

// ================================================================ görev paneli
function renderInspector() {
  const d = state.current ? sessionData(state.current) : null;
  const todos = d?.todos || [];
  $('#todoList').innerHTML = todos.length
    ? todos.map((t) => `<div class="todo ${t.status}"><span class="box">${t.status === 'completed' ? icon('check', 11) : ''}</span><span>${esc(t.content)}</span></div>`).join('')
    : '<p class="empty">Ajan plan çıkardığında burada görünür.</p>';
  const diffs = d?.diffs || [];
  $('#diffList').innerHTML = diffs.length
    ? diffs.map((f, i) => `<button class="diff-item" data-diff="${i}" title="${esc(f.file || f.path)}">${icon('file', 14)}<span class="p">${esc(f.file || f.path)}</span><span class="a">+${f.additions}</span><span class="r">−${f.deletions}</span></button>`).join('')
    : '<p class="empty">Henüz değişiklik yok.</p>';
  let inTok = 0, outTok = 0, cost = 0, model = '';
  if (d) for (const m of d.msgs.values()) {
    if (m.info.role !== 'assistant') continue;
    const t = m.info.tokens || {};
    inTok += (t.input || 0) + (t.cache?.read || 0); outTok += t.output || 0; cost += m.info.cost || 0;
    model = m.info.modelID || model;
  }
  const cm = currentModel();
  $('#stats').innerHTML = `
    <dt>Asistan</dt><dd>${esc(cm ? brandName(cm) : '—')}</dd>
    <dt>Mod</dt><dd>${isDaily() ? 'Günlük' : state.cfg.agent === 'plan' ? 'Plan' : 'İnşa'}</dd>
    <dt>Girdi</dt><dd>${fmtNum(inTok)} token</dd>
    <dt>Çıktı</dt><dd>${fmtNum(outTok)} token</dd>
    <dt>Maliyet</dt><dd>${cost ? '$' + cost.toFixed(4) : 'Ücretsiz'}</dd>
    ${isDaily() ? '' : `<dt>Klasör</dt><dd title="${esc(state.project || '')}">${esc(state.project ? baseName(state.project) : 'Hızlı sohbet')}</dd>`}`;
  $('#usage').textContent = d && inTok + outTok ? `${fmtNum(inTok + outTok)} token${cost ? ' · $' + cost.toFixed(3) : ''}` : '';
}

// ================================================================ olaylar
function handleEvent(ev) {
  const p = ev.properties || {};
  const sid = p.sessionID || p.info?.sessionID || p.part?.sessionID;
  switch (ev.type) {
    case 'message.updated': {
      const d = sessionData(p.info.sessionID);
      const m = d.msgs.get(p.info.id);
      if (m) m.info = p.info;
      else { d.msgs.set(p.info.id, { info: p.info, parts: new Map() }); d.order.push(p.info.id); }
      if (p.info.role === 'assistant' && p.info.time?.completed) renderInspector();
      break;
    }
    case 'message.part.updated': {
      const part = p.part;
      const d = sessionData(part.sessionID);
      let m = d.msgs.get(part.messageID);
      if (!m) { m = { info: { id: part.messageID, sessionID: part.sessionID, role: 'assistant', time: {} }, parts: new Map() }; d.msgs.set(part.messageID, m); d.order.push(part.messageID); }
      const old = m.parts.get(part.id);
      if (old?._open) part._open = true;
      m.parts.set(part.id, part);
      break;
    }
    case 'message.part.delta': {
      const d = sessionData(p.sessionID);
      const m = d.msgs.get(p.messageID);
      const part = m?.parts.get(p.partID);
      if (part && p.field) part[p.field] = (part[p.field] || '') + p.delta;
      break;
    }
    case 'message.part.removed': {
      sessionData(p.sessionID).msgs.get(p.messageID)?.parts.delete(p.partID);
      break;
    }
    case 'session.status': {
      const st = p.status || {};
      if (st.type === 'retry') { onRetry(p.sessionID, st); return; }
      setBusy(p.sessionID, st.type !== 'idle');
      break;
    }
    case 'session.idle': setBusy(sid, false); break;
    case 'session.error': {
      setBusy(sid, false);
      const raw = rawError(p.error);
      if (raw && sid && LIMIT_RE.test(raw)) { handleLimit(sid, raw); break; }
      const t = errorText(p.error);
      if (t && sid === state.current) showBanner(t);
      break;
    }
    case 'permission.asked': queuePermission(p); return;
    case 'question.asked': askQuestion(p); return;
    case 'question.replied': case 'question.rejected': closeDialog(p.requestID || p.id); return;
    case 'todo.updated': sessionData(p.sessionID).todos = p.todos || []; if (p.sessionID === state.current) renderInspector(); return;
    case 'session.diff': sessionData(p.sessionID).diffs = p.diff || []; if (p.sessionID === state.current) renderInspector(); return;
    case 'session.updated': case 'session.created': {
      const info = p.info;
      if (!info || info.parentID) return;
      const dir = curDir();
      if (info.directory && info.directory !== dir) return;
      const owner = sessionOwners()[info.id];
      if (owner ? owner !== acct.status?.user?.id : ev.type !== 'session.created') return;
      const i = state.sessions.findIndex((s) => s.id === info.id);
      if (i >= 0) state.sessions[i] = info; else state.sessions.unshift(info);
      state.sessions.sort((a, b) => b.time.updated - a.time.updated);
      renderSessions();
      if (info.id === state.current && document.activeElement !== $('#sessionTitle')) $('#sessionTitle').value = cleanTitle(info.title);
      return;
    }
    case 'session.deleted': {
      state.sessions = state.sessions.filter((s) => s.id !== p.info?.id);
      renderSessions();
      return;
    }
    default: return;
  }
  if (sid && sid === state.current) scheduleRender();
}

function setBusy(sid, busy) {
  if (!sid) return;
  const d = sessionData(sid);
  if (d.busy === busy) return;
  d.busy = busy;
  renderSessions();
  if (sid === state.current) { scheduleRender(); updateComposer(); }
  if (!busy) onSessionDone(sid);
}

const isBusy = () => (state.current ? sessionData(state.current).busy : false);

const LIMIT_RE = /free.?(tier|usage)|free_tier|usage limit|limit reached|rate.?limit|too many requests|quota|exceeded|resource.?exhausted|credit balance|insufficient.?(credit|balance|quota)|\b429\b/i;

// Sıradaki kullanılabilir model: önce ücretsizler (sırayla dolaşır), mevcut model ücretliyse diğer ücretliler de aday.
function nextModel(fromKey) {
  const cur = state.models.find((m) => m.key === fromKey);
  const open = state.models.filter((m) => m.key !== fromKey && !isLocked(m.key));
  const pool = open.filter((m) => m.free).length || (cur && cur.free) ? open.filter((m) => m.free) : open;
  if (!pool.length) return null;
  const idx = state.models.findIndex((m) => m.key === fromKey);
  return pool.find((m) => state.models.indexOf(m) > idx) || pool[0];
}

async function onRetry(sid, st) {
  let msg = st.message || 'Model şu an yanıt veremiyor.';
  if (st.action?.title && !msg.includes(st.action.title)) msg += ' — ' + st.action.title;
  const reason = (st.action?.reason || '') + ' ' + msg;
  if (!LIMIT_RE.test(reason) && (st.attempt || 0) < 3) return; // geçici hata: motor kendisi yeniden dener
  return handleLimit(sid, reason, st.next, st.action?.link);
}

async function handleLimit(sid, reason, next, link) {
  const d = sessionData(sid);
  if (d.limitBusy) return;
  d.limitBusy = true;
  try {
    const model = currentModel();
    try { await api('POST', `/session/${sid}/abort`, {}); } catch { /* yok say */ }
    setBusy(sid, false);
    if (model) {
      const ms = next && next > Date.now() ? next - Date.now() : /free|quota|usage|credit/i.test(reason) ? 60 * 60e3 : 5 * 60e3;
      await setCfg('lockedModels', { ...(state.cfg.lockedModels || {}), [model.key]: Date.now() + ms });
    }
    const tries = d.autoTries || 0;
    const nx = state.cfg.autoSwitch !== false && tries < 8 ? nextModel(model?.key) : null;
    if (nx) {
      d.autoTries = tries + 1;
      await setCfg('model', nx.key); renderModelChip();
      await new Promise((r) => setTimeout(r, 300));
      d.busy = true; if (sid === state.current) { renderThread(); updateComposer(); }
      try {
        await api('POST', `/session/${sid}/prompt_async`, {
          model: { providerID: nx.providerID, modelID: nx.modelID }, agent: agentName(),
          parts: [{ type: 'text', text: 'Önceki isteğime kaldığın yerden devam et. Yarım kalan işi tamamla.', synthetic: true }],
        });
      } catch (e) { setBusy(sid, false); toast('Devam edilemedi: ' + e.message, 'err'); }
      return;
    }
    if (sid === state.current) showBanner('Glassly şu an çok yoğun. Birazdan tekrar dene.');
  } finally { d.limitBusy = false; }
}

function showBanner(msg, link) {
  const b = $('#banner');
  b.innerHTML = `${icon('info')}<p>${esc(msg)}</p><div class="acts">
    <button class="btn sm ghost" data-banner="model">Başka model</button>
    ${link ? `<button class="btn sm ghost" data-banner="link" data-link="${esc(link)}">Ayrıntı</button>` : ''}
    <button class="btn sm ghost" data-banner="close" aria-label="Kapat">${icon('x', 14)}</button></div>`;
  b.hidden = false;
}

// ================================================================ izin & soru diyalogları
function queuePermission(p) {
  state.pendingPermissions.push(p);
  if (state.pendingPermissions.length === 1) showPermission();
}

const PERM_TEXT = {
  edit: ['pencil', 'Dosya düzenleme izni', 'Glassly bir dosyayı değiştirmek istiyor.'],
  bash: ['terminal', 'Komut çalıştırma izni', 'Glassly terminalde bir komut çalıştırmak istiyor.'],
  webfetch: ['globe', 'Web erişimi izni', 'Glassly bir web sayfasını okumak istiyor.'],
  external_directory: ['folder', 'Proje dışı erişim', 'Glassly proje klasörünün dışındaki bir yola erişmek istiyor.'],
};

function showPermission() {
  const p = state.pendingPermissions[0];
  if (!p) return closeLayer('#dialogLayer');
  const [ic, title, text] = PERM_TEXT[p.permission] || ['shield', 'İzin isteği', `“${p.permission}” aracı için izin gerekiyor.`];
  const detail = p.metadata?.command || p.metadata?.filepath || p.metadata?.filePath || p.metadata?.url || (p.patterns || []).join('\n');
  const diff = p.metadata?.diff;
  openDialog(`<div class="dialog glass" data-perm="${p.id}">
    <h3>${icon(ic)}${title}</h3><p>${text}</p>
    ${diff ? `<pre style="padding:8px 0">${renderDiffText(diff)}</pre>` : detail ? `<pre>${esc(detail)}</pre>` : ''}
    <div class="acts">
      <button class="btn ghost" data-reply="reject">Reddet</button>
      <button class="btn ghost" data-reply="always">Her zaman izin ver</button>
      <button class="btn primary" data-reply="once">İzin ver</button>
    </div></div>`);
  $('[data-reply="once"]', $('#dialogLayer')).focus();
}

async function replyPermission(reply) {
  const p = state.pendingPermissions.shift();
  if (p) { try { await api('POST', `/permission/${p.id}/reply`, { reply }); } catch (e) { toast(e.message, 'err'); } }
  showPermission();
}

function askQuestion(q) {
  const answers = q.questions.map(() => []);
  let idx = 0;
  const draw = () => {
    const item = q.questions[idx];
    openDialog(`<div class="dialog glass" data-question="${q.id}">
      <h3>${icon('question')}${esc(item.header || 'Soru')}</h3><p>${esc(item.question)}</p>
      <div class="q-opts">${item.options.map((o, i) => `<button class="q-opt ${answers[idx].includes(o.label) ? 'on' : ''}" data-opt="${i}"><b>${esc(o.label)}</b><span>${esc(o.description || '')}</span></button>`).join('')}</div>
      ${item.custom !== false ? '<input class="field" id="qCustom" placeholder="Ya da kendi cevabını yaz…" style="margin-bottom:14px" />' : ''}
      <div class="acts"><button class="btn ghost" data-q="reject">Geç</button><button class="btn primary" data-q="next">${idx < q.questions.length - 1 ? 'Sonraki' : 'Gönder'}</button></div></div>`);
    $$('.q-opt', $('#dialogLayer')).forEach((b) => b.onclick = () => {
      const label = item.options[Number(b.dataset.opt)].label;
      if (item.multiple) answers[idx] = answers[idx].includes(label) ? answers[idx].filter((x) => x !== label) : [...answers[idx], label];
      else answers[idx] = [label];
      $$('.q-opt', $('#dialogLayer')).forEach((x) => x.classList.toggle('on', answers[idx].includes(item.options[Number(x.dataset.opt)].label)));
    });
    $('[data-q="next"]', $('#dialogLayer')).onclick = async () => {
      const custom = $('#qCustom')?.value.trim();
      if (custom) answers[idx] = item.multiple ? [...answers[idx], custom] : [custom];
      if (idx < q.questions.length - 1) { idx++; draw(); return; }
      closeLayer('#dialogLayer');
      try { await api('POST', `/question/${q.id}/reply`, { answers }); } catch (e) { toast(e.message, 'err'); }
    };
    $('[data-q="reject"]', $('#dialogLayer')).onclick = async () => {
      closeLayer('#dialogLayer');
      try { await api('POST', `/question/${q.id}/reject`, {}); } catch { /* yok say */ }
    };
  };
  draw();
}

function openDialog(html) {
  const l = $('#dialogLayer');
  l.innerHTML = html;
  l.hidden = false;
}
function closeDialog(id) {
  const l = $('#dialogLayer');
  if (!l.hidden && $(`[data-question="${id}"]`, l)) closeLayer('#dialogLayer');
}
function closeLayer(sel) { $(sel).hidden = true; }

// ================================================================ yazma kapsülü
function updateComposer() {
  const busy = isBusy();
  const send = $('#send');
  send.classList.toggle('stop', busy);
  send.innerHTML = icon(busy ? 'stop' : 'arrow');
  send.setAttribute('aria-label', busy ? 'Durdur' : 'Gönder');
  send.disabled = !busy && state.engine.state !== 'ready';
  $$('#agentSeg button').forEach((b) => { b.classList.toggle('on', b.dataset.agent === (state.cfg.agent || 'build')); b.setAttribute('aria-checked', b.classList.contains('on')); });
}

function autosize() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 220) + 'px';
}

function renderAttachments() {
  const up = state.uploads.map((u, i) => {
    const thumb = u.kind === 'image' && u.url ? `<img src="${esc(u.url)}" alt="" />` : icon(u.loading ? 'refresh' : u.error ? 'x' : /\.pdf$/i.test(u.name) ? 'file' : 'book', 13);
    const meta = u.loading ? 'okunuyor…' : u.error ? u.error : u.kind === 'image' ? 'görsel' : u.pages ? `${u.pages} sayfa` : `${fmtNum(u.chars || 0)} karakter`;
    return `<span class="chip up ${u.error ? 'bad' : ''} ${u.loading ? 'loading' : ''}" title="${esc(u.name)}">${thumb}<span class="n">${esc(u.name)}</span><small>${esc(meta)}</small><button type="button" data-unupload="${i}" aria-label="Kaldır">${icon('x', 12)}</button></span>`;
  }).join('');
  $('#attachments').innerHTML = up + state.attachments.map((a, i) => `<span class="chip">${icon('file', 12)}${esc(a)}<button type="button" data-unattach="${i}" aria-label="Kaldır">${icon('x', 12)}</button></span>`).join('');
}

async function submit() {
  if (isBusy()) {
    try { await api('POST', `/session/${state.current}/abort`, {}); } catch { /* yok say */ }
    return;
  }
  const input = $('#input');
  const text = input.value.trim();
  if (state.uploads.some((u) => u.loading)) return toast('Dosyalar hâlâ okunuyor, bir saniye…');
  if (!text && !state.attachments.length && !state.uploads.some((u) => !u.error)) return;
  if (state.engine.state !== 'ready') return toast('Motor henüz hazır değil.', 'err');
  if (!state.models.length) await loadModels();
  const model = currentModel();
  if (!model) return toast('Önce bir model seç.', 'err');
  if (isLocked(model.key)) {
    const pick = nextModel(model.key);
    if (pick) { await setCfg('model', pick.key); renderModelChip(); }
  } else if (state.cfg.rotate && model.free && state.current && sessionData(state.current).order.length) {
    const pick = nextModel(model.key);
    if (pick && pick.free) { await setCfg('model', pick.key); renderModelChip(); }
  }
  // Günlük mesaj hakkı (geliştirici hesabı sınırsız)
  try {
    const q = await G.account.consume();
    if (!q.unlimited && q.left > 0 && q.left <= 5) toast(`Bugün ${q.left} mesaj hakkın kaldı.`);
    if (!q.unlimited && q.left === 0) toast('Bu bugünkü son mesajındı. Hakkın gece yarısı yenilenir.');
  } catch (e) { return showBanner(ipcErr(e)); }
  if (state.current) sessionData(state.current).autoTries = 0;
  $('#banner').hidden = true;
  input.value = ''; autosize(); hideSuggest();
  const files = state.attachments.splice(0);
  const uploads = state.uploads.splice(0).filter((u) => !u.error);
  renderAttachments();
  const dir = curDir();
  try {
    const sid = await ensureSession();
    const d = sessionData(sid);
    const first = !d.order.length;
    d.busy = true; renderThread(); scrollToEnd(true); updateComposer();
    const fileParts = [
      ...files.map((rel) => ({ type: 'file', mime: 'text/plain', filename: rel, url: fileUrl(joinPath(dir, rel)) })),
      ...uploadParts(uploads),
    ];
    const ctxParts = await contextParts(first);
    let m = currentModel();
    // Görsel eklendiyse ve seçili model görsel okuyamıyorsa, bu mesaj için sessizce görebilen bir modele geç
    if (uploads.some((u) => u.kind === 'image') && !m.vision) {
      const v = state.models.find((x) => x.vision && x.free && !isLocked(x.key)) || state.models.find((x) => x.vision && !isLocked(x.key));
      if (v) m = v;
    }
    const cmd = text.match(/^\/([\w:-]+)\s*([\s\S]*)$/);
    if (cmd && state.commands.some((c) => c.name === cmd[1])) {
      await api('POST', `/session/${sid}/command`, { command: cmd[1], arguments: cmd[2] || '', agent: agentName(), model: m.key, parts: fileParts });
    } else {
      await api('POST', `/session/${sid}/prompt_async`, {
        model: { providerID: m.providerID, modelID: m.modelID },
        agent: agentName(),
        parts: [...ctxParts, ...(text ? [{ type: 'text', text }] : [{ type: 'text', text: uploads.length > 1 ? 'Eklediğim dosyalara bak.' : 'Eklediğim dosyaya bak.' }]), ...fileParts],
      });
    }
  } catch (e) {
    if (state.current) setBusy(state.current, false);
    toast('Gönderilemedi: ' + e.message, 'err');
  }
}

// --- / ve @ önerileri
let suggestTimer = null;
function onInput() {
  autosize();
  const t = $('#input');
  const before = t.value.slice(0, t.selectionStart);
  const slash = /^\/([\w:-]*)$/.exec(before);
  const at = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (slash) {
    const q = lower(slash[1]);
    const items = state.commands.filter((c) => lower(c.name).includes(q)).slice(0, 12)
      .map((c) => ({ k: '/' + c.name, d: c.description, apply: () => replaceBefore(slash[0], '/' + c.name + ' ') }));
    showSuggest(items);
  } else if (at) {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(async () => {
      try {
        const res = await api('GET', `/find/file?query=${encodeURIComponent(at[1] || '')}&limit=12`);
        showSuggest((res || []).slice(0, 12).map((f) => ({ k: '@', d: f, apply: () => { replaceBefore('@' + at[1], ''); if (!state.attachments.includes(f)) state.attachments.push(f); renderAttachments(); } })));
      } catch { hideSuggest(); }
    }, 120);
  } else hideSuggest();
}

function replaceBefore(token, replacement) {
  const t = $('#input');
  const pos = t.selectionStart;
  const start = t.value.lastIndexOf(token, pos);
  t.value = t.value.slice(0, start) + replacement + t.value.slice(pos);
  const np = start + replacement.length;
  t.setSelectionRange(np, np);
  t.focus();
  autosize();
}

function showSuggest(items) {
  const box = $('#suggest');
  if (!items.length) return hideSuggest();
  state.suggest = { items, sel: 0 };
  box.innerHTML = items.map((it, i) => `<button type="button" class="opt ${i === 0 ? 'sel' : ''}" data-sug="${i}"><span class="k">${esc(it.k)}</span><span class="d">${esc(it.d)}</span></button>`).join('');
  box.hidden = false;
}
function hideSuggest() { state.suggest = null; $('#suggest').hidden = true; }
function moveSuggest(dir) {
  const s = state.suggest; if (!s) return;
  s.sel = (s.sel + dir + s.items.length) % s.items.length;
  $$('#suggest .opt').forEach((b, i) => b.classList.toggle('sel', i === s.sel));
  $$('#suggest .opt')[s.sel].scrollIntoView({ block: 'nearest' });
}

// ================================================================ model seçici
function openModelPicker() {
  $('#modelLayer').hidden = false;
  $('#modelFilter').value = '';
  renderModelList();
  $('#modelFilter').focus();
}
function renderModelList() {
  const q = lower($('#modelFilter').value);
  const list = state.models.filter((m) => !q || lower(m.name + ' ' + m.key + ' ' + m.provider).includes(q));
  if (!list.length) { $('#modelList').innerHTML = `<div class="list-empty">Model bulunamadı. Ayarlar → Sağlayıcılar'dan anahtar ekleyebilirsin.</div>`; return; }
  let html = '', last = '';
  for (const m of list.slice(0, 300)) {
    const g = m.providerID === 'opencode' ? 'Ücretsiz · OpenCode Zen' : m.provider;
    if (g !== last) { html += `<div class="picker-group"><span lang="${m.providerID === 'opencode' ? 'tr' : 'en'}">${esc(g)}</span></div>`; last = g; }
    const lock = isLocked(m.key);
    html += `<button class="opt" data-model="${esc(m.key)}"><span>${esc(m.name)}</span>
      ${m.free ? '<span class="tag free">ücretsiz</span>' : ''}${lock ? `<span class="tag lock">${icon('lock', 11)} kilitli</span>` : ''}
      ${m.key === state.cfg.model ? `<span class="check">${icon('check', 16)}</span>` : ''}</button>`;
  }
  $('#modelList').innerHTML = html;
}

// ================================================================ komut paleti
function paletteItems() {
  const acts = [
    { ic: 'plus', t: 'Yeni sohbet', h: '⌘N', run: newSession },
    { ic: 'folder', t: 'Klasör aç…', h: '⌘O', run: pickProject },
    { ic: 'cpu', t: 'Model seç…', h: '⌘M', run: openModelPicker },
    { ic: 'gear', t: 'Ayarlar', h: '⌘,', run: () => openSettings() },
    { ic: 'plug', t: 'Bağlantılar (Google, GitHub)', run: () => openSettings('conn') },
    { ic: 'mic', t: 'Konuşarak yaz', h: '⌘⇧M', run: () => $('#btnMic').click() },
    { ic: 'wave', t: 'Sesli sohbeti başlat', run: () => $('#btnVoiceChat').click() },
    { ic: 'paperclip', t: 'Dosya ekle (PDF, Word, görsel)…', run: () => $('#btnAttach').click() },
    { ic: 'bell', t: 'Hatırlatıcılar', run: () => openSettings('rem') },
    { ic: 'memory', t: 'Hafıza', run: () => openSettings('memory') },
    { ic: 'speaker', t: 'Ses ayarları', run: () => openSettings('voice') },
    { ic: 'spark', t: 'Günlük sekmesine geç', run: () => setMode('gunluk') },
    { ic: 'terminal', t: 'Kod sekmesine geç', run: () => setMode('kod') },
    { ic: 'moon', t: 'Temayı değiştir', run: cycleTheme },
    { ic: 'panel', t: 'Görev panelini aç/kapa', h: '⌘I', run: toggleInspector },
    { ic: 'key', t: 'Sağlayıcı anahtarı ekle', run: () => openSettings('providers') },
    { ic: 'book', t: 'Yetenekleri yönet', run: () => openSettings('skills') },
    { ic: 'refresh', t: 'Motoru yeniden başlat', run: () => G.engine.restart() },
  ];
  const sessions = state.sessions.slice(0, 30).map((s) => ({ ic: 'layers', t: cleanTitle(s.title), h: relTime(s.time.updated), run: () => openSession(s.id) }));
  const projects = (state.cfg.projects || []).map((p) => ({ ic: 'folder', t: baseName(p), h: p, run: () => setProject(p) }));
  return [...acts, ...sessions, ...projects];
}
let paletteSel = 0, paletteList = [];
function openPalette() {
  $('#paletteLayer').hidden = false;
  $('#paletteInput').value = '';
  renderPalette();
  $('#paletteInput').focus();
}
function renderPalette() {
  const q = lower($('#paletteInput').value);
  paletteList = paletteItems().filter((i) => !q || lower(i.t + ' ' + (i.h || '')).includes(q)).slice(0, 40);
  paletteSel = 0;
  $('#paletteList').innerHTML = paletteList.map((i, n) => `<button class="opt ${n === 0 ? 'sel' : ''}" data-pal="${n}">${icon(i.ic, 16)}<span>${esc(i.t)}</span>${i.h ? `<span class="hint">${esc(G.platform === 'darwin' ? i.h : i.h.replace(/⌘/g, 'Ctrl+'))}</span>` : ''}</button>`).join('') || '<div class="list-empty">Sonuç yok</div>';
}
function runPalette(n) {
  const it = paletteList[n];
  closeLayer('#paletteLayer');
  it?.run();
}

// ================================================================ ayarlar
const SETTINGS_TABS = [
  ['account', 'user', 'Hesap'], ['look', 'spark', 'Görünüm'], ['conn', 'plug', 'Bağlantılar'], ['memory', 'memory', 'Hafıza'], ['rem', 'bell', 'Hatırlatıcılar'], ['voice', 'mic', 'Ses'], ['providers', 'key', 'Sağlayıcılar'], ['models', 'layers', 'Modeller'], ['perms', 'shield', 'İzinler'],
  ['skills', 'book', 'Yetenekler'], ['instr', 'edit', 'Talimatlar'], ['engine', 'cpu', 'Motor'], ['dev', 'bolt', 'Geliştirici'], ['about', 'info', 'Hakkında'],
];
const isDevUser = () => acct.status?.user?.role === 'gelistirici';

function openSettings(tab = 'look') {
  const l = $('#settingsLayer');
  l.innerHTML = `<div class="settings glass" role="dialog" aria-label="Ayarlar">
    <nav class="settings-nav"><h2>Ayarlar</h2>${SETTINGS_TABS.filter(([id]) => id !== 'dev' || isDevUser()).map(([id, ic, t]) => `<button data-tab="${id}">${icon(ic, 16)}${t}</button>`).join('')}</nav>
    <div class="settings-body" id="settingsBody"></div></div>`;
  l.hidden = false;
  showTab(tab);
}

async function showTab(tab) {
  $$('.settings-nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  const body = $('#settingsBody');
  const close = `<button class="settings-close" data-close-settings aria-label="Kapat">${icon('x')}</button>`;
  const c = state.cfg;
  if (tab === 'dev' && !isDevUser()) tab = 'account';
  if (tab === 'account') {
    body.innerHTML = close + accountTab();
    fillUsage();
  } else if (tab === 'dev') {
    body.innerHTML = close + '<h3>Geliştirici</h3><p class="sub">Yükleniyor…</p>';
    renderDevTab();
  } else if (tab === 'look') {
    const accents = { iris: ['#8b7bff', '#47c6ff'], lagoon: ['#24d6c1', '#3a7dff'], ember: ['#ff9a4d', '#ff4d8d'], moss: ['#8be38f', '#1fb3a3'], rose: ['#ff7ac6', '#9f7bff'] };
    body.innerHTML = `${close}<h3>Görünüm</h3><p class="sub">Glassly'nin camını kendine göre ayarla.</p>
      <div class="theme-cards">${[['aurora', 'Aurora', 'Koyu'], ['frost', 'Frost', 'Açık'], ['system', 'Sistem', 'Otomatik']].map(([id, n, s]) => `<button class="theme-card ${c.theme === id ? 'on' : ''}" data-theme-set="${id}"><div class="pv ${id}"></div><b>${n}</b> <span class="dim">${s}</span></button>`).join('')}</div>
      <div class="row"><div class="l"><b>Vurgu rengi</b><span>Düğmeler, seçimler ve ışık kümeleri</span></div>
        <div class="swatches">${Object.entries(accents).map(([id, [a, b]]) => `<button class="swatch ${c.accent === id ? 'on' : ''}" data-accent-set="${id}" style="background:linear-gradient(135deg,${a},${b})" aria-label="${id}"></button>`).join('')}</div></div>
      <div class="row"><div class="l"><b>Cam bulanıklığı</b><span>Panellerin ne kadar buzlu görüneceği</span></div><input type="range" min="0" max="48" value="${c.blur ?? 28}" id="blurRange" /></div>
      <div class="row"><div class="l"><b>Hareketli arka plan</b><span>Işık kümeleri yavaşça dolaşır</span></div><button class="switch ${c.motion !== false ? 'on' : ''}" data-switch="motion" aria-label="Hareket"></button></div>`;
  } else if (tab === 'providers') {
    body.innerHTML = `${close}<h3>Sağlayıcılar</h3><p class="sub">Ücretsiz modeller anahtarsız çalışır. Daha güçlü modeller için kendi anahtarını bağla — anahtarlar yalnızca bu bilgisayarda saklanır.</p><div id="provList"><div class="list-empty">Yükleniyor…</div></div>
      <h3 style="margin-top:26px;font-size:15px">Özel OpenAI uyumlu sağlayıcı</h3><p class="sub">Ollama, LM Studio, vLLM veya başka bir uyumlu adres.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <input class="field" id="cpId" placeholder="kimlik (ör. ollama)" /><input class="field" id="cpName" placeholder="Görünen ad" />
        <input class="field" id="cpUrl" placeholder="http://localhost:11434/v1" style="grid-column:1/-1" />
        <input class="field" id="cpKey" placeholder="API anahtarı (isteğe bağlı)" type="password" /><input class="field" id="cpModels" placeholder="modeller, virgülle: llama3.2, qwen2.5-coder" />
      </div><div style="margin-top:10px;display:flex;gap:8px"><button class="btn sm primary" id="cpAdd">Ekle ve uygula</button></div>
      <div id="cpList" style="margin-top:10px"></div>`;
    renderProviders();
  } else if (tab === 'models') {
    const info = await G.engine.info();
    const cl = info.cloud || {};
    const locked = Object.entries(c.lockedModels || {}).filter(([, t]) => t > Date.now());
    const nameOf = (k) => state.models.find((m) => m.key === k)?.name || k;
    const until = (t) => new Date(t).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    body.innerHTML = `${close}<h3>Modeller</h3><p class="sub">Limit dolduğunda Glassly beklemez; sıradaki modele geçip işine kaldığı yerden devam eder.</p>
      <div class="row"><div class="l"><b>Limit dolunca otomatik geç</b><span>Ücretsiz bir model sınıra takılırsa sıradaki ücretsiz modele geçer ve yanıtı sürdürür</span></div><button class="switch ${c.autoSwitch !== false ? 'on' : ''}" data-switch="autoSwitch" aria-label="Otomatik geç"></button></div>
      <div class="row"><div class="l"><b>Dönüşümlü kullan</b><span>Her mesajda ücretsiz modeller arasında sırayla dolaş; yük tek modelde birikmez</span></div><button class="switch ${c.rotate ? 'on' : ''}" data-switch="rotate" aria-label="Dönüşümlü"></button></div>
      <h3 style="margin-top:26px;font-size:15px">Glassly Bulut</h3>
      <p class="sub">Kendi Glassly Bulut sunucun. OpenAI uyumlu her adres olur; modeller sunucudan otomatik çekilir ve listede en üstte görünür.</p>
      <div style="display:grid;grid-template-columns:1fr;gap:8px">
        <input class="field" id="cloudUrl" placeholder="https://api.alanadin.com/v1" value="${esc((c.cloud && c.cloud.url) || cl.url || '')}" />
        <input class="field" id="cloudKey" type="password" placeholder="Erişim anahtarı (sunucu istiyorsa)" value="${esc((c.cloud && c.cloud.key) || '')}" />
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center"><button class="btn sm primary" id="cloudSave">Kaydet ve bağlan</button>
        <span class="dim" style="font-size:var(--text-xs)">${cl.url ? (cl.models?.length ? `Bağlı · ${cl.models.length} model` : 'Sunucuya ulaşılamadı') : 'Ayarlanmadı'}</span></div>
      <h3 style="margin-top:26px;font-size:15px">Kilitli modeller</h3>
      ${locked.length ? locked.map(([k, t]) => `<div class="skill-row"><div class="l"><b>${esc(nameOf(k))}</b><span>${until(t)} saatinde kendiliğinden açılır</span></div><button class="btn sm ghost" data-unlock="${esc(k)}">Kilidi aç</button></div>`).join('') : '<p class="empty">Şu an kilitli model yok.</p>'}`;
  } else if (tab === 'conn') {
    body.innerHTML = `${close}<h3>Bağlantılar</h3><p class="sub">Hesaplarını bağla; Glassly e-postalarını okuyup özetlesin, senin adına e-posta göndersin, takvimine etkinlik eklesin, Drive dosyalarını bulsun, GitHub işlerine baksın. Göndermek veya oluşturmak gibi her adımda önce sana sorar.</p><div id="connList"><div class="list-empty">Yükleniyor…</div></div>`;
    renderConnections();
  } else if (tab === 'memory' || tab === 'rem' || tab === 'voice') {
    body.innerHTML = close + (await featureTab(tab));
    if (tab === 'voice') fillMics();
  } else if (tab === 'perms') {
    const p = c.permissions || {};
    const sel = (k, d) => `<select class="field" data-perm-set="${k}">${[['ask', 'Sor'], ['allow', 'İzin ver'], ['deny', 'Reddet']].map(([v, t]) => `<option value="${v}" ${(p[k] || d) === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
    body.innerHTML = `${close}<h3>İzinler</h3><p class="sub">Ajanın riskli adımlardan önce sana sorup sormayacağını belirle. Değişiklikler motoru yeniden başlatır.</p>
      <div class="row"><div class="l"><b>Dosya düzenleme</b><span>Dosya yazma, düzenleme ve yama</span></div>${sel('edit', 'ask')}</div>
      <div class="row"><div class="l"><b>Komut çalıştırma</b><span>Terminal komutları (bash / PowerShell)</span></div>${sel('bash', 'ask')}</div>
      <div class="row"><div class="l"><b>Web erişimi</b><span>Sayfa okuma ve web araması</span></div>${sel('webfetch', 'allow')}</div>
      <div class="row"><div class="l"><b>Oto mod</b><span>Hiçbir şey sorma, her şeye izin ver. Dikkatli kullan.</span></div><button class="switch ${p.auto ? 'on' : ''}" data-switch="auto" aria-label="Oto mod"></button></div>
      <div style="margin-top:16px"><button class="btn sm primary" id="permApply">Uygula</button></div>`;
  } else if (tab === 'skills') {
    const skills = await G.skills.list();
    const info = await G.engine.info();
    body.innerHTML = `${close}<h3>Yetenekler</h3><p class="sub">Yetenekler (SKILL.md), ajana belirli işleri nasıl yapacağını öğretir. Ajan gerektiğinde kendisi yükler.</p>
      ${skills.map((s) => `<div class="skill-row"><div class="l"><b>${esc(s.name)}</b><span>${esc(s.description)}</span></div><button class="btn sm ghost" data-skill-edit="${esc(s.name)}">Düzenle</button><button class="btn sm danger" data-skill-del="${esc(s.name)}">Sil</button></div>`).join('') || '<p class="empty">Henüz yetenek yok.</p>'}
      <div style="margin-top:16px;display:flex;gap:8px"><button class="btn sm primary" id="skillNew">Yeni yetenek</button><button class="btn sm ghost" data-open="${esc(info.skillsDir)}">Klasörü aç</button><button class="btn sm ghost" id="skillApply">Motoru yenile</button></div>
      <div id="skillEditor"></div>`;
  } else if (tab === 'instr') {
    body.innerHTML = `${close}<h3>Talimatlar</h3><p class="sub">Her sohbette ajana verilecek genel talimatlar. Örneğin kod stilin, tercih ettiğin dil veya araçlar.</p>
      <textarea class="field" id="instrText" rows="12" placeholder="Örnek:&#10;- Her zaman Türkçe yanıt ver.&#10;- TypeScript'te strict mod kullan.&#10;- Commit mesajlarını Conventional Commits biçiminde yaz.">${esc(c.instructions || '')}</textarea>
      <div style="margin-top:12px"><button class="btn sm primary" id="instrSave">Kaydet ve uygula</button></div>`;
  } else if (tab === 'engine') {
    const info = await G.engine.info();
    const log = await G.engine.log();
    body.innerHTML = `${close}<h3>Motor</h3><p class="sub">Glassly, açık kaynak <b>opencode</b> motorunu kendi izole klasöründe çalıştırır; bilgisayarındaki diğer opencode kurulumlarına dokunmaz.</p>
      <div class="row"><div class="l"><b>Durum</b><span>${esc(state.engine.message || state.engine.state)}</span></div><button class="btn sm ghost" id="engRestart">${icon('refresh', 14)}Yeniden başlat</button></div>
      <div class="row"><div class="l"><b>Sürüm</b><span>opencode ${esc(info.version || 'sistem kurulumu')}</span></div><button class="btn sm ghost" id="engUpdate">Motoru güncelle</button></div>
      <div class="row"><div class="l"><b>Adres</b><span>${esc(info.url || '—')}</span></div></div>
      <h3 style="margin:18px 0 8px;font-size:14px">Günlük</h3><pre class="log">${esc(log || 'Boş')}</pre>`;
  } else if (tab === 'about') {
    const a = await G.appInfo();
    body.innerHTML = `${close}<div style="text-align:center;padding:30px 0 18px"><svg width="72" height="72"><use href="#logo"/></svg>
      <h3 style="font-size:30px;margin:12px 0 4px;letter-spacing:-.03em">Glassly</h3><p class="sub">Sürüm ${esc(a.version)} · ${esc(a.platform)}</p>
      <p style="max-width:44ch;margin:0 auto;color:var(--text-2)">Cam gibi berrak yapay zekâ asistanı. Ahmet Mert Evci tarafından yapıldı.</p></div>
      <h3 style="margin:8px 0 8px;font-size:14px">Güncellemeler</h3><div id="updRow"></div>
      <div style="text-align:center;margin-top:18px"><button class="btn sm ghost" data-open="https://glassly.biz">glassly.biz</button></div>`;
    renderUpdateRow();
  }
}

// ---------------------------------------------------------------- güncelleme
const mb = (n) => (n ? (n / 1048576).toFixed(1).replace('.', ',') + ' MB' : '');
function updText(u) {
  switch (u.status) {
    case 'checking': return 'Güncellemeler denetleniyor…';
    case 'latest': return `Glassly güncel (sürüm ${esc(u.current)}).`;
    case 'available': return `Yeni sürüm hazır: <b>${esc(u.latest)}</b>${u.size ? ' · ' + mb(u.size) : ''}`;
    case 'downloading': return `İndiriliyor… %${u.progress || 0}`;
    case 'ready': return u.hint ? esc(u.hint) : `Sürüm ${esc(u.latest)} indirildi, kurmaya hazır.`;
    case 'installing': return u.type === 'deb' ? 'Kuruluyor… Şifre sorulursa bilgisayarının şifresini yaz.' : 'Kuruluyor…';
    case 'error': return esc(u.error || 'Bir sorun oldu.');
    default: return `Şu anki sürüm ${esc(u.current)}.`;
  }
}
function updButtons(u) {
  if (u.status === 'checking' || u.status === 'installing') return '<button class="btn sm ghost" disabled><span class="spin"></span>Bekle</button>';
  if (u.status === 'available') return '<button class="btn sm primary" data-upd="download">İndir ve kur</button>';
  if (u.status === 'downloading') return '<button class="btn sm ghost" data-upd="cancel">Vazgeç</button>';
  if (u.status === 'ready') return '<button class="btn sm primary" data-upd="install">Kur ve yeniden başlat</button>';
  return '<button class="btn sm ghost" data-upd="check">Güncellemeleri denetle</button>';
}
const updBar = (u) => (u.status === 'downloading' ? `<div class="upd-prog"><i style="width:${u.progress || 0}%"></i></div>` : '');
async function renderUpdateRow(u) {
  const el = $('#updRow');
  if (!el) return;
  u = u || state.update || (state.update = await G.update.status());
  el.innerHTML = `<div class="row"><div class="l"><b>Glassly sürümü</b><span>${updText(u)}</span>${updBar(u)}</div>${updButtons(u)}</div>`;
}
function renderUpdateCard(u) {
  let card = $('#updCard');
  const show = ['available', 'downloading', 'ready', 'installing'].includes(u.status) && state.updDismissed !== u.latest;
  if (!show) { if (card) card.remove(); return; }
  if (!card) { card = document.createElement('div'); card.id = 'updCard'; card.className = 'upd-card'; document.body.append(card); }
  const later = u.status === 'available' || u.status === 'ready' ? '<button class="btn sm ghost" data-upd="later">Sonra</button>' : '';
  card.innerHTML = `<div class="upd-head"><svg width="22" height="22"><use href="#logo"/></svg><b>Glassly güncellemesi</b></div>
    <p>${updText(u)}</p>${updBar(u)}<div class="upd-acts">${later}${updButtons(u)}</div>`;
}
function onUpdate(u) {
  state.update = u;
  renderUpdateRow(u);
  renderUpdateCard(u);
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-upd]');
  if (!b) return;
  const act = b.dataset.upd;
  if (act === 'later') { state.updDismissed = state.update?.latest; renderUpdateCard(state.update); return; }
  if (act === 'check') { const u = await G.update.check(); if (u.status === 'latest') toast('Glassly güncel.'); else if (u.status === 'available') state.updDismissed = null; onUpdate(u); return; }
  if (act === 'download') { state.updDismissed = null; onUpdate(await G.update.download()); return; }
  if (act === 'cancel') { onUpdate(await G.update.cancel()); return; }
  if (act === 'install') onUpdate(await G.update.install());
});
G.update.onState(onUpdate);
G.update.status().then(onUpdate).catch(() => {});

const POPULAR = ['anthropic', 'openai', 'google', 'openrouter', 'deepseek', 'groq', 'mistral', 'xai', 'opencode'];
async function renderProviders() {
  try {
    const d = await api('GET', '/provider');
    state.providers = d.all || []; state.connected = d.connected || [];
  } catch { /* önceki liste */ }
  const list = POPULAR.map((id) => state.providers.find((p) => p.id === id)).filter(Boolean);
  const el = $('#provList');
  if (!el) return;
  el.innerHTML = list.map((p) => {
    const on = state.connected.includes(p.id) && p.id !== 'opencode';
    const n = Object.keys(p.models || {}).length;
    return `<div class="prov"><div class="n">${esc(p.name)} <small>${n} model</small> ${on ? '<span class="badge-ok">● bağlı</span>' : ''}</div>
      <div>${on ? `<button class="btn sm danger" data-prov-del="${p.id}">Kaldır</button>` : ''}</div>
      <div class="keyrow"><input class="field" type="password" placeholder="${p.id === 'opencode' ? 'OpenCode Zen / Go anahtarı (isteğe bağlı)' : 'API anahtarı'}" data-prov-key="${p.id}" /><button class="btn sm ghost" data-prov-save="${p.id}">Bağla</button></div></div>`;
  }).join('');
  const cps = state.cfg.customProviders || [];
  $('#cpList').innerHTML = cps.map((p, i) => `<div class="skill-row"><div class="l"><b>${esc(p.id)}</b><span>${esc(p.baseURL)} · ${esc((p.models || []).join(', '))}</span></div><button class="btn sm danger" data-cp-del="${i}">Sil</button></div>`).join('');
}

const ipcErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

async function renderConnections() {
  const el = $('#connList');
  if (!el) return;
  let st;
  try { st = await G.conn.status(); } catch (e) { el.innerHTML = `<p class="empty">${esc(ipcErr(e))}</p>`; return; }
  const g = st.google;
  const svc = (ic, n, on, note) => `<span class="svc ${on ? 'on' : ''}" title="${esc(note || '')}">${icon(ic, 13)}${n}</span>`;
  const googleSvcs = g
    ? [svc('mail', g.gmailRead ? 'Gmail' : 'Gmail (gönderme)', g.gmail), svc('calendar', 'Takvim', g.calendar), svc('drive', g.driveFull ? 'Drive' : 'Drive (Glassly dosyaları)', g.drive)].join('')
    : [svc('mail', 'Gmail'), svc('calendar', 'Takvim'), svc('drive', 'Drive')].join('');
  const custom = st.custom || [];
  el.innerHTML = `
    <div class="conn big">
      <div class="logo g">${googleMark()}</div>
      <div class="l"><b>Google</b><span>${g ? `<span class="on">Bağlı</span>${g.email ? ' · ' + esc(g.email) : ''}` : 'Gmail, Takvim ve Drive tek tıkla'}</span><div class="svcs">${googleSvcs}</div></div>
      <div>${g ? '<button class="btn sm danger" data-conn-off="google">Kaldır</button>' : `<button class="btn sm primary" data-conn-on="google">Google ile bağlan</button>`}</div>
    </div>
    <div class="conn big">
      <div class="logo">${icon('github', 20)}</div>
      <div class="l"><b>GitHub</b><span>${st.github ? `<span class="on">Bağlı</span>${st.github.login ? ' · ' + esc(st.github.login) : ''}` : 'Depolar, issue ve PR\'lar, dosya okuma, yorum'}</span></div>
      <div>${st.github ? '<button class="btn sm danger" data-conn-off="github">Kaldır</button>' : st.githubClient ? '<button class="btn sm primary" data-conn-on="github-device">GitHub ile bağlan</button>' : ''}</div>
      ${!st.github && !st.githubClient ? `<div class="conn-extra"><input class="field" id="ghToken" type="password" placeholder="GitHub erişim belirteci (ghp_… veya github_pat_…)" /><button class="btn sm ghost" data-open-url="https://github.com/settings/tokens/new?scopes=repo,read:user&description=Glassly">Belirteç oluştur</button><button class="btn sm primary" data-conn-on="github">Bağla</button></div>` : ''}
    </div>
    <p class="sub" style="margin-top:12px">Glassly bir e-posta göndermeden, takvime eklemeden ya da dosya oluşturmadan önce her seferinde sana sorar. Bilgilerin yalnızca bu bilgisayarda, şifreli saklanır.</p>
    <details class="adv"><summary>Gelişmiş</summary>
      <p>${st.googleBundled ? 'Bu sürümde Google bağlantısı hazır gelir. İstersen kendi Google OAuth istemcini kullanabilirsin.' : 'Google bağlantısı için bir Google OAuth istemcisi gerekir: Google Cloud Console → yeni proje → Gmail, Google Calendar ve Google Drive API\'lerini etkinleştir → OAuth izin ekranı → Kimlik bilgileri → OAuth istemci kimliği → “Masaüstü uygulaması”.'}</p>
      <div style="display:grid;gap:8px"><input class="field" id="gcId" placeholder="Google istemci kimliği (….apps.googleusercontent.com)" /><input class="field" id="gcSecret" type="password" placeholder="İstemci gizli anahtarı" />
        <select class="field" id="gcProfile"><option value="tam">Tam erişim (gelen kutusunu okuma dahil)</option><option value="hafif">Hafif (sadece gönderme, Takvim, Glassly'nin Drive dosyaları)</option></select></div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm primary" id="gcSave">Kaydet</button><button class="btn sm ghost" data-open-url="https://console.cloud.google.com/apis/credentials">Google Cloud Console</button>${st.googleClient && !st.googleBundled ? '<button class="btn sm danger" id="gcDel">Sil</button>' : ''}</div>
      ${st.githubClient && !st.github ? `<p style="margin-top:14px">GitHub'a erişim belirteciyle de bağlanabilirsin.</p><div class="conn-extra" style="padding:0"><input class="field" id="ghToken" type="password" placeholder="ghp_… veya github_pat_…" /><button class="btn sm ghost" data-conn-on="github">Belirteçle bağla</button></div>` : ''}
    </details>
    <details class="adv"><summary>Özel MCP sunucusu ${custom.length ? '· ' + custom.length : ''}</summary>
      <p>Başka bir hizmeti (Notion, Slack…) MCP sunucusuyla bağlayabilirsin. Uzak adres ya da yerel komut gir.</p>
      ${custom.map((m, i) => `<div class="skill-row"><div class="l"><b>${esc(m.id)}</b><span>${esc(m.type === 'local' ? m.command : m.url)}</span></div><button class="btn sm danger" data-mcp-del="${i}">Sil</button></div>`).join('')}
      <div style="display:grid;grid-template-columns:1fr 2fr;gap:8px;margin-top:8px"><input class="field" id="mcpId" placeholder="ad (ör. notion)" /><input class="field" id="mcpUrl" placeholder="https://… veya npx -y paket-adi" />
      <input class="field" id="mcpToken" type="password" placeholder="Belirteç (isteğe bağlı)" style="grid-column:1/-1" /></div>
      <div style="margin-top:10px"><button class="btn sm primary" id="mcpAdd">Ekle ve uygula</button></div>
    </details>`;
}

const googleMark = () => '<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

// GitHub tek tık: kodu göster, tarayıcıda onaylanınca kendiliğinden bağlanır
async function githubDevice() {
  let info;
  try { info = await G.conn.githubDevice(); } catch (e) { return toast(ipcErr(e), 'err'); }
  openDialog(`<div class="dialog glass" id="ghDevice">
    <h3>${icon('github')}GitHub ile bağlan</h3>
    <p class="sub">Tarayıcıda açılan sayfaya bu kodu gir ve izin ver. Onayladığında Glassly kendiliğinden bağlanır.</p>
    <div class="device-code"><code>${esc(info.user_code)}</code><button class="btn sm ghost" data-copy-code="${esc(info.user_code)}">${icon('copy', 14)}Kopyala</button></div>
    <p class="wait"><span class="spin"></span>Onay bekleniyor…</p>
    <div class="acts"><button class="btn ghost" data-open-url="${esc(info.verification_uri)}">Sayfayı yeniden aç</button><button class="btn ghost" data-gh-cancel>Vazgeç</button></div>
  </div>`);
}

// Google: istemci yoksa bir kerelik kurulum sihirbazı
async function googleSetup() {
  const packaged = await G.conn.packaged();
  const C = 'https://console.cloud.google.com';
  openDialog(`<div class="dialog glass setup wide" id="gsDlg">
    <h3>${googleMark()}Google'ı bir kez hazırla</h3>
    <p class="sub">Gmail, Takvim ve Drive'a tek tıkla bağlanmak için Glassly'nin bir Google istemcisi olmalı. Bunu uygulamayı yayınlayan kişi bir kez yapar, sonra herkes sadece “Google ile bağlan”a basar. Yaklaşık 5 dakika sürer.</p>
    <ol class="steps big">
      <li><b>Proje oluştur.</b> <button class="linkbtn" data-open-url="${C}/projectcreate">Proje oluşturma sayfası</button></li>
      <li><b>API'leri aç</b> (Gmail, Takvim, Drive). <button class="linkbtn" data-open-url="${C}/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,drive.googleapis.com">Üçünü birden etkinleştir</button></li>
      <li><b>İzin ekranını doldur.</b> Uygulama adı “Glassly”, kitle “Harici”. Test kullanıcısı olarak kendi Gmail adresini ekle. <button class="linkbtn" data-open-url="${C}/auth/overview">İzin ekranı</button> · <button class="linkbtn" data-open-url="${C}/auth/audience">Test kullanıcıları</button></li>
      <li><b>İstemci oluştur.</b> Tür: <b>Masaüstü uygulaması</b>. Oluşturduktan sonra <b>JSON'u indir</b>. <button class="linkbtn" data-open-url="${C}/auth/clients/create">İstemci oluştur</button></li>
      <li><b>İndirdiğin dosyayı buraya bırak.</b></li>
    </ol>
    <div class="dropzone" id="gsDrop" tabindex="0">${icon('upload', 18)}<span id="gsFileTxt">client_secret_….json dosyasını sürükle ya da <u>seç</u></span></div>
    <div class="grid2" style="margin-top:10px">
      <select class="field" id="gsProfile"><option value="tam">Tam: Gmail okuma ve gönderme, Takvim, Drive</option><option value="hafif">Hafif: sadece gönderme, Takvim, Glassly'nin Drive dosyaları</option></select>
      ${packaged ? '' : '<label class="check"><input type="checkbox" id="gsEmbed" checked /> Uygulamaya göm (yayınladığın sürümde herkes tek tıkla bağlanır)</label>'}
    </div>
    <p class="err" id="gsErr" hidden></p>
    <div class="acts"><button class="btn ghost" data-dlg="cancel">Vazgeç</button><button class="btn primary" id="gsGo" disabled>Kaydet ve bağlan</button></div>
  </div>`);
  const L = $('#dialogLayer');
  let client = null;
  const fail = (m) => { $('#gsErr').textContent = m; $('#gsErr').hidden = false; };
  const take = async (p) => {
    $('#gsErr').hidden = true;
    try {
      const c = await G.conn.googleFile(p);
      if (!c) return;
      client = c;
      $('#gsFileTxt').innerHTML = `${icon('check', 14)} İstemci okundu: <code>${esc(c.client_id.slice(0, 18))}…</code>`;
      $('#gsDrop').classList.add('ok');
      $('#gsGo').disabled = false;
    } catch (e) { fail(ipcErr(e)); }
  };
  const dz = $('#gsDrop');
  dz.onclick = () => take();
  dz.ondragover = (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.add('over'); };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) take(G.files.pathOf(f)); };
  $('[data-dlg="cancel"]', L).onclick = () => closeLayer('#dialogLayer');
  $('#gsGo').onclick = async () => {
    if (!client) return;
    const profile = $('#gsProfile').value;
    await G.conn.googleClient({ ...client, profile });
    if ($('#gsEmbed')?.checked) await G.conn.googleEmbed({ ...client, profile }).catch(() => {});
    closeLayer('#dialogLayer');
    startGoogle();
  };
}

function startGoogle() {
  toast('Tarayıcıda Google hesabını seç ve izin ver…');
  return connAction(() => G.conn.google(), 'Google bağlandı: Gmail, Takvim ve Drive hazır.').then(renderConnChips);
}

async function connectGmail() {
  const st = await G.conn.status().catch(() => ({}));
  return st.googleClient ? startGoogle() : googleSetup();
}

async function connAction(fn, okMsg) {
  try {
    await fn();
    await restartEngine(okMsg);
  } catch (e) { toast(ipcErr(e), 'err'); }
  renderConnections();
}

async function restartEngine(msg = 'Ayarlar uygulandı, motor yeniden başlıyor…') {
  toast(msg);
  await G.engine.restart();
}

// ================================================================ kısayollar & bağlantılar
async function pickProject() {
  const dir = await G.pickFolder();
  if (dir) await setProject(dir);
}

function cycleTheme() {
  const order = ['aurora', 'frost', 'system'];
  const next = order[(order.indexOf(state.cfg.theme || 'system') + 1) % order.length];
  setCfg('theme', next).then(applyTheme);
  toast('Tema: ' + { aurora: 'Aurora (koyu)', frost: 'Frost (açık)', system: 'Sistem' }[next]);
}

function toggleSessions() {
  $('#app').classList.toggle('no-sessions');
  $('#btnSessions').classList.toggle('on', !$('#app').classList.contains('no-sessions'));
}
const narrowMQ = matchMedia('(max-width: 1180px)');
function inspectorVisible() {
  const app = $('#app');
  return narrowMQ.matches ? app.classList.contains('force-inspector') : !app.classList.contains('no-inspector');
}
function toggleInspector(force) {
  const app = $('#app');
  const show = typeof force === 'boolean' ? force : !inspectorVisible();
  app.classList.toggle('force-inspector', show && narrowMQ.matches);
  if (!narrowMQ.matches) { app.classList.toggle('no-inspector', !show); setCfg('inspector', show); }
  $('#btnInspector').classList.toggle('on', show);
}
narrowMQ.addEventListener('change', () => {
  const app = $('#app');
  app.classList.remove('force-inspector');
  app.classList.toggle('no-inspector', state.cfg.inspector === false);
  $('#btnInspector').classList.toggle('on', inspectorVisible());
});

function bind() {
  $('#btnNew').onclick = newSession;
  $('#stage')?.addEventListener('pointerdown', () => { if (narrowMQ.matches && $('#app').classList.contains('force-inspector')) toggleInspector(false); });
  $('#btnHome').onclick = newSession;
  $('#btnSessions').onclick = toggleSessions;
  $('#btnPalette').onclick = openPalette;
  $('#btnInspector').onclick = toggleInspector;
  $('#btnTheme').onclick = cycleTheme;
  $('#btnSettings').onclick = () => openSettings();
  $('#btnConn').onclick = () => openSettings('conn');
  $('#connChips').onclick = async (e) => {
    const b = e.target.closest('[data-conn-open]');
    if (!b) return;
    if (b.classList.contains('on')) return openSettings('conn');
    const id = b.dataset.connOpen;
    if (id === 'gmail') return connectGmail();
    if (id === 'calendar') { const st = await G.conn.status().catch(() => ({})); return st.googleClient ? startGoogle() : googleSetup(); }
    if (id === 'github') { const st = await G.conn.status().catch(() => ({})); if (st.githubClient) return githubDevice(); }
    openSettings('conn');
  };
  $('#btnOpenFolder').onclick = pickProject;
  $('#btnQuickChat').onclick = () => setProject(null).then(() => $('#input').focus());
  $('#projectChip').onclick = pickProject;
  $('#modelChip').onclick = openModelPicker;
  $('#sessionFilter').oninput = renderSessions;

  $('#composer').onsubmit = (e) => { e.preventDefault(); submit(); };
  const input = $('#input');
  input.oninput = onInput;
  input.onkeydown = (e) => {
    if (state.suggest) {
      if (e.key === 'ArrowDown') { e.preventDefault(); return moveSuggest(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); return moveSuggest(-1); }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); const it = state.suggest.items[state.suggest.sel]; hideSuggest(); return it.apply(); }
      if (e.key === 'Escape') return hideSuggest();
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    if (e.key === 'Backspace' && !input.value && state.attachments.length) { state.attachments.pop(); renderAttachments(); }
  };
  $('#suggest').onclick = (e) => { const b = e.target.closest('[data-sug]'); if (b) { const it = state.suggest.items[Number(b.dataset.sug)]; hideSuggest(); it.apply(); } };
  $('#attachments').onclick = (e) => { const b = e.target.closest('[data-unattach]'); if (b) { state.attachments.splice(Number(b.dataset.unattach), 1); renderAttachments(); } };

  $('#agentSeg').onclick = (e) => {
    const b = e.target.closest('[data-agent]');
    if (b) setCfg('agent', b.dataset.agent).then(() => { updateComposer(); renderInspector(); });
  };

  $('#sessionTitle').onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { e.target.value = cleanTitle(state.sessions.find((s) => s.id === state.current)?.title); e.target.blur(); } };
  $('#sessionTitle').onchange = async (e) => {
    const title = e.target.value.trim();
    if (!state.current || !title) return;
    try { await api('PATCH', `/session/${state.current}`, { title }); } catch (err) { toast(err.message, 'err'); }
  };

  $('#sessionList').onclick = async (e) => {
    const item = e.target.closest('.session-item');
    if (!item) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    const id = item.dataset.id;
    if (act === 'delete') {
      e.stopPropagation();
      openDialog(`<div class="dialog glass"><h3>${icon('trash')}Sohbet silinsin mi?</h3><p>Bu sohbet ve tüm mesajları kalıcı olarak silinecek.</p><div class="acts"><button class="btn ghost" data-dlg="cancel">Vazgeç</button><button class="btn danger" data-dlg="ok">Sil</button></div></div>`);
      $('[data-dlg="cancel"]', $('#dialogLayer')).onclick = () => closeLayer('#dialogLayer');
      $('[data-dlg="ok"]', $('#dialogLayer')).onclick = async () => {
        closeLayer('#dialogLayer');
        try { await api('DELETE', `/session/${id}`); } catch (err) { return toast(err.message, 'err'); }
        state.sessions = state.sessions.filter((s) => s.id !== id);
        state.data.delete(id);
        if (state.current === id) newSession(); else renderSessions();
      };
    } else if (act === 'rename') {
      e.stopPropagation();
      await openSession(id);
      $('#sessionTitle').focus(); $('#sessionTitle').select();
    } else openSession(id);
  };

  $('#sessionList').onkeydown = (e) => { if (e.key === 'Enter' && e.target.matches('.session-item')) openSession(e.target.dataset.id); };
  $('#recentProjects').onclick = (e) => { const b = e.target.closest('[data-project]'); if (b) setProject(b.dataset.project); };
  $('#ideas').onclick = (e) => { const b = e.target.closest('[data-prompt]'); if (b) { $('#input').value = b.dataset.prompt; autosize(); $('#input').focus(); } };

  $('#threadInner').onclick = (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      navigator.clipboard.writeText(copy.closest('.code').querySelector('code').innerText);
      copy.textContent = 'Kopyalandı'; setTimeout(() => (copy.textContent = 'Kopyala'), 1400);
      return;
    }
    const tog = e.target.closest('[data-toggle]');
    if (tog) {
      const card = tog.closest('.tool');
      const col = $('.tool-collapse', card);
      if (col) col.hidden = !col.hidden;
      const part = findPart(tog.dataset.toggle);
      if (part) part._open = col && !col.hidden;
    }
  };
  $('#threadInner').addEventListener('toggle', (e) => {
    const det = e.target.closest?.('details[data-part]');
    const part = det && findPart(det.dataset.part);
    if (part) part._open = det.open;
  }, true);

  $('#diffList').onclick = (e) => {
    const b = e.target.closest('[data-diff]');
    if (!b) return;
    const f = sessionData(state.current).diffs[Number(b.dataset.diff)];
    const patch = f.patch || (f.before != null ? '' : '');
    openDialog(`<div class="dialog glass" style="width:min(820px,calc(100vw - 40px))"><h3>${icon('diff')}${esc(f.file || f.path)}</h3>
      <p><span style="color:var(--ok)">+${f.additions}</span> · <span style="color:var(--err)">−${f.deletions}</span></p>
      <pre style="padding:8px 0;max-height:60vh">${patch ? renderDiffText(patch) : esc(f.after || 'Yama içeriği yok')}</pre>
      <div class="acts"><button class="btn primary" data-dlg="close">Kapat</button></div></div>`);
    $('[data-dlg="close"]', $('#dialogLayer')).onclick = () => closeLayer('#dialogLayer');
  };

  $('#banner').onclick = (e) => {
    const b = e.target.closest('[data-banner]');
    if (!b) return;
    if (b.dataset.banner === 'model') openModelPicker();
    if (b.dataset.banner === 'link') G.open(b.dataset.link);
    $('#banner').hidden = true;
  };

  // Katmanlar
  for (const id of ['#paletteLayer', '#modelLayer', '#settingsLayer']) {
    $(id).addEventListener('mousedown', (e) => { if (e.target === $(id)) closeLayer(id); });
  }
  $('#dialogLayer').addEventListener('click', (e) => {
    const r = e.target.closest('[data-reply]');
    if (r) replyPermission(r.dataset.reply);
  });
  $('#paletteInput').oninput = renderPalette;
  $('#paletteInput').onkeydown = (e) => {
    const n = paletteList.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      paletteSel = (paletteSel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      $$('#paletteList .opt').forEach((b, i) => b.classList.toggle('sel', i === paletteSel));
      $$('#paletteList .opt')[paletteSel]?.scrollIntoView({ block: 'nearest' });
    }
    if (e.key === 'Enter') runPalette(paletteSel);
  };
  $('#paletteList').onclick = (e) => { const b = e.target.closest('[data-pal]'); if (b) runPalette(Number(b.dataset.pal)); };
  $('#modelFilter').oninput = renderModelList;
  $('#modelFilter').onkeydown = (e) => { if (e.key === 'Enter') $('#modelList [data-model]')?.click(); };
  $('#modelList').onclick = async (e) => {
    const b = e.target.closest('[data-model]');
    if (!b) return;
    const key = b.dataset.model;
    if (isLocked(key)) { const l = { ...(state.cfg.lockedModels || {}) }; delete l[key]; await setCfg('lockedModels', l); }
    await setCfg('model', key);
    renderModelChip(); renderInspector();
    closeLayer('#modelLayer');
    $('#input').focus();
  };

  // Ayarlar etkileşimleri
  $('#settingsLayer').addEventListener('click', async (e) => {
    const t = e.target.closest('button, [data-open]');
    if (!t) return;
    const ds = t.dataset;
    if (ds.closeSettings !== undefined) return closeLayer('#settingsLayer');
    if (ds.tab) return showTab(ds.tab);
    if (ds.open) return G.open(ds.open);
    if (ds.themeSet) { await setCfg('theme', ds.themeSet); applyTheme(); return showTab('look'); }
    if (ds.accentSet) { await setCfg('accent', ds.accentSet); applyTheme(); return showTab('look'); }
    if (ds.switch === 'motion') { await setCfg('motion', !(state.cfg.motion !== false)); applyTheme(); return showTab('look'); }
    if (ds.switch === 'auto') { t.classList.toggle('on'); return; }
    if (ds.switch === 'autoSwitch') { await setCfg('autoSwitch', !(state.cfg.autoSwitch !== false)); return showTab('models'); }
    if (ds.switch === 'rotate') { await setCfg('rotate', !state.cfg.rotate); return showTab('models'); }
    if (ds.unlock) { const l = { ...(state.cfg.lockedModels || {}) }; delete l[ds.unlock]; await setCfg('lockedModels', l); renderModelChip(); return showTab('models'); }
    if (t.id === 'cloudSave') {
      let url = $('#cloudUrl').value.trim().replace(/\/$/, '');
      if (url && !/^https?:\/\//.test(url)) url = 'https://' + url;
      await setCfg('cloud', { url, key: $('#cloudKey').value.trim() });
      await restartEngine(url ? 'Glassly Bulut bağlanıyor…' : 'Glassly Bulut kapatıldı.');
      return showTab('models');
    }
    if (ds.openUrl) return G.open(ds.openUrl);
    if (ds.connOn === 'google' || ds.connOn === 'gmail' || ds.connOn === 'drive') {
      const st = await G.conn.status();
      return st.googleClient ? startGoogle() : googleSetup();
    }
    if (ds.connOn === 'github-device') return githubDevice();
    if (ds.connOn === 'github') {
      const tok = $('#ghToken').value.trim();
      if (!tok) return toast('Önce GitHub belirtecini yapıştır.', 'err');
      return connAction(() => G.conn.github(tok), 'GitHub bağlandı.');
    }
    if (ds.connOff === 'github') return connAction(() => G.conn.githubOff(), 'GitHub kaldırıldı.');
    if (ds.connOff) return connAction(() => G.conn.googleOff(), 'Google bağlantısı kaldırıldı.');
    if (t.id === 'gcSave') {
      const client_id = $('#gcId').value.trim();
      if (!client_id) return toast('İstemci kimliğini yapıştır.', 'err');
      await G.conn.googleClient({ client_id, client_secret: $('#gcSecret').value.trim(), profile: $('#gcProfile').value });
      toast('Google istemcisi kaydedildi.');
      return renderConnections();
    }
    if (t.id === 'gcDel') { await G.conn.googleClient(null); return renderConnections(); }
    if (t.id === 'mcpAdd') {
      const id = $('#mcpId').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      const target = $('#mcpUrl').value.trim();
      if (!id || !target) return toast('Ad ve adres gerekli.', 'err');
      const remote = /^https?:\/\//.test(target);
      const list = [...((await G.conn.status()).custom || []).filter((m) => m.id !== id),
        remote ? { id, type: 'remote', url: target, token: $('#mcpToken').value.trim(), enabled: true } : { id, type: 'local', command: target, enabled: true }];
      return connAction(() => G.conn.custom(list), 'MCP sunucusu eklendi.');
    }
    if (ds.mcpDel !== undefined) {
      const list = ((await G.conn.status()).custom || []).filter((_, i) => i !== Number(ds.mcpDel));
      return connAction(() => G.conn.custom(list), 'MCP sunucusu silindi.');
    }
    if (t.id === 'permApply') {
      const p = { ...(state.cfg.permissions || {}) };
      $$('[data-perm-set]').forEach((s) => (p[s.dataset.permSet] = s.value));
      p.auto = $('[data-switch="auto"]').classList.contains('on');
      await setCfg('permissions', p);
      return restartEngine();
    }
    if (ds.provSave) {
      const key = $(`[data-prov-key="${ds.provSave}"]`).value.trim();
      if (!key) return toast('Önce anahtarı yapıştır.', 'err');
      try { await api('PUT', `/auth/${ds.provSave}`, { type: 'api', key }); } catch (err) { return toast(err.message, 'err'); }
      toast('Anahtar kaydedildi.');
      await restartEngine('Sağlayıcı bağlandı, modeller yükleniyor…');
      return;
    }
    if (ds.provDel) {
      try { await api('DELETE', `/auth/${ds.provDel}`); } catch (err) { return toast(err.message, 'err'); }
      await restartEngine('Sağlayıcı kaldırıldı.');
      return;
    }
    if (t.id === 'cpAdd') {
      const id = $('#cpId').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
      const baseURL = $('#cpUrl').value.trim();
      const models = $('#cpModels').value.split(',').map((s) => s.trim()).filter(Boolean);
      if (!id || !baseURL || !models.length) return toast('Kimlik, adres ve en az bir model gerekli.', 'err');
      const list = [...(state.cfg.customProviders || []).filter((p) => p.id !== id), { id, name: $('#cpName').value.trim() || id, baseURL, apiKey: $('#cpKey').value.trim(), models }];
      await setCfg('customProviders', list);
      return restartEngine('Özel sağlayıcı eklendi.');
    }
    if (ds.cpDel) {
      const list = [...(state.cfg.customProviders || [])]; list.splice(Number(ds.cpDel), 1);
      await setCfg('customProviders', list);
      return restartEngine('Özel sağlayıcı silindi.');
    }
    if (t.id === 'instrSave') { await setCfg('instructions', $('#instrText').value); return restartEngine('Talimatlar kaydedildi.'); }
    if (t.id === 'engRestart') { await restartEngine('Motor yeniden başlıyor…'); return showTab('engine'); }
    if (t.id === 'engUpdate') {
      toast('Güncellemeler denetleniyor…');
      try { const r = await G.engine.update(); toast(r.updated ? `opencode ${r.version} kuruldu.` : 'Motor zaten güncel.'); } catch (err) { toast(err.message, 'err'); }
      return showTab('engine');
    }
    if (ds.skillDel) { await G.skills.remove(ds.skillDel); toast('Yetenek silindi.'); return showTab('skills'); }
    if (t.id === 'skillNew' || ds.skillEdit) {
      const name = ds.skillEdit || '';
      let content = `---\nname: yeni-yetenek\ndescription: "Ne zaman kullanılacağını tek cümleyle yaz"\n---\n\n# Yeni yetenek\n\nAjanın bu işi nasıl yapacağını adım adım anlat.\n`;
      if (name) content = (await G.skills.read(name)) || content;
      $('#skillEditor').innerHTML = `<div style="margin-top:18px;display:flex;flex-direction:column;gap:8px"><input class="field" id="skName" placeholder="yetenek-adi" value="${esc(name)}" /><textarea class="field" id="skBody" rows="12">${esc(content)}</textarea><div><button class="btn sm primary" id="skSave">Kaydet</button></div></div>`;
      return;
    }
    if (t.id === 'skSave') {
      const name = $('#skName').value.trim() || (/^name:\s*(.+)$/m.exec($('#skBody').value) || [])[1];
      try { await G.skills.save({ name, content: $('#skBody').value }); } catch (err) { return toast(err.message, 'err'); }
      toast('Yetenek kaydedildi.');
      return showTab('skills');
    }
    if (t.id === 'skillApply') return restartEngine('Yetenekler yenileniyor…');
  });
  $('#settingsLayer').addEventListener('input', (e) => {
    if (e.target.id === 'blurRange') { const v = Number(e.target.value); document.documentElement.style.setProperty('--blur', v + 'px'); setCfg('blur', v); }
  });

  // Klavye kısayolları
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') {
      for (const id of ['#paletteLayer', '#modelLayer', '#settingsLayer']) if (!$(id).hidden) return closeLayer(id);
      if (!$('#dialogLayer').hidden && !state.pendingPermissions.length) return closeLayer('#dialogLayer');
      if (isBusy() && !state.suggest) submit();
      return;
    }
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 'k') { e.preventDefault(); openPalette(); }
    else if (k === 'n') { e.preventDefault(); newSession(); }
    else if (k === 'o') { e.preventDefault(); pickProject(); }
    else if (k === 'm') { e.preventDefault(); openModelPicker(); }
    else if (k === ',') { e.preventDefault(); openSettings(); }
    else if (k === 'b') { e.preventDefault(); toggleSessions(); }
    else if (k === 'i') { e.preventDefault(); toggleInspector(); }
  });

  // Dış bağlantıları sistem tarayıcısında aç
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (a && /^https?:/.test(a.getAttribute('href'))) { e.preventDefault(); G.open(a.href); }
  });
}

function findPart(partId) {
  const d = state.current && sessionData(state.current);
  if (!d) return null;
  for (const m of d.msgs.values()) if (m.parts.has(partId)) return m.parts.get(partId);
  return null;
}

// ================================================================ kullanım modu (Günlük / Kod)
function applyMode() {
  const daily = isDaily();
  document.body.classList.toggle('mode-gunluk', daily);
  $$('#modeTabs button').forEach((b) => { const on = b.dataset.mode === (daily ? 'gunluk' : 'kod'); b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  $('#input').placeholder = daily ? 'Glassly\'ye bir şey sor…' : 'Glassly\'ye bir iş ver…  ( / komutlar · @ dosya )';
}

async function setMode(mode) {
  if ((isDaily() ? 'gunluk' : 'kod') === mode) return;
  await setCfg('mode', mode);
  applyMode();
  state.current = null;
  $('#sessionTitle').value = '';
  showWelcome();
  await loadSessions();
  renderInspector();
  $('#input').focus();
}

// Günlük karşılama ekranında bağlı olmayan hesaplar için kısayol
async function renderConnChips() {
  const el = $('#connChips');
  let st = null;
  try { st = await G.conn.status(); } catch { /* yok say */ }
  const g = st?.google || {};
  const mailOn = !!st?.google?.gmail;
  const items = [['gmail', 'mail', mailOn ? 'E-posta bağlı' : 'Gmail\'i bağla', mailOn], ['calendar', 'calendar', st?.google?.calendar ? 'Takvim bağlı' : 'Takvimi bağla', !!st?.google?.calendar], ['github', 'github', st?.github ? 'GitHub bağlı' : 'GitHub\'ı bağla', !!st?.github]];
  el.innerHTML = items.map(([id, ic, t, on]) => `<button data-conn-open="${id}" class="${on ? 'on' : ''}" title="${esc(t)}">${icon(on ? 'check' : ic, 14)}<span>${t}</span></button>`).join('');
}

// Onay penceresi: Glassly e-posta göndermek, dosya veya issue oluşturmak istediğinde
const confirmQueue = [];
function showConfirm() {
  const c = confirmQueue[0];
  if (!c) return closeLayer('#dialogLayer');
  const ic = { mail: 'mail', gmail: 'mail', drive: 'drive', github: 'github', calendar: 'calendar' }[c.kind] || 'shield';
  openDialog(`<div class="dialog glass" data-confirm="${esc(c.id)}">
    <h3>${icon(ic)}${esc(c.title || 'Onay gerekiyor')}</h3>
    ${(c.fields || []).length ? `<dl class="confirm-fields">${c.fields.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
    ${c.text ? `<pre class="confirm-text">${esc(c.text)}</pre>` : ''}
    <div class="acts"><button class="btn ghost" data-confirm-reply="0">Vazgeç</button><button class="btn primary" data-confirm-reply="1">${esc(c.okLabel || 'Onayla')}</button></div>
  </div>`);
}

// ================================================================ asistan: bağlam, dosyalar, ses, hatırlatıcılar, hafıza
const V = () => window.GlasslyVoice;
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Her mesaja görünmez bir bağlam eklenir: şu anki zaman ve (ilk mesajda) hafızadaki bilgiler
async function contextParts(first) {
  const now = new Date();
  const lines = [`[Glassly bağlamı, kullanıcıya gösterme] Şu an: ${now.toLocaleString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })} (${tz}, ISO ${toLocalISO(now)}).`];
  if (first) {
    try {
      const m = await G.memory.list();
      if (m.enabled && m.text) lines.push('Kullanıcı hakkında hafızanda olanlar:\n' + m.text);
    } catch { /* yok say */ }
  }
  return [{ type: 'text', text: lines.join('\n'), synthetic: true }];
}
const toLocalISO = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

function uploadParts(uploads) {
  return uploads.map((u) => (u.kind === 'image'
    ? { type: 'file', mime: u.mime, filename: u.name, url: u.url }
    : { type: 'text', synthetic: true, text: `<dosya ad="${u.name.replace(/"/g, "'")}"${u.pages ? ` sayfa="${u.pages}"` : ''}${u.truncated ? ' kisaltildi="evet"' : ''}>\n${u.text}\n</dosya>` }));
}

async function addFiles(paths) {
  paths = (paths || []).filter(Boolean);
  if (!paths.length) return;
  for (const p of paths) {
    const u = { name: baseName(p), loading: true };
    state.uploads.push(u);
    renderAttachments();
    const r = await G.files.extract(p);
    Object.assign(u, r, { loading: false });
    if (r.error) toast(r.error, 'err');
    else if (r.truncated) toast(`${u.name} çok uzun; ilk kısmı eklendi.`);
    renderAttachments();
  }
  $('#input').focus();
}

async function addBlobImage(blob, name = 'yapistirilan-gorsel.png') {
  if (blob.size > 8 * 1024 * 1024) return toast('Görsel çok büyük (en fazla 8 MB).', 'err');
  const url = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
  state.uploads.push({ name, kind: 'image', mime: blob.type || 'image/png', url, size: blob.size });
  renderAttachments();
}

// --- oturum bittiğinde: sesli sohbette yanıtı oku, arka plan işlerinde bildirim göster
function lastAssistantText(sid) {
  const d = sessionData(sid);
  for (let i = d.order.length - 1; i >= 0; i--) {
    const m = d.msgs.get(d.order[i]);
    if (!m) continue;
    if (m.info.role === 'user') break;
    const t = [...m.parts.values()].filter((p) => p.type === 'text' && !p.synthetic && p.text).map((p) => p.text).join('\n');
    if (t.trim()) return { id: m.info.id, text: t };
  }
  return null;
}

async function onSessionDone(sid) {
  if (state.taskSessions.has(sid)) {
    const title = state.taskSessions.get(sid);
    state.taskSessions.delete(sid);
    const last = lastAssistantText(sid);
    if (!(await G.focused()) || sid !== state.current) G.notify({ title: 'Glassly işini bitirdi: ' + title, body: last ? last.text.replace(/[#*_`>|]/g, '').slice(0, 220) : '' });
  }
  if (sid !== state.current) return;
  const cfgV = state.cfg.voice || {};
  if (state.voiceChat || (cfgV.autoRead && state.lastInputVoice)) {
    setTimeout(async () => {
      if (isBusy()) return;
      const last = lastAssistantText(sid);
      if (last) {
        if (state.voiceChat) {
          const bar = $('#voiceBar');
          bar.hidden = false; bar.className = 'voice-bar speaking';
          $('#vbText').textContent = 'Glassly konuşuyor…';
          $('#vbStop').textContent = 'Sustur';
        }
        await speakMessage(last.id, last.text);
        if (state.voiceChat && $('#voiceBar').classList.contains('speaking')) $('#voiceBar').hidden = true;
      }
      if (state.voiceChat && !isBusy() && !V().listening()) startListening(true);
    }, 250);
  }
}

// --- sesli okuma
async function speakMessage(id, text) {
  const v = state.cfg.voice || {};
  state.speakingMsg = id;
  scheduleRender();
  await V().speak(text, { voice: v.voice || 'tr-TR-EmelNeural', rate: v.rate || 0, onError: (e) => toast(e.message, 'err') });
  if (state.speakingMsg === id) { state.speakingMsg = null; scheduleRender(); }
}
function stopSpeaking() { V().stopSpeaking(); state.speakingMsg = null; scheduleRender(); }

// --- dinleme
let sttNoticeShown = false;
async function startListening(auto = false) {
  if (V().listening()) return V().stop();
  stopSpeaking();
  const bar = $('#voiceBar');
  const txt = $('#vbText');
  const bars = $$('#vbWave i');
  $('#btnMic').classList.add('rec');
  bar.hidden = false;
  bar.className = 'voice-bar listening';
  $('#vbStop').textContent = 'Bitir';
  txt.textContent = state.voiceChat ? 'Sesli sohbet · dinliyorum…' : 'Dinliyorum… konuşman bitince kendiliğinden durur';
  let audio;
  try {
    audio = await V().listen({
      onLevel: (lv) => bars.forEach((b, i) => { b.style.transform = `scaleY(${0.25 + Math.min(1, lv * (1.6 - Math.abs(i - 2) * 0.3)) * 0.9})`; }),
    });
  } catch (e) {
    $('#btnMic').classList.remove('rec');
    bar.hidden = true;
    setVoiceChat(false);
    return toast(e.message, 'err');
  }
  $('#btnMic').classList.remove('rec');
  if (!audio) {
    bar.hidden = true;
    if (auto && state.voiceChat) { setVoiceChat(false); toast('Sesli sohbet kapandı.'); }
    else toast('Ses algılanmadı. Ayarlar → Ses bölümünden mikrofonu test edebilirsin.', 'err');
    return;
  }
  bar.className = 'voice-bar working';
  bars.forEach((b) => (b.style.transform = ''));
  txt.textContent = 'Yazıya çeviriyorum…';
  const off = V().onProgress((p) => {
    if (!sttNoticeShown) { sttNoticeShown = true; }
    txt.textContent = p.loaded < p.total ? `Ses modeli hazırlanıyor (ilk seferlik) · %${Math.round((p.loaded / p.total) * 100)}` : 'Yazıya çeviriyorum…';
  });
  let text = '';
  try { text = await V().transcribe(audio, (state.cfg.voice || {}).model); } catch (e) { off(); bar.hidden = true; setVoiceChat(false); return toast(sttError(e), 'err'); }
  off();
  bar.hidden = true;
  text = (text || '').replace(/^\s*[[(].*?[\])]\s*$/, '').trim();
  if (!text) {
    if (state.voiceChat) return startListening(true);
    return toast('Ses anlaşılamadı, tekrar dener misin?');
  }
  const input = $('#input');
  input.value = input.value.trim() ? input.value.trim() + ' ' + text : text;
  autosize();
  state.lastInputVoice = true;
  if (state.voiceChat || (state.cfg.voice || {}).autoSend) submit();
  else input.focus();
}

// --- Ayarlar → Ses: mikrofon seçimi ve deneme
async function fillMics() {
  const sel = $('#micSel');
  if (!sel) return;
  const list = await V().devices();
  const cur = V().micId();
  sel.innerHTML = '<option value="">Varsayılan mikrofon</option>' + list.filter((d) => d.id && d.id !== 'default').map((d) => `<option value="${esc(d.id)}" ${d.id === cur ? 'selected' : ''}>${esc(d.label)}</option>`).join('');
  $('#micInfo').textContent = list.length ? `${list.length} mikrofon bulundu` : 'Mikrofon bulunamadı. Takılı olduğundan ve sistemin gördüğünden emin ol.';
}
async function micTest(btn) {
  const out = $('#micResult'), meter = $('#micMeter');
  if (V().listening()) return V().stop();
  btn.innerHTML = `${icon('stop', 14)}Bitir`;
  out.className = 'mic-result'; out.textContent = 'Bir şey söyle… (ör. “yarın sabah toplantım var”)';
  let audio = null, peak = 0;
  try {
    audio = await V().listen({ maxMs: 8000, silenceMs: 1200, keepSilent: true, onLevel: (lv) => { peak = Math.max(peak, lv); if (meter) meter.style.width = Math.round(lv * 100) + '%'; } });
  } catch (e) {
    out.className = 'mic-result bad'; out.textContent = e.message;
    btn.innerHTML = `${icon('mic', 14)}Mikrofonu test et`;
    return;
  }
  if (meter) meter.style.width = '0%';
  btn.innerHTML = `${icon('mic', 14)}Mikrofonu test et`;
  if (!audio || peak < 0.05) { out.className = 'mic-result bad'; out.textContent = 'Ses gelmiyor. Üstten başka bir mikrofon seç ya da sistem ses ayarlarında giriş seviyesini aç.'; return; }
  out.textContent = 'Ses geliyor. Yazıya çeviriyorum…';
  const off = V().onProgress((p) => { if (p.loaded < p.total) out.textContent = `Ses modeli iniyor (ilk seferlik) · %${Math.round((p.loaded / p.total) * 100)}`; else out.textContent = 'Yazıya çeviriyorum…'; });
  try {
    const text = (await V().transcribe(audio, (state.cfg.voice || {}).model) || '').trim();
    out.className = 'mic-result ' + (text ? 'good' : 'bad');
    out.textContent = text ? `Duyduğum: “${text}”` : 'Ses geldi ama konuşma anlaşılamadı. Biraz daha yakından ve net konuş.';
  } catch (e) { out.className = 'mic-result bad'; out.textContent = sttError(e); }
  off();
}
const sttError = (e) => (/fetch|network|Failed to|load|404|ERR_/i.test(String(e?.message)) ? 'Ses modeli indirilemedi. İnternet bağlantını kontrol edip tekrar dene.' : 'Ses yazıya çevrilemedi: ' + (e?.message || e));

function setVoiceChat(on) {
  state.voiceChat = on;
  $('#btnVoiceChat').classList.toggle('on', on);
  $('#btnVoiceChat').dataset.tip = on ? 'Sesli sohbeti kapat' : 'Sesli sohbet';
  if (!on) { V().cancel(); stopSpeaking(); $('#voiceBar').hidden = true; }
}

// --- hatırlatıcılar
async function renderReminders() {
  const el = $('#remList');
  if (!el) return;
  let list = [];
  try { list = await G.reminders.list(); } catch { /* */ }
  el.innerHTML = list.length
    ? list.slice(0, 8).map((r) => `<div class="rem"><span class="ic">${icon(r.task ? 'spark' : 'bell', 13)}</span><div class="t"><b>${esc(r.text)}</b><span>${esc(r.when)}${r.repeatKey !== 'none' ? ' · ' + esc(r.repeat) : ''}</span></div><button class="x" data-rem-del="${r.id}" aria-label="Sil">${icon('x', 12)}</button></div>`).join('')
    : '<p class="empty">"Yarın 9\'da bana hatırlat" de, burada görünsün.</p>';
}

async function onReminderFire(r) {
  renderReminders();
  if (r.task) return runTask(r.text);
  openDialog(`<div class="dialog glass">
    <h3>${icon('bell')}Hatırlatma</h3>
    <p style="font-size:var(--text-md);margin:6px 0 2px">${esc(r.text)}</p>
    <p class="sub">${esc(r.when)}${r.repeat && r.repeat !== 'Bir kez' ? ' · ' + esc(r.repeat) : ''}</p>
    <div class="acts"><button class="btn ghost" data-snooze="${esc(r.text)}">10 dk ertele</button><button class="btn primary" data-close-dialog>Tamam</button></div>
  </div>`);
  if ((state.cfg.voice || {}).readReminders) V().speak('Hatırlatma: ' + r.text, { voice: (state.cfg.voice || {}).voice });
}

// Zamanlanmış işi Günlük modunda yeni bir sohbette çalıştırır
async function runTask(prompt) {
  if (state.engine.state !== 'ready') { setTimeout(() => runTask(prompt), 5000); return; }
  const model = currentModel() || (await loadModels(), currentModel());
  if (!model) return;
  const dir = state.daily;
  const title = prompt.length > 48 ? prompt.slice(0, 46) + '…' : prompt;
  try {
    const s = await api('POST', '/session', { title: 'Zamanlanmış: ' + title }, dir);
    ownSession(s.id);
    state.taskSessions.set(s.id, title);
    sessionData(s.id).busy = true;
    if (isDaily()) { state.sessions.unshift(s); renderSessions(); }
    await api('POST', `/session/${s.id}/prompt_async`, {
      model: { providerID: model.providerID, modelID: model.modelID },
      agent: 'gunluk',
      parts: [...(await contextParts(true)), { type: 'text', synthetic: true, text: 'Bu, kullanıcının daha önce zamanladığı bir iş. Kullanıcı şu an başında olmayabilir; işi yap ve sonucu kısa bir özetle bildir. Onay gerektiren adımlarda (e-posta göndermek gibi) yine onay iste.' }, { type: 'text', text: prompt }],
    }, dir);
    toast('Zamanlanmış iş başladı: ' + title);
  } catch (e) { toast('Zamanlanmış iş başlatılamadı: ' + e.message, 'err'); }
}

// --- ayar sekmeleri: Hafıza, Hatırlatıcılar, Ses
async function featureTab(tab) {
  if (tab === 'memory') {
    const m = await G.memory.list();
    return `<h3>Hafıza</h3><p class="sub">Glassly seninle ilgili önemli şeyleri hatırlar: adın, işin, sık yazıştığın kişiler, tercihlerin. Sohbette "bunu hatırla" demen yeter. Hepsi yalnızca bu bilgisayarda durur.</p>
      <div class="row"><div class="l"><b>Hafızayı kullan</b><span>Kapalıyken Glassly yeni bir şey kaydetmez ve kayıtlıları kullanmaz</span></div><button class="switch ${m.enabled ? 'on' : ''}" data-mem-toggle aria-label="Hafıza"></button></div>
      <div class="mem-add"><input class="field" id="memNew" placeholder="Ör: Adım Ahmet, Konya'da yazılım geliştiriciyim." maxlength="500" /><button class="btn sm primary" id="memAddBtn">Ekle</button></div>
      <div class="mem-list">${m.items.length ? m.items.slice().reverse().map((x) => `<div class="skill-row"><div class="l"><b>${esc(x.text)}</b><span>${new Date(x.at).toLocaleDateString('tr-TR', { dateStyle: 'medium' })}</span></div><button class="btn sm ghost" data-mem-del="${x.id}">Unut</button></div>`).join('') : '<p class="empty">Henüz bir şey kaydedilmedi.</p>'}</div>`;
  }
  if (tab === 'rem') {
    const list = await G.reminders.list();
    const bg = await G.background();
    const def = new Date(Date.now() + 3600e3); def.setMinutes(0, 0, 0);
    return `<h3>Hatırlatıcılar</h3><p class="sub">Sohbette "yarın 9'da bana faturayı hatırlat" ya da "her sabah 8'de gelen kutumu özetle" demen yeterli. Buradan da ekleyebilirsin.</p>
      <div class="rem-form">
        <input class="field" id="remText" placeholder="Ne hatırlatayım? Ya da ne yapayım?" style="grid-column:1/-1" />
        <input class="field" id="remWhen" type="datetime-local" value="${toLocalISO(def)}" />
        <select class="field" id="remRepeat"><option value="none">Bir kez</option><option value="daily">Her gün</option><option value="weekdays">Hafta içi</option><option value="weekly">Her hafta</option><option value="monthly">Her ay</option></select>
        <label class="check"><input type="checkbox" id="remTask" /> Zamanı gelince bu işi Glassly yapsın</label>
        <button class="btn sm primary" id="remSave">Ekle</button>
      </div>
      <div class="mem-list">${list.length ? list.map((r) => `<div class="skill-row"><div class="l"><b>${icon(r.task ? 'spark' : 'bell', 13)} ${esc(r.text)}</b><span>${esc(r.when)} · ${esc(r.repeat)}${r.task ? ' · Glassly yapacak' : ''}</span></div><button class="btn sm ghost" data-rem-del="${r.id}">Sil</button></div>`).join('') : '<p class="empty">Kurulu hatırlatıcı yok.</p>'}</div>
      <div class="row" style="margin-top:18px"><div class="l"><b>Kapatınca arka planda çalış</b><span>Pencereyi kapatsan da Glassly sistem tepsisinde kalır, hatırlatıcılar zamanında gelir</span></div><button class="switch ${bg ? 'on' : ''}" data-bg-toggle aria-label="Arka planda çalış"></button></div>`;
  }
  const v = state.cfg.voice || {};
  const sw = (k, on) => `<button class="switch ${on ? 'on' : ''}" data-voice-switch="${k}" aria-label="${k}"></button>`;
  return `<h3>Ses</h3><p class="sub">Mikrofon düğmesine basıp konuş; Glassly yazıya çevirir. Sesli sohbet modunda yanıtı sesli okur ve seni yeniden dinler. Konuşman bilgisayarında yazıya çevrilir, hiçbir yere gönderilmez.</p>
    <div class="mic-test glass-soft">
      <div class="row" style="border:0;padding-top:0"><div class="l"><b>Mikrofon</b><span id="micInfo">Hangi mikrofonun kullanılacağını seç</span></div><select class="field" id="micSel" style="width:auto;max-width:260px"><option value="">Varsayılan mikrofon</option></select></div>
      <div class="mic-meter"><i id="micMeter"></i></div>
      <div class="mic-acts"><button class="btn sm primary" id="micTest">${icon('mic', 14)}Mikrofonu test et</button><span id="micResult" class="mic-result"></span></div>
    </div>
    <div class="row"><div class="l"><b>Okuyan ses</b><span>Doğal Türkçe sesler</span></div><select class="field" data-voice-set="voice" style="width:auto">${[['tr-TR-EmelNeural', 'Emel (kadın)'], ['tr-TR-AhmetNeural', 'Ahmet (erkek)']].map(([id, n]) => `<option value="${id}" ${(v.voice || 'tr-TR-EmelNeural') === id ? 'selected' : ''}>${n}</option>`).join('')}</select><button class="btn sm ghost" id="voiceTest">${icon('speaker', 14)}Dinle</button></div>
    <div class="row"><div class="l"><b>Okuma hızı</b><span>Yavaştan hızlıya</span></div><input type="range" min="-30" max="40" step="5" value="${v.rate || 0}" data-voice-range="rate" /></div>
    <div class="row"><div class="l"><b>Konuşarak sorunca sesli yanıtla</b><span>Mikrofonla sorduğunda yanıt kendiliğinden okunur</span></div>${sw('autoRead', !!v.autoRead)}</div>
    <div class="row"><div class="l"><b>Konuşma bitince hemen gönder</b><span>Yazıya çevrilen metni beklemeden gönderir</span></div>${sw('autoSend', !!v.autoSend)}</div>
    <div class="row"><div class="l"><b>Hatırlatmaları sesli oku</b><span>Hatırlatma geldiğinde sesli söyler</span></div>${sw('readReminders', !!v.readReminders)}</div>
    <div class="row"><div class="l"><b>Tanıma kalitesi</b><span>Hızlı yaklaşık 80 MB, Kaliteli yaklaşık 250 MB; ilk kullanımda bir kez iner</span></div><select class="field" data-voice-set="model" style="width:auto">${[['onnx-community/whisper-base', 'Hızlı'], ['onnx-community/whisper-small', 'Kaliteli']].map(([id, n]) => `<option value="${id}" ${(v.model || 'onnx-community/whisper-base') === id ? 'selected' : ''}>${n}</option>`).join('')}</select><button class="btn sm ghost" id="voicePreload">Şimdi indir</button></div>`;
}

function initFeatures() {
  $('#btnAttach').onclick = async () => addFiles(await G.files.pick());
  $('#btnMic').onclick = () => { if (V().listening()) V().stop(); else startListening(false); };
  $('#btnVoiceChat').onclick = () => {
    if (state.voiceChat) return setVoiceChat(false);
    setVoiceChat(true);
    if (!isBusy()) startListening(true);
  };
  $('#vbStop').onclick = () => {
    if ($('#voiceBar').classList.contains('speaking')) { stopSpeaking(); return; }
    V().stop();
  };
  $('#vbCancel').onclick = () => { V().cancel(); $('#voiceBar').hidden = true; setVoiceChat(false); };
  $('#input').addEventListener('input', () => { state.lastInputVoice = false; });
  $('#attachments').addEventListener('click', (e) => { const b = e.target.closest('[data-unupload]'); if (b) { state.uploads.splice(Number(b.dataset.unupload), 1); renderAttachments(); } });

  // Sürükle-bırak ve yapıştırma
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('#dropHint').hidden = false; });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropHint').hidden = true; });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0; $('#dropHint').hidden = true;
    const files = [...e.dataTransfer.files];
    const paths = files.map((f) => G.files.pathOf(f)).filter(Boolean);
    if (paths.length) addFiles(paths);
    else files.filter((f) => f.type.startsWith('image/')).forEach((f) => addBlobImage(f, f.name));
  });
  $('#input').addEventListener('paste', (e) => {
    const imgs = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (!imgs.length) return;
    e.preventDefault();
    imgs.forEach((i) => addBlobImage(i.getAsFile()));
  });

  // Mesaj eylemleri: sesli oku, kopyala
  $('#threadInner').addEventListener('click', (e) => {
    const sp = e.target.closest('[data-speak]');
    if (sp) {
      const id = sp.dataset.speak;
      if (state.speakingMsg === id) return stopSpeaking();
      const m = sessionData(state.current).msgs.get(id);
      const t = m && [...m.parts.values()].filter((p) => p.type === 'text' && !p.synthetic && p.text).map((p) => p.text).join('\n');
      if (t) speakMessage(id, t);
      return;
    }
    const cp = e.target.closest('[data-copy-msg]');
    if (cp) {
      const m = sessionData(state.current).msgs.get(cp.dataset.copyMsg);
      const t = m && [...m.parts.values()].filter((p) => p.type === 'text' && !p.synthetic && p.text).map((p) => p.text).join('\n');
      if (t) navigator.clipboard.writeText(t).then(() => toast('Kopyalandı.'));
    }
  });

  // Görev paneli: hatırlatıcılar
  $('#remAdd').onclick = () => openSettings('rem');
  $('#remList').addEventListener('click', async (e) => { const b = e.target.closest('[data-rem-del]'); if (b) { await G.reminders.remove(b.dataset.remDel); renderReminders(); } });
  G.reminders.onFire(onReminderFire);
  G.onAssistantChanged(async (what) => {
    if (what === 'reminders') renderReminders();
    const tab = $('.settings-nav button.on')?.dataset.tab;
    if (!$('#settingsLayer').hidden && ((what === 'memory' && tab === 'memory') || (what === 'reminders' && tab === 'rem'))) showTab(tab);
  });
  renderReminders();
  setInterval(renderReminders, 60e3);

  // GitHub cihaz akışı sonucu
  G.conn.onChanged(async ({ what, err }) => {
    if (what === 'account') {
      renderConnChips();
      if (!$('#settingsLayer').hidden && $('.settings-nav button.on')?.dataset.tab === 'conn') renderConnections();
    } else if (what === 'github') {
      if ($('#ghDevice')) closeLayer('#dialogLayer');
      await restartEngine('GitHub bağlandı.');
      renderConnections(); renderConnChips();
    } else if (what === 'github-error') {
      if ($('#ghDevice')) closeLayer('#dialogLayer');
      toast('GitHub bağlanamadı: ' + err, 'err');
    }
  });
  $('#dialogLayer').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.copyCode) { navigator.clipboard.writeText(t.dataset.copyCode); toast('Kod kopyalandı.'); }
    else if (t.dataset.openUrl) G.open(t.dataset.openUrl);
    else if (t.hasAttribute('data-gh-cancel')) { G.conn.githubCancel(); closeLayer('#dialogLayer'); }
    else if (t.hasAttribute('data-close-dialog')) closeLayer('#dialogLayer');
    else if (t.dataset.snooze) { G.reminders.add({ text: t.dataset.snooze, in_minutes: 10 }).then(renderReminders); toast('10 dakika sonra tekrar hatırlatacağım.'); closeLayer('#dialogLayer'); }
  });

  // Ayar sekmeleri
  const L = $('#settingsLayer');
  L.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const ds = t.dataset;
    if (t.hasAttribute('data-mem-toggle')) { const m = await G.memory.list(); await G.memory.enabled(!m.enabled); await restartEngine(m.enabled ? 'Hafıza kapatıldı.' : 'Hafıza açıldı.'); return showTab('memory'); }
    if (t.id === 'memAddBtn') { const v = $('#memNew').value.trim(); if (!v) return; await G.memory.add(v); return showTab('memory'); }
    if (ds.memDel) { await G.memory.forget(ds.memDel); return showTab('memory'); }
    if (t.id === 'remSave') {
      const text = $('#remText').value.trim();
      if (!text) return toast('Ne hatırlatayım?', 'err');
      try { await G.reminders.add({ text, when: $('#remWhen').value, repeat: $('#remRepeat').value, task: $('#remTask').checked }); } catch (er) { return toast(ipcErr(er), 'err'); }
      toast('Hatırlatıcı kuruldu.');
      renderReminders();
      return showTab('rem');
    }
    if (ds.remDel) { await G.reminders.remove(ds.remDel); renderReminders(); return showTab('rem'); }
    if (t.hasAttribute('data-bg-toggle')) { await G.background(!(await G.background())); return showTab('rem'); }
    if (ds.voiceSwitch) { const v = { ...(state.cfg.voice || {}) }; v[ds.voiceSwitch] = !v[ds.voiceSwitch]; await setCfg('voice', v); return showTab('voice'); }
    if (t.closest('#voiceTest')) {
      const b = t.closest('#voiceTest'), v = state.cfg.voice || {};
      b.disabled = true;
      await V().speak('Merhaba, ben Glassly. Bugün sana nasıl yardım edebilirim?', { voice: v.voice || 'tr-TR-EmelNeural', rate: v.rate || 0, onError: (er) => toast(er.message, 'err') });
      b.disabled = false;
      return;
    }
    if (t.closest('#micTest')) return micTest(t.closest('#micTest'));
    if (t.id === 'voicePreload') {
      t.disabled = true; t.textContent = 'İniyor…';
      const off = V().onProgress((p) => { t.textContent = '%' + Math.round((p.loaded / p.total) * 100); });
      try { await V().preload((state.cfg.voice || {}).model); t.textContent = 'Hazır'; } catch (er) { t.textContent = 'Olmadı'; toast('Ses modeli indirilemedi: ' + er.message, 'err'); }
      off();
    }
  });
  L.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'micSel') { if (t.value) localStorage.setItem('glassly.mic', t.value); else localStorage.removeItem('glassly.mic'); toast('Mikrofon seçildi.'); }
    if (t.dataset.voiceSet) { await setCfg('voice', { ...(state.cfg.voice || {}), [t.dataset.voiceSet]: t.value }); }
    if (t.dataset.voiceRange) { await setCfg('voice', { ...(state.cfg.voice || {}), [t.dataset.voiceRange]: Number(t.value) }); }
  });
  L.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'memNew') $('#memAddBtn').click(); if (e.key === 'Enter' && e.target.id === 'remText') $('#remSave').click(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (V().listening() || state.voiceChat)) { V().cancel(); $('#voiceBar').hidden = true; setVoiceChat(false); }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm') { e.preventDefault(); $('#btnMic').click(); }
  }, true);
}

// ================================================================ hesap (kaydol / giriş)
const acct = { status: null, tab: 'login', done: null };
const initials = (u) => {
  const n = (u?.name || u?.email || '?').trim();
  const parts = n.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 && u?.name ? parts[1][0] : '')).toLocaleUpperCase('tr');
};
const GOOGLE_G = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

function pwScore(p) {
  if (!p) return 0;
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 12) s++;
  if (/[a-zçğıöşü]/.test(p) && /[A-ZÇĞİÖŞÜ]/.test(p)) s++;
  if (/\d/.test(p) && /[^\w\sçğıöşüÇĞİÖŞÜ]/.test(p)) s++;
  return p.length < 8 ? Math.min(s, 1) : Math.max(1, s);
}
const PW_LABEL = ['En az 8 karakter', 'Zayıf', 'Orta', 'İyi', 'Güçlü'];

function renderAvatar() {
  const u = acct.status?.user;
  const b = $('#btnAccount');
  if (!b) return;
  b.hidden = !u;
  b.classList.toggle('dev', u?.role === 'gelistirici');
  $('#avatarText').textContent = u ? initials(u) : '';
  b.dataset.tip = u ? `${u.name || u.email}` : 'Hesabım';
}

function authScreen(tab = acct.tab, keep = {}) {
  acct.tab = tab;
  const st = acct.status || {};
  const reg = tab === 'register';
  const el = $('#auth');
  el.innerHTML = `<div class="auth-card glass" role="dialog" aria-modal="true" aria-label="Glassly hesabı">
    <div class="auth-brand"><svg width="52" height="52"><use href="#logo" /></svg><h1>${reg ? 'Hesabını oluştur' : 'Tekrar hoş geldin'}</h1>
      <p>${reg ? 'Bir dakikada hesabını aç, Glassly hemen işe koyulsun.' : 'Glassly hesabınla giriş yap, kaldığın yerden devam et.'}</p></div>
    <div class="auth-tabs" role="tablist"><button type="button" role="tab" data-auth-tab="login" class="${reg ? '' : 'on'}" aria-selected="${!reg}">Giriş yap</button><button type="button" role="tab" data-auth-tab="register" class="${reg ? 'on' : ''}" aria-selected="${reg}">Kaydol</button><span class="auth-tabs-ink"></span></div>
    ${st.google ? `<button type="button" class="btn ghost auth-google" id="authGoogle">${GOOGLE_G}<span>Google ile devam et</span></button>
      <div class="auth-or"><span>veya e-postayla</span></div>` : ''}
    <form id="authForm" novalidate>
      ${reg ? `<label class="auth-field"><span>Adın</span><input id="authName" autocomplete="name" placeholder="Adın Soyadın" value="${esc(keep.name || '')}" /></label>` : ''}
      <label class="auth-field"><span>E-posta</span><input id="authEmail" type="email" autocomplete="email" placeholder="ornek@gmail.com" value="${esc(keep.email || '')}" /></label>
      <label class="auth-field"><span>Şifre</span><div class="pw"><input id="authPass" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" placeholder="${reg ? 'En az 8 karakter' : 'Şifren'}" /><button type="button" class="pw-eye" data-pw-toggle aria-label="Şifreyi göster">${icon('eye', 16)}</button></div></label>
      ${reg ? `<div class="pw-meter" id="pwMeter" data-s="0"><i></i><i></i><i></i><i></i></div><small class="pw-hint" id="pwHint">${PW_LABEL[0]}</small>` : ''}
      <label class="auth-check"><input type="checkbox" id="authRemember" ${keep.remember === true ? 'checked' : ''} /><span>Beni hatırla</span></label>
      <p class="auth-err" id="authErr" role="alert" hidden></p>
      <button class="btn primary auth-submit" id="authSubmit" type="submit">${reg ? 'Hesap oluştur' : 'Giriş yap'}</button>
    </form>
    <p class="auth-foot">${st.mode === 'bulut' ? 'Hesabın Glassly Bulut\'ta tutulur; her bilgisayardan aynı hesapla girersin.' : 'Hesabın bu bilgisayarda tutulur. Şifren açık hâliyle hiçbir yere kaydedilmez.'}${st.google ? ' Gmail, Takvim ve Drive\'ı sonra Ayarlar → Bağlantılar\'dan bağlayabilirsin.' : ''}</p>
  </div>`;
  el.hidden = false;
  document.body.classList.add('auth-open');
  window.Icons?.hydrate?.(el);
  setTimeout(() => (reg ? $('#authName') : keep.email ? $('#authPass') : $('#authEmail'))?.focus(), 30);
}

function authError(msg) {
  const e = $('#authErr');
  if (!e) return;
  e.textContent = msg || '';
  e.hidden = !msg;
  if (msg) { const c = $('.auth-card'); c?.classList.remove('shake'); void c?.offsetWidth; c?.classList.add('shake'); }
}
function authBusy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spin"></span>${label}`; }
  else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
}
function authDone(st) {
  const prev = acct.lastUid;
  acct.status = st;
  acct.lastUid = st.user?.id;
  // Başka bir hesaba geçildiyse açık sohbet kapanır, liste yeni hesaba göre yenilenir
  if (prev !== undefined && prev !== st.user?.id) { state.current = null; newSession(); }
  loadSessions();
  renderAvatar();
  const el = $('#auth');
  el.classList.add('leaving');
  setTimeout(() => { el.hidden = true; el.classList.remove('leaving'); el.innerHTML = ''; document.body.classList.remove('auth-open'); }, 260);
  const u = st.user;
  toast(`Hoş geldin, ${(u.name || u.email).split(' ')[0]}`, 'ok');
  const f = acct.done; acct.done = null; f?.();
  $('#input')?.focus();
}

function bindAuth() {
  const el = $('#auth');
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-auth-tab],[data-pw-toggle],#authGoogle');
    if (!t) return;
    if (t.dataset.authTab && t.dataset.authTab !== acct.tab) {
      return authScreen(t.dataset.authTab, { email: $('#authEmail')?.value, name: $('#authName')?.value, remember: $('#authRemember')?.checked });
    }
    if (t.hasAttribute('data-pw-toggle')) {
      const i = $('#authPass'); const show = i.type === 'password';
      i.type = show ? 'text' : 'password'; t.classList.toggle('on', show); t.setAttribute('aria-label', show ? 'Şifreyi gizle' : 'Şifreyi göster');
      return i.focus();
    }
    if (t.id === 'authGoogle') {
      authError('');
      authBusy(t, true, 'Tarayıcıda Google hesabını seç…');
      try { authDone(await G.account.google({ remember: $('#authRemember')?.checked === true })); }
      catch (err) { authBusy(t, false); authError(ipcErr(err)); }
    }
  });
  el.addEventListener('input', (e) => {
    if (e.target.id === 'authPass' && $('#pwMeter')) {
      const s = pwScore(e.target.value);
      $('#pwMeter').dataset.s = s; $('#pwHint').textContent = PW_LABEL[s];
    }
    if ($('#authErr') && !$('#authErr').hidden) authError('');
  });
  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    const reg = acct.tab === 'register';
    const a = { name: $('#authName')?.value || '', email: $('#authEmail').value.trim(), password: $('#authPass').value, remember: $('#authRemember').checked };
    if (reg && !a.name.trim()) { authError('Adını yaz.'); return $('#authName').focus(); }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(a.email)) { authError('Geçerli bir e-posta adresi yaz.'); return $('#authEmail').focus(); }
    if (!a.password) { authError('Şifreni yaz.'); return $('#authPass').focus(); }
    if (reg && a.password.length < 8) { authError('Şifre en az 8 karakter olmalı.'); return $('#authPass').focus(); }
    const btn = $('#authSubmit');
    authBusy(btn, true, reg ? 'Hesap oluşturuluyor…' : 'Giriş yapılıyor…');
    try { authDone(await (reg ? G.account.register(a) : G.account.login(a))); }
    catch (err) {
      authBusy(btn, false);
      const m = ipcErr(err);
      authError(m);
      if (/zaten bir hesap/.test(m)) setTimeout(() => authScreen('login', { email: a.email, remember: a.remember }), 900);
    }
  });
  // Giriş ekranı açıkken uygulama kısayolları çalışmasın
  window.addEventListener('keydown', (e) => {
    if (el.hidden) return;
    if ((e.ctrlKey || e.metaKey) && !['a', 'c', 'v', 'x', 'z', 'y'].includes(e.key.toLowerCase())) { e.preventDefault(); e.stopImmediatePropagation(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  $('#btnAccount').onclick = () => openSettings('account');
}

async function ensureAccount() {
  acct.status = await G.account.status();
  acct.lastUid = acct.status.user?.id ?? null;
  renderAvatar();
  if (acct.status.user) return;
  authScreen(acct.tab);
  await new Promise((r) => (acct.done = r));
}

function accountTab() {
  const st = acct.status || {};
  const u = st.user || {};
  const google = (u.provider || '').includes('google');
  const hasPw = (u.provider || 'sifre').includes('sifre');
  const since = u.created ? new Date(u.created).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  return `<h3>Hesap</h3><p class="sub">Glassly hesabın. ${st.mode === 'bulut' ? 'Hesabın Glassly Bulut\'ta tutulur.' : 'Hesabın bu bilgisayarda tutulur.'}</p>
    <div class="acct-head"><div class="acct-avatar">${esc(initials(u))}</div><div class="l"><b>${esc(u.name || '')}${u.role === 'gelistirici' ? ' <em class="dev-badge">Geliştirici</em>' : ''}</b><span>${esc(u.email || '')}</span><span class="dim">${google ? 'Google ile bağlı' : 'E-posta ve şifre'}${since ? ` · ${since} tarihinden beri` : ''}</span></div>
      <button class="btn sm ghost" id="acctLogout">${icon('logout', 14)}Çıkış yap</button></div>
    <div class="row" id="acctUsage" style="margin-top:12px"><div class="l"><b>Günlük mesaj</b><span>Yükleniyor…</span></div></div>
    <h3 style="margin-top:22px;font-size:15px">Adın</h3>
    <div class="conn-extra" style="padding:0"><input class="field" id="acctName" value="${esc(u.name || '')}" autocomplete="name" /><button class="btn sm primary" id="acctNameSave">Kaydet</button></div>
    <h3 style="margin-top:22px;font-size:15px">${hasPw ? 'Şifreni değiştir' : 'Şifre belirle'}</h3>
    <p class="sub" style="margin-bottom:8px">${hasPw ? 'Yeni şifren en az 8 karakter olmalı.' : 'Google dışında e-posta ve şifreyle de girebilmek için bir şifre belirle.'}</p>
    <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px">${hasPw ? '<input class="field" id="acctPwOld" type="password" placeholder="Mevcut şifre" autocomplete="current-password" />' : ''}<input class="field" id="acctPwNew" type="password" placeholder="Yeni şifre" autocomplete="new-password" ${hasPw ? '' : 'style="grid-column:1/3"'} /><button class="btn sm ghost" id="acctPwSave">${hasPw ? 'Değiştir' : 'Belirle'}</button></div>
    <h3 style="margin-top:26px;font-size:15px;color:var(--err)">Hesabı sil</h3>
    <p class="sub" style="margin-bottom:8px">Hesabın kalıcı olarak silinir; bu hesaba bağlı Google, GitHub, hafıza ve hatırlatıcılar da silinir.</p>
    <div id="acctDelBox"><button class="btn sm danger" id="acctDel">Hesabımı sil</button></div>`;
}

function bindAccountSettings() {
  $('#settingsLayer').addEventListener('click', async (e) => {
    const t = e.target.closest('#acctLogout,#acctNameSave,#acctPwSave,#acctDel,#acctDelYes,#acctDelNo');
    if (!t) return;
    const run = async (fn, ok) => {
      t.disabled = true;
      try { acct.status = await fn(); renderAvatar(); if (ok) toast(ok, 'ok'); return true; }
      catch (err) { toast(ipcErr(err), 'err'); return false; }
      finally { t.disabled = false; }
    };
    if (t.id === 'acctLogout') {
      if (await run(() => G.account.logout())) { closeLayer('#settingsLayer'); authScreen('login'); ensureAfterLogout(); }
    } else if (t.id === 'acctNameSave') {
      if (await run(() => G.account.rename($('#acctName').value), 'Adın kaydedildi.')) showTab('account');
    } else if (t.id === 'acctPwSave') {
      if (await run(() => G.account.password({ current: $('#acctPwOld')?.value || '', next: $('#acctPwNew').value }), 'Şifren güncellendi.')) showTab('account');
    } else if (t.id === 'acctDel') {
      const hasPw = (acct.status?.user?.provider || 'sifre').includes('sifre');
      $('#acctDelBox').innerHTML = `<div class="conn-extra" style="padding:0">${hasPw ? '<input class="field" id="acctDelPw" type="password" placeholder="Onaylamak için şifren" />' : '<span class="dim" style="font-size:var(--text-sm)">Emin misin? Bu geri alınamaz.</span>'}<button class="btn sm danger" id="acctDelYes">Kalıcı olarak sil</button><button class="btn sm ghost" id="acctDelNo">Vazgeç</button></div>`;
      $('#acctDelPw')?.focus();
    } else if (t.id === 'acctDelNo') {
      showTab('account');
    } else if (t.id === 'acctDelYes') {
      if (await run(() => G.account.remove({ password: $('#acctDelPw')?.value || '' }), 'Hesabın silindi.')) { closeLayer('#settingsLayer'); authScreen('register'); ensureAfterLogout(); }
    }
  });
}
function ensureAfterLogout() { acct.done = () => {}; }

// Hesap sekmesindeki günlük mesaj hakkı çubuğu
async function fillUsage() {
  const el = $('#acctUsage');
  if (!el) return;
  let q;
  try { q = await G.account.usage(); } catch { el.remove(); return; }
  if (!q) return el.remove();
  const at = new Date(q.reset).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = q.unlimited
    ? `<div class="l"><b>Günlük mesaj</b><span>Geliştirici hesabı: sınırsız · bugün ${q.used} mesaj</span></div>`
    : `<div class="l"><b>Günlük mesaj</b><span>Bugün ${q.used} / ${q.limit} kullandın · ${q.left ? `${q.left} hakkın kaldı` : `hakkın doldu, ${at}'da yenilenir`}</span>
        <div class="usage-bar ${q.left <= 5 ? 'low' : ''}"><i style="width:${Math.min(100, (q.used / q.limit) * 100)}%"></i></div></div>`;
}

// ---------------------------------------------------------------- geliştirici paneli
async function renderDevTab() {
  const body = $('#settingsBody');
  const close = `<button class="settings-close" data-close-settings aria-label="Kapat">${icon('x')}</button>`;
  let d;
  try { d = await G.account.admin(); }
  catch (err) { body.innerHTML = `${close}<h3>Geliştirici</h3><p class="sub">${esc(ipcErr(err))}</p>`; return; }
  const st = d.stats || {};
  const me = acct.status?.user?.id;
  const date = (t) => (t ? new Date(t).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const ago = (t) => (t ? relTime(t) : 'hiç');
  const card = (n, l) => `<div class="dev-stat"><b>${n}</b><span>${l}</span></div>`;
  const stats = d.mode === 'bulut'
    ? card(st.users, 'Hesap') + card(st.sessions, 'Açık oturum') + card(`${st.ready}/${st.slots}`, 'Hazır model yuvası') + card(st.models?.length || 0, 'Model')
    : card(st.users, 'Hesap') + card(d.users.filter((u) => u.google || u.github).length, 'Bağlantısı olan') + card(d.users.reduce((a, u) => a + u.chats, 0), 'Sohbet') + card(d.users.reduce((a, u) => a + u.reminders, 0), 'Hatırlatıcı');
  const row = (u) => {
    const info = d.mode === 'bulut'
      ? `bugün ${u.today}${u.limit ? '/' + u.limit : ''} mesaj · ${u.sessions} oturum · ${u.requests} istek · son: ${ago(u.lastSeen)}`
      : `bugün ${u.today}${u.limit ? '/' + u.limit : ''} mesaj · ` + [u.google && 'Google', u.github && 'GitHub'].filter(Boolean).join(', ') + `${u.google || u.github ? ' · ' : ''}${u.chats} sohbet · ${u.memory} not · ${u.reminders} hatırlatıcı`;
    const canDel = u.id !== me && u.role !== 'gelistirici';
    return `<div class="dev-user" data-uid="${esc(u.id)}"><div class="dev-ava">${esc(initials(u))}</div>
      <div class="l"><b>${esc(u.name)}${u.role === 'gelistirici' ? ' <em class="dev-badge">Geliştirici</em>' : ''}${u.id === me ? ' <em class="dev-badge me">Sen</em>' : ''}</b>
        <span>${esc(u.email)} · ${(u.provider || '').includes('google') ? 'Google' : 'Şifre'} · ${date(u.created)}</span><span class="dim">${esc(info)}</span></div>
      ${canDel ? `<button class="btn sm danger" data-dev-del="${esc(u.id)}">Sil</button>` : ''}</div>`;
  };
  body.innerHTML = `${close}<h3>Geliştirici</h3><p class="sub">Glassly'nin bütün hesaplarını ve sistemini buradan yönetirsin. ${d.mode === 'bulut' ? 'Glassly Bulut sunucusundaki hesaplar gösteriliyor.' : 'Bu bilgisayardaki hesaplar gösteriliyor.'}</p>
    <div class="dev-stats">${stats}</div>
    ${d.mode === 'bulut' ? `<div class="row"><div class="l"><b>Yeni kayıt</b><span>Kapalıyken kimse yeni hesap açamaz; mevcut hesaplar girmeye devam eder</span></div><button class="switch ${st.registration ? 'on' : ''}" id="devReg" aria-label="Yeni kayıt"></button></div>` : ''}
    <h3 style="margin-top:22px;font-size:15px">Hesaplar (${d.users.length})</h3>
    <div class="dev-users">${d.users.sort((a, b) => (b.role === 'gelistirici') - (a.role === 'gelistirici') || b.created - a.created).map(row).join('')}</div>
    ${d.mode === 'bulut' && st.cooling?.length ? `<h3 style="margin-top:22px;font-size:15px">Soğumadaki modeller</h3>${st.cooling.map((c) => `<div class="skill-row"><div class="l"><b>${esc(c.id)}</b><span>${new Date(c.until).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })} saatinde açılır</span></div></div>`).join('')}` : ''}
    <h3 style="margin-top:22px;font-size:15px">Sistem</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap">${st.file ? `<button class="btn sm ghost" data-dev-reveal="${esc(st.file)}">${icon('folder', 14)}Veri klasörünü aç</button>` : ''}<button class="btn sm ghost" data-tab-go="engine">${icon('cpu', 14)}Motor günlüğü</button><button class="btn sm ghost" data-tab-go="models">${icon('layers', 14)}Modeller ve Bulut</button></div>`;
}

function bindDevSettings() {
  $('#settingsLayer').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-dev-del],[data-dev-yes],[data-dev-no],#devReg,[data-dev-reveal],[data-tab-go]');
    if (!t) return;
    if (t.dataset.tabGo) return showTab(t.dataset.tabGo);
    if (t.dataset.devReveal) return G.reveal(t.dataset.devReveal);
    if (t.dataset.devDel) {
      const box = t.closest('.dev-user');
      t.outerHTML = `<span class="dev-confirm"><span>Silinsin mi?</span><button class="btn sm danger" data-dev-yes="${esc(t.dataset.devDel)}">Evet, sil</button><button class="btn sm ghost" data-dev-no>Vazgeç</button></span>`;
      return box;
    }
    if (t.hasAttribute('data-dev-no')) return renderDevTab();
    t.disabled = true;
    try {
      if (t.dataset.devYes) { await G.account.adminDelete(t.dataset.devYes); toast('Hesap silindi.', 'ok'); }
      if (t.id === 'devReg') { await G.account.adminSettings({ registration: !t.classList.contains('on') }); toast(t.classList.contains('on') ? 'Yeni kayıt kapatıldı.' : 'Yeni kayıt açıldı.', 'ok'); }
    } catch (err) { toast(ipcErr(err), 'err'); }
    renderDevTab();
  });
}

// ================================================================ başlangıç
async function init() {
  document.body.classList.add('platform-' + G.platform);
  window.Icons.hydrate();
  state.cfg = await G.store.all();
  state.scratch = await G.scratchDir();
  state.daily = await G.dailyDir();
  if (G.platform !== 'darwin') {
    $$('[data-tip]').forEach((b) => (b.dataset.tip = b.dataset.tip.replace(/⌘/g, 'Ctrl+')));
  }
  applyMode();
  $('#modeTabs').onclick = (e) => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); };
  G.onConfirm((c) => { confirmQueue.push(c); if (confirmQueue.length === 1) showConfirm(); });
  $('#dialogLayer').addEventListener('click', (e) => {
    const b = e.target.closest('[data-confirm-reply]');
    if (!b) return;
    const c = confirmQueue.shift();
    if (c) G.confirmReply(c.id, b.dataset.confirmReply === '1');
    showConfirm();
  });
  applyTheme();
  G.onNativeTheme(() => { if (state.cfg.theme === 'system') applyTheme(); });
  bindAuth();
  bindAccountSettings();
  bindDevSettings();
  await ensureAccount();
  if (state.cfg.inspector === false) $('#app').classList.add('no-inspector');
  $('#btnSessions').classList.add('on');
  $('#btnInspector').classList.toggle('on', inspectorVisible());
  bind();
  initFeatures();
  updateComposer();

  const proj = state.cfg.currentProject;
  state.project = proj && (await G.exists(proj)) ? proj : null;
  $('#projectName').textContent = state.project ? baseName(state.project) : 'Hızlı sohbet';
  showWelcome();

  G.engine.onEvent(handleEvent);
  G.engine.onStatus(async (s) => {
    const was = state.engine.state;
    state.engine = s;
    renderEngine();
    if (s.state === 'ready' && was !== 'ready') await onEngineReady();
  });
  state.engine = await G.engine.status();
  renderEngine();
  if (state.engine.state === 'ready') await onEngineReady();
  await loadSessions();
  $('#input').focus();
}

init();
