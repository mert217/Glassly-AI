// Glassly araçları: internet araması, görsel oluşturma, görsel anlama, ses yazıya dökme ve hatırlatıcılar.
// Hepsi sunucu tarafında çalışır; kullanıcıya hangi servisin kullanıldığı gösterilmez.

import { openUpstream, runWorkersAI } from './pool.js';

const log = (...a) => console.log(...a);

// ---- Hangi aracın gerektiğine karar veren kısa ön adım
// Sohbet mesajlarının çoğu araç istemez; boşuna gecikme olmasın diye önce kaba bir süzgeç uygulanır.
const HINT = /(ara[şs]t[ıi]r|\bara\b|aray|bul\b|internet|google|\bweb\b|g[üu]ncel|son dakika|haber|bug[üu]n|yar[ıi]n|d[üu]n\b|bu hafta|[şs]u an|[şs]imdi|hava\s?durumu|hava nas|s[ıi]cakl[ıi]k|derece|fiyat|ka[çc] para|ka[çc] tl|\bkur\b|dolar|euro|sterlin|alt[ıi]n|borsa|bist|bitcoin|kripto|ma[çc]|skor|puan durumu|kim kazand|se[çc]im|\b20[2-3]\d\b|yeni [çc][ıi]kan|[çc][ıi]kt[ıi] m[ıi]|ne zaman|nerede|nereye|a[çc][ıi]k m[ıi]|adres|telefon numaras|n[öo]bet[çc]i|vizyon|film|dizi|hat[ıi]rlat|alarm|uyand[ıi]r|unutma|resim|g[öo]rsel|[çc]iz|[çc]izer|foto[ğg]raf|foto\b|logo|ill[üu]strasyon|duvar ka[ğg][ıi]d|wallpaper|draw|image|picture|search|latest|news|price|weather|remind|kimdir|nedir|kim\b|ka[çc]\b)/i;
export const mayNeedTools = (text) => HINT.test(text);

function localNow(TZ) {
  const d = new Date();
  const s = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const wd = d.toLocaleDateString('tr-TR', { timeZone: TZ, weekday: 'long' });
  return `${s} (${wd})`;
}
// "YYYY-MM-DD HH:MM" yerel saatini (TZ) zaman damgasına çevirir
export function localToEpoch(str, TZ) {
  const m = String(str || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const asLocal = (t) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(t)).map((x) => [x.type, x.value])); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute); };
  const off = asLocal(guess) - guess;
  return guess - off;
}

const PLAN = (TZ) => `Sen bir yönlendiricisin. Kullanıcının son mesajına (ve gerekirse önceki birkaç mesaja) bakıp YALNIZCA şu biçimde tek bir JSON nesnesi döndür, başka hiçbir şey yazma:
{"search": null, "image": null, "reminder": null}
- "search": Cevap güncel ya da gerçek zamanlı bilgi gerektiriyorsa (haberler, hava durumu, döviz/altın/hisse fiyatları, maç sonuçları, son olaylar, yeni çıkan ürünler, belirli bir yer, işletme veya kişi hakkında güncel bilgi, kullanıcının internette aramanı istemesi) kısa ve net bir arama sorgusu yaz (kullanıcının dilinde). Genel bilgi, sohbet, yazı yazma, çeviri, kod, matematik ve tavsiye için null bırak.
- "image": Kullanıcı açıkça bir resim, görsel, çizim, logo ya da fotoğraf OLUŞTURMANI istiyorsa, görseli ayrıntılı anlatan İNGİLİZCE bir istem yaz. Aksi halde null.
- "reminder": Kullanıcı açıkça bir şeyi hatırlatmanı istiyorsa {"at": "YYYY-MM-DD HH:MM", "text": "kısa hatırlatma metni"}. Şu anki yerel tarih ve saat: ${localNow(TZ)}. Saat belirtilmemişse 09:00 kullan; "10 dakika sonra" gibi göreli ifadeleri hesapla. Aksi halde null.`;

export async function plan(S, ctxMsgs, TZ) {
  const recent = ctxMsgs.slice(-5).map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 9000);
  try {
    const r = await openUpstream(S, { model: 'auto', stream: false, temperature: 0, max_tokens: 300, messages: [{ role: 'system', content: PLAN(TZ) }, ...recent, { role: 'user', content: 'Yukarıdaki son kullanıcı mesajı için JSON:' }] }, ac.signal);
    const j = await r.json();
    let t = j.choices?.[0]?.message?.content || '';
    t = t.replace(/<think>[\s\S]*?<\/think>/g, '');
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return {};
    const o = JSON.parse(m[0]);
    const str = (v) => (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim().slice(0, 600) : null);
    const rem = o.reminder && typeof o.reminder === 'object' && str(o.reminder.text) && str(o.reminder.at) ? { at: str(o.reminder.at), text: str(o.reminder.text) } : null;
    return { search: str(o.search), image: str(o.image), reminder: rem };
  } catch (e) { log('yönlendirici', e.message); return {}; }
  finally { clearTimeout(timer); }
}

// ---- İnternet araması
export async function webSearch(query, n = 6) {
  const r = await fetch('https://mcp.exa.ai/mcp', {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search_exa', arguments: { query, numResults: n } } }),
  });
  if (!r.ok) throw new Error('arama HTTP ' + r.status);
  const raw = await r.text();
  let text = '';
  for (const line of raw.split('\n')) {
    const d = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
    if (!d.startsWith('{')) continue;
    try { const j = JSON.parse(d); for (const c of j.result?.content || []) if (c.type === 'text') text += c.text + '\n'; } catch { /* parça */ }
  }
  const items = [];
  for (const block of text.split(/\n(?=Title:)/)) {
    const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
    const url = block.match(/^URL:\s*(\S+)/m)?.[1]?.trim();
    if (!title || !url) continue;
    const date = block.match(/^Published(?: Date)?:\s*(.+)$/m)?.[1]?.trim() || '';
    const body = block.replace(/^(Title|URL|Published(?: Date)?|Author|Image|Favicon|ID):.*$/gm, '').replace(/^(Highlights|Text|Summary):\s*/gm, '').replace(/\n{2,}/g, '\n').trim();
    items.push({ title: title.slice(0, 200), url, date, text: body.slice(0, 1800) });
  }
  return items.slice(0, n);
}
export function searchContext(query, items, TZ) {
  const list = items.map((x, i) => `[${i + 1}] ${x.title}\n${x.url}${x.date ? `\nTarih: ${x.date}` : ''}\n${x.text}`).join('\n\n');
  return `İnternette "${query}" için arama yaptın (şu an: ${localNow(TZ)}). Sonuçlar:\n\n${list}\n\nCevabını bu sonuçlara dayandır. Kullandığın bilginin hemen ardından kaynağını Markdown bağlantısı olarak ver, ör. [Site adı](url). Sonuçlarda olmayan bilgiyi uydurma; emin değilsen söyle. Arama yaptığını uzun uzun anlatma, doğrudan cevap ver.`;
}

// ---- Görsel oluşturma
export async function generateImage(env, prompt) {
  const out = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt: prompt.slice(0, 2000), steps: 6 });
  if (!out?.image) throw new Error('görsel oluşmadı');
  return { mime: 'image/jpeg', data: out.image };
}

// ---- Görsel anlama: fotoğraflı mesajlar bu modellere gider
const VISION = ['@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/google/gemma-3-12b-it', '@cf/mistralai/mistral-small-3.1-24b-instruct'];
export async function openVision(S, messages) {
  let last = '';
  for (const model of VISION) {
    try { return await runWorkersAI(S, { id: model, upstream: 'cloudflare', model, ai: true }, { messages, stream: true, max_tokens: 2048 }); }
    catch (e) { last = e.message; log('görsel modeli', model, e.message); }
  }
  throw new Error('görsel modeli yok: ' + last);
}

// ---- Sesi yazıya dökme
export async function transcribe(env, bytes, lang = 'tr') {
  let bin = ''; const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
  const out = await env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio: btoa(bin), language: lang, task: 'transcribe' });
  return String(out?.text || '').trim();
}
