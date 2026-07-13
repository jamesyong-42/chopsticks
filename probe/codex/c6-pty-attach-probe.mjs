// C6a probe (part 4): user types in the native TUI -> controller observes the
// resulting thread on the same app-server. Proves the coexistence model C6 uses.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync } from 'node:fs';
const require = createRequire('/Users/jamesyong/Projects/project100/p008/chopsticks/packages/node/');
const pty = require('node-pty');
const LOG = new URL('./c6-pty2.log', import.meta.url).pathname;
appendFileSync(LOG, '\n==== ' + new Date().toISOString() + ' ====\n');
const log = (...a) => appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');

const PORT = 8796;
const server = spawn('codex', ['app-server', '--listen', `ws://127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r) => setTimeout(r, 1800));

let nextId = 1;
const pending = new Map();
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const req = (method, params) => { const id = nextId++; return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); }); };
const notify = (method, params) => ws.send(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }));
const notifMethods = new Set();
ws.addEventListener('message', (ev) => { let m; try { m = JSON.parse(String(ev.data)); } catch { return; } if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } else if (m.method) notifMethods.add(m.method); });
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await req('initialize', { clientInfo: { name: 'observer', version: '0' }, capabilities: {} });
notify('initialized');
const before = new Set(((await req('thread/list', {}))?.data ?? []).map((t) => t.id));
log('threads BEFORE:', before.size);

let out = '';
const term = pty.spawn('codex', ['--remote', `ws://127.0.0.1:${PORT}`], { name: 'xterm-256color', cols: 120, rows: 40, cwd: '/private/tmp', env: { ...process.env, TERM: 'xterm-256color' } });
term.onData((d) => { out += d; });
await new Promise((r) => setTimeout(r, 4000)); // let TUI become ready

log('typing prompt into TUI...');
term.write('Reply with exactly the single word: pong');
await new Promise((r) => setTimeout(r, 800));
term.write('\r'); // submit
await new Promise((r) => setTimeout(r, 12000)); // let the turn run

const after = (await req('thread/list', {}))?.data ?? [];
const fresh = after.filter((t) => !before.has(t.id));
log('threads AFTER:', after.length, '| NEW:', fresh.length, fresh.map((t) => t.id).join(','));
if (fresh[0]) {
  const tid = fresh[0].id;
  log('NEW thread:', tid, 'sessionId=', fresh[0].sessionId, 'preview=', JSON.stringify(fresh[0].preview));
  try {
    const read = await req('thread/read', { threadId: tid });
    const items = read?.thread?.turns ?? read?.turns ?? read?.items ?? read;
    log('thread/read keys:', Object.keys(read ?? {}).join(','));
    log('thread/read snippet:', JSON.stringify(read).slice(0, 500));
  } catch (e) { log('thread/read err:', e.message); }
}
log('controller notif methods seen:', [...notifMethods].join(',') || 'none');
// Does the TUI show the assistant reply?
const plain = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[()][AB0]/g, '').replace(/\x1b\][0-9];[^\x07]*\x07/g, '');
log('TUI contains "pong":', /pong/i.test(plain));

try { term.kill(); } catch {}
try { ws.close(); } catch {}
server.kill('SIGTERM');
setTimeout(() => process.exit(0), 200);
