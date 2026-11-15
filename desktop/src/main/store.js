'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  theme: 'system',          // system | aurora | frost
  accent: 'iris',           // iris | lagoon | ember | moss | rose
  blur: 28,
  motion: true,
  model: null,              // "providerID/modelID"
  agent: 'build',
  projects: [],             // son kullanılan klasörler
  currentProject: null,
  permissions: { edit: 'ask', bash: 'ask', webfetch: 'allow', auto: false },
  customProviders: [],
  instructions: '',
  lockedModels: {},         // "p/m" -> açılma zamanı (ms)
  inspector: true,
  autoSwitch: true,         // limit dolunca otomatik başka modele geç ve devam et
  rotate: false,            // her mesajda ücretsiz modeller arasında dönüşümlü kullan
  cloud: { url: '', key: '' }, // Glassly Bulut (kendi sunucun, OpenAI uyumlu)
};

class Store {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    try {
      this.data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch { /* ilk açılış */ }
  }

  get(key) {
    return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), this.data);
  }

  set(key, value) {
    const parts = key.split('.');
    let o = this.data;
    for (const k of parts.slice(0, -1)) o = o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {};
    o[parts.at(-1)] = value;
    this.save();
  }

  save() {
    clearTimeout(this.t);
    this.t = setTimeout(() => {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    }, 150);
  }
}

module.exports = { Store };
