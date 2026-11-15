// Konuşmayı yazıya çevirir (Whisper, tamamen bilgisayarda çalışır; model ilk kullanımda bir kez indirilir).
import { pipeline, env } from './vendor/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;

let asr = null;
let loadedName = '';

async function load(name) {
  if (asr && loadedName === name) return asr;
  asr = null;
  const progress = (p) => { if (p.status === 'progress' && p.total) postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total }); };
  let device = 'wasm';
  try { if (self.navigator?.gpu && (await navigator.gpu.requestAdapter())) device = 'webgpu'; } catch { /* wasm */ }
  try {
    asr = await pipeline('automatic-speech-recognition', name, { device, dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8', progress_callback: progress });
  } catch (e) {
    if (device === 'wasm') throw e;
    asr = await pipeline('automatic-speech-recognition', name, { device: 'wasm', dtype: 'q8', progress_callback: progress });
  }
  loadedName = name;
  return asr;
}

self.onmessage = async (e) => {
  const { id, type, audio, model = 'onnx-community/whisper-base', language = 'turkish' } = e.data;
  try {
    if (type === 'load') { await load(model); postMessage({ id, type: 'ready' }); return; }
    const p = await load(model);
    const out = await p(audio, { language, task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
    postMessage({ id, type: 'result', text: String(out.text || '').trim() });
  } catch (err) {
    postMessage({ id, type: 'error', error: String(err?.message || err) });
  }
};
