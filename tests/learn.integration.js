// Local Worker + test upstream only. Uses temporary accounts and cleans up.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
const base = 'http://127.0.0.1:8790';
async function req(path, body, token, method = 'POST') {
  const res = await fetch(base + path, { method, headers: {'content-type':'application/json', ...(token ? { authorization: `Bearer ${token}` } : {})}, body: body ? JSON.stringify(body) : undefined });
  return { status:res.status, body:await res.json() };
}
const pass = 'Learning-test-' + randomBytes(16).toString('hex');
const user = await req('/auth/register', { email:`learning-${crypto.randomUUID()}@example.com`, password:pass, name:'Learning Test' });
assert.equal(user.status,200);
const auth=user.body.token;
const start=async()=>{
  const verifier=randomBytes(32).toString('hex');
  const proof=createHash('sha256').update(verifier).digest('hex');
  const {status,body}=await req('/auth/learn/start',{proof});
  assert.equal(status,201);
  return {code:body.code,verifier};
};
const coachBody={scenario:'cafe',messages:[{role:'user',content:"I'd like tea please."}]};
try {
  const x=await start();
  assert.match(x.code,/^[A-F0-9]{12}$/);
  assert.equal((await req('/auth/learn/exchange',x)).status,202);
  assert.equal((await req('/auth/learn/approve',{code:x.code})).status,401);
  assert.equal((await req('/auth/learn/approve',{code:x.code},auth)).status,200);
  assert.equal((await req('/auth/learn/exchange',{...x,verifier:'0'.repeat(64)})).status,404);
  const exchange=await Promise.all([req('/auth/learn/exchange',x),req('/auth/learn/exchange',x)]);
  assert.equal(exchange.filter(r=>r.status===200).length,1);
  const token=exchange.find(r=>r.status===200).body.token;
  assert.match(token,/^gly_learn_[a-f0-9]{64}$/);
  assert.equal((await req('/auth/me',null,token,'GET')).status,401);
  assert.equal((await req('/api/chats',null,token,'GET')).status,401);
  assert.equal((await req('/auth/learn/coach',coachBody,auth)).status,401);
  const response=await req('/auth/learn/coach',coachBody,token);
  assert.equal(response.status,200);assert.ok(response.body.content.length);
  const key=await req('/auth/api-keys',{name:'Quota test'},auth);
  assert.equal(key.status,201);
  const normal=await req('/v1/chat/completions',{model:'glassly',messages:coachBody.messages},key.body.key);
  assert.equal(normal.status,200);
  assert.equal((await req('/auth/learn/coach',coachBody,token)).status,429);
  assert.equal((await req('/auth/learn/disconnect',{},token)).status,200);
  assert.equal((await req('/auth/learn/coach',coachBody,token)).status,401);
  const secondLogin=await req('/auth/login',{email:user.body.user.email,password:pass});
  assert.equal(secondLogin.status,200);
  const next=await start();
  assert.equal((await req('/auth/learn/approve',{code:next.code},secondLogin.body.token)).status,200);
  const token2=(await req('/auth/learn/exchange',next)).body.token;
  assert.equal((await req('/auth/logout',{},secondLogin.body.token)).status,200);
  assert.equal((await req('/auth/me',null,auth,'GET')).status,200);
  assert.match(token2,/^gly_learn_/);
  assert.equal((await req('/auth/learn/coach',coachBody,token2)).status,401);
  console.log('PASS: approval and proof, single exchange, scope, AI response, shared quota, disconnect, account isolation.');
} finally {
  assert.equal((await req('/auth/me',{password:pass},auth,'DELETE')).status,200);
}
