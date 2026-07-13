/**
 * Claude session driver — the composition layer (DESIGN §11, §16).
 *
 * Runs HUB-SIDE (Electron main / future daemon), never in the pty-host: the
 * host stays Claude-agnostic. The driver owns observation and control only;
 * PROCESS lifecycle (spawn/terminate) belongs to the host behind the injected
 * ports:
 *
 *   prepare (settings + UUID join contract)
 *     → ports.spawn (avocado requestSpawn carries the hook token in env)
 *     → hook bridge (loopback HTTP; the ONLY session it accepts is ours)
 *     → normalizer → envelope stamping → session reducer state
 *     → transcript observer (lazy: created at the first hook envelope, whose
 *       payload hands us transcript_path; every envelope pokes poll())
 *     → prompt injector (writes through ports.write; confirmation and
 *       permission gating wired from the normalized event stream)
 *
 * Observation level (DESIGN §19.2) is reported honestly: 'terminal-only'
 * until the first hook arrives, 'native-hooks' after.
 */

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  createEnvelopeStamper,
  createInitialSessionState,
  reduceSessionState,
  type AgentEvent,
  type AgentEventEnvelope,
  type AgentSession,
  type ObservationLevel,
} from '@vibecook/chopsticks-core';
import { createHookBridge, type HookBridge } from './hook-bridge.js';
import { ClaudeHookNormalizer, type ClaudeHookPayload } from './normalizer.js';
import { prepareClaudeSession, cleanupClaudeSession, type PreparedClaudeSession } from './prepare.js';
import { createPromptInjector, type PromptInjector } from './prompt.js';
import { assistantMessageEvent, createTranscriptObserver, type TranscriptObserver } from './transcript-observer.js';

const TOKEN_ENV_VAR = 'CHOPSTICKS_HOOK_TOKEN';

export interface ClaudeSessionPorts {
  /** Spawn the prepared command; resolves with the host's session id for writes. */
  spawn(prepared: PreparedClaudeSession): Promise<{ runtimeSessionId: string }>;
  /** Raw terminal input for the session (the injector's write path). */
  write(runtimeSessionId: string, data: string): void;
}

export interface CreateClaudeSessionOptions {
  cwd: string;
  ports: ClaudeSessionPorts;
  title?: string;
  executable?: string;
  permissionMode?: string;
  /**
   * Resume an existing session by id (native `--resume`; the session keeps its
   * transcript and id — HOOK-SURFACE-FINDINGS §6). Omit to start fresh.
   */
  resume?: string;
  /** Observer fallback cadence; hook envelopes are the primary poll signal. */
  transcriptPollIntervalMs?: number;
}

/**
 * The core `AgentSession` handle (sessionId is the `--session-id` UUID = the
 * chopsticks ↔ spaghetti join contract) plus Claude-specific transcript extras.
 */
export interface ClaudeSession extends AgentSession {
  /** Absolute path to this session's transcript JSONL (handed to us by hooks). */
  transcriptPath(): string | undefined;
  /** Force a transcript delta parse now (tests, explicit refresh). */
  pollTranscript(): Promise<void>;
}

export async function createClaudeSession(options: CreateClaudeSessionOptions): Promise<ClaudeSession> {
  // Session id first: the bridge must be able to enforce its allow-list from
  // the instant it starts listening, with no window where the closure could
  // dereference a not-yet-prepared session. On resume the id is the session
  // being resumed (it keeps its own id); otherwise mint a fresh one.
  const sessionId = options.resume ?? randomUUID();
  const bridge: HookBridge = createHookBridge({
    allowSession: (id) => id === sessionId,
  });
  await bridge.start();

  const prepared = await prepareClaudeSession({
    cwd: options.cwd,
    sessionId,
    resume: options.resume,
    title: options.title,
    executable: options.executable,
    permissionMode: options.permissionMode,
    endpoint: bridge.endpoint(),
    tokenEnvVar: TOKEN_ENV_VAR,
    token: bridge.token,
  });

  let runtimeSessionId: string;
  try {
    ({ runtimeSessionId } = await options.ports.spawn(prepared));
  } catch (err) {
    await bridge.dispose();
    await cleanupClaudeSession(prepared);
    throw err;
  }

  const normalizer = new ClaudeHookNormalizer();
  const stamper = createEnvelopeStamper();
  let state = createInitialSessionState();
  let observation: ObservationLevel = 'terminal-only';
  let transcriptPath: string | undefined;
  let observer: TranscriptObserver | undefined;
  const eventListeners = new Set<(e: AgentEventEnvelope) => void>();

  const injector: PromptInjector = createPromptInjector({
    write: (data) => options.ports.write(runtimeSessionId, data),
  });

  function apply(
    event: AgentEvent,
    meta: {
      source: AgentEventEnvelope['source'];
      timestamp: string;
      promptId?: string;
      turnId?: string;
      native?: unknown;
    },
  ): void {
    const envelope = stamper.next({
      sessionId: prepared.sessionId,
      nativeSessionId: prepared.sessionId,
      promptId: meta.promptId,
      turnId: meta.turnId,
      timestamp: meta.timestamp,
      monotonicTime: performance.now(),
      source: meta.source,
      confidence: 'authoritative',
      event,
      nativeEvent: meta.native,
    });
    state = reduceSessionState(state, envelope);

    // Injector wiring rides the normalized stream, not raw payloads.
    switch (event.type) {
      case 'turn.started':
        injector.handleTurnStarted(event.turnId, event.prompt);
        break;
      case 'permission.requested':
        injector.setPermissionPending(true);
        break;
      // The dialog is gone on any of these; denial has no positive signal
      // (the absence pattern), so turn/session boundaries clear the gate.
      case 'permission.resolved':
      case 'turn.completed':
      case 'turn.failed':
      case 'session.exited':
        injector.setPermissionPending(false);
        break;
    }

    for (const listener of eventListeners) {
      try {
        listener(envelope);
      } catch {
        /* listener faults stay out of the pipeline */
      }
    }
  }

  function ensureObserver(path: string): void {
    if (observer) return;
    transcriptPath = path;
    observer = createTranscriptObserver(path, { pollIntervalMs: options.transcriptPollIntervalMs });
    observer.onRecord((record) => {
      const event = assistantMessageEvent(record.message);
      if (!event) return; // non-assistant records: transcript is enrichment, not lifecycle
      apply(event, { source: 'native-transcript', timestamp: new Date().toISOString() });
    });
    observer.onError(() => {
      // §16.8: transcript failure must never fail the session; hooks carry on.
    });
  }

  bridge.onEvent((hookEnvelope) => {
    observation = 'native-hooks';
    const body = hookEnvelope.body as ClaudeHookPayload;
    const normalized = normalizer.normalize(body);
    if (normalized.transcriptPath) ensureObserver(normalized.transcriptPath);
    for (const event of normalized.events) {
      apply(event, {
        source: 'native-hook',
        timestamp: hookEnvelope.receivedAt,
        promptId: normalized.promptId,
        turnId: normalized.turnId,
        native: body,
      });
    }
    // Hooks fire 1:1 with transcript appends — poke the tail now instead of
    // waiting out its fallback interval.
    void observer?.notifyActivity();
  });

  return {
    sessionId: prepared.sessionId,
    runtimeSessionId,
    state: () => state,
    observationLevel: () => observation,
    transcriptPath: () => transcriptPath,
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    submitPrompt: (submission) => injector.submit(submission),
    notifyUserInput: () => injector.notifyUserInput(),
    pollTranscript: async () => {
      await observer?.notifyActivity();
    },
    async dispose() {
      observer?.stop();
      await bridge.dispose();
      await cleanupClaudeSession(prepared);
    },
  };
}
