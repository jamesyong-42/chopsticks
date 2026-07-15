/**
 * Minimal path: thread/start → inject_items (no model turn) → resume → TUI resume.
 * Goal: early ready WITHOUT spending a model turn / polluting chat.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let pty;
try {
  pty = require('../../packages/node/node_modules/node-pty');
} catch {
  pty = require('node-pty');
}

const LOG = new URL('./controller-owned-thread-probe3.log', import.meta.url).pathname;
appendFileSync(LOG, `\n==== ${new Date().toISOString()} ====\n`);
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  appendFileSync(LOG, line + '\n');
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wsClient(port) {
  let nextId = 1;
  const pending = new Map();
  const notifs = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const req = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout ${method}`));
      }, 20_000);
      pending.set(id, (msg) => {
        clearTimeout(t);
        if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  };
  const noti = (method, params = {}) => ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  ws.addEventListener('message', (e) => {
    let msg;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) notifs.push(msg.method);
  });
  return {
    ws,
    req,
    noti,
    notifs,
    ready: new Promise((r, j) => {
      ws.addEventListener('open', () => r(), { once: true });
      ws.addEventListener('error', (e) => j(e.error ?? e), { once: true });
    }),
  };
}

const PORT = 8950 + Math.floor(Math.random() * 40);
const CWD = join(realpathSync(tmpdir()), `chopsticks-codex-p3-${process.pid}`);
mkdirSync(CWD, { recursive: true });

const server = spawn('codex', ['app-server', '--listen', `ws://127.0.0.1:${PORT}`], { stdio: 'ignore' });
await sleep(1800);
const ctl = wsClient(PORT);
await ctl.ready;
await ctl.req('initialize', { clientInfo: { name: 'p3', version: '0' }, capabilities: {} });
ctl.noti('initialized');

const { thread } = await ctl.req('thread/start', {
  cwd: CWD,
  sandbox: 'read-only',
  approvalPolicy: 'never',
});
const threadId = thread.id;
const rolloutPath = thread.path;
log('start', threadId);

// Try empty inject vs marker inject
const injectVariants = [
  { label: 'empty-items', params: { threadId, items: [] } },
  { label: 'text-marker', params: { threadId, items: [{ type: 'text', text: '' }] } },
  {
    label: 'user-message-shape',
    params: {
      threadId,
      items: [{ type: 'userMessage', content: [{ type: 'text', text: '' }] }],
    },
  },
];

// Fresh thread only once — first successful inject that enables resume wins.
// Re-run with sequential threads if needed.
let materializeMethod = null;

async function tryMaterialize(label, call) {
  try {
    await call();
    await ctl.req('thread/resume', { threadId });
    materializeMethod = label;
    log('MATERIALIZE OK via', label);
    return true;
  } catch (e) {
    log('try', label, '→', e.message.slice(0, 180));
    return false;
  }
}

// First: inject only
for (const v of injectVariants) {
  if (await tryMaterialize(v.label, () => ctl.req('thread/inject_items', v.params))) break;
}

if (!materializeMethod) {
  // Fallback documented: one turn
  log('inject variants failed; not starting a turn in this minimal probe');
}

// Inspect rollout file size / first lines
if (existsSync(rolloutPath)) {
  const raw = readFileSync(rolloutPath, 'utf8');
  log('rollout bytes', raw.length, 'lines', raw.split('\n').filter(Boolean).length);
  log('rollout head', raw.split('\n').slice(0, 3).map((l) => l.slice(0, 120)));
} else {
  log('rollout missing on disk', rolloutPath);
}

// lifecycle ready claim
const canReady = !!materializeMethod;
log('can emit session.started / ready without user typing?', canReady, materializeMethod);

// TUI resume
let tuiOut = '';
const tui = pty.spawn('codex', ['resume', threadId, '--remote', `ws://127.0.0.1:${PORT}`], {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  cwd: CWD,
  env: { ...process.env, TERM: 'xterm-256color' },
});
tui.onData((d) => {
  tuiOut += d;
});
await sleep(5000);
const plain = tuiOut.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ' ');
const tuiFail = /Failed to resume|no rollout/i.test(plain);
log('TUI fail?', tuiFail, 'bytes', tuiOut.length);
log('TUI peek', JSON.stringify(plain.replace(/\s+/g, ' ').trim().slice(0, 280)));

try {
  tui.kill();
} catch {}
try {
  ctl.ws.close();
} catch {}
try {
  server.kill('SIGTERM');
} catch {}

log('\nRESULT', {
  materializeMethod,
  canReady,
  tuiResumeOk: !tuiFail && tuiOut.length > 100,
});
process.exit(canReady && !tuiFail ? 0 : 2);
