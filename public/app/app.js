// Glassly web uygulaması
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KEY = 'glassly.token';

const state = { token: '', user: null, usage: null, config: {}, chats: [], chatId: null, messages: [], busy: false, abort: null, mode: 'login', files: [], reminders: [] };

// ---------------------------------------------------------------- telefon uygulaması (Capacitor)
const Cap = window.Capacitor;
const isApp = !!(Cap && (Cap.isNativePlatform?.() || Cap.getPlatform?.() === 'android'));
const hasPlugin = (n) => !!(Cap && ((Cap.PluginHeaders || []).some((h) => h.name === n) || Cap.isPluginAvailable?.(n)));
const native = (plugin, method, opts = {}) => Cap.nativePromise(plugin, method, opts);
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------------------------------------------------------------- oturum
function loadToken() { try { return localStorage.getItem(KEY) || sessionStorage.getItem(KEY) || ''; } catch { return ''; } }
function saveToken(t, remember) {
  try { localStorage.removeItem(KEY); sessionStorage.removeItem(KEY); (remember ? localStorage : sessionStorage).setItem(KEY, t); } catch {}
}
function dropToken() { try { localStorage.removeItem(KEY); sessionStorage.removeItem(KEY); } catch {} }

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(state.token ? { authorization: 'Bearer ' + state.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error?.message || 'Bağlantı hatası, tekrar dene.'); e.status = r.status; e.type = j.error?.type;
    if (r.status === 401 && state.token && !path.startsWith('/auth/login') && !path.startsWith('/auth/password') && path !== '/auth/me') signedOut();
    throw e;
  }
  return j;
}

function toast(msg, kind = '') {
  const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg;
  $('#toasts').append(t); setTimeout(() => t.remove(), 3600);
}

// ---------------------------------------------------------------- giriş ekranı
function setMode(m) {
  state.mode = m;
  $$('.seg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
  const reg = m === 'register';
  $('#fName').hidden = !reg;
  $('#authTitle').textContent = reg ? 'Glassly hesabı aç' : 'Tekrar hoş geldin';
  $('#authSub').textContent = reg ? (state.config.dailyMessages ? `Ücretsiz. Her gün ${state.config.dailyMessages} mesaj hakkın olur.` : 'Ücretsiz.') : 'Hesabınla giriş yap, kaldığın yerden devam et.';
  $('#authBtn').textContent = reg ? 'Hesap oluştur' : 'Giriş yap';
  $('#aPass').autocomplete = reg ? 'new-password' : 'current-password';
  $('#authErr').textContent = '';
  const closed = reg && state.config.registration === false;
  $('#regClosed').hidden = !closed; $('#authBtn').disabled = closed;
}
$$('.seg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const reg = state.mode === 'register';
  const body = { email: $('#aEmail').value.trim(), password: $('#aPass').value };
  if (reg) body.name = $('#aName').value.trim();
  if (reg && !body.name) return ($('#authErr').textContent = 'Adını yaz.');
  if (!body.email) return ($('#authErr').textContent = 'E-posta adresini yaz.');
  if (body.password.length < (reg ? 8 : 1)) return ($('#authErr').textContent = reg ? 'Şifre en az 8 karakter olmalı.' : 'Şifreni yaz.');
  const btn = $('#authBtn'); btn.disabled = true; $('#authErr').textContent = '';
  try {
    const j = await api('POST', reg ? '/auth/register' : '/auth/login', body);
    signedIn(j, $('#aRemember').checked);
  } catch (err) { $('#authErr').textContent = err.message; }
  finally { btn.disabled = false; }
});

function initGoogle() {
  const id = state.config.googleClientId;
  if (!id) return;
  if (isApp) {
    // Telefonda Google girişi uygulamanın içinde açılamaz; Chrome sekmesinde yapılıp uygulamaya dönülür
    $('#gWrap').hidden = false; $('#gBtn').hidden = true; $('#gNative').hidden = false;
    return;
  }
  const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
  s.onload = () => {
    google.accounts.id.initialize({
      client_id: id, ux_mode: 'popup', auto_select: false, cancel_on_tap_outside: true,
      callback: async ({ credential }) => {
        try { signedIn(await api('POST', '/auth/google', { id_token: credential }), $('#aRemember').checked); }
        catch (err) { $('#authErr').textContent = err.message; }
      },
    });
    google.accounts.id.renderButton($('#gBtn'), { theme: document.documentElement.dataset.theme === 'aurora' ? 'filled_black' : 'outline', size: 'large', shape: 'pill', text: 'continue_with', width: 300, locale: 'tr' });
    $('#gWrap').hidden = false;
  };
  document.head.append(s);
}

$('#gNative').addEventListener('click', async () => {
  if (!hasPlugin('Browser') || !hasPlugin('App')) { $('#authErr').textContent = 'Google ile giriş için uygulamanın yeni sürümünü kur.'; $('#appNoteAuth')?.remove(); showAppNote(true); return; }
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const ch = b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  try { localStorage.setItem('glassly.verifier', verifier); } catch {}
  native('Browser', 'open', { url: location.origin + '/app/google/?ch=' + ch, presentationStyle: 'popover' }).catch((e) => ($('#authErr').textContent = e.message || 'Açılamadı.'));
});
async function finishAppLogin(url) {
  const code = String(url || '').match(/[?&#]code=([\w-]+)/)?.[1];
  if (!code) return;
  let verifier = ''; try { verifier = localStorage.getItem('glassly.verifier') || ''; } catch {}
  native('Browser', 'close').catch(() => {});
  try { const j = await api('POST', '/auth/exchange', { code, verifier }); try { localStorage.removeItem('glassly.verifier'); } catch {} signedIn(j, true); }
  catch (e) { $('#authErr').textContent = e.message; }
}
function initAppBridge() {
  if (!isApp) return;
  if (hasPlugin('App')) {
    try { Cap.nativeCallback('App', 'addListener', { eventName: 'appUrlOpen' }, (d) => finishAppLogin(d?.url)); } catch {}
    native('App', 'getLaunchUrl').then((d) => d?.url && finishAppLogin(d.url)).catch(() => {});
  }
  showAppNote();
}
function showAppNote(force) {
  const old = !hasPlugin('App') || !hasPlugin('LocalNotifications');
  $('#appNote').hidden = !(isApp && (old || force));
}

function signedIn(j, remember) {
  state.token = j.token; state.user = j.user;
  saveToken(j.token, remember);
  $('#aPass').value = '';
  showApp();
}
function signedOut() {
  hideApiSecret();
  $('#apiKeys').replaceChildren();
  dropToken(); Object.assign(state, { token: '', user: null, chats: [], chatId: null, messages: [] });
  state.abort?.abort();
  try { window.google?.accounts.id.disableAutoSelect(); } catch {}
  $('#settings').hidden = true; $('#app').hidden = true; $('#auth').hidden = false;
  history.replaceState(null, '', '/app/');
  setMode('login');
  if ($('#gWrap').hidden) initGoogle();
}

// ---------------------------------------------------------------- uygulama
const TASKS = [
  ['Günümü planla', 'Bugün için yapılacaklar listesi', 'Bugün yapmam gerekenleri sıralayıp gerçekçi bir gün planı çıkarmama yardım et. Önce bana birkaç kısa soru sor.'],
  ['E-posta yaz', 'Kibar ve net bir mesaj', 'Bir e-posta yazmama yardım et. Kime ve ne hakkında olduğunu sorup kısa, kibar ve net bir taslak hazırla.'],
  ['Basitçe anlat', 'Karmaşık bir konuyu sadeleştir', 'Bana bir konuyu sanki 12 yaşındaymışım gibi basitçe anlatmanı istiyorum. Hangi konu olduğunu sor.'],
  ['Çeviri yap', 'Doğal ve akıcı', 'Bir metni çevirmeni istiyorum. Metni ve hedef dili soracağın kısa bir mesajla başla.'],
  ['Kod yardımı', 'Hata bul, açıkla, düzelt', 'Kodumla ilgili yardım istiyorum. Kodu yapıştıracağım; hatayı bul, nedenini açıkla ve düzeltilmiş halini ver.'],
  ['Yemek önerisi', 'Evdeki malzemelerle', 'Evdeki malzemelerle ne pişirebilirim? Önce elimde ne olduğunu sor, sonra 3 kolay tarif öner.'],
];
function renderEmpty() {
  const h = new Date().getHours();
  const hi = h < 6 ? 'İyi geceler' : h < 12 ? 'Günaydın' : h < 18 ? 'İyi günler' : 'İyi akşamlar';
  $('#hello').textContent = `${hi}, ${(state.user?.name || '').split(' ')[0]}`;
  $('#tasks').innerHTML = TASKS.map(([t, s], i) => `<button class="task" data-task="${i}"><b>${esc(t)}</b><small>${esc(s)}</small></button>`).join('');
}
$('#tasks').addEventListener('click', (e) => { const b = e.target.closest('[data-task]'); if (b) send(TASKS[b.dataset.task][2]); });

async function showApp() {
  $('#auth').hidden = true; $('#app').hidden = false;
  fillUser();
  renderEmpty();
  try { const j = await api('GET', '/auth/me'); state.user = j.user; state.usage = j.usage; fillUser(); renderEmpty(); }
  catch (e) { if (e.status === 401) return signedOut(); }
  await loadChats();
  loadReminders();
  const m = location.hash.match(/^#c=([\w-]+)/);
  if (m) openChat(m[1]); else newChat();
  setTimeout(() => $('#input').focus(), 50);
}

function fillUser() {
  const u = state.user || {};
  $('#meName').textContent = u.name || '';
  $('#meEmail').textContent = u.email || '';
  $('#meAv').textContent = (u.name || 'G').trim().charAt(0).toLocaleUpperCase('tr');
  const dev = u.role === 'gelistirici';
  $('#menuDev').hidden = !dev; $('#tabDev').hidden = !dev;
  $('#delWrap').hidden = dev;
  const pw = !!u.hasPassword;
  $('#pCur').hidden = !pw; $('#pNote').hidden = pw; $('#delPass').hidden = !pw;
  $('#pGrid').style.gridTemplateColumns = pw ? '' : '1fr';
  $('#savePass').textContent = pw ? 'Şifreyi değiştir' : 'Şifre belirle';
  fillUsage();
}
function fillUsage() {
  const q = state.usage; const box = $('#usage');
  if (!q) { box.hidden = true; return; }
  box.hidden = false;
  if (q.unlimited) { $('#usageTxt').textContent = `${q.used} · sınırsız`; $('#usageBar').style.width = '100%'; $('.meter').classList.remove('low'); }
  else {
    $('#usageTxt').textContent = `${q.used} / ${q.limit}`;
    $('#usageBar').style.width = Math.min(100, (q.used / q.limit) * 100) + '%';
    $('.meter').classList.toggle('low', q.left <= Math.max(5, q.limit * 0.1));
  }
  $('#sUsage').textContent = q.unlimited ? `Bugün ${q.used} mesaj · geliştirici hesabı, sınır yok` : `Bugün ${q.used} / ${q.limit} mesaj · kalan ${q.left} · gece yarısı yenilenir`;
}

async function loadChats() {
  try { state.chats = (await api('GET', '/api/chats')).chats; } catch { state.chats = []; }
  renderChats();
}
const ICON_PC = '<svg viewBox="0 0 24 24" class="src"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';
let searchRes = null;
function renderChats() {
  const el = $('#chats');
  $('#listH').textContent = searchRes ? 'Arama sonuçları' : 'Sohbetler';
  if (searchRes) {
    el.innerHTML = searchRes.length ? searchRes.map((c) => `<div class="chat-i res${c.id === state.chatId ? ' on' : ''}" data-id="${esc(c.id)}"><a href="#c=${esc(c.id)}" title="${esc(c.title)}">${c.src === 'masaustu' ? ICON_PC : ''}<span>${esc(c.title)}</span>${c.snippet ? `<small>${esc(c.snippet)}</small>` : ''}</a></div>`).join('') : '<div class="none">Sonuç yok.</div>';
    return;
  }
  if (!state.chats.length) { el.innerHTML = '<div class="none">Henüz sohbet yok.</div>'; return; }
  el.innerHTML = state.chats.map((c) => `<div class="chat-i${c.id === state.chatId ? ' on' : ''}" data-id="${esc(c.id)}"><a href="#c=${esc(c.id)}" title="${esc(c.title)}${c.src === 'masaustu' ? ' (masaüstü)' : ''}">${c.src === 'masaustu' ? ICON_PC : ''}<span>${esc(c.title)}</span></a><button class="icon x" data-del="${esc(c.id)}" aria-label="Sohbeti sil" title="Sil"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></div>`).join('');
}
let sTimer = 0;
$('#chatSearch').addEventListener('input', (e) => {
  clearTimeout(sTimer); const q = e.target.value.trim();
  if (q.length < 2) { searchRes = null; renderChats(); return; }
  sTimer = setTimeout(async () => {
    try { const j = await api('GET', '/api/search?q=' + encodeURIComponent(q)); if ($('#chatSearch').value.trim() === q) { searchRes = j.results; renderChats(); } } catch {}
  }, 250);
});
$('#chats').addEventListener('click', async (e) => {
  const d = e.target.closest('[data-del]');
  if (d) {
    e.preventDefault();
    if (!confirm('Bu sohbet silinsin mi?')) return;
    try { await api('DELETE', '/api/chats/' + d.dataset.del); } catch (err) { return toast(err.message, 'err'); }
    state.chats = state.chats.filter((c) => c.id !== d.dataset.del);
    if (state.chatId === d.dataset.del) newChat(); else renderChats();
    return;
  }
  const a = e.target.closest('a');
  if (a) { e.preventDefault(); openChat(a.closest('.chat-i').dataset.id); closeDrawer(); }
});

function newChat() {
  if (state.busy) state.abort?.abort();
  state.chatId = null; state.messages = [];
  history.replaceState(null, '', '/app/');
  $('#chatTitle').textContent = 'Yeni sohbet';
  renderMessages(); renderChats(); closeDrawer();
  $('#input').focus();
}
$('#newChat').addEventListener('click', newChat);
$('#newChat2').addEventListener('click', newChat);

async function openChat(id) {
  if (state.busy) state.abort?.abort();
  try {
    const c = await api('GET', '/api/chats/' + id);
    state.chatId = c.id; state.messages = c.messages;
    $('#chatTitle').textContent = c.title;
    history.replaceState(null, '', '#c=' + c.id);
    renderMessages(); renderChats();
    const sc = $('#scroll'); sc.scrollTop = sc.scrollHeight;
  } catch (e) { toast(e.message, 'err'); newChat(); }
}

// ---------------------------------------------------------------- markdown
marked.setOptions({ gfm: true, breaks: true });
function md(text) {
  const html = DOMPurify.sanitize(marked.parse(text || ''), { ADD_ATTR: ['target'] });
  const t = document.createElement('template'); t.innerHTML = html;
  t.content.querySelectorAll('a[href]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  return t.content;
}
function decorate(el) {
  el.querySelectorAll('pre code').forEach((c) => {
    if (!c.dataset.hl) { try { hljs.highlightElement(c); } catch {} c.dataset.hl = '1'; }
    const pre = c.parentElement;
    if (!pre.querySelector('.cp')) {
      const b = document.createElement('button'); b.className = 'cp'; b.type = 'button'; b.textContent = 'Kopyala';
      b.onclick = () => { navigator.clipboard.writeText(c.innerText); b.textContent = 'Kopyalandı'; setTimeout(() => (b.textContent = 'Kopyala'), 1400); };
      pre.append(b);
    }
  });
}

const ICON_COPY = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const ICON_RE = '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.3L3 16M3 21v-5h5"/></svg>';
const ICON_SPK = '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
const ICON_DL = '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>';
const ICON_BELL = '<svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>';
const ICON_FILE = '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>';
const imgSrc = (f) => f.src || ('/api/img/' + f.img);
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const when = (t) => new Date(t).toLocaleString('tr-TR', { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
function filesEl(files) {
  const w = document.createElement('div'); w.className = 'mfiles';
  for (const f of files) {
    if (f.kind === 'image') { const a = document.createElement('a'); a.href = imgSrc(f); a.target = '_blank'; a.rel = 'noopener'; a.innerHTML = `<img src="${esc(imgSrc(f))}" alt="${esc(f.name)}" loading="lazy" />`; w.append(a); }
    else { const c = document.createElement('span'); c.className = 'fchip'; c.innerHTML = `${ICON_FILE}<span>${esc(f.name)}</span>`; w.append(c); }
  }
  return w;
}
function extrasEl(m) {
  const frag = document.createDocumentFragment();
  if (m.reminder) {
    const r = document.createElement('div'); r.className = 'remcard';
    r.innerHTML = `${ICON_BELL}<div><b>${esc(m.reminder.text)}</b><small>${esc(when(m.reminder.at))}</small></div>`;
    frag.append(r);
  }
  for (const id of m.images || []) {
    const g = document.createElement('figure'); g.className = 'gen';
    g.innerHTML = `<img src="/api/img/${esc(id)}" alt="Oluşturulan görsel" /><a class="icon" href="/api/img/${esc(id)}" download="glassly.jpg" title="İndir" aria-label="İndir">${ICON_DL}</a>`;
    frag.append(g);
  }
  return frag;
}
function sourcesEl(list) {
  const w = document.createElement('div'); w.className = 'srcs';
  w.innerHTML = list.slice(0, 6).map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer" title="${esc(x.title)}"><b>${esc(host(x.url))}</b><span>${esc(x.title)}</span></a>`).join('');
  return w;
}
function msgEl(m, last) {
  const el = document.createElement('div');
  if (m.role === 'user') {
    el.className = 'msg user';
    if (m.files?.length) { el.classList.add('hasf'); el.append(filesEl(m.files)); }
    const b = document.createElement('div'); b.className = 'bubble'; b.textContent = m.content; el.append(b);
    return el;
  }
  el.className = 'msg ai' + (last ? ' last' : '') + (m.error ? ' error' : '');
  el.innerHTML = `<img class="ava" src="/assets/logo.svg" alt="" /><div class="body"><div class="xtra"></div><div class="md"></div><div class="acts"><button class="icon" data-copy title="Kopyala" aria-label="Kopyala">${ICON_COPY}</button>${m.error ? '' : `<button class="icon" data-say title="Sesli oku" aria-label="Sesli oku">${ICON_SPK}</button>`}${last ? `<button class="icon" data-regen title="Yeniden yaz" aria-label="Yeniden yaz">${ICON_RE}</button>` : ''}</div></div>`;
  el.querySelector('.xtra').append(extrasEl(m));
  const box = el.querySelector('.md');
  if (m.error) box.textContent = m.content; else { box.append(md(m.content)); decorate(box); }
  if (m.sources?.length) el.querySelector('.acts').before(sourcesEl(m.sources));
  el.querySelector('[data-copy]').onclick = () => { navigator.clipboard.writeText(m.content); toast('Kopyalandı'); };
  el.querySelector('[data-say]')?.addEventListener('click', (e) => speak(m.content, e.currentTarget));
  el.querySelector('[data-regen]')?.addEventListener('click', () => regenerate());
  return el;
}
function renderMessages() {
  const box = $('#msgs'); box.innerHTML = '';
  $('#empty').hidden = state.messages.length > 0;
  const lastAi = state.messages.length - 1;
  state.messages.forEach((m, i) => box.append(msgEl(m, i === lastAi && m.role === 'assistant' && !state.busy)));
}

// ---------------------------------------------------------------- gönderme
const input = $('#input');
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(220, input.scrollHeight) + 'px'; syncSend(); }
function syncSend() {
  const b = $('#send');
  b.classList.toggle('stop', state.busy);
  b.disabled = !state.busy && !input.value.trim() && !state.files.length;
  b.setAttribute('aria-label', state.busy ? 'Durdur' : 'Gönder');
  b.innerHTML = state.busy ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
}
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); $('#composer').requestSubmit(); }
});
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (state.busy) { state.abort?.abort(); return; }
  const t = input.value.trim(); if (!t && !state.files.length) return;
  if (state.files.some((f) => f.loading)) return toast('Dosya hazırlanıyor, bir saniye…');
  send(t);
});

const nearBottom = () => { const s = $('#scroll'); return s.scrollHeight - s.scrollTop - s.clientHeight < 120; };
const toBottom = () => { const s = $('#scroll'); s.scrollTop = s.scrollHeight; };

function send(text, viaVoice) {
  const files = state.files; state.files = []; drawAtt();
  const payload = files.map((f) => (f.kind === 'image' ? { name: f.name, kind: 'image', data: f.data } : { name: f.name, kind: 'text', text: f.text }));
  const shown = files.map((f) => ({ name: f.name, kind: f.kind, src: f.kind === 'image' ? f.data : undefined }));
  const content = text || (files.length ? (files.some((f) => f.kind === 'image') ? 'Bu görsele bak.' : 'Bu dosyaya bak.') : '');
  state.voiceTurn = !!viaVoice;
  stream({ chatId: state.chatId, text, files: payload }, { role: 'user', content, files: shown.length ? shown : undefined });
}
function regenerate() {
  if (state.busy || !state.chatId) return;
  if (state.messages.at(-1)?.role === 'assistant') state.messages.pop();
  stream({ chatId: state.chatId, regenerate: true }, null);
}

async function stream(body, userMsg) {
  if (state.busy) return;
  if (state.usage && !state.usage.unlimited && state.usage.left <= 0) return toast(`Bugünkü ${state.usage.limit} mesaj hakkın doldu. Gece yarısı yenilenir.`, 'err');
  state.busy = true; syncSend();
  if (userMsg) { state.messages.push(userMsg); input.value = ''; autosize(); }
  renderMessages();
  const el = document.createElement('div'); el.className = 'msg ai';
  el.innerHTML = '<img class="ava" src="/assets/logo.svg" alt="" /><div class="body"><div class="status" hidden></div><div class="xtra"></div><div class="md"><span class="typing"><i></i><i></i><i></i></span></div></div>';
  $('#msgs').append(el); toBottom();
  const box = el.querySelector('.md'); const stat = el.querySelector('.status');
  const meta = {};
  let out = ''; let raf = 0; let errMsg = ''; let receivedDone = false;
  const paint = () => {
    raf = 0; const stick = nearBottom();
    box.replaceChildren(md(out));
    if (stick) toBottom();
  };
  const ac = new AbortController(); state.abort = ac;
  try {
    const r = await fetch('/api/chat', { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token }, body: JSON.stringify(body) });
    if (!r.ok || !r.body) {
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) { signedOut(); return; }
      throw new Error(j.error?.message || 'Bağlantı hatası, tekrar dene.');
    }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 2);
        if (!line.startsWith('data:')) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev.type === 'chat') {
          if (!state.chatId || state.chatId !== ev.id) {
            state.chatId = ev.id; history.replaceState(null, '', '#c=' + ev.id); $('#chatTitle').textContent = ev.title;
            if (!state.chats.some((c) => c.id === ev.id)) state.chats.unshift({ id: ev.id, title: ev.title, updated: Date.now() });
            renderChats();
          }
        } else if (ev.type === 'delta') { out += ev.text; stat.hidden = true; if (!raf) raf = requestAnimationFrame(paint); }
        else if (ev.type === 'status') { stat.hidden = !ev.text; stat.innerHTML = ev.text ? `<span class="spin"></span>${esc(ev.text)}` : ''; }
        else if (ev.type === 'sources') meta.sources = ev.items;
        else if (ev.type === 'image') { meta.images = [ev.id]; el.querySelector('.xtra').replaceChildren(extrasEl(meta)); toBottom(); }
        else if (ev.type === 'reminder') { meta.reminder = ev.item; el.querySelector('.xtra').replaceChildren(extrasEl(meta)); onReminder(ev.item); }
        else if (ev.type === 'error') errMsg = ev.message;
        else if (ev.type === 'done') { receivedDone = true; if (ev.usage) { state.usage = ev.usage; fillUsage(); } }
      }
    }
    if (!receivedDone && !ac.signal.aborted) errMsg ||= 'Bağlantı kesildi. “Devam et” yazarak yanıtı sürdürebilirsin.';
  } catch (e) {
    if (e.name !== 'AbortError') errMsg = e.message;
  } finally {
    if (raf) cancelAnimationFrame(raf);
    state.busy = false; state.abort = null;
    if (out.trim()) { state.messages.push({ role: 'assistant', content: out, ...meta }); if (state.voiceTurn && voiceMode()) speak(out); }
    else if (errMsg) state.messages.push({ role: 'assistant', content: errMsg, error: true });
    else if (userMsg && ac.signal.aborted) { /* durduruldu, yanıt yok */ }
    const c = state.chats.find((x) => x.id === state.chatId);
    if (c) { c.updated = Date.now(); state.chats = [c, ...state.chats.filter((x) => x !== c)]; renderChats(); }
    const stick = nearBottom();
    renderMessages(); syncSend();
    if (errMsg && out.trim()) toast(errMsg, 'err');
    if (stick) toBottom();
    state.voiceTurn = false;
    if (ac.signal.aborted) api('GET', '/auth/usage').then((q) => { state.usage = q; fillUsage(); }).catch(() => {});
  }
}

// ---------------------------------------------------------------- menü, çekmece
$('#meBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#meMenu').hidden = !$('#meMenu').hidden; });
document.addEventListener('click', (e) => { if (!e.target.closest('#meMenu')) $('#meMenu').hidden = true; });
$('#logout').addEventListener('click', async () => { try { await api('POST', '/auth/logout'); } catch {} signedOut(); });
const closeDrawer = () => $('#app').classList.remove('drawer');
$('#openSide').addEventListener('click', () => $('#app').classList.add('drawer'));
$('#closeSide').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);

// ---------------------------------------------------------------- ayarlar
function openSettings(tab) {
  $('#meMenu').hidden = true; closeDrawer();
  $('#settings').hidden = false;
  $('#sName').value = state.user.name; $('#sEmail').textContent = state.user.email;
  fillUsage(); pickTheme();
  showTab(tab === 'dev' && state.user.role !== 'gelistirici' ? 'account' : tab);
}
function showTab(t) {
  if (t !== 'api') hideApiSecret();
  $$('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  $$('.panes [data-pane]').forEach((p) => p.classList.toggle('on', p.dataset.pane === t));
  if (t === 'dev') loadDev();
  if (t === 'api') loadApiKeys();
  if (t === 'rem') { drawReminders(); loadReminders(); const d = new Date(Date.now() + 3600e3); d.setMinutes(0, 0, 0); if (!$('#remAt').value) $('#remAt').value = new Date(d - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16); }
  if (t === 'look') $('#voiceMode').checked = voiceMode();
}
$$('[data-open-settings]').forEach((b) => b.addEventListener('click', () => openSettings(b.dataset.openSettings)));
$$('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('#settings').addEventListener('click', (e) => { if (e.target.id === 'settings' || e.target.closest('[data-close]')) { $('#settings').hidden = true; hideApiSecret(); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#settings').hidden = true; hideApiSecret(); $('#meMenu').hidden = true; closeDrawer(); } });

$('#saveName').addEventListener('click', async () => {
  try { const j = await api('PATCH', '/auth/me', { name: $('#sName').value }); state.user = j.user; fillUser(); renderEmpty(); toast('Adın güncellendi'); }
  catch (e) { toast(e.message, 'err'); }
});
$('#savePass').addEventListener('click', async () => {
  try { const had = state.user.hasPassword; await api('POST', '/auth/password', { current: $('#pCur').value, next: $('#pNew').value }); $('#pCur').value = $('#pNew').value = ''; state.user.hasPassword = true; fillUser(); toast(had ? 'Şifren değişti. Diğer cihazlardaki oturumlar kapatıldı.' : 'Şifren belirlendi. Artık e-postanla da giriş yapabilirsin.'); }
  catch (e) { toast(e.message, 'err'); }
});
$('#clearChats').addEventListener('click', async () => {
  if (!confirm('Tüm sohbetlerin kalıcı olarak silinsin mi?')) return;
  try { await api('DELETE', '/api/chats'); state.chats = []; newChat(); toast('Sohbetler silindi'); } catch (e) { toast(e.message, 'err'); }
});
$('#delAcct').addEventListener('click', async () => {
  if (!confirm('Hesabın ve tüm sohbetlerin kalıcı olarak silinecek. Emin misin?')) return;
  try { await api('DELETE', '/auth/me', { password: $('#delPass').value }); signedOut(); toast('Hesabın silindi'); } catch (e) { toast(e.message, 'err'); }
});

function pickTheme() { const t = document.documentElement.dataset.theme; $$('[data-theme-pick]').forEach((b) => b.classList.toggle('on', b.dataset.themePick === t)); }
$$('[data-theme-pick]').forEach((b) => b.addEventListener('click', () => {
  document.documentElement.dataset.theme = b.dataset.themePick;
  try { localStorage.setItem('glassly.theme', b.dataset.themePick); } catch {}
  document.querySelector('meta[name=theme-color]').content = b.dataset.themePick === 'frost' ? '#e9edf7' : '#06071a';
  pickTheme();
}));

// ---------------------------------------------------------------- ekler (fotoğraf, PDF, Word, metin)
const MAX_FILES = 5;
function drawAtt() {
  const box = $('#att');
  box.hidden = !state.files.length;
  box.innerHTML = state.files.map((f, i) => `<div class="achip${f.loading ? ' busy' : ''}">${f.kind === 'image' && f.data ? `<img src="${esc(f.data)}" alt="" />` : ICON_FILE}<span>${esc(f.name)}</span><button type="button" class="icon" data-rm="${i}" aria-label="Kaldır"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`).join('');
  syncSend();
}
$('#att').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { state.files.splice(+b.dataset.rm, 1); drawAtt(); } });
$('#attach').addEventListener('click', () => $('#fileIn').click());
$('#fileIn').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
input.addEventListener('paste', (e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); addFiles(fs); } });
let dragN = 0;
window.addEventListener('dragenter', (e) => { if (!state.token || ![...(e.dataTransfer?.types || [])].includes('Files')) return; dragN++; $('#drop').hidden = false; });
window.addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; $('#drop').hidden = true; } });
window.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
window.addEventListener('drop', (e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); dragN = 0; $('#drop').hidden = true; addFiles([...e.dataTransfer.files]); });

async function addFiles(list) {
  for (const file of list) {
    if (state.files.length >= MAX_FILES) { toast(`En fazla ${MAX_FILES} dosya ekleyebilirsin.`, 'err'); break; }
    const item = { name: file.name || 'dosya', kind: file.type.startsWith('image/') ? 'image' : 'text', loading: true };
    if (item.kind === 'image' && state.files.filter((f) => f.kind === 'image').length >= 3) { toast('Bir mesajda en fazla 3 fotoğraf olabilir.', 'err'); continue; }
    state.files.push(item); drawAtt();
    try {
      if (item.kind === 'image') item.data = await shrinkImage(file);
      else {
        const r = await readDoc(file);
        if (r.images) { state.files.splice(state.files.indexOf(item), 1); for (const [i, d] of r.images.entries()) state.files.push({ name: `${item.name} (sayfa ${i + 1})`, kind: 'image', data: d }); }
        else { item.text = r.text; if (!item.text.trim()) throw new Error('Bu dosyada okunabilir metin yok.'); }
      }
      item.loading = false;
    } catch (err) { state.files.splice(state.files.indexOf(item), 1); toast(err.message || 'Dosya okunamadı.', 'err'); }
    drawAtt();
  }
  input.focus();
}
function shrinkImage(file, max = 1600) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Fotoğraf açılamadı.')); };
    img.src = url;
  });
}
async function readDoc(file) {
  const n = file.name.toLowerCase();
  if (file.size > 25e6) throw new Error('Dosya çok büyük (en fazla 25 MB).');
  if (n.endsWith('.pdf') || file.type === 'application/pdf') return readPdf(file);
  if (n.endsWith('.docx')) return { text: await readDocx(file) };
  if (/\.(doc|xls|xlsx|ppt|pptx|zip|rar|exe|apk|mp3|mp4)$/.test(n)) throw new Error('Bu dosya türü desteklenmiyor. PDF, Word (.docx), metin ya da fotoğraf ekleyebilirsin.');
  return { text: (await file.text()).slice(0, 200000) };
}
let pdfjs = null;
async function readPdf(file) {
  pdfjs ||= await import('/assets/vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/assets/vendor/pdf.worker.min.mjs';
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  let text = '';
  for (let i = 1; i <= Math.min(doc.numPages, 80) && text.length < 120000; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    text += `\n--- Sayfa ${i} ---\n` + tc.items.map((x) => x.str + (x.hasEOL ? '\n' : ' ')).join('');
  }
  if (text.replace(/--- Sayfa \d+ ---|\s/g, '').length > 40) return { text };
  // Taranmış PDF: ilk sayfalar fotoğraf olarak gönderilir
  const images = [];
  for (let i = 1; i <= Math.min(doc.numPages, 3); i++) {
    const page = await doc.getPage(i); const vp = page.getViewport({ scale: 1.6 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    images.push(c.toDataURL('image/jpeg', 0.8));
  }
  return { images };
}
// .docx bir zip dosyasıdır: word/document.xml açılıp paragraflar metne çevrilir
async function readDocx(file) {
  const buf = new Uint8Array(await file.arrayBuffer()); const dv = new DataView(buf.buffer);
  let eocd = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Word dosyası okunamadı.');
  let p = dv.getUint32(eocd + 16, true); const count = dv.getUint16(eocd + 10, true);
  for (let k = 0; k < count; k++) {
    const method = dv.getUint16(p + 10, true); const csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true); const xl = dv.getUint16(p + 30, true); const cl = dv.getUint16(p + 32, true); const off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nl));
    if (name === 'word/document.xml') {
      const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
      let data = buf.subarray(start, start + csize);
      if (method === 8) data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      const xml = new TextDecoder().decode(data);
      return xml.replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
    }
    p += 46 + nl + xl + cl;
  }
  throw new Error('Word dosyası okunamadı.');
}

// ---------------------------------------------------------------- ses: konuşarak yazma ve sesli okuma
const voiceMode = () => { try { return localStorage.getItem('glassly.voice') === '1'; } catch { return false; } };
$('#voiceMode').addEventListener('change', (e) => { try { localStorage.setItem('glassly.voice', e.target.checked ? '1' : '0'); } catch {} });
let rec = null;
$('#mic').addEventListener('click', async () => {
  if (rec) { rec.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('Bu cihazda ses kaydı desteklenmiyor.', 'err');
  let streamA;
  try { streamA = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { return toast('Mikrofon izni verilmedi.', 'err'); }
  stopSpeak();
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
  const chunks = []; const r = new MediaRecorder(streamA, mime ? { mimeType: mime } : undefined); rec = r;
  const btn = $('#mic'); btn.classList.add('rec'); btn.setAttribute('aria-label', 'Kaydı bitir');
  const t0 = Date.now(); const tick = setInterval(() => { const sec = Math.round((Date.now() - t0) / 1000); input.placeholder = `Dinliyorum… ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}  (bitirmek için tekrar bas)`; if (sec >= 120) r.stop(); }, 250);
  r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  r.onstop = async () => {
    clearInterval(tick); rec = null; streamA.getTracks().forEach((t) => t.stop());
    btn.classList.remove('rec'); btn.classList.add('wait'); btn.setAttribute('aria-label', 'Sesle yaz');
    input.placeholder = 'Yazıya dökülüyor…';
    try {
      const blob = new Blob(chunks, { type: r.mimeType || 'audio/webm' });
      if (blob.size < 1500 || Date.now() - t0 < 600) throw new Error('Kayıt çok kısa.');
      const res = await fetch('/api/stt', { method: 'POST', headers: { authorization: 'Bearer ' + state.token, 'content-type': blob.type }, body: blob });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error?.message || 'Ses yazıya dökülemedi.');
      if (!j.text) throw new Error('Bir şey duyamadım, tekrar dene.');
      input.value = (input.value ? input.value.trimEnd() + ' ' : '') + j.text; autosize();
      if (voiceMode() && !state.busy) { const t = input.value.trim(); send(t, true); } else input.focus();
    } catch (e) { toast(e.message, 'err'); }
    finally { btn.classList.remove('wait'); input.placeholder = "Glassly'ye bir şey sor…"; }
  };
  r.start(250);
});
const plain = (t) => String(t).replace(/```[\s\S]*?```/g, ' Kod bloğu. ').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[#*_>`|~-]+/g, ' ').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
let speakingBtn = null;
function stopSpeak() {
  try { if (isApp && hasPlugin('TextToSpeech')) native('TextToSpeech', 'stop').catch(() => {}); else speechSynthesis.cancel(); } catch {}
  speakingBtn?.classList.remove('on'); speakingBtn = null;
}
async function speak(text, btn) {
  if (btn && btn === speakingBtn) return stopSpeak();
  stopSpeak();
  const t = plain(text).slice(0, 4000); if (!t) return;
  if (btn) { btn.classList.add('on'); speakingBtn = btn; }
  const done = () => { if (speakingBtn === btn) { btn?.classList.remove('on'); speakingBtn = null; } };
  if (isApp && hasPlugin('TextToSpeech')) { native('TextToSpeech', 'speak', { text: t, lang: 'tr-TR', rate: 1.0, pitch: 1.0, volume: 1.0, category: 'playback' }).catch(() => toast('Sesli okuma şu an çalışmıyor.', 'err')).finally(done); return; }
  if (!('speechSynthesis' in window)) { done(); return toast(isApp ? 'Sesli okuma için uygulamanın yeni sürümünü kur.' : 'Bu tarayıcı sesli okumayı desteklemiyor.', 'err'); }
  const parts = t.match(/[^.!?…]+[.!?…]*\s*/g) || [t];
  const voice = speechSynthesis.getVoices().find((v) => /^tr/i.test(v.lang));
  parts.forEach((p, i) => { const u = new SpeechSynthesisUtterance(p); u.lang = 'tr-TR'; if (voice) u.voice = voice; if (i === parts.length - 1) { u.onend = done; u.onerror = done; } speechSynthesis.speak(u); });
}
try { speechSynthesis.getVoices(); } catch {}

// ---------------------------------------------------------------- hatırlatıcılar ve bildirimler
const notifId = (id) => { let h = 7; for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h) % 2000000000 || 1; };
async function loadReminders() {
  try { state.reminders = (await api('GET', '/api/reminders')).reminders; } catch { return; }
  drawReminders(); scheduleNative();
}
function onReminder(item) {
  state.reminders = [...state.reminders.filter((r) => r.id !== item.id), { ...item, done: 0 }].sort((a, b) => a.at - b.at);
  drawReminders(); scheduleNative(true);
  if (!isApp && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}
async function scheduleNative(ask) {
  if (!isApp || !hasPlugin('LocalNotifications')) return;
  try {
    const perm = await native('LocalNotifications', 'checkPermissions');
    if (perm.display !== 'granted') { if (!ask && perm.display === 'denied') return; const p = await native('LocalNotifications', 'requestPermissions'); if (p.display !== 'granted') return; }
    const pending = (await native('LocalNotifications', 'getPending')).notifications || [];
    if (pending.length) await native('LocalNotifications', 'cancel', { notifications: pending.map((n) => ({ id: n.id })) });
    const now = Date.now();
    const list = state.reminders.filter((r) => !r.done && r.at > now).slice(0, 60).map((r) => ({ id: notifId(r.id), title: 'Glassly', body: r.text, largeBody: r.text, schedule: { at: new Date(r.at).toISOString(), allowWhileIdle: true }, extra: { rid: r.id } }));
    if (list.length) await native('LocalNotifications', 'schedule', { notifications: list });
  } catch (e) { console.warn('bildirim', e); }
}
// Tarayıcıda: sekme açıkken zamanı gelen hatırlatıcı bildirim olarak gösterilir
setInterval(() => {
  if (!state.token || isApp) return;
  const now = Date.now(); let shown; try { shown = JSON.parse(localStorage.getItem('glassly.shown') || '[]'); } catch { shown = []; }
  for (const r of state.reminders) {
    if (r.done || r.at > now || now - r.at > 6 * 3600e3 || shown.includes(r.id)) continue;
    shown.push(r.id);
    if ('Notification' in window && Notification.permission === 'granted') { try { new Notification('Glassly', { body: r.text, icon: '/assets/icon-192.png', tag: r.id }); } catch {} }
    toast('Hatırlatma: ' + r.text);
  }
  try { localStorage.setItem('glassly.shown', JSON.stringify(shown.slice(-200))); } catch {}
}, 15000);
function drawReminders() {
  const box = $('#rems'); if (!box) return;
  const now = Date.now();
  const up = state.reminders.filter((r) => !r.done && r.at > now); const past = state.reminders.filter((r) => r.done || r.at <= now).reverse();
  const row = (r, old) => `<div class="rem${old ? ' old' : ''}">${ICON_BELL}<div class="t"><b>${esc(r.text)}</b><small>${esc(when(r.at))}${old ? ' · geçti' : ''}</small></div><button class="icon" data-rdel="${esc(r.id)}" aria-label="Sil" title="Sil"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`;
  box.innerHTML = (up.length ? up.map((r) => row(r)).join('') : '<p class="muted small">Yaklaşan hatırlatıcı yok.</p>') + (past.length ? '<h4>Geçmiş</h4>' + past.slice(0, 20).map((r) => row(r, true)).join('') : '');
  $('#notifPerm').hidden = isApp || !('Notification' in window) || Notification.permission !== 'default';
}
$('#rems').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-rdel]'); if (!b) return;
  try { await api('DELETE', '/api/reminders/' + b.dataset.rdel); state.reminders = state.reminders.filter((r) => r.id !== b.dataset.rdel); drawReminders(); scheduleNative(); } catch (err) { toast(err.message, 'err'); }
});
$('#remAdd').addEventListener('click', async () => {
  const text = $('#remText').value.trim(); const at = new Date($('#remAt').value).getTime();
  if (!text) return toast('Ne hatırlatayım?', 'err');
  if (!(at > Date.now())) return toast('İleride bir zaman seç.', 'err');
  try { const j = await api('POST', '/api/reminders', { text, at }); $('#remText').value = ''; onReminder(j.reminder); toast('Hatırlatıcı kuruldu'); } catch (err) { toast(err.message, 'err'); }
});
$('#notifPerm').addEventListener('click', async () => { try { await Notification.requestPermission(); } catch {} drawReminders(); });

// ---------------------------------------------------------------- geliştirici paneli
let devUsers = [];
const ago = (t) => { if (!t) return 'hiç'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'az önce' : m < 60 ? `${m} dk önce` : m < 1440 ? `${Math.round(m / 60)} sa önce` : `${Math.round(m / 1440)} gün önce`; };
async function loadDev() {
  try {
    const [s, u] = await Promise.all([api('GET', '/admin/stats'), api('GET', '/admin/users')]);
    const dayN = (kind, d) => (s.days || []).find((x) => x.day === d && x.kind === kind)?.n || 0;
    const days = []; for (let i = 13; i >= 0; i--) days.push(new Date(Date.now() - i * 864e5).toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' }));
    const today = days[13];
    $('#devStats').innerHTML = [[s.users, 'Hesap'], [s.newUsers7 ?? 0, 'Son 7 günde yeni'], [s.messagesToday, 'Bugünkü mesaj'], [`${s.ready}/${s.slots}`, 'Hazır kaynak'], [dayN('img', today), 'Bugün görsel'], [dayN('search', today), 'Bugün arama'], [s.sessions, 'Açık oturum'], [s.dailyMessages ?? 'Sınırsız', 'Günlük sınır']]
      .map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><small>${esc(l)}</small></div>`).join('');
    const vals = days.map((d) => dayN('msg', d)); const mx = Math.max(1, ...vals);
    $('#devChart').innerHTML = `<div class="ch-h"><b>Son 14 gün</b><small class="muted">günlük mesaj</small></div><div class="bars">${days.map((d, i) => `<div class="bar" title="${esc(d)}: ${vals[i]} mesaj"><i style="height:${Math.max(2, (vals[i] / mx) * 100)}%"></i><small>${vals[i] || ''}</small><em>${esc(d.slice(8))}</em></div>`).join('')}</div>`;
    $('#devLimit').value = s.dailyMessages ?? 0;
    $('#devReg').checked = s.registration;
    devUsers = u.users; drawUsers();
  } catch (e) { toast(e.message, 'err'); }
}
async function loadApiKeys() {
  try {
    const j = await api('GET', '/auth/api-keys');
    $('#apiKeys').innerHTML = j.keys.length ? j.keys.map(k => `<div class="u"><div style="min-width:0;flex:1"><b>${esc(k.name)}</b><small class="muted" style="display:block;overflow-wrap:anywhere">${esc(k.prefix)}… · ${k.used}/10 bugün · ${k.revoked ? 'İptal edildi' : 'Etkin'}</small></div>${k.revoked ? '' : `<button class="btn sm ghost" data-revoke-key="${esc(k.id)}">İptal et</button>`}</div>`).join('') : '<p class="muted">Henüz API anahtarı yok.</p>';
  } catch (e) { toast(e.message, 'err'); }
}
$('#apiKeyCreate').addEventListener('click', async () => {
  const name = $('#apiKeyName').value.trim();
  if (!name) return toast('Anahtar için bir ad yaz.', 'err');
  const b = $('#apiKeyCreate'); b.disabled = true;
  try {
    const j = await api('POST', '/auth/api-keys', { name });
    $('#apiKeyValue').value = j.key; $('#apiKeySecret').hidden = false; $('#apiKeyName').value = '';
    loadApiKeys();
  } catch (e) { toast(e.message, 'err'); }
  finally { b.disabled = false; }
});
$('#apiKeyCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#apiKeyValue').value); toast('Anahtar kopyalandı'); }
  catch { $('#apiKeyValue').select(); toast('Anahtarı seçip elle kopyalayabilirsin.', 'err'); }
});
function hideApiSecret() { $('#apiKeyValue').value = ''; $('#apiKeySecret').hidden = true; }
$('#apiKeyHide').addEventListener('click', hideApiSecret);
$('#apiKeys').addEventListener('click', async e => {
  const b = e.target.closest('[data-revoke-key]');
  if (!b) return;
  if (b.dataset.confirm !== 'yes') {
    b.dataset.confirm = 'yes'; b.textContent = 'Eminsen tekrar bas';
    setTimeout(() => { if (b.isConnected) { delete b.dataset.confirm; b.textContent = 'İptal et'; } }, 5000);
    return;
  }
  try { await api('DELETE', '/auth/api-keys/' + b.dataset.revokeKey); hideApiSecret(); loadApiKeys(); toast('API anahtarı iptal edildi'); }
  catch (err) { toast(err.message, 'err'); }
});
function drawUsers() {
  const q = $('#devSearch').value.trim().toLocaleLowerCase('tr');
  const list = devUsers.filter((u) => !q || (u.name + ' ' + u.email).toLocaleLowerCase('tr').includes(q));
  $('#devCount').textContent = `(${devUsers.length})`;
  $('#devUsers').innerHTML = list.map((u) => `<div class="u"><span class="av">${esc((u.name || '?').charAt(0).toLocaleUpperCase('tr'))}</span>
    <div class="t"><b>${esc(u.name)}${u.role === 'gelistirici' ? '<span class="badge">Geliştirici</span>' : ''}</b>
    <small>${esc(u.email)} · ${u.provider.includes('google') ? 'Google' : 'Şifre'} · bugün ${u.today}${u.limit ? '/' + u.limit : ''} · toplam ${u.requests} · ${u.chats} sohbet · son ${ago(u.lastSeen)}</small></div>
    ${u.role === 'gelistirici' ? '' : `<button class="btn sm danger" data-del-user="${esc(u.id)}">Sil</button>`}</div>`).join('') || '<p class="muted small">Sonuç yok.</p>';
}
$('#devSearch').addEventListener('input', drawUsers);
$('#devUsers').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del-user]'); if (!b) return;
  const u = devUsers.find((x) => x.id === b.dataset.delUser);
  if (!confirm(`${u.email} hesabı ve sohbetleri silinsin mi?`)) return;
  try { await api('DELETE', '/admin/users/' + u.id); toast('Hesap silindi'); loadDev(); } catch (err) { toast(err.message, 'err'); }
});
$('#devLimitSave').addEventListener('click', async () => {
  try { const j = await api('POST', '/admin/settings', { daily: Number($('#devLimit').value) }); toast(j.dailyMessages ? `Günlük sınır ${j.dailyMessages} mesaj` : 'Günlük sınır kaldırıldı'); state.config.dailyMessages = j.dailyMessages; loadDev(); }
  catch (err) { toast(err.message, 'err'); }
});
$('#devReg').addEventListener('change', async (e) => {
  try { const j = await api('POST', '/admin/settings', { registration: e.target.checked }); toast(j.registration ? 'Yeni kayıtlar açık' : 'Yeni kayıtlar kapalı'); }
  catch (err) { e.target.checked = !e.target.checked; toast(err.message, 'err'); }
});

// ---------------------------------------------------------------- başlangıç
(async function boot() {
  try { state.config = await (await fetch('/api/config')).json(); } catch { state.config = {}; }
  state.token = loadToken();
  initAppBridge();
  syncSend();
  if (state.token) showApp();
  else {
    $('#auth').hidden = false;
    setMode(location.hash === '#kayit' ? 'register' : 'login');
    initGoogle();
  }
})();
