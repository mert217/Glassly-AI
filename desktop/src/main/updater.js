'use strict';

// Glassly güncelleyici: GitHub'daki son sürümü denetler, uygun dosyayı indirir ve kurar.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = 'mert217/Glassly-AI';
const CHECK_EVERY = 6 * 60 * 60 * 1000;

const parse = (v) => String(v || '').replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
const newer = (a, b) => { const x = parse(a), y = parse(b); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; } return false; };

class Updater {
  constructor({ app, shell, send }) {
    this.app = app; this.shell = shell; this.send = send;
    this.state = { status: 'idle', current: process.env.GLASSLY_UPDATE_TEST_VERSION || app.getVersion(), latest: null, progress: 0, error: '' };
    this.file = null; this.asset = null; this.abort = null; this.timer = null;
  }

  // Bu kurulum hangi dosyayla güncellenir
  kind() {
    if (process.platform === 'win32') return { asset: 'Glassly-Setup.exe', type: 'exe' };
    if (process.platform === 'darwin') return { asset: 'Glassly.dmg', type: 'dmg' };
    if (process.env.APPIMAGE) return { asset: 'Glassly.AppImage', type: 'appimage' };
    return { asset: 'Glassly.deb', type: 'deb' };
  }

  set(patch) { Object.assign(this.state, patch); this.send('update:state', this.status()); }
  status() { return { ...this.state, packaged: this.app.isPackaged, type: this.kind().type }; }

  start() {
    setTimeout(() => this.check({ quiet: true }).catch(() => {}), 8000);
    this.timer = setInterval(() => this.check({ quiet: true }).catch(() => {}), CHECK_EVERY);
  }

  async check({ quiet = false } = {}) {
    if (['downloading', 'installing'].includes(this.state.status)) return this.status();
    if (this.state.status === 'ready' && this.file && fs.existsSync(this.file)) return this.status();
    this.set({ status: 'checking', error: '' });
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': 'Glassly', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`Sunucu yanıtı: ${r.status}`);
      const rel = await r.json();
      const latest = String(rel.tag_name || '').replace(/^v/i, '');
      const want = this.kind().asset;
      const asset = (rel.assets || []).find((a) => a.name === want);
      // Dosya henüz yüklenmediyse (derleme sürüyor) güncelleme yokmuş gibi davran
      if (latest && newer(latest, this.state.current) && asset) {
        this.asset = asset;
        this.set({ status: 'available', latest, size: asset.size, notes: String(rel.body || '').slice(0, 1200) });
      } else {
        this.set({ status: 'latest', latest: latest || this.state.current });
      }
    } catch (e) {
      this.set({ status: quiet ? 'idle' : 'error', error: 'Güncelleme denetlenemedi. İnternet bağlantını kontrol et.' });
    }
    return this.status();
  }

  async download() {
    if (this.state.status === 'downloading') return this.status();
    if (!this.asset) { await this.check(); if (!this.asset) return this.status(); }
    const dir = path.join(this.app.getPath('downloads'));
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, this.asset.name);
    const part = dest + '.indiriliyor';
    this.set({ status: 'downloading', progress: 0, error: '' });
    const ctl = new AbortController(); this.abort = ctl;
    try {
      const r = await fetch(this.asset.browser_download_url, { headers: { 'User-Agent': 'Glassly' }, redirect: 'follow', signal: ctl.signal });
      if (!r.ok || !r.body) throw new Error(`İndirme başarısız (${r.status})`);
      const total = Number(r.headers.get('content-length')) || this.asset.size || 0;
      const out = fs.createWriteStream(part);
      let got = 0, last = 0;
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (!out.write(Buffer.from(value))) await new Promise((res) => out.once('drain', res));
        const now = Date.now();
        if (total && now - last > 250) { last = now; this.set({ progress: Math.min(99, Math.round((got / total) * 100)) }); }
      }
      await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
      if (total && got < total) throw new Error('İndirme yarıda kaldı');
      fs.renameSync(part, dest);
      this.file = dest;
      this.set({ status: 'ready', progress: 100, file: dest });
    } catch (e) {
      try { fs.unlinkSync(part); } catch {}
      this.set({ status: ctl.signal.aborted ? 'available' : 'error', progress: 0, error: ctl.signal.aborted ? '' : 'Güncelleme indirilemedi. Tekrar dener misin?' });
    } finally { this.abort = null; }
    return this.status();
  }

  cancel() { if (this.abort) this.abort.abort(); return this.status(); }

  run(cmd, args) {
    return new Promise((res) => {
      let err = '';
      const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', (e) => res({ code: -1, err: e.message }));
      p.on('exit', (code) => res({ code, err }));
    });
  }

  async install() {
    const file = this.file;
    if (!file || !fs.existsSync(file)) { this.set({ status: 'error', error: 'Güncelleme dosyası bulunamadı, tekrar indir.' }); return this.status(); }
    const { type } = this.kind();
    this.set({ status: 'installing' });
    if (type === 'exe') {
      spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
      setTimeout(() => this.app.quit(), 800);
      return this.status();
    }
    if (type === 'dmg') {
      await this.shell.openPath(file);
      this.set({ status: 'ready', hint: 'Açılan pencerede Glassly simgesini Uygulamalar klasörüne sürükle, sonra Glassly\'yi yeniden aç.' });
      return this.status();
    }
    if (type === 'appimage') {
      try {
        const target = process.env.APPIMAGE;
        const tmp = target + '.yeni';
        fs.copyFileSync(file, tmp); fs.chmodSync(tmp, 0o755); fs.renameSync(tmp, target);
        this.app.relaunch({ execPath: target, args: [] });
        this.app.exit(0);
      } catch (e) {
        this.set({ status: 'error', error: 'Güncelleme kurulamadı: ' + e.message });
      }
      return this.status();
    }
    // deb: yönetici şifresi istenir, paket kurulur, Glassly yeniden açılır
    const r = await this.run('pkexec', ['dpkg', '-i', file]);
    if (r.code === 0) {
      this.app.relaunch();
      this.app.exit(0);
      return this.status();
    }
    if (r.code === 126 || r.code === 127) { this.set({ status: 'ready', error: 'Kurulum iptal edildi.' }); return this.status(); }
    if (r.code === -1) {
      // pkexec yoksa paketi Yazılım Merkezi ile aç
      await this.shell.openPath(file);
      this.set({ status: 'ready', hint: 'Açılan pencereden Kur\'a bas, sonra Glassly\'yi yeniden aç.' });
      return this.status();
    }
    this.set({ status: 'error', error: 'Güncelleme kurulamadı. Terminalde şunu dene: sudo dpkg -i "' + file + '"' });
    return this.status();
  }
}

module.exports = { Updater, newer };
