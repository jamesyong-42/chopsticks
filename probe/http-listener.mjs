#!/usr/bin/env node
// Phase 0: one-shot loopback listener proving whether type:"http" hooks
// actually POST, and whether Authorization env interpolation works.
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    writeFileSync(new URL('./http-received.json', import.meta.url), JSON.stringify({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization ?? null,
      contentType: req.headers['content-type'] ?? null,
      body: (() => { try { return JSON.parse(body); } catch { return body; } })(),
    }, null, 2));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
    server.close();
  });
});
server.listen(59999, '127.0.0.1', () => console.log('listening'));
setTimeout(() => { console.log('timeout, no request'); server.close(); process.exit(2); }, 90_000);
