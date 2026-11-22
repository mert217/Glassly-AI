// Yalnızca yerel entegrasyon testinde kullanılır.
const http = require('node:http');
http.createServer((req, res) => {
  let raw = '';
  req.on('data', b => { raw += b; });
  req.on('end', () => {
    const b = JSON.parse(raw || '{}');
    const c = { index: 0, message: { role: 'assistant', content: 'Merhaba, Glassly burada.' }, finish_reason: 'stop' };
    if (!b.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'private-provider', choices: [c] })); return; }
    res.setHeader('content-type', 'text/event-stream');
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: c.message.content }, finish_reason: null }] }) + '\n\n');
    res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
}).listen(5110, '127.0.0.1');
