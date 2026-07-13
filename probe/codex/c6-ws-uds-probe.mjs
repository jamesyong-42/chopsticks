// Prove WebSocket-over-UDS: minimal hand-rolled WS client over a unix socket
// to the app-server. Confirms UDS + WS framing carries the JSON-RPC.
import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import { existsSync, unlinkSync, mkdirSync, appendFileSync } from 'node:fs';
const LOG = new URL('./c6-ws-uds.log', import.meta.url).pathname;
appendFileSync(LOG, '\n==== ' + new Date().toISOString() + ' ====\n');
const log = (...a) => appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');

const SOCK = '/private/tmp/cdxuds/s.sock';
mkdirSync('/private/tmp/cdxuds', { recursive: true });
try { if (existsSync(SOCK)) unlinkSync(SOCK); } catch {}

const server = spawn('codex', ['app-server', '--listen', `unix://${SOCK}`], { stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', (d) => log('[srv]', d.toString().slice(0, 100)));
for (let i = 0; i < 60 && !existsSync(SOCK); i++) await new Promise((r) => setTimeout(r, 100));
log('socket exists:', existsSync(SOCK));

const sock = net.connect(SOCK);
await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
log('UDS connected');

// WebSocket client frame encoder (client frames MUST be masked).
function encode(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

let buf = Buffer.alloc(0);
let handshakeDone = false;
let nextId = 1;
const pending = new Map();
const send = (method, params) => { const id = nextId++; return new Promise((res) => { pending.set(id, res); sock.write(encode(JSON.stringify({ jsonrpc: '2.0', id, method, params }))); }); };
const notify = (method, params) => sock.write(encode(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} })));

function handleMessage(s) {
  let m; try { m = JSON.parse(s); } catch { return; }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  else if (m.method) log('notif:', m.method);
}
function parseFrames() {
  while (buf.length >= 2) {
    const b1 = buf[1];
    const opcode = buf[0] & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    let key;
    if (masked) { if (buf.length < off + 4) return; key = buf.subarray(off, off + 4); off += 4; }
    if (buf.length < off + len) return;
    let payload = buf.subarray(off, off + len);
    if (masked) { const u = Buffer.alloc(len); for (let i = 0; i < len; i++) u[i] = payload[i] ^ key[i % 4]; payload = u; }
    buf = buf.subarray(off + len);
    if (opcode === 0x1 || opcode === 0x2) handleMessage(payload.toString('utf8'));
  }
}

sock.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (!handshakeDone) {
    const idx = buf.indexOf('\r\n\r\n');
    if (idx === -1) return;
    const head = buf.subarray(0, idx).toString();
    log('handshake response line:', head.split('\r\n')[0]);
    handshakeDone = true;
    buf = buf.subarray(idx + 4);
  }
  parseFrames();
});

const key = crypto.randomBytes(16).toString('base64');
sock.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);

for (let i = 0; i < 30 && !handshakeDone; i++) await new Promise((r) => setTimeout(r, 100));
log('handshake done:', handshakeDone);

const initRes = await send('initialize', { clientInfo: { name: 'ws-uds', version: '0' }, capabilities: {} });
log('initialize OK over WS-UDS; keys:', Object.keys(initRes ?? {}).join(','));
notify('initialized');
const start = await send('thread/start', { cwd: '/private/tmp', sandbox: 'read-only', approvalPolicy: 'never' });
log('thread/start OK; id=', start?.thread?.id, 'sessionId=', start?.thread?.sessionId);

sock.end();
server.kill('SIGTERM');
try { unlinkSync(SOCK); } catch {}
log('RESULT:', JSON.stringify({ uds: true, handshake: handshakeDone, initialized: !!initRes, threadId: start?.thread?.id }));
setTimeout(() => process.exit(0), 200);
