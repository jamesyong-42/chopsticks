#!/usr/bin/env node
// Fake terminal agent for runtime and adapter tests (DESIGN §26.1).
//
// Simulates a TUI coding agent: colored output, a prompt loop, alt-screen,
// bracketed paste, permission dialogs, child process trees, output floods,
// ignored interrupts, crashes, and Claude-shaped hook emission.
//
// Scenario commands (typed or piped as input lines):
//   /exit /crash /hang /alt /spawn /permission /badutf8 /flood [kb] /tool [cmd]
// Anything else is echoed back as a fake assistant response.
//
// Env:
//   FAKE_AGENT_HOOKS_FILE   append Claude-shaped hook JSON lines here
//   FAKE_AGENT_SESSION_ID   fixed session id (default: random UUID)
//   FAKE_AGENT_TITLE        session title reported on SessionStart

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const ESC = '\x1b';
const hooksFile = process.env.FAKE_AGENT_HOOKS_FILE;
const sessionId = process.env.FAKE_AGENT_SESSION_ID ?? randomUUID();
const out = (s) => process.stdout.write(s);

function hook(event, extra = {}) {
  if (!hooksFile) return;
  const record = {
    session_id: sessionId,
    transcript_path: `/tmp/fake-agent/${sessionId}.jsonl`,
    cwd: process.cwd(),
    hook_event_name: event,
    ...extra,
  };
  appendFileSync(hooksFile, `${JSON.stringify(record)}\n`);
}

let promptId;
let altMode = false;
let permissionMode = false;
let ignoreInterrupt = false;

process.on('SIGINT', () => {
  if (ignoreInterrupt) {
    out(`\r\n${ESC}[31m(interrupt ignored)${ESC}[0m\r\n`);
    return;
  }
  out('\r\n^C interrupted\r\n');
  prompt();
});

function prompt() {
  out(`${ESC}[36m> ${ESC}[0m`);
}

function respond(text) {
  out(`\r\n${ESC}[32m⟪fake⟫${ESC}[0m ${text}\r\n`);
  hook('Stop', { prompt_id: promptId, last_assistant_message: text, stop_hook_active: false });
  prompt();
}

function handleLine(line) {
  if (altMode) {
    altMode = false;
    out(`${ESC}[?1049l`);
    respond('left alt screen');
    return;
  }
  if (permissionMode) {
    permissionMode = false;
    respond(line.trim().toLowerCase().startsWith('y') ? 'permission allowed' : 'permission denied');
    return;
  }
  if (!line.trim()) {
    prompt();
    return;
  }

  promptId = randomUUID();
  hook('UserPromptSubmit', { prompt: line, prompt_id: promptId, permission_mode: 'default' });

  const [cmd, arg] = line.trim().split(/\s+/, 2);
  switch (cmd) {
    case '/exit':
      hook('SessionEnd', { reason: 'other', prompt_id: promptId });
      out('bye\r\n');
      process.exit(0);
      break;
    case '/crash':
      out('simulated crash\r\n');
      process.exit(1);
      break;
    case '/hang':
      ignoreInterrupt = true;
      respond('hanging: SIGINT ignored from now on');
      break;
    case '/alt':
      altMode = true;
      out(`${ESC}[?1049h${ESC}[2J${ESC}[H┌─ fake alt screen ─┐\r\n│ press enter…      │\r\n└───────────────────┘`);
      break;
    case '/spawn': {
      const child = spawn('sleep', ['300'], { stdio: 'ignore' });
      respond(`spawned sleep pid=${child.pid}`);
      break;
    }
    case '/permission': {
      permissionMode = true;
      hook('PermissionRequest', {
        prompt_id: promptId,
        tool_name: 'Bash',
        tool_input: { command: 'echo hooktest' },
        tool_use_id: `toolu_fake_${randomUUID().slice(0, 8)}`,
      });
      out(`\r\n${ESC}[33m⚠ allow Bash(echo hooktest)? [y/n]${ESC}[0m `);
      break;
    }
    case '/badutf8':
      process.stdout.write(Buffer.from([0xff, 0xfe, 0x80, 0x81]));
      respond('emitted malformed utf8');
      break;
    case '/flood': {
      const kb = Math.max(1, Number(arg ?? 64) || 64);
      const row = `${'x'.repeat(78)}\r\n`;
      for (let i = 0; i < Math.ceil((kb * 1024) / row.length); i++) out(row);
      respond(`flooded ~${kb}KB`);
      break;
    }
    case '/tool': {
      const toolUseId = `toolu_fake_${randomUUID().slice(0, 8)}`;
      const common = { prompt_id: promptId, tool_name: 'Bash', tool_input: { command: arg ?? 'true' }, tool_use_id: toolUseId };
      hook('PreToolUse', common);
      hook('PostToolUse', { ...common, tool_response: { ok: true }, duration_ms: 1 });
      respond(`tool done (${toolUseId})`);
      break;
    }
    default:
      respond(`echo: ${line}`);
  }
}

// Line assembly with bracketed-paste passthrough: paste markers are stripped
// and pasted content joins the input buffer, like a real terminal editor.
let buf = '';
let inPaste = false;
process.stdin.on('data', (chunk) => {
  let s = chunk.toString('utf8');
  for (;;) {
    if (inPaste) {
      const end = s.indexOf(`${ESC}[201~`);
      if (end === -1) {
        buf += s;
        return;
      }
      buf += s.slice(0, end);
      s = s.slice(end + 6);
      inPaste = false;
      continue;
    }
    const start = s.indexOf(`${ESC}[200~`);
    const head = start === -1 ? s : s.slice(0, start);
    for (const ch of head) {
      if (ch === '\r' || ch === '\n') {
        const line = buf;
        buf = '';
        handleLine(line);
      } else {
        buf += ch;
      }
    }
    if (start === -1) return;
    s = s.slice(start + 6);
    inPaste = true;
  }
});

process.stdin.on('end', () => {
  hook('SessionEnd', { reason: 'other' });
  process.exit(0);
});

hook('SessionStart', { source: 'startup', session_title: process.env.FAKE_AGENT_TITLE ?? 'fake-agent' });
out(`${ESC}[1;35m⟪fake-agent⟫${ESC}[0m ready (pid ${process.pid}, session ${sessionId})\r\n`);
prompt();
