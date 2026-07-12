#!/usr/bin/env node
// Interactive hook census: drive a real Claude Code TUI via node-pty to capture
// hook events that never fire in headless `-p` mode — PermissionRequest,
// PostToolUseFailure, Notification, SubagentStart/Stop, TaskCreated/Completed.
// See draft/HOOK-SURFACE-FINDINGS.md §5 (open items) and probe/interactive-settings.json.
//
// Each session is a real Claude Code run (authorized; prompts are kept tiny).
// Every wait is bounded; on timeout we log the screen tail and continue to
// cleanup. We never leave a claude process running.
//
// Run from repo root: node packages/node/scripts/interactive-census.mjs
// Env knobs: CENSUS_SUBAGENT=0 to skip the optional second (subagent) run.

import { spawn } from 'node-pty';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..', '..'); // packages/node/scripts -> repo root
const probeDir = join(repoRoot, 'probe');
const settingsPath = join(probeDir, 'interactive-settings.json');
const capturesDir = join(probeDir, 'captures-interactive');
mkdirSync(capturesDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(`[${ts()}]`, ...a);

function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}
function tail(s, n = 2000) {
  return stripAnsi(s).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').slice(-n);
}

function findClaude() {
  const candidates = [
    process.env.CLAUDE_BIN,
    join(process.env.HOME || '', '.local/bin/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    return execSync('command -v claude', { encoding: 'utf8' }).trim();
  } catch {
    return 'claude';
  }
}

function lineCount(event) {
  const p = join(capturesDir, `${event}.jsonl`);
  if (!existsSync(p)) return 0;
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim().length > 0).length;
}
function lastLine(event) {
  const p = join(capturesDir, `${event}.jsonl`);
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  return lines.length ? lines[lines.length - 1] : null;
}

// Build a clean environment: PATH/HOME/TERM plus a few locale basics, and
// deliberately NOT the parent agent's CLAUDE*/ANTHROPIC* vars so the nested
// TUI starts as a fresh interactive session.
function childEnv() {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TERM: process.env.TERM || 'xterm-256color',
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL || process.env.LANG || 'en_US.UTF-8',
    USER: process.env.USER,
    SHELL: process.env.SHELL || '/bin/zsh',
    COLORTERM: 'truecolor',
  };
}

const claudeBin = findClaude();
log('claude binary:', claudeBin);
log('settings:', settingsPath);
log('captures dir:', capturesDir);

// ---- one driven session -----------------------------------------------------

async function runSession({ label, interact }) {
  const sessionId = randomUUID();
  log(`\n===== SESSION [${label}] session-id=${sessionId} =====`);

  let screen = '';
  let lastActivity = Date.now();
  let exited = false;
  let exitInfo = null;

  const pty = spawn(claudeBin, ['--settings', settingsPath, '--session-id', sessionId, '-n', 'interactive-census'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: probeDir,
    env: childEnv(),
  });
  const pid = pty.pid;
  log(`spawned pid=${pid}`);

  pty.onData((d) => {
    screen += d;
    lastActivity = Date.now();
  });
  pty.onExit((e) => {
    exited = true;
    exitInfo = e;
    log(`pty exit: code=${e?.exitCode} signal=${e?.signal}`);
  });

  const st = () => stripAnsi(screen);
  const idleMs = () => Date.now() - lastActivity;

  async function waitFor(pred, timeoutMs, name) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (pred()) {
        log(`  waitFor(${name}) ok in ${Date.now() - start}ms`);
        return true;
      }
      if (exited) {
        log(`  waitFor(${name}) process exited before satisfied`);
        return pred();
      }
      await sleep(200);
    }
    log(`  waitFor(${name}) TIMEOUT ${timeoutMs}ms. screen tail:\n----\n${tail(screen)}\n----`);
    return false;
  }

  const ctx = { sessionId, pty, st, idleMs, waitFor, isExited: () => exited, screen: () => screen };

  try {
    // Wait for the TUI to be ready (accept a first-run trust dialog if shown).
    let trustHandled = false;
    const ready = await waitFor(() => {
      const s = st();
      if (!trustHandled && /(do you trust|trust the files|trust this folder|enter to confirm)/i.test(s)) {
        log('  trust dialog detected -> Enter');
        pty.write('\r');
        trustHandled = true;
        return false;
      }
      const hasPrompt = /(\? for shortcuts|for shortcuts|Welcome to Claude|╭─{2,}|│\s*>|>\s*$)/m.test(s);
      if (hasPrompt && idleMs() > 700) return true;
      if (s.length > 400 && idleMs() > 2500) return true; // stabilized fallback
      return false;
    }, 20000, 'tui-ready');
    log(`  TUI ready=${ready}. screen tail:\n----\n${tail(screen, 1200)}\n----`);

    await interact(ctx);
  } catch (err) {
    log(`  interact() threw: ${err?.stack || err}`);
  } finally {
    await shutdown({ pty, pid, isExited: () => exited, write: (s) => pty.write(s), sessionId });
  }
}

async function shutdown({ pty, pid, isExited, write, sessionId }) {
  log(`  shutdown: attempting /exit (pid=${pid})`);
  try {
    write('/exit\r');
  } catch {}
  let ok = await until(() => isExited(), 10000);
  if (!ok) {
    log('  not exited after /exit -> sending Ctrl-C x2');
    try {
      write('\x03');
      await sleep(300);
      write('\x03');
    } catch {}
    ok = await until(() => isExited(), 10000);
  }
  if (!ok) {
    log('  still alive -> pty.kill() + group SIGKILL');
    try {
      pty.kill();
    } catch {}
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
    await sleep(500);
  }
  // Backstop: kill any lingering claude process for THIS session id only.
  try {
    const out = execSync(
      `ps -Ao pid=,command= | grep -- '${sessionId}' | grep -v grep || true`,
      { encoding: 'utf8' },
    ).trim();
    if (out) {
      log(`  lingering process(es) for session:\n${out}`);
      for (const line of out.split('\n')) {
        const p = parseInt(line.trim().split(/\s+/)[0], 10);
        if (p && p !== process.pid) {
          try {
            process.kill(p, 'SIGKILL');
            log(`  killed stray pid=${p}`);
          } catch {}
        }
      }
    } else {
      log('  no lingering process for this session ✓');
    }
  } catch (e) {
    log(`  backstop ps check failed: ${e?.message}`);
  }
  // Confirm the tracked pid is gone.
  let gone = false;
  try {
    process.kill(pid, 0);
  } catch {
    gone = true;
  }
  log(`  final: pid=${pid} gone=${gone}`);
}

function until(pred, timeoutMs) {
  return new Promise(async (r) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (pred()) return r(true);
      await sleep(200);
    }
    r(false);
  });
}

// ---- scenarios --------------------------------------------------------------

// Scenario 1 (priority): force a permission dialog and DENY it.
async function permissionScenario(ctx) {
  const { pty, st, waitFor, idleMs } = ctx;
  const before = {
    PermissionRequest: lineCount('PermissionRequest'),
    Notification: lineCount('Notification'),
    PreToolUse: lineCount('PreToolUse'),
    PostToolUse: lineCount('PostToolUse'),
    PostToolUseFailure: lineCount('PostToolUseFailure'),
    Stop: lineCount('Stop'),
  };
  log('  counts before prompt:', JSON.stringify(before));

  const prompt = 'Use the Bash tool to run exactly this command: mkdir -p /tmp/chopsticks-perm-probe';
  log('  typing permission-forcing prompt');
  pty.write(prompt);
  await sleep(600);
  pty.write('\r');

  // The PermissionRequest hook fires when the dialog is displayed; poll both the
  // capture file and the on-screen dialog text.
  const gotDialog = await waitFor(
    () =>
      lineCount('PermissionRequest') > before.PermissionRequest ||
      /(Do you want to proceed|Allow this|permission|❯\s*1\.|1\.\s*Yes|No, and tell Claude)/i.test(st()),
    60000,
    'permission-dialog',
  );
  log(`  permission dialog observed=${gotDialog}. PermissionRequest lines now=${lineCount('PermissionRequest')}`);
  log('  dialog screen tail:\n----\n' + tail(ctx.screen(), 1600) + '\n----');

  // DENY: Escape rejects the pending tool call in the Claude Code TUI.
  log('  denying via Escape');
  pty.write('\x1b');
  await sleep(2500);
  // If a dialog is still up, try navigating to a "No" option and confirm.
  if (/(Do you want to proceed|❯\s*1\.|1\.\s*Yes)/i.test(st())) {
    log('  dialog still present -> arrow-down x2 + Enter (select a No/deny option)');
    pty.write('\x1b[B');
    await sleep(200);
    pty.write('\x1b[B');
    await sleep(200);
    pty.write('\r');
    await sleep(2000);
  }

  const afterDeny = {
    PostToolUse: lineCount('PostToolUse'),
    PostToolUseFailure: lineCount('PostToolUseFailure'),
    Notification: lineCount('Notification'),
  };
  log('  counts after deny:', JSON.stringify(afterDeny));
  log('  post-deny screen tail:\n----\n' + tail(ctx.screen(), 1200) + '\n----');

  // Trivial follow-up to produce a clean Stop.
  const stopBefore = lineCount('Stop');
  log('  sending trivial follow-up "reply ok"');
  // Make sure any leftover dialog is dismissed first.
  await sleep(500);
  pty.write('reply ok');
  await sleep(500);
  pty.write('\r');
  const gotStop = await waitFor(() => lineCount('Stop') > stopBefore, 60000, 'stop-after-followup');
  log(`  Stop after follow-up observed=${gotStop} (Stop lines=${lineCount('Stop')})`);
}

// A live "is a permission dialog showing right now" check that inspects only
// the RECENT tail of the terminal (not the whole accumulated buffer, which
// keeps stale dialog text around forever).
function dialogShowing(ctx) {
  const recent = ctx.st().slice(-1400);
  return /(Do you want to proceed|Allow this|❯\s*1\.\s*Yes|1\.\s*Yes)/i.test(recent);
}

// Scenario 2a: run an approved-but-failing tool to try to elicit
// PostToolUseFailure (vs. a normal PostToolUse carrying an error result).
async function failureScenario(ctx) {
  const { pty, waitFor } = ctx;
  const before = {
    PreToolUse: lineCount('PreToolUse'),
    PostToolUse: lineCount('PostToolUse'),
    PostToolUseFailure: lineCount('PostToolUseFailure'),
    Stop: lineCount('Stop'),
  };
  log('  [failure] counts before:', JSON.stringify(before));

  const prompt =
    'Use the Bash tool to run exactly this command: cat /no/such/chopsticks/file-xyz . I expect it to error; run it once anyway and then stop.';
  log('  [failure] typing prompt');
  pty.write(prompt);
  await sleep(600);
  pty.write('\r');

  // Approve the permission so the command actually executes and fails.
  const deadline = Date.now() + 90000;
  let approvals = 0;
  while (Date.now() < deadline) {
    if (ctx.isExited()) break;
    if (lineCount('Stop') > before.Stop && (lineCount('PostToolUse') > before.PostToolUse || lineCount('PostToolUseFailure') > before.PostToolUseFailure)) break;
    if (dialogShowing(ctx) && approvals < 3) {
      log('  [failure] permission dialog -> approving (Enter)');
      pty.write('\r');
      approvals += 1;
      await sleep(1800);
      continue;
    }
    await sleep(500);
  }
  log(
    `  [failure] results: PreToolUse Δ=${lineCount('PreToolUse') - before.PreToolUse} ` +
      `PostToolUse Δ=${lineCount('PostToolUse') - before.PostToolUse} ` +
      `PostToolUseFailure Δ=${lineCount('PostToolUseFailure') - before.PostToolUseFailure}`,
  );
  log('  [failure] screen tail:\n----\n' + tail(ctx.screen(), 1200) + '\n----');
  await waitFor(() => lineCount('Stop') > before.Stop, 20000, 'stop-after-failure');
}

// Scenario 2b: spawn a subagent via the Task tool to capture
// SubagentStart/SubagentStop and possibly TaskCreated/TaskCompleted.
async function subagentScenario(ctx) {
  const { pty, waitFor } = ctx;
  const before = {
    SubagentStart: lineCount('SubagentStart'),
    SubagentStop: lineCount('SubagentStop'),
    TaskCreated: lineCount('TaskCreated'),
    TaskCompleted: lineCount('TaskCompleted'),
    Stop: lineCount('Stop'),
  };
  log('  [subagent] counts before:', JSON.stringify(before));

  const prompt =
    'Use the Task tool to launch exactly one subagent (general-purpose) whose entire job is to reply with the number 4. Keep it minimal, one sentence.';
  log('  [subagent] typing prompt');
  pty.write(prompt);
  await sleep(600);
  pty.write('\r');

  // Approve any permission dialog (default option is Yes -> Enter) so the
  // subagent actually runs. Watch the recent tail, not the whole buffer.
  const deadline = Date.now() + 120000;
  let approvals = 0;
  let sawSubagent = false;
  while (Date.now() < deadline) {
    if (ctx.isExited()) break;
    if (lineCount('SubagentStart') > before.SubagentStart) sawSubagent = true;
    if (lineCount('SubagentStop') > before.SubagentStop && lineCount('Stop') > before.Stop) break;
    if (dialogShowing(ctx) && approvals < 5) {
      log('  [subagent] permission dialog -> approving (Enter)');
      pty.write('\r');
      approvals += 1;
      await sleep(1800);
      continue;
    }
    await sleep(500);
  }
  log(
    `  [subagent] results: SubagentStart=${lineCount('SubagentStart')} SubagentStop=${lineCount('SubagentStop')} ` +
      `TaskCreated=${lineCount('TaskCreated')} TaskCompleted=${lineCount('TaskCompleted')} sawStart=${sawSubagent}`,
  );
  log('  [subagent] screen tail:\n----\n' + tail(ctx.screen(), 1400) + '\n----');
  await waitFor(() => lineCount('Stop') > before.Stop, 20000, 'stop-after-subagent');
}

// Run 2 combines the failure probe and the subagent probe in one session.
async function run2Scenario(ctx) {
  await failureScenario(ctx);
  await sleep(1500);
  await subagentScenario(ctx);
}

// ---- main -------------------------------------------------------------------

function summary() {
  const events = [
    'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
    'PermissionRequest', 'PostToolUseFailure', 'Notification', 'SubagentStart',
    'SubagentStop', 'TaskCreated', 'TaskCompleted', 'Stop', 'StopFailure',
    'InstructionsLoaded', 'Elicitation', 'ElicitationResult', 'TeammateIdle',
  ];
  log('\n===== CAPTURE SUMMARY (line counts) =====');
  for (const e of events) {
    const n = lineCount(e);
    if (n > 0) log(`  ${e}: ${n}`);
  }
  const pr = lastLine('PermissionRequest');
  if (pr) {
    log('\n  last PermissionRequest payload:');
    try {
      log('  ' + JSON.stringify(JSON.parse(pr), null, 2).replace(/\n/g, '\n  '));
    } catch {
      log('  ' + pr);
    }
  }
}

async function main() {
  const mode = process.env.CENSUS_MODE || 'run1';
  log(`CENSUS_MODE=${mode}`);

  if (mode === 'run1' || mode === 'all') {
    await runSession({ label: 'permission-deny', interact: permissionScenario });
  }
  if (mode === 'run2' || mode === 'all') {
    if (mode === 'all') {
      log('\n(waiting 3s before run 2)');
      await sleep(3000);
    }
    await runSession({ label: 'failure+subagent', interact: run2Scenario });
  }

  summary();

  // Final safety sweep: no claude process should reference our settings file.
  try {
    const stray = execSync(
      `ps -Ao pid=,command= | grep -- 'interactive-settings.json' | grep -v grep || true`,
      { encoding: 'utf8' },
    ).trim();
    if (stray) {
      log('\nWARNING stray claude processes referencing interactive-settings.json:\n' + stray);
      for (const line of stray.split('\n')) {
        const p = parseInt(line.trim().split(/\s+/)[0], 10);
        if (p && p !== process.pid) {
          try {
            process.kill(p, 'SIGKILL');
            log(`  killed stray pid=${p}`);
          } catch {}
        }
      }
    } else {
      log('\nFinal sweep: no stray claude processes referencing our settings ✓');
    }
  } catch (e) {
    log('final sweep failed: ' + e?.message);
  }
  log('done.');
}

main().then(
  () => process.exit(0),
  (e) => {
    log('FATAL', e?.stack || e);
    process.exit(1);
  },
);
