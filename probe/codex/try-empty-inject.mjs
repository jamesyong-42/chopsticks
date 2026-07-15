/**
 * Interactive demo: what does thread/inject_items([{type:"text",text:""}])
 * do to a Codex TUI?
 *
 * This process only owns the app-server + bootstrap. YOU open the TUI in
 * another terminal with the printed command, poke around, then Ctrl+C here.
 *
 *   node probe/codex/try-empty-inject.mjs
 *   node probe/codex/try-empty-inject.mjs --no-inject   # control: start only
 */
import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NO_INJECT = process.argv.includes('--no-inject');
const PORT = 8970 + Math.floor(Math.random() * 20);
const CWD = process.cwd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wsClient(port) {
  let nextId = 1;
  const pending = new Map();
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
    }
  });
  return {
    ws,
    req,
    noti,
    ready: new Promise((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true });
      ws.addEventListener('error', (ev) => rej(ev.error ?? ev), { once: true });
    }),
  };
}

console.log(`
┌─────────────────────────────────────────────────────────────┐
│  Codex empty-inject TUI demo                                │
│  mode: ${NO_INJECT ? 'thread/start ONLY (--no-inject)' : 'thread/start + inject_items([{type:"text",text:""}])'}
└─────────────────────────────────────────────────────────────┘
`);

const server = spawn('codex', ['app-server', '--listen', `ws://127.0.0.1:${PORT}`], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
let died = false;
server.on('exit', (code) => {
  died = true;
  console.error(`[app-server exited code=${code}]`);
});

await sleep(1800);
if (died) {
  console.error('app-server failed to start');
  process.exit(1);
}

const ctl = wsClient(PORT);
await ctl.ready;
await ctl.req('initialize', { clientInfo: { name: 'try-empty-inject', version: '0' }, capabilities: {} });
ctl.noti('initialized');

const { thread } = await ctl.req('thread/start', {
  cwd: CWD,
  sandbox: 'read-only',
  approvalPolicy: 'never',
});
const threadId = thread.id;
const rolloutPath = thread.path;
console.log('thread/start');
console.log('  id:   ', threadId);
console.log('  path: ', rolloutPath);

if (!NO_INJECT) {
  await ctl.req('thread/inject_items', {
    threadId,
    items: [{ type: 'text', text: '' }],
  });
  console.log('inject_items([{ type: "text", text: "" }])  → ok');
  try {
    await ctl.req('thread/resume', { threadId });
    console.log('thread/resume  → ok  (materialized; TUI resume should work)');
  } catch (e) {
    console.log('thread/resume  → FAIL', e.message);
  }
} else {
  try {
    await ctl.req('thread/resume', { threadId });
    console.log('thread/resume  → ok (unexpected without inject)');
  } catch (e) {
    console.log('thread/resume  → FAIL (expected without inject):', e.message.slice(0, 120));
  }
}

if (existsSync(rolloutPath)) {
  const raw = readFileSync(rolloutPath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  console.log(`\nrollout on disk: ${lines.length} lines, ${raw.length} bytes`);
  for (const line of lines.slice(0, 8)) {
    let t = '?';
    try {
      const j = JSON.parse(line);
      t = j.type + (j.payload?.type ? `/${j.payload.type}` : '') + (j.payload?.role ? ` role=${j.payload.role}` : '');
    } catch {
      /* */
    }
    console.log('  •', t, line.slice(0, 100) + (line.length > 100 ? '…' : ''));
  }
}

const remote = `ws://127.0.0.1:${PORT}`;
const cmd = `codex resume ${threadId} --remote ${remote}`;

console.log(`
──────────────────────────────────────────────────────────────
Open THIS in another terminal (same machine), then look around:

  ${cmd}

Things to notice in the TUI:
  • Does a blank / empty user bubble appear?
  • Is the welcome ("To get started…") still shown?
  • Scrollback / transcript — any phantom message?
  • Does typing a real prompt work on THIS same session?

When done, Ctrl+C this process (kills the app-server).
──────────────────────────────────────────────────────────────
`);

const shutdown = () => {
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
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// keep alive
await new Promise(() => {});
