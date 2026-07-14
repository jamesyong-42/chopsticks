// C6a probe (part 5): can a controller OBSERVE a TUI-created thread's live
// turn/item stream? Subscription is implicit (no thread/subscribe; only
// unsubscribe) — test whether thread/resume opens the live stream.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync } from 'node:fs';
const require = createRequire('/Users/jamesyong/Projects/project100/p008/chopsticks/packages/node/');
const pty = require('node-pty');
const LOG = new URL('./c6-subscribe.log', import.meta.url).pathname;
appendFileSync(LOG, '\n==== ' + new Date().toISOString() + ' ====\n');
const log = (...a) => appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');

const PORT = 8798;
const server = spawn('codex', ['app-server', '--listen', `ws://127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r) => setTimeout(r, 1800));

let nextId = 1;
const pending = new Map();
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const req = (method, params) => { const id = nextId++; return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); }); };
const notify = (method, params) => ws.send(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }));

let watchThread = null;
const afterResume = []; // notifications seen AFTER we resume the TUI thread
let resumed = false;
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (!m.method) return;
  if (m.method === 'thread/started' && !watchThread) {
    watchThread = m.params?.thread?.id;
    log('observed thread/started ->', watchThread);
  }
  const tid = m.params?.threadId ?? m.params?.thread?.id ?? m.params?.turn?.threadId;
  if (resumed && watchThread && (tid === watchThread || m.method.startsWith('item/') || m.method.startsWith('turn/'))) {
    afterResume.push(m.method);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await req('initialize', { clientInfo: { name: 'observer', version: '0' }, capabilities: {} });
notify('initialized');

// Native TUI attaches + user types prompt #1 -> creates a thread.
let out = '';
const term = pty.spawn('codex', ['--remote', `ws://127.0.0.1:${PORT}`], { name: 'xterm-256color', cols: 120, rows: 40, cwd: '/private/tmp', env: { ...process.env, TERM: 'xterm-256color' } });
term.onData((d) => { out += d; });
await new Promise((r) => setTimeout(r, 4000));
term.write('Reply with exactly: pong');
await new Promise((r) => setTimeout(r, 700));
term.write('\r');
await new Promise((r) => setTimeout(r, 6000)); // let thread appear + first turn finish

if (!watchThread) { log('no thread observed; abort'); }
else {
  log('resuming thread to open live stream:', watchThread);
  const r = await req('thread/resume', { threadId: watchThread });
  resumed = true;
  log('thread/resume returned turns?:', Array.isArray(r?.thread?.turns) ? r.thread.turns.length : 'n/a');
  // User types prompt #2 in the SAME TUI -> does the controller now see the stream?
  term.write('Reply with exactly: ping');
  await new Promise((r) => setTimeout(r, 700));
  term.write('\r');
  await new Promise((r) => setTimeout(r, 9000));
}
log('notifications AFTER resume:', [...new Set(afterResume)].join(',') || 'NONE');
log('count after resume:', afterResume.length);

try { term.kill(); } catch {}
try { ws.close(); } catch {}
server.kill('SIGTERM');
setTimeout(() => process.exit(0), 200);
