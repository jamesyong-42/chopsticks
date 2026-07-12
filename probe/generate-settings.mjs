#!/usr/bin/env node
// Phase 0 probe: generate settings files that capture every candidate hook
// event's raw stdin JSON into per-event files under probe/captures/.
// See draft/IMPLEMENTATION-PLAN.md §5.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const probeDir = dirname(fileURLToPath(import.meta.url));
const capturesDir = join(probeDir, 'captures');
mkdirSync(capturesDir, { recursive: true });

// Verified names: spaghetti packages/sdk/src/types/hook-events.ts (HookEventName)
const VERIFIED_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'Stop',
  'StopFailure',
  'TeammateIdle',
  'InstructionsLoaded',
  'ConfigChange',
  'CwdChanged',
  'FileChanged',
  'PreCompact',
  'PostCompact',
  'WorktreeCreate',
  'WorktreeRemove',
  'Elicitation',
  'ElicitationResult',
];

// Unverified names from DESIGN.md §16 — probed separately so a rejected
// unknown name cannot poison the main census.
const CANDIDATE_EVENTS = ['MessageDisplay', 'PermissionResolved', 'TurnStart', 'BogusEventProbe'];

function commandHook(event) {
  const file = join(capturesDir, `${event}.jsonl`);
  return {
    hooks: [{ type: 'command', command: `sh -c 'cat >> "${file}"; echo >> "${file}"'` }],
  };
}

function settingsFor(events) {
  return { hooks: Object.fromEntries(events.map((e) => [e, [commandHook(e)]])) };
}

writeFileSync(join(probeDir, 'census-settings.json'), JSON.stringify(settingsFor(VERIFIED_EVENTS), null, 2));
writeFileSync(join(probeDir, 'probe2-settings.json'), JSON.stringify(settingsFor(CANDIDATE_EVENTS), null, 2));

// HTTP transport probe (DESIGN §16.4): does the settings schema accept type:"http"?
const httpProbe = {
  hooks: {
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: 'http',
            url: 'http://127.0.0.1:59999/hooks',
            headers: { Authorization: 'Bearer $CHOPSTICKS_HOOK_TOKEN' },
            allowedEnvVars: ['CHOPSTICKS_HOOK_TOKEN'],
            timeout: 2,
          },
        ],
      },
    ],
  },
};
writeFileSync(join(probeDir, 'http-probe-settings.json'), JSON.stringify(httpProbe, null, 2));

console.log('wrote census-settings.json (%d events), probe2-settings.json (%d), http-probe-settings.json', VERIFIED_EVENTS.length, CANDIDATE_EVENTS.length);
