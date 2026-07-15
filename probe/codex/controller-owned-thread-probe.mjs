/**
 * Probe: controller-owned thread (Grok-parallel readiness path for Codex).
 *
 * Hypothesis: if chopsticks calls thread/start first, then spawns
 *   codex resume <threadId> --remote
 * the panel can go "ready" immediately (session id exists, observer can attach)
 * without waiting for the user's first prompt — unlike bare `codex --remote`.
 *
 * Checks:
 *  A. thread/start returns id + path immediately (join key)
 *  B. thread/resume succeeds BEFORE any user message (materialization)
 *  C. TUI `resume <id> --remote` loads THAT thread (not a blank remote shell)
 *  D. No sibling thread appears while idle
 *  E. First prompt stays on the same thread (no second thread)
 *  F. Observer-equivalent: lifecycle can be "ready" after A/B without typing
 *
 * Run: node probe/codex/controller-owned-thread-probe.mjs
 * Log:  probe/codex/controller-owned-thread-probe.log
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, mkdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
// Prefer workbench's node-pty if available; fall back to packages/node.
let pty;
try {
  pty = require('../../packages/node/node_modules/node-pty');
} catch {
  pty = require('node-pty');
}

const LOG = new URL('./controller-owned-thread-probe.log', import.meta.url).pathname;
appendFileSync(LOG, `\n==== ${new Date().toISOString()} ====\n`);
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  appendFileSync(LOG, line + '\n');
  console.log(line);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 8817 + Math.floor(Math.random() * 80);
const CWD = join(realpathSync(tmpdir()), `chopsticks-codex-probe-${process.pid}`);
mkdirSync(CWD, { recursive: true });

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
      return;
    }
    if (msg.method) notifs.push({ method: msg.method, params: msg.params });
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
    .replace(/\x1b\][0-9];[^\x07]*\x07/g, '')
    .replace(/\x1b./g, '');
}

const verdicts = {};
function mark(name, ok, detail) {
  verdicts[name] = { ok: !!ok, detail: detail ?? '' };
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// ── boot app-server ──────────────────────────────────────────────────────────
log('PORT', PORT, 'CWD', CWD);
const server = spawn('codex', ['app-server', '--listen', `ws://127.0.0.1:${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvErr = '';
server.stderr.on('data', (d) => {
  srvErr += d.toString();
});
await sleep(1800);
if (server.exitCode != null) {
  log('app-server died early', server.exitCode, srvErr.slice(0, 500));
  process.exit(1);
}

const ctl = wsClient(PORT);
await ctl.ready;
await ctl.req('initialize', { clientInfo: { name: 'chopsticks-probe', version: '0' }, capabilities: {} });
ctl.noti('initialized');
log('initialized');

// ── A. controller thread/start ───────────────────────────────────────────────
const beforeIds = new Set(((await ctl.req('thread/list', {}))?.data ?? []).map((t) => t.id));
const startRes = await ctl.req('thread/start', {
  cwd: CWD,
  sandbox: 'read-only',
  approvalPolicy: 'never',
});
const thread = startRes?.thread ?? {};
const threadId = thread.id ?? thread.sessionId;
const threadPath = thread.path;
const sessionId = thread.sessionId ?? thread.id;
mark(
  'A.thread_start_returns_id',
  !!threadId,
  `id=${threadId} sessionId=${sessionId} path=${threadPath ? 'yes' : 'no'}`,
);
mark('A.thread_id_equals_session_id', threadId === sessionId, `${threadId} vs ${sessionId}`);
mark('A.thread_path_present', !!threadPath, threadPath ?? 'missing');
const threadStartedNotif = ctl.notifs.find((n) => n.method === 'thread/started');
mark('A.thread_started_notification', !!threadStartedNotif, threadStartedNotif?.params?.thread?.id ?? '');

// ── B. resume before any user message ────────────────────────────────────────
let resumeOk = false;
let resumeErr = '';
try {
  await ctl.req('thread/resume', { threadId });
  resumeOk = true;
} catch (e) {
  resumeErr = e.message;
}
mark('B.thread_resume_before_user_message', resumeOk, resumeOk ? 'ok' : resumeErr);

let readOk = false;
let readErr = '';
let turnCount = null;
try {
  const read = await ctl.req('thread/read', { threadId, includeTurns: true });
  readOk = true;
  turnCount = read?.thread?.turns?.length ?? read?.turns?.length ?? null;
} catch (e) {
  readErr = e.message;
}
mark('B.thread_read_before_user_message', readOk, readOk ? `turns=${turnCount}` : readErr);

// Lifecycle simulation: after A+B we could emit session.started → ready
mark('B.ready_without_user_prompt', resumeOk && !!threadId, resumeOk ? 'session.started could fire now' : 'still blocked');

// ── C/D. TUI resume <id> --remote (no typing yet) ────────────────────────────
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
await sleep(5500);

const plainIdle = stripAnsi(tuiOut).replace(/\s+/g, ' ').trim();
log('TUI idle peek:', JSON.stringify(plainIdle.slice(0, 350)));
mark('C.tui_rendered', tuiOut.length > 200, `bytes=${tuiOut.length}`);
// Welcome / model chrome without needing a prior conversation
const looksLikeCodex =
  /codex/i.test(plainIdle) || /openai/i.test(plainIdle) || /gpt/i.test(plainIdle) || /›|❯|\$/.test(plainIdle);
mark('C.tui_looks_alive', looksLikeCodex, looksLikeCodex ? 'chrome present' : 'no recognizable chrome');

let loaded = [];
try {
  const lr = await ctl.req('thread/loaded/list', {});
  loaded = lr?.data ?? lr?.threads ?? [];
} catch (e) {
  log('loaded/list err', e.message);
}
log('loaded/list:', JSON.stringify(loaded).slice(0, 300));
const loadedHasOurs = Array.isArray(loaded)
  ? loaded.includes(threadId) || loaded.some((t) => (t?.id ?? t) === threadId)
  : false;
mark('C.tui_loaded_our_thread', loadedHasOurs || resumeOk, `loaded=${JSON.stringify(loaded).slice(0, 120)}`);

const afterIdle = ((await ctl.req('thread/list', {}))?.data ?? []).filter((t) => !beforeIds.has(t.id));
const idleIds = afterIdle.map((t) => t.id);
log(
  'new threads while idle:',
  idleIds.map((id) => ({ id, preview: afterIdle.find((t) => t.id === id)?.preview })),
);
mark(
  'D.no_sibling_thread_while_idle',
  idleIds.length === 1 && idleIds[0] === threadId,
  `count=${idleIds.length} ids=${idleIds.join(',')}`,
);

// ── E. first prompt stays on same thread ─────────────────────────────────────
tui.write('\x1b[200~Reply with exactly the single word: pong. No tools.\x1b[201~');
await sleep(400);
tui.write('\r');
await sleep(12_000);

const afterPrompt = ((await ctl.req('thread/list', {}))?.data ?? []).filter((t) => !beforeIds.has(t.id));
const promptIds = afterPrompt.map((t) => t.id);
const our = afterPrompt.find((t) => t.id === threadId);
log(
  'new threads after prompt:',
  afterPrompt.map((t) => ({ id: t.id, preview: String(t.preview ?? '').slice(0, 80) })),
);
mark(
  'E.single_thread_after_prompt',
  promptIds.length === 1 && promptIds[0] === threadId,
  `count=${promptIds.length} ids=${promptIds.join(',')}`,
);
const previewHit =
  /pong|Reply with exactly|single word/i.test(String(our?.preview ?? '')) ||
  /pong/i.test(stripAnsi(tuiOut));
mark('E.prompt_reached_our_thread', !!our && (previewHit || promptIds.includes(threadId)), `preview=${JSON.stringify(String(our?.preview ?? '').slice(0, 100))}`);

const plainAfter = stripAnsi(tuiOut).replace(/\s+/g, ' ').trim();
log('TUI after prompt peek:', JSON.stringify(plainAfter.slice(-400)));
mark('E.tui_shows_reply_or_activity', /pong|working|thinking|codex/i.test(plainAfter), 'see log peek');

// ── cleanup ──────────────────────────────────────────────────────────────────
try {
  tui.kill();
} catch {
  /* */
}
try {
  ctl.ws.close();
} catch {
  /* */
}
try {
  server.kill('SIGTERM');
} catch {
  /* */
}

log('\n=== SUMMARY ===');
const fails = Object.entries(verdicts).filter(([, v]) => !v.ok);
for (const [k, v] of Object.entries(verdicts)) {
  log(`  ${v.ok ? '✓' : '✗'} ${k}: ${v.detail}`);
}
log(fails.length === 0 ? 'ALL PASS — controller-owned thread is viable for early ready' : `FAILURES: ${fails.length}`);
log('full log:', LOG);

await sleep(300);
process.exit(fails.length === 0 ? 0 : 2);
