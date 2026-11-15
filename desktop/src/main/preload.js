'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('glassly', {
  platform: process.platform,
  api: (req) => ipcRenderer.invoke('api', req),
  engine: {
    status: () => ipcRenderer.invoke('engine:status'),
    restart: () => ipcRenderer.invoke('engine:restart'),
    update: () => ipcRenderer.invoke('engine:update'),
    log: () => ipcRenderer.invoke('engine:log'),
    info: () => ipcRenderer.invoke('engine:info'),
    onStatus: on('engine:status'),
    onEvent: on('engine:event'),
  },
  store: {
    all: () => ipcRenderer.invoke('store:all'),
    get: (k) => ipcRenderer.invoke('store:get', k),
    set: (k, v) => ipcRenderer.invoke('store:set', k, v),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    save: (s) => ipcRenderer.invoke('skills:save', s),
    remove: (n) => ipcRenderer.invoke('skills:remove', n),
    read: (n) => ipcRenderer.invoke('skills:read', n),
  },
  scratchDir: () => ipcRenderer.invoke('app:scratch'),
  dailyDir: () => ipcRenderer.invoke('app:daily'),
  conn: {
    status: () => ipcRenderer.invoke('conn:status'),
    google: (service) => ipcRenderer.invoke('conn:google', service),
    googleOff: (service) => ipcRenderer.invoke('conn:google-off', service),
    googleClient: (c) => ipcRenderer.invoke('conn:google-client', c),
    github: (token) => ipcRenderer.invoke('conn:github', token),
    githubDevice: () => ipcRenderer.invoke('conn:github-device'),
    githubCancel: () => ipcRenderer.invoke('conn:github-cancel'),
    githubClient: (id) => ipcRenderer.invoke('conn:github-client', id),
    onChanged: on('conn:changed'),
    githubOff: () => ipcRenderer.invoke('conn:github-off'),
    googleFile: (p) => ipcRenderer.invoke('conn:google-file', p),
    googleEmbed: (c) => ipcRenderer.invoke('conn:google-embed', c),
    packaged: () => ipcRenderer.invoke('app:packaged'),
    custom: (list) => ipcRenderer.invoke('conn:custom', list),
  },
  account: {
    status: () => ipcRenderer.invoke('account:status'),
    register: (a) => ipcRenderer.invoke('account:register', a),
    login: (a) => ipcRenderer.invoke('account:login', a),
    google: (a) => ipcRenderer.invoke('account:google', a),
    logout: () => ipcRenderer.invoke('account:logout'),
    rename: (name) => ipcRenderer.invoke('account:rename', { name }),
    password: (a) => ipcRenderer.invoke('account:password', a),
    remove: (a) => ipcRenderer.invoke('account:remove', a),
    usage: () => ipcRenderer.invoke('account:usage'),
    consume: () => ipcRenderer.invoke('account:consume'),
    admin: () => ipcRenderer.invoke('account:admin'),
    adminDelete: (id) => ipcRenderer.invoke('account:admin-delete', id),
    adminSettings: (p) => ipcRenderer.invoke('account:admin-settings', p),
  },
  memory: {
    list: () => ipcRenderer.invoke('mem:list'),
    add: (t) => ipcRenderer.invoke('mem:add', t),
    forget: (id) => ipcRenderer.invoke('mem:forget', id),
    enabled: (v) => ipcRenderer.invoke('mem:enabled', v),
  },
  reminders: {
    list: () => ipcRenderer.invoke('rem:list'),
    add: (r) => ipcRenderer.invoke('rem:add', r),
    remove: (id) => ipcRenderer.invoke('rem:remove', id),
    onFire: on('reminder:fire'),
  },
  onAssistantChanged: on('assistant:changed'),
  background: (v) => ipcRenderer.invoke('app:background', v),
  notify: (n) => ipcRenderer.invoke('app:notify', n),
  focused: () => ipcRenderer.invoke('app:focused'),
  files: {
    pick: () => ipcRenderer.invoke('files:pick'),
    extract: (p) => ipcRenderer.invoke('files:extract', p),
    pathOf: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  },
  voice: { speak: (o) => ipcRenderer.invoke('voice:speak', o) },
  onConfirm: on('confirm:ask'),
  confirmReply: (id, ok) => ipcRenderer.send('confirm:reply', { id, ok }),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  open: (t) => ipcRenderer.invoke('shell:open', t),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  exists: (p) => ipcRenderer.invoke('fs:exists', p),
  nativeTheme: () => ipcRenderer.invoke('theme:native'),
  onNativeTheme: on('theme:native'),
  setOverlay: (o) => ipcRenderer.invoke('window:overlay', o),
  appInfo: () => ipcRenderer.invoke('app:info'),
  update: {
    status: () => ipcRenderer.invoke('update:status'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    cancel: () => ipcRenderer.invoke('update:cancel'),
    install: () => ipcRenderer.invoke('update:install'),
    onState: on('update:state'),
  },
});
