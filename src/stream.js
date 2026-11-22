// SSE satırları ağ paketleriyle aynı sınırda gelmez. Son satırı ve bitiş nedenini de oku.
export async function* completionEvents(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '', ended = false;
  const parse = (line) => {
    if (!line.startsWith('data:')) return null;
    const data = line.slice(5).trim();
    if (data === '[DONE]') return { done: true };
    let j;
    try { j = JSON.parse(data); } catch { return null; }
    if (j.error) throw new Error(j.error.message || 'Yanıt akışı kesildi.');
    const c = j.choices?.[0];
    return { text: c?.delta?.content ?? c?.message?.content ?? '', finish: c?.finish_reason };
  };
  try {
    for (;;) {
      let timer;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Yanıt akışı beklenmedik biçimde durdu.')), 45000); }),
      ]).finally(() => clearTimeout(timer));
      buf += done ? dec.decode() : dec.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      if (done && buf) { lines.push(buf); buf = ''; }
      for (const line of lines) {
        const ev = parse(line);
        if (!ev) continue;
        if (ev.done || ev.finish) ended = true;
        yield ev;
        if (ev.done) return;
      }
      if (done) break;
    }
    if (!ended) yield { interrupted: true };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function completeReliably({ open, response, messages, signal, onText, onRetry, attempts = 3 }) {
  let text = '', reason = '';
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) throw new DOMException('Durduruldu', 'AbortError');
    reason = '';
    try {
      const r = response || await open(text ? [
        ...messages, { role: 'assistant', content: text },
        { role: 'user', content: 'Yanıtın yarıda kaldı. Önceki metni tekrarlamadan, tam kaldığın yerden devam et ve yanıtı tamamla.' },
      ] : messages);
      response = null;
      if (!r.ok || !r.body) throw new Error('Yanıt alınamadı.');
      for await (const ev of completionEvents(r.body)) {
        if (signal?.aborted) throw new DOMException('Durduruldu', 'AbortError');
        if (ev.text) { text += ev.text; await onText(ev.text); }
        if (ev.finish) reason = ev.finish;
        if (ev.interrupted) reason = 'interrupted';
      }
      if (text.trim() && !['length', 'max_tokens', 'interrupted'].includes(reason)) return text;
    } catch (e) {
      response = null;
      if (signal?.aborted || e.name === 'AbortError') throw e;
      reason = 'interrupted';
    }
    if (i + 1 < attempts) await onRetry?.();
  }
  throw new Error('Yanıt tamamlanamadı. Devam et yazarak sürdürebilirsin.');
}
