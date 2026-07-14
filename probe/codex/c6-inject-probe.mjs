// Verify PTY injection into the native codex --remote TUI: bracketed-paste a
// prompt + Enter, then confirm the created thread's user message is the CLEAN
// text (no escape markers) — i.e. the panel's Send can drive Codex like Claude.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync } from 'node:fs';
const require = createRequire('/Users/jamesyong/Projects/project100/p008/chopsticks/packages/node/');
const pty = require('node-pty');
const LOG = new URL('./c6-inject.log', import.meta.url).pathname;
appendFileSync(LOG, '\n==== ' + new Date().toISOString() + ' ====\n');
const log = (...a) => appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');

const PORT = 8802;
const server = spawn('codex', ['app-server', '--listen', `ws://127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r) => setTimeout(r, 1800));

let nextId = 1;
const pending = new Map();
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const req = (m, p) => { const i = nextId++; return new Promise((res) => { pending.set(i, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method: m, params: p })); }); };
const noti = (m, p) => ws.send(JSON.stringify({ jsonrpc: '2.0', method: m, params: p ?? {} }));
ws.addEventListener('message', (e) => { const x = JSON.parse(String(e.data)); if (x.id && pending.has(x.id)) { pending.get(x.id)(x.result); pending.delete(x.id); } });
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await req('initialize', { clientInfo: { name: 'inj', version: '0' }, capabilities: {} });
noti('initialized');
const before = new Set(((await req('thread/list', {}))?.data ?? []).map((t) => t.id));

const term = pty.spawn('codex', ['--remote', `ws://127.0.0.1:${PORT}`], { name: 'xterm-256color', cols: 120, rows: 40, cwd: '/private/tmp', env: { ...process.env, TERM: 'xterm-256color' } });
await new Promise((r) => setTimeout(r, 4000));

const PROMPT = 'Reply with exactly: pong';
log('injecting via bracketed paste...');
term.write(`\x1b[200~${PROMPT}\x1b[201~`);
await new Promise((r) => setTimeout(r, 600));
term.write('\r');
await new Promise((r) => setTimeout(r, 7000));

const after = (await req('thread/list', {}))?.data ?? [];
const fresh = after.filter((t) => !before.has(t.id));
log('new threads:', fresh.length);
if (fresh[0]) {
  log('preview EXACT:', JSON.stringify(fresh[0].preview));
  log('preview clean == prompt:', fresh[0].preview === PROMPT);
  log('preview has escape markers:', /\x1b|\[200~|\[201~/.test(fresh[0].preview));
}
try { term.kill(); } catch {}
try { ws.close(); } catch {}
server.kill('SIGTERM');
setTimeout(() => process.exit(0), 200);
