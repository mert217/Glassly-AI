// Glassly web uygulaması
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KEY = 'glassly.token';

const state = { token: '', user: null, usage: null, config: {}, chats: [], chatId: null, messages: [], busy: false, abort: null, mode: 'login' };

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
  $('#authSub').textContent = reg ? 'Ücretsiz. Her gün 70 mesaj hakkın olur.' : 'Hesabınla giriş yap, kaldığın yerden devam et.';
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

function signedIn(j, remember) {
  state.token = j.token; state.user = j.user;
  saveToken(j.token, remember);
  $('#aPass').value = '';
  showApp();
}
function signedOut() {
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
function renderChats() {
  const el = $('#chats');
  if (!state.chats.length) { el.innerHTML = '<div class="none">Henüz sohbet yok.</div>'; return; }
  el.innerHTML = state.chats.map((c) => `<div class="chat-i${c.id === state.chatId ? ' on' : ''}" data-id="${esc(c.id)}"><a href="#c=${esc(c.id)}" title="${esc(c.title)}">${esc(c.title)}</a><button class="icon x" data-del="${esc(c.id)}" aria-label="Sohbeti sil" title="Sil"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></div>`).join('');
}
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
function msgEl(m, last) {
  const el = document.createElement('div');
  if (m.role === 'user') { el.className = 'msg user'; el.innerHTML = `<div class="bubble"></div>`; el.firstChild.textContent = m.content; return el; }
  el.className = 'msg ai' + (last ? ' last' : '') + (m.error ? ' error' : '');
  el.innerHTML = `<img class="ava" src="/assets/logo.svg" alt="" /><div class="body"><div class="md"></div><div class="acts"><button class="icon" data-copy title="Kopyala" aria-label="Kopyala">${ICON_COPY}</button>${last ? `<button class="icon" data-regen title="Yeniden yaz" aria-label="Yeniden yaz">${ICON_RE}</button>` : ''}</div></div>`;
  const box = el.querySelector('.md');
  if (m.error) box.textContent = m.content; else { box.append(md(m.content)); decorate(box); }
  el.querySelector('[data-copy]').onclick = () => { navigator.clipboard.writeText(m.content); toast('Kopyalandı'); };
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
  b.disabled = !state.busy && !input.value.trim();
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
  const t = input.value.trim(); if (!t) return;
  send(t);
});

const nearBottom = () => { const s = $('#scroll'); return s.scrollHeight - s.scrollTop - s.clientHeight < 120; };
const toBottom = () => { const s = $('#scroll'); s.scrollTop = s.scrollHeight; };

function send(text) { stream({ chatId: state.chatId, text }, { role: 'user', content: text }); }
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
  el.innerHTML = '<img class="ava" src="/assets/logo.svg" alt="" /><div class="body"><div class="md"><span class="typing"><i></i><i></i><i></i></span></div></div>';
  $('#msgs').append(el); toBottom();
  const box = el.querySelector('.md');
  let out = ''; let raf = 0; let errMsg = '';
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
        } else if (ev.type === 'delta') { out += ev.text; if (!raf) raf = requestAnimationFrame(paint); }
        else if (ev.type === 'error') errMsg = ev.message;
        else if (ev.type === 'done' && ev.usage) { state.usage = ev.usage; fillUsage(); }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') errMsg = e.message;
  } finally {
    if (raf) cancelAnimationFrame(raf);
    state.busy = false; state.abort = null;
    if (out.trim()) state.messages.push({ role: 'assistant', content: out });
    else if (errMsg) state.messages.push({ role: 'assistant', content: errMsg, error: true });
    else if (userMsg && ac.signal.aborted) { /* durduruldu, yanıt yok */ }
    const c = state.chats.find((x) => x.id === state.chatId);
    if (c) { c.updated = Date.now(); state.chats = [c, ...state.chats.filter((x) => x !== c)]; renderChats(); }
    const stick = nearBottom();
    renderMessages(); syncSend();
    if (stick) toBottom();
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
  $$('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  $$('.panes [data-pane]').forEach((p) => p.classList.toggle('on', p.dataset.pane === t));
  if (t === 'dev') loadDev();
}
$$('[data-open-settings]').forEach((b) => b.addEventListener('click', () => openSettings(b.dataset.openSettings)));
$$('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('#settings').addEventListener('click', (e) => { if (e.target.id === 'settings' || e.target.closest('[data-close]')) $('#settings').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#settings').hidden = true; $('#meMenu').hidden = true; closeDrawer(); } });

$('#saveName').addEventListener('click', async () => {
  try { const j = await api('PATCH', '/auth/me', { name: $('#sName').value }); state.user = j.user; fillUser(); renderEmpty(); toast('Adın güncellendi'); }
  catch (e) { toast(e.message, 'err'); }
});
$('#savePass').addEventListener('click', async () => {
  try { await api('POST', '/auth/password', { current: $('#pCur').value, next: $('#pNew').value }); $('#pCur').value = $('#pNew').value = ''; toast('Şifren değişti. Diğer cihazlardaki oturumlar kapatıldı.'); }
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

// ---------------------------------------------------------------- geliştirici paneli
let devUsers = [];
const ago = (t) => { if (!t) return 'hiç'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'az önce' : m < 60 ? `${m} dk önce` : m < 1440 ? `${Math.round(m / 60)} sa önce` : `${Math.round(m / 1440)} gün önce`; };
async function loadDev() {
  try {
    const [s, u] = await Promise.all([api('GET', '/admin/stats'), api('GET', '/admin/users')]);
    $('#devStats').innerHTML = [[s.users, 'Hesap'], [s.sessions, 'Açık oturum'], [s.messagesToday, 'Bugünkü mesaj'], [`${s.ready}/${s.slots}`, 'Hazır kaynak']]
      .map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><small>${esc(l)}</small></div>`).join('');
    $('#devReg').checked = s.registration;
    devUsers = u.users; drawUsers();
  } catch (e) { toast(e.message, 'err'); }
}
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
$('#devReg').addEventListener('change', async (e) => {
  try { const j = await api('POST', '/admin/settings', { registration: e.target.checked }); toast(j.registration ? 'Yeni kayıtlar açık' : 'Yeni kayıtlar kapalı'); }
  catch (err) { e.target.checked = !e.target.checked; toast(err.message, 'err'); }
});

// ---------------------------------------------------------------- başlangıç
(async function boot() {
  try { state.config = await (await fetch('/api/config')).json(); } catch { state.config = {}; }
  state.token = loadToken();
  syncSend();
  if (state.token) showApp();
  else {
    $('#auth').hidden = false;
    setMode(location.hash === '#kayit' ? 'register' : 'login');
    initGoogle();
  }
})();
