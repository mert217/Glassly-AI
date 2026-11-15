'use strict';
// Sesli okuma. Sırayla dener:
//  1) Microsoft Edge doğal Türkçe sesleri (en doğal)
//  2) Google çeviri sesi (yedek)
//  3) Bilgisayardaki espeak-ng (internet yoksa; Linux'ta çoğu zaman kurulu)
// Hangisi çalıştıysa bir dahaki sefere önce onu dener.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let preferred = null; // 'edge' | 'google' | 'espeak'
const errors = {};

function clean(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' kod bloğu ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'bağlantı')
    .replace(/[*_#>`|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

const timeout = (ms, label) => new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' zaman aşımı')), ms));

async function edge(text, voice, rate) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
  const tts = new MsEdgeTTS();
  try {
    await Promise.race([tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3), timeout(8000, 'Edge')]);
    const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const { audioStream } = tts.toStream(esc, { rate: `${rate >= 0 ? '+' : ''}${rate}%` });
    const chunks = [];
    await Promise.race([
      new Promise((res, rej) => {
        audioStream.on('data', (c) => chunks.push(c));
        audioStream.on('end', res);
        audioStream.on('close', res);
        audioStream.on('error', rej);
      }),
      timeout(20000, 'Edge'),
    ]);
    const buf = Buffer.concat(chunks);
    if (buf.length < 500) throw new Error('Edge boş ses döndürdü');
    return { data: buf.toString('base64'), mime: 'audio/mpeg' };
  } finally {
    try { tts.close(); } catch { /* */ }
  }
}

// Google çeviri sesi: istek başına ~200 karakter; parçalara bölüp mp3'leri birleştirir
function chunk(text, n = 190) {
  const words = text.split(' ');
  const out = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > n) { if (cur) out.push(cur); cur = w.slice(0, n); } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  return out;
}
async function google(text, voice, rate) {
  const parts = chunk(text);
  const bufs = [];
  for (let i = 0; i < parts.length; i++) {
    const q = new URLSearchParams({ ie: 'UTF-8', tl: 'tr', client: 'tw-ob', q: parts[i], total: String(parts.length), idx: String(i), textlen: String(parts[i].length), ttsspeed: rate < -10 ? '0.8' : '1' });
    const r = await Promise.race([fetch(`https://translate.google.com/translate_tts?${q}`, { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36', referer: 'https://translate.google.com/' } }), timeout(12000, 'Google')]);
    if (!r.ok) throw new Error('Google ses ' + r.status);
    bufs.push(Buffer.from(await r.arrayBuffer()));
  }
  const buf = Buffer.concat(bufs);
  if (buf.length < 500) throw new Error('Google boş ses döndürdü');
  return { data: buf.toString('base64'), mime: 'audio/mpeg' };
}

function espeak(text, voice, rate) {
  return new Promise((resolve, reject) => {
    const bin = ['espeak-ng', 'espeak'].find((b) => process.env.PATH.split(path.delimiter).some((d) => fs.existsSync(path.join(d, b))));
    if (!bin) return reject(new Error('espeak-ng kurulu değil'));
    const out = path.join(os.tmpdir(), `glassly-tts-${process.pid}-${Date.now()}.wav`);
    const speed = String(Math.round(165 * (1 + (rate || 0) / 100)));
    execFile(bin, ['-v', voice === 'tr-TR-AhmetNeural' ? 'tr+m3' : 'tr+f3', '-s', speed, '-w', out, text], { timeout: 30000 }, (err) => {
      if (err) return reject(new Error('espeak: ' + err.message));
      try {
        const data = fs.readFileSync(out).toString('base64');
        fs.unlink(out, () => {});
        resolve({ data, mime: 'audio/wav' });
      } catch (e) { reject(e); }
    });
  });
}

const ENGINES = { edge, google, espeak };

async function speak(text, voice = 'tr-TR-EmelNeural', rate = 0) {
  const t = clean(text);
  if (!t) return null;
  const order = [preferred, 'edge', 'google', 'espeak'].filter((x, i, a) => x && a.indexOf(x) === i);
  const blocked = String(process.env.GLASSLY_TTS_BLOCK || '').split(',');
  for (const name of order) {
    try {
      if (blocked.includes(name)) throw new Error('kapalı (test)');
      const r = await ENGINES[name](t, voice, rate);
      preferred = name;
      delete errors[name];
      return { ...r, engine: name };
    } catch (e) {
      errors[name] = String(e?.message || e);
      if (preferred === name) preferred = null;
    }
  }
  const why = Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join(' · ');
  throw new Error('Sesli okuma yapılamadı. ' + why);
}

module.exports = { speak, lastErrors: () => ({ ...errors }), preferred: () => preferred };
