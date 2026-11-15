'use strict';
// Sohbete eklenen dosyaları okur: PDF, Word, metin/kod ve görseller.

const fs = require('node:fs');
const path = require('node:path');

const MAX_TEXT = 120000;
const MAX_IMAGE = 8 * 1024 * 1024;
const IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.yml', '.yaml', '.ini', '.log', '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.php', '.rb', '.sh', '.sql', '.css', '.srt', '.env', '.toml']);

async function extract(file) {
  const st = await fs.promises.stat(file);
  const name = path.basename(file);
  const ext = path.extname(file).toLowerCase();
  if (IMG[ext]) {
    if (st.size > MAX_IMAGE) throw new Error(`${name} çok büyük (en fazla 8 MB).`);
    const b = await fs.promises.readFile(file);
    return { kind: 'image', name, mime: IMG[ext], size: st.size, url: `data:${IMG[ext]};base64,${b.toString('base64')}` };
  }
  let text = '';
  let pages;
  if (ext === '.pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(await fs.promises.readFile(file)));
    const r = await extractText(pdf, { mergePages: false });
    pages = r.totalPages;
    text = r.text.map((t, i) => `[Sayfa ${i + 1}]\n${t.trim()}`).join('\n\n');
    if (!text.replace(/\[Sayfa \d+\]/g, '').trim()) throw new Error(`${name} içinde okunabilir metin yok (taranmış PDF olabilir).`);
  } else if (ext === '.docx') {
    const mammoth = require('mammoth');
    text = (await mammoth.extractRawText({ path: file })).value;
  } else if (TEXT_EXT.has(ext) || st.size < 2e6) {
    const b = await fs.promises.readFile(file);
    if (b.subarray(0, 4000).includes(0)) throw new Error(`${name} desteklenmeyen bir dosya türü.`);
    text = b.toString('utf8');
  } else throw new Error(`${name} desteklenmeyen bir dosya türü.`);
  const truncated = text.length > MAX_TEXT;
  return { kind: 'text', name, size: st.size, pages, chars: text.length, truncated, text: truncated ? text.slice(0, MAX_TEXT) : text };
}

module.exports = { extract, IMG };
