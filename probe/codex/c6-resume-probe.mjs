// Verify Codex resume for the workbench: materialize a thread in one app-server,
// tear down, then `codex resume <id> --remote` against a FRESH app-server and
// confirm the thread comes back (loaded, with its prior turn).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync } from 'node:fs';
const require = createRequire('/Users/jamesyong/Projects/project100/p008/chopsticks/packages/node/');
const pty = require('node-pty');
const LOG = new URL('./c6-resume.log', import.meta.url).pathname;
appendFileSync(LOG, '\n==== ' + new Date().toISOString() + ' ====\n');
const log = (...a) => appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');

function wsClient(port) {
  let nextId = 1; const pending = new Map();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const req = (m, p) => { const i = nextId++; return new Promise((res) => { pending.set(i, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method: m, params: p })); }); };
  const noti = (m, p) => ws.send(JSON.stringify({ jsonrpc: '2.0', method: m, params: p ?? {} }));
  ws.addEventListener('message', (e) => { const x = JSON.parse(String(e.data)); if (x.id && pending.has(x.id)) { pending.get(x.id)(x.result); pending.delete(x.id); } });
  return { ws, req, noti, ready: new Promise((r) => ws.addEventListener('open', r, { once: true })) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Phase 1: create + materialize a thread ---
const P1 = 8803;
const s1 = spawn('codex', ['app-server', '--listen', `ws://127.0.0.1:${P1}`], { stdio: ['ignore', 'pipe', 'pipe'] });
await sleep(1800);
const c1 = wsClient(P1); await c1.ready;
await c1.req('initialize', { clientInfo: { name: 'p', version: '0' }, capabilities: {} }); c1.noti('initialized');
const before = new Set(((await c1.req('thread/list', {}))?.data ?? []).map((t) => t.id));
const t1 = pty.spawn('codex', ['--remote', `ws://127.0.0.1:${P1}`], { name: 'xterm-256color', cols: 120, rows: 40, cwd: '/private/tmp', env: { ...process.env, TERM: 'xterm-256color' } });
await sleep(4000);
t1.write('\x1b[200~Remember the word banana\x1b[201~'); await sleep(500); t1.write('\r');
await sleep(7000);
const fresh = ((await c1.req('thread/list', {}))?.data ?? []).filter((t) => !before.has(t.id));
const threadId = fresh[0]?.id;
log('created threadId:', threadId, 'preview:', JSON.stringify(fresh[0]?.preview));
try { t1.kill(); } catch {} try { c1.ws.close(); } catch {} s1.kill('SIGTERM');
await sleep(1500);

if (!threadId) { log('no thread; abort'); process.exit(1); }

// --- Phase 2: resume it against a fresh app-server ---
const P2 = 8804;
const s2 = spawn('codex', ['app-server', '--listen', `ws://127.0.0.1:${P2}`], { stdio: ['ignore', 'pipe', 'pipe'] });
await sleep(1800);
const c2 = wsClient(P2); await c2.ready;
await c2.req('initialize', { clientInfo: { name: 'p2', version: '0' }, capabilities: {} }); c2.noti('initialized');
const before2 = new Set(((await c2.req('thread/list', {}))?.data ?? []).map((t) => t.id));

let out = '';
const t2 = pty.spawn('codex', ['resume', threadId, '--remote', `ws://127.0.0.1:${P2}`], { name: 'xterm-256color', cols: 120, rows: 40, cwd: '/private/tmp', env: { ...process.env, TERM: 'xterm-256color' } });
t2.onData((d) => { out += d; });
await sleep(6000);
const plain = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[()][AB0]/g, '').replace(/\x1b\][0-9];[^\x07]*\x07/g, '');
log('resumed TUI bytes:', out.length);
log('resumed TUI shows prior prompt (banana):', /banana/i.test(plain));
log('resumed TUI plain peek:', JSON.stringify(plain.replace(/\s+/g, ' ').trim().slice(0, 300)));
// Is the resumed thread present + loaded on the app-server?
const loaded = ((await c2.req('thread/loaded/list', {}))?.data ?? ((await c2.req('thread/loaded/list', {}))?.threads) ?? []);
log('thread/loaded/list:', JSON.stringify(loaded).slice(0, 200));
try { const r = await c2.req('thread/read', { threadId, includeTurns: true }); log('thread/read turns:', r?.thread?.turns?.length ?? 'n/a'); } catch (e) { log('read err:', e.message); }

try { t2.kill(); } catch {} try { c2.ws.close(); } catch {} s2.kill('SIGTERM');
setTimeout(() => process.exit(0), 200);
