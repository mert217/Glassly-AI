import test from 'node:test';
import assert from 'node:assert/strict';
import { completionEvents, completeReliably } from '../src/stream.js';

const enc = new TextEncoder();
function response(text, split = 1) {
  return new Response(new ReadableStream({
    start(c) {
      const bytes = enc.encode(text);
      for (let i = 0; i < bytes.length; i += split) c.enqueue(bytes.slice(i, i + split));
      c.close();
    },
  }));
}
const delta = (s) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: s }, finish_reason: null }] }) + '\r\n\r\n';
const finish = (s) => 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: s }] });

test('UTF-8, split packets, CRLF and last line without newline survive', async () => {
  const events = [];
  for await (const e of completionEvents(response(delta('Türkçe ıİşğ') + finish('stop')).body)) events.push(e);
  assert.equal(events.map(e => e.text || '').join(''), 'Türkçe ıİşğ');
  assert.equal(events.at(-1).finish, 'stop');
});
test('EOF without terminal event is interrupted', async () => {
  const events = [];
  for await (const e of completionEvents(response(delta('yarım')).body)) events.push(e);
  assert.equal(events.at(-1).interrupted, true);
});
test('length and interrupted streams continue within one response', async () => {
  const responses = [response(delta('Bir ') + finish('length')), response(delta('iki ')), response(delta('üç.') + finish('stop'))];
  let text = '', calls = 0;
  await completeReliably({
    messages: [{ role: 'user', content: 'Say' }],
    open: async (msgs) => { if (calls) assert.equal(msgs.at(-2).content, text); return responses[calls++]; },
    onText: async t => { text += t; },
  });
  assert.equal(text, 'Bir iki üç.');
  assert.equal(calls, 3);
});
test('repeated failure is not reported as success', async () => {
  await assert.rejects(completeReliably({
    messages: [], open: async () => response(delta('x')), onText: async () => {},
  }), /tamamlanamadı/);
});
test('stop does not cause another request', async () => {
  const ac = new AbortController();
  let calls = 0;
  await assert.rejects(completeReliably({
    signal: ac.signal, messages: [],
    open: async () => { calls++; ac.abort(); return response(delta('x')); }, onText: async () => {},
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
});
