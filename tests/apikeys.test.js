import test from 'node:test';
import assert from 'node:assert/strict';
import { validateApiBody, hasApiKey } from '../src/apikeys.js';
const base = { messages: [{ role: 'user', content: 'Merhaba' }] };
test('external API enforces explicit small limits and strips extra fields', () => {
  const b = validateApiBody({ ...base, model: 'glassly', arbitrary: 'never-forward' });
  assert.equal(b.max_tokens, 512);
  assert.equal(b.model, 'auto');
  assert.equal(b.arbitrary, undefined);
  assert.throws(() => validateApiBody({ ...base, max_tokens: 513 }));
  assert.throws(() => validateApiBody({ ...base, messages: [{ role: 'user', content: 'x'.repeat(16001) }] }));
  assert.throws(() => validateApiBody({ ...base, tools: [{}] }));
  assert.throws(() => validateApiBody({ ...base, messages: [{ role: 'tool', content: 'x' }] }));
  assert.throws(() => validateApiBody({ ...base, stream: 'false' }));
});
test('API keys use a separate namespace from login sessions', () => {
  const req = token => new Request('https://glassly.biz/v1/models', { headers: { authorization: 'Bearer ' + token } });
  assert.equal(hasApiKey(req('gly_api_abc')), true);
  assert.equal(hasApiKey(req('gly_session')), false);
});
