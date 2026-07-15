/**
 * Follow-up: can we materialize a controller-started thread so TUI resume works?
 *
 * Probe 1 showed thread/start gives id+path+loaded, but thread/resume fails with
 * "no rollout found" until first user message — and `codex resume <id> --remote`
 * dies with the same error.
 *
 * This probe tries bootstrap materialization strategies, then TUI resume:
 *  1. turn/start with a tiny text (protocol-side first message)
 *  2. thread/inject_items (if available) as a quieter alternative
 *  3. After materialize: resume succeeds? TUI resume works? single thread?
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, mkdirSync } from 'node:fs';
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

const LOG = new URL('./controller-owned-thread-probe2.log', import.meta.url).pathname;
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
        reject(new Error(`timeout: ${method}`));
      }, 60_000);
      pending.set(id, (msg) => {
        clearTimeout(t);
        if (msg.error) reject(Object.assign(new Error(`${method}: ${JSON.stringify(msg.error)}`), { rpc: msg.error }));
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
      return;
    }
    if (msg.method) notifs.push({ method: msg.method, params: msg.params, t: Date.now() });
  });
  return {
    ws,
    req,
    noti,
    notifs,
    ready: new Promise((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true });
      ws.addEventListener('error', (e) => rej(e.error ?? e), { once: true });
    }),
  };
}

function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b[()][AB0]/g, '')
    .replace(/\x1b\][0-9];[^\x07]*\x07/g, '');
}

const PORT = 8901 + Math.floor(Math.random() * 50);
const CWD = join(realpathSync(tmpdir()), `chopsticks-codex-probe2-${process.pid}`);
mkdirSync(CWD, { recursive: true });
log('PORT', PORT, 'CWD', CWD);

const server = spawn('codex', ['app-server', '--listen', `ws://127.0.0.1:${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
await sleep(1800);

const ctl = wsClient(PORT);
await ctl.ready;
await ctl.req('initialize', { clientInfo: { name: 'probe2', version: '0' }, capabilities: {} });
ctl.noti('initialized');

const startRes = await ctl.req('thread/start', {
  cwd: CWD,
  sandbox: 'read-only',
  approvalPolicy: 'never',
});
const threadId = startRes.thread.id;
const path = startRes.thread.path;
log('thread/start', { threadId, path });

// --- try inject_items first (quiet materialize?) ---
let injectOk = false;
try {
  const r = await ctl.req('thread/inject_items', {
    threadId,
    items: [{ type: 'text', text: '[chopsticks bootstrap]' }],
  });
  injectOk = true;
  log('inject_items ok', JSON.stringify(r).slice(0, 200));
} catch (e) {
  log('inject_items fail', e.message.slice(0, 300));
}

// check resume after inject
try {
  await ctl.req('thread/resume', { threadId });
  log('resume after inject: OK');
} catch (e) {
  log('resume after inject: FAIL', e.message.slice(0, 200));
}

// --- turn/start bootstrap if still not materializable ---
let turnOk = false;
try {
  const turnRes = await ctl.req('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'Reply with exactly: ready' }],
    clientUserMessageId: 'chopsticks-bootstrap-1',
  });
  turnOk = true;
  log('turn/start ok', JSON.stringify(turnRes).slice(0, 250));
} catch (e) {
  log('turn/start fail', e.message.slice(0, 300));
}

// wait for turn completed notification
const t0 = Date.now();
while (Date.now() - t0 < 45_000) {
  if (ctl.notifs.some((n) => n.method === 'turn/completed')) break;
  await sleep(200);
}
const completed = ctl.notifs.filter((n) => n.method === 'turn/completed');
const agentDeltas = ctl.notifs.filter((n) => n.method === 'item/agentMessage/delta');
log(
  'turn/completed count',
  completed.length,
  'deltas',
  agentDeltas.length,
  'methods sample',
  [...new Set(ctl.notifs.map((n) => n.method))].join(','),
);

// resume after first turn
let resumeAfterTurn = false;
try {
  await ctl.req('thread/resume', { threadId });
  resumeAfterTurn = true;
  log('resume after turn: OK');
} catch (e) {
  log('resume after turn: FAIL', e.message.slice(0, 200));
}

let readAfterTurn = false;
try {
  const read = await ctl.req('thread/read', { threadId, includeTurns: true });
  readAfterTurn = true;
  log('read turns', read?.thread?.turns?.length ?? '?', 'preview', String(read?.thread?.preview ?? '').slice(0, 80));
} catch (e) {
  log('read after turn: FAIL', e.message.slice(0, 200));
}

// thread/list visibility (source filters)
try {
  const def = await ctl.req('thread/list', {});
  const all = await ctl.req('thread/list', { sourceKinds: null }).catch(() => null);
  const ids = (def?.data ?? []).map((t) => t.id);
  log('thread/list default includes ours?', ids.includes(threadId), 'count', ids.length);
  if (all) log('thread/list alt', JSON.stringify(all).slice(0, 200));
} catch (e) {
  log('thread/list err', e.message);
}

// --- TUI resume after materialization ---
let tuiOut = '';
const tui = pty.spawn('codex', ['resume', threadId, '--remote', `ws://127.0.0.1:${PORT}`], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd: CWD,
  env: { ...process.env, TERM: 'xterm-256color' },
});
tui.onData((d) => {
  tuiOut += d;
});
await sleep(6000);
const plain = stripAnsi(tuiOut).replace(/\s+/g, ' ').trim();
log('TUI bytes', tuiOut.length);
log('TUI has error?', /Failed to resume|no rollout|Error:/i.test(plain));
log('TUI shows ready/pong/bootstrap?', /ready|pong|bootstrap|chopsticks/i.test(plain));
log('TUI peek', JSON.stringify(plain.slice(0, 400)));

// second prompt from TUI — should stay on same thread
const beforeList = new Set(((await ctl.req('thread/list', {}))?.data ?? []).map((t) => t.id));
tui.write('\x1b[200~Reply with exactly: pong2\x1b[201~\r');
await sleep(12_000);
const afterList = (await ctl.req('thread/list', {}))?.data ?? [];
const newIds = afterList.map((t) => t.id).filter((id) => !beforeList.has(id) || id === threadId);
log(
  'threads after TUI prompt (relevant)',
  afterList
    .filter((t) => t.id === threadId || !beforeList.has(t.id))
    .map((t) => ({ id: t.id, preview: String(t.preview ?? '').slice(0, 60) })),
);

const loaded = (await ctl.req('thread/loaded/list', {}))?.data ?? [];
log('loaded/list', loaded);

// verdicts
const tuiOk = tuiOut.length > 200 && !/Failed to resume|no rollout found/i.test(plain);
log('\n=== VERDICTS ===');
log('inject_items materializes?', injectOk, '(see resume-after-inject above)');
log('turn/start works on controller thread?', turnOk);
log('resume works after first turn?', resumeAfterTurn);
log('read works after first turn?', readAfterTurn);
log('TUI resume works after materialize?', tuiOk);
log('controller connection got turn stream without re-subscribe?', completed.length > 0 || agentDeltas.length > 0);

try {
  tui.kill();
} catch {}
try {
  ctl.ws.close();
} catch {}
try {
  server.kill('SIGTERM');
} catch {}
await sleep(300);
process.exit(tuiOk && resumeAfterTurn ? 0 : 2);
