'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Menu, Tray, Notification, nativeImage, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Engine } = require('./engine');
const { Store } = require('./store');
const { Connections } = require('./connections');
const { Assistant } = require('./assistant');
const { Accounts } = require('./account');
const files = require('./files');
const voice = require('./voice');
const crypto = require('node:crypto');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

if (process.env.GLASSLY_DATA_DIR) app.setPath('userData', process.env.GLASSLY_DATA_DIR);

const store = new Store(path.join(app.getPath('userData'), 'glassly.json'));
// Linux'ta tarayıcı sesinin (speechSynthesis) sistem seslerini görebilmesi için
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-speech-dispatcher');
const resourcesDir = app.isPackaged
  ? path.join(process.resourcesPath, 'resources')
  : path.join(__dirname, '..', '..', 'resources');
const engine = new Engine({ dataDir: app.getPath('userData'), store, resourcesDir });

// Ajanın Gmail/Drive/GitHub işlemleri için onay penceresi (arayüzde gösterilir)
const pendingConfirms = new Map();
function askConfirm(req) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve(false);
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pendingConfirms.delete(id); resolve(false); }, 10 * 60e3);
    pendingConfirms.set(id, (v) => { clearTimeout(timer); resolve(!!v); });
    if (win.isMinimized()) win.restore();
    win.focus();
    send('confirm:ask', { id, ...req });
  });
}
ipcMain.on('confirm:reply', (_e, { id, ok }) => { const f = pendingConfirms.get(id); if (f) { pendingConfirms.delete(id); f(ok); } });
const assistant = new Assistant({ store });
const connections = new Connections({
  store, resourcesDir, confirm: askConfirm, assistant,
  onChange: (what, err) => send('conn:changed', { what, err, status: connections.status() }),
});
assistant.on('changed', (what) => send('assistant:changed', what));
assistant.on('fire', (r) => {
  const d = assistant.describe(r);
  // Uygulama arka plandaysa sistem bildirimi; işi olan hatırlatıcılar arayüzde çalıştırılır
  if (Notification.isSupported()) {
    const n = new Notification({ title: r.task ? 'Glassly işe başladı' : 'Glassly hatırlatıyor', body: r.text.slice(0, 200), icon: appIcon() });
    n.on('click', showWindow);
    n.show();
  }
  if (r.task && (!win || win.isDestroyed())) createWindow();
  send('reminder:fire', d);
});
engine.extraConfig = () => ({ mcp: connections.mcpConfig() });
const accounts = new Accounts({ store, dataDir: app.getPath('userData'), engine, connections });
engine.accountKey = () => (accounts.current()?.mode === 'bulut' ? accounts.token() : '');
engine.userName = () => accounts.current()?.name || '';
engine.isCreator = () => { const u = accounts.current(); return !!u && (u.role === 'gelistirici' || String(u.email || '').toLowerCase() === 'ahmetmertevci@gmail.com'); };
connections.scope = () => accounts.current()?.id || null;
assistant.scope = () => accounts.current()?.id || null;

let win = null;
let tray = null;
const appIcon = () => path.join(__dirname, '..', '..', 'build', 'icon.png');
const bgEnabled = () => store.get('background') !== false;
function showWindow() {
  if (!win || win.isDestroyed()) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
function setupTray() {
  if (tray || !bgEnabled()) return;
  try {
    const img = nativeImage.createFromPath(appIcon()).resize({ width: 18, height: 18 });
    tray = new Tray(img);
    tray.setToolTip('Glassly');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Glassly\'yi aç', click: showWindow },
      { type: 'separator' },
      { label: 'Çık', click: () => { forceQuit = true; app.quit(); } },
    ]));
    tray.on('click', showWindow);
  } catch (e) { console.error('Tepsi simgesi', e); }
}

function createWindow() {
  const bounds = store.get('window') || { width: 1360, height: 860 };
  win = new BrowserWindow({
    ...bounds,
    minWidth: 920,
    minHeight: 600,
    show: false,
    title: 'Glassly',
    backgroundColor: '#00000000',
    transparent: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 18, y: 18 },
    titleBarOverlay: isMac ? false : { color: '#00000000', symbolColor: '#c9d2ff', height: 44 },
    vibrancy: isMac ? 'under-window' : undefined,
    visualEffectState: 'active',
    backgroundMaterial: isWin ? 'acrylic' : undefined,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });
  // Kapatınca arka planda çalışmaya devam et (hatırlatıcılar için)
  win.on('close', (e) => {
    if (!forceQuit && bgEnabled() && tray) {
      e.preventDefault();
      win.hide();
      if (!store.get('bgHintShown') && Notification.isSupported()) {
        store.set('bgHintShown', true);
        new Notification({ title: 'Glassly arka planda çalışıyor', body: 'Hatırlatıcıların zamanında gelecek. Tamamen kapatmak için tepsi simgesinden Çık\'ı seç.', icon: appIcon() }).show();
      }
    }
  });
  const saveBounds = () => { if (!win.isMaximized()) store.set('window', win.getBounds()); };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); } });
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

engine.on('status', (s) => send('engine:status', s));
engine.on('event', (e) => send('engine:event', e));

// ---------------------------------------------------------------- IPC
ipcMain.handle('engine:status', () => engine.state);
ipcMain.handle('engine:restart', async () => { await engine.restart(); return engine.state; });
ipcMain.handle('engine:update', async () => engine.update());
ipcMain.handle('engine:log', () => engine.log.slice(-200).join('\n'));
ipcMain.handle('engine:info', async () => ({
  version: await engine.installedVersion(),
  binary: engine.proc ? engine.proc.spawnfile : null,
  url: engine.url,
  skillsDir: engine.skillsDir(),
  cloud: { ...engine.cloudConfig(), key: undefined, models: engine.cloudModels || [] },
}));
ipcMain.handle('api', (_e, req) => engine.request(req));

// Hesap: oturum değişince motor yeni ad ve Bulut anahtarıyla yeniden kurulur
const accountDo = (fn) => async (_e, arg) => {
  const before = JSON.stringify([accounts.current()?.id, accounts.current()?.name, accounts.token()]);
  const r = await fn(arg || {});
  const after = JSON.stringify([accounts.current()?.id, accounts.current()?.name, accounts.token()]);
  if (before !== after) {
    // Hesap değişti: önceki hesabın Google erişimi ve bekleyen GitHub girişi bırakılır
    if (JSON.parse(before)[0] !== accounts.current()?.id) {
      connections.access = null;
      try { connections.cancelGithubDevice(); } catch { /* yok */ }
      send('conn:changed', { what: 'account', status: connections.status() });
      send('assistant:changed', 'memory');
      send('assistant:changed', 'reminders');
    }
    if (engine.state?.state === 'ready') engine.restart().catch(() => {});
  }
  if (fn === googleLogin) send('conn:changed', { what: 'google', status: connections.status() });
  return r;
};
const googleLogin = (a) => accounts.google(a);
ipcMain.handle('account:status', () => accounts.status());
ipcMain.handle('account:register', accountDo((a) => accounts.register(a)));
ipcMain.handle('account:login', accountDo((a) => accounts.login(a)));
ipcMain.handle('account:google', accountDo(googleLogin));
ipcMain.handle('account:logout', accountDo(() => accounts.logout()));
ipcMain.handle('account:rename', accountDo((a) => accounts.rename(a.name)));
ipcMain.handle('account:password', accountDo((a) => accounts.changePassword(a)));
ipcMain.handle('account:remove', accountDo((a) => accounts.remove(a)));
ipcMain.handle('account:usage', () => accounts.usage());
ipcMain.handle('account:consume', () => accounts.consume());
ipcMain.handle('account:admin', () => accounts.adminOverview());
ipcMain.handle('account:admin-delete', (_e, id) => accounts.adminDelete(id));
ipcMain.handle('account:admin-settings', (_e, p) => accounts.adminSettings(p || {}));

ipcMain.handle('conn:status', () => connections.status());
ipcMain.handle('conn:google', async () => {
  // Bağlantılar'dan Google bağlanırken de hesap seçimi her zaman sorulur; giriş yapmadan bağlanamaz
  const me = accounts.current();
  if (!me) throw new Error('Önce giriş yap.');
  return connections.connectGoogle({ hint: (me.provider || '').includes('google') ? me.email : '' });
});
ipcMain.handle('conn:github-device', async () => connections.startGithubDevice());
ipcMain.handle('conn:github-cancel', () => connections.cancelGithubDevice());
ipcMain.handle('conn:github-client', (_e, id) => { connections.setSecret('github-client', id ? { client_id: id } : null); return connections.status(); });

// Hafıza ve hatırlatıcılar
ipcMain.handle('mem:list', () => ({ enabled: assistant.memoryEnabled(), items: assistant.memories(), text: assistant.memoryText() }));
ipcMain.handle('mem:add', (_e, t) => assistant.remember(t));
ipcMain.handle('mem:forget', (_e, id) => assistant.forget(id));
ipcMain.handle('mem:enabled', (_e, v) => { store.set('memoryEnabled', !!v); return true; });
ipcMain.handle('rem:list', () => assistant.reminders().map((r) => ({ ...assistant.describe(r), at: r.at, repeatKey: r.repeat })));
ipcMain.handle('rem:add', (_e, r) => assistant.describe(assistant.addReminder(r)));
ipcMain.handle('rem:remove', (_e, id) => assistant.removeReminder(id));
ipcMain.handle('app:background', (_e, v) => {
  if (v === undefined) return bgEnabled();
  store.set('background', !!v);
  if (v) setupTray(); else if (tray) { tray.destroy(); tray = null; }
  return !!v;
});
ipcMain.handle('app:notify', (_e, { title, body }) => {
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title: title || 'Glassly', body: String(body || '').slice(0, 240), icon: appIcon() });
  n.on('click', showWindow);
  n.show();
  return true;
});
ipcMain.handle('app:focused', () => !!(win && !win.isDestroyed() && win.isVisible() && win.isFocused()));

// Dosyalar
ipcMain.handle('files:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Dosya ekle', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Belgeler ve görseller', extensions: ['pdf', 'docx', 'txt', 'md', 'csv', 'json', 'png', 'jpg', 'jpeg', 'webp', 'gif'] }, { name: 'Tüm dosyalar', extensions: ['*'] }],
  });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('files:extract', async (_e, p) => {
  try { return await files.extract(p); } catch (e) { return { error: e.message, name: path.basename(p) }; }
});

// Ses
ipcMain.handle('voice:speak', async (_e, { text, voice: v, rate }) => voice.speak(text, v, rate));
ipcMain.handle('conn:google-off', (_e, service) => connections.disconnectGoogle(service));
ipcMain.handle('conn:google-client', (_e, c) => { connections.setSecret('google-client', c && c.client_id ? c : null); return connections.status(); });
ipcMain.handle('conn:github', async (_e, token) => connections.connectGithub(token));
// Google Cloud'dan indirilen istemci dosyasını (client_secret_….json) okur
ipcMain.handle('conn:google-file', async (_e, p) => {
  if (!p) {
    const r = await dialog.showOpenDialog(win, { title: 'Google istemci dosyasını seç', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    p = r.filePaths[0];
  }
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { throw new Error('Dosya okunamadı. Google Cloud\'dan indirdiğin JSON dosyasını seç.'); }
  const c = j.installed || j.web || j;
  if (!c.client_id) throw new Error('Bu dosyada istemci kimliği yok. “Masaüstü uygulaması” türünde istemci oluşturup JSON\'unu indir.');
  if (j.web) throw new Error('Bu bir “Web uygulaması” istemcisi. Google Cloud\'da türü “Masaüstü uygulaması” olan yeni bir istemci oluştur.');
  return { client_id: c.client_id, client_secret: c.client_secret || '' };
});
// Kaynak koddan çalışırken istemciyi uygulamaya göm (paketlenen sürümde herkes tek tıkla bağlanır)
ipcMain.handle('conn:google-embed', (_e, c) => {
  if (app.isPackaged) return false;
  const f = path.join(connections.resourcesDir, 'google-oauth.json');
  fs.writeFileSync(f, JSON.stringify({ installed: { client_id: c.client_id, client_secret: c.client_secret || '' }, profile: c.profile || 'tam' }, null, 2));
  return true;
});
ipcMain.handle('app:packaged', () => app.isPackaged);
ipcMain.handle('conn:github-off', () => connections.disconnectGithub());
ipcMain.handle('conn:custom', (_e, list) => { store.set('mcpServers', list || []); return connections.status(); });
ipcMain.handle('app:daily', () => {
  const dir = path.join(app.getPath('userData'), 'gunluk');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
});

ipcMain.handle('store:get', (_e, key) => store.get(key));
ipcMain.handle('store:all', () => store.data);
ipcMain.handle('store:set', (_e, key, value) => { store.set(key, value); return true; });

ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Proje klasörü seç' });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('shell:open', (_e, target) => {
  if (/^https?:/.test(target)) return shell.openExternal(target);
  return shell.openPath(target);
});
ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('fs:exists', (_e, p) => fs.existsSync(p));

ipcMain.handle('skills:list', async () => {
  const dir = engine.skillsDir();
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    const desc = (text.match(/^description:\s*"?(.+?)"?\s*$/m) || [])[1] || '';
    out.push({ name, description: desc, path: f });
  }
  return out;
});
ipcMain.handle('skills:save', (_e, { name, content }) => {
  const safe = String(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  if (!safe) throw new Error('Geçersiz ad');
  const dir = path.join(engine.skillsDir(), safe);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
  return safe;
});
ipcMain.handle('skills:read', (_e, name) => {
  const f = path.join(engine.skillsDir(), path.basename(name), 'SKILL.md');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
});
ipcMain.handle('app:scratch', () => {
  const dir = path.join(app.getPath('userData'), 'hizli-sohbet');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
});
ipcMain.handle('skills:remove', (_e, name) => {
  fs.rmSync(path.join(engine.skillsDir(), path.basename(name)), { recursive: true, force: true });
  return true;
});

ipcMain.handle('theme:native', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));
nativeTheme.on('updated', () => send('theme:native', nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));
ipcMain.handle('window:overlay', (_e, { color, symbolColor }) => {
  if (!isMac && win && win.setTitleBarOverlay) {
    try { win.setTitleBarOverlay({ color, symbolColor, height: 44 }); } catch { /* linux bazı WM'ler */ }
  }
});
ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }));

// ---------------------------------------------------------------- uygulama
app.whenReady().then(() => {
  if (!isMac) Menu.setApplicationMenu(null);
  // Mikrofon izni (sesli konuşma) ve bildirimler
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write'].includes(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => ['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write'].includes(perm));
  if (process.platform === 'win32') app.setAppUserModelId('biz.glassly.app');
  createWindow();
  setupTray();
  assistant.start();
  connections.start().catch((e) => console.error('Bağlantı sunucusu', e)).finally(() => engine.start());
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (!isMac && !(bgEnabled() && tray && !forceQuit)) app.quit(); });
let quitting = false;
let forceQuit = false;
// Tek kopya: ikinci kez açılırsa mevcut pencereyi göster
if (!process.env.GLASSLY_MULTI && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', showWindow);
app.on('before-quit', async (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  forceQuit = true;
  assistant.stop();
  await engine.stop();
  app.quit();
});
