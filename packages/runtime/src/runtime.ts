import { randomUUID } from 'node:crypto';
import type { AgentEventEnvelope, AgentSession, PromptReceipt, TerminalSpec } from '@vibecook/chopsticks-core';
import {
  createWorkspace,
  workspaceIdentity,
  WorkspaceError,
  type Workspace,
  type WorkspaceErrorCode,
  type WorkspaceMode,
  type WorkspaceRequest,
} from '@vibecook/chopsticks-workspaces';
import type {
  AdoptPreparedSessionOptions,
  AdoptPreparedSessionResult,
  AgentProcessExit,
  AgentProvider,
  AgentRuntime,
  AgentRuntimeOptions,
  AgentSessionInfo,
  AgentWorkspaceFinal,
  AgentWorkspaceInfo,
  CancelPreparedSessionResult,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  PreparationFailure,
  PreparedAgentSessionInfo,
  PreparedProviderSession,
  PrepareAgentSessionResult,
} from './types.js';
import { AgentConversationProjector } from './conversation.js';

interface ManagedSession {
  session: AgentSession;
  info: AgentSessionInfo;
  workspace: Workspace;
  unsubscribe: () => void;
  releaseClaim: () => void;
  conversation: AgentConversationProjector;
  preparationId?: string;
}

interface WorkspaceLease {
  workspace: Workspace;
  releaseClaim: () => void;
}

interface WorkspaceLeaseFailure {
  error: { code: WorkspaceErrorCode; message: string };
}

type PreparationStatus = 'prepared' | 'adopting' | 'adopted';

interface ManagedPreparation extends WorkspaceLease {
  id: string;
  provider: AgentProvider;
  prepared: PreparedProviderSession;
  status: PreparationStatus;
  timer: ReturnType<typeof setTimeout>;
  adoptedRuntimeSessionId?: string;
  adoptedProcessId?: number;
  adoption?: Promise<AdoptPreparedSessionResult>;
  adoptedInfo?: AgentSessionInfo;
}

type PreparationTombstone = 'expired' | 'cancelled';

/**
 * Drivers may use a transcript to enrich reducer state while also receiving the
 * same assistant text from a live hook/protocol stream. Applications should not
 * have to know that. Prefer the live stream when the session reports one, while
 * retaining transcript messages for native-log-only providers.
 */
function isCanonicalApplicationEvent(session: AgentSession, envelope: AgentEventEnvelope): boolean {
  if (envelope.event.type !== 'assistant.message' || envelope.source !== 'native-transcript') return true;
  const level = session.observationLevel();
  return level !== 'native-hooks' && level !== 'structured';
}

function workspaceInfo(workspace: Workspace): AgentWorkspaceInfo {
  return {
    mode: workspace.mode,
    root: workspace.root,
    sourcePath: workspace.sourcePath,
    branch: workspace.branch,
    initialCommit: workspace.initialCommit,
  };
}

function cloneLaunch(launch: TerminalSpec): TerminalSpec {
  return {
    command: launch.command,
    args: [...launch.args],
    cwd: launch.cwd,
    env: launch.env ? { ...launch.env } : undefined,
    cols: launch.cols,
    rows: launch.rows,
  };
}

const preparationFailure = (code: PreparationFailure['error']['code'], message: string): PreparationFailure => ({
  error: { code, message },
});

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  const providers = new Map(options.providers.map((provider) => [provider.kind, provider]));
  const sessions = new Map<string, ManagedSession>();
  const preparations = new Map<string, ManagedPreparation>();
  const preparationTombstones = new Map<string, PreparationTombstone>();
  const preparationCleanups = new Map<string, Promise<void>>();
  const claims = new Map<string, Map<symbol, 'direct' | 'exclusive'>>();
  const listeners = new Set<(runtimeSessionId: string, envelope: AgentEventEnvelope) => void>();
  const preparationTtlMs = options.preparationTtlMs ?? 30_000;
  if (!Number.isFinite(preparationTtlMs) || preparationTtlMs <= 0) {
    throw new Error('preparationTtlMs must be a positive finite number');
  }
  let disposed = false;

  const report = (err: unknown): void => options.onError?.(err instanceof Error ? err : new Error(String(err)));

  function rememberTombstone(preparationId: string, tombstone: PreparationTombstone): void {
    preparationTombstones.set(preparationId, tombstone);
    if (preparationTombstones.size > 1_024) {
      const oldest = preparationTombstones.keys().next().value as string | undefined;
      if (oldest) preparationTombstones.delete(oldest);
    }
  }

  async function finalize(managed: ManagedSession): Promise<AgentWorkspaceFinal> {
    const { session, workspace } = managed;
    const metadata = await workspace.finalize();
    let retained = false;
    let reason: string | undefined;

    if (workspace.mode === 'worktree' || workspace.mode === 'copy') {
      try {
        await workspace.destroy();
      } catch (err) {
        if (err instanceof WorkspaceError && err.code === 'WORKSPACE_DIRTY') {
          retained = true;
          reason = err.message;
        } else {
          report(err);
        }
      }
    }

    await options.recorder?.record({
      type: 'workspace-final',
      sessionId: session.sessionId,
      runtimeSessionId: session.runtimeSessionId,
      mode: workspace.mode,
      branch: workspace.branch,
      initialCommit: workspace.initialCommit,
      finalCommit: metadata.finalCommit,
      filesTouched: metadata.filesTouched,
      retained,
    });

    return { runtimeSessionId: session.runtimeSessionId, metadata, retained, reason };
  }

  async function closeManaged(
    managed: ManagedSession,
    exit?: AgentProcessExit,
  ): Promise<AgentWorkspaceFinal | undefined> {
    if (!sessions.delete(managed.session.runtimeSessionId)) return undefined;
    if (managed.preparationId) {
      preparations.delete(managed.preparationId);
      rememberTombstone(managed.preparationId, 'cancelled');
    }
    managed.unsubscribe();
    managed.releaseClaim();

    if (exit) {
      await options.recorder?.record({
        type: 'session-exit',
        sessionId: managed.session.sessionId,
        runtimeSessionId: managed.session.runtimeSessionId,
        exitCode: exit.exitCode,
        signal: exit.signal,
        reason: exit.reason,
      });
    }

    await managed.session.dispose().catch(report);
    try {
      return await finalize(managed);
    } catch (err) {
      report(err);
      return undefined;
    }
  }

  function reserveClaim(identity: string, mode: WorkspaceMode): () => void {
    if (mode !== 'direct' && mode !== 'exclusive') return () => undefined;
    const active = claims.get(identity);
    const conflict =
      mode === 'exclusive' ? active && active.size > 0 : active && [...active.values()].includes('exclusive');
    if (conflict) {
      const description =
        mode === 'exclusive' ? 'another direct or exclusive agent is active' : 'an exclusive agent is active';
      throw new WorkspaceError('WORKSPACE_CONFLICT', `cannot start ${mode} agent on ${identity}: ${description}`);
    }

    const token = Symbol(mode);
    const entries = active ?? new Map<symbol, 'direct' | 'exclusive'>();
    entries.set(token, mode);
    claims.set(identity, entries);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = claims.get(identity);
      current?.delete(token);
      if (current?.size === 0) claims.delete(identity);
    };
  }

  async function acquireWorkspace(request: CreateAgentSessionOptions): Promise<WorkspaceLease | WorkspaceLeaseFailure> {
    const cwd = request.cwd ?? options.defaultCwd;
    const workspaceRequest: WorkspaceRequest = {
      mode: request.workspace?.mode ?? 'direct',
      path: request.workspace?.path ?? cwd,
      baseRef: request.workspace?.baseRef,
      branchName: request.workspace?.branchName,
      resumeBranch: request.workspace?.resumeBranch,
      resumeRoot: request.workspace?.resumeRoot,
      workspacesRoot: request.workspace?.workspacesRoot,
    };

    let releaseClaim: () => void = () => undefined;
    try {
      if (workspaceRequest.mode === 'direct' || workspaceRequest.mode === 'exclusive') {
        releaseClaim = reserveClaim(await workspaceIdentity(workspaceRequest.path), workspaceRequest.mode);
      }
    } catch (err) {
      if (!(err instanceof WorkspaceError)) throw err;
      if (err.code === 'WORKSPACE_CONFLICT') {
        await options.recorder?.record({
          type: 'policy-conflict',
          sessionId: `pending:${workspaceRequest.path}`,
          code: err.code,
          message: err.message,
        });
      }
      return { error: { code: err.code, message: err.message } };
    }

    try {
      return { workspace: await createWorkspace(workspaceRequest), releaseClaim };
    } catch (err) {
      releaseClaim();
      if (err instanceof WorkspaceError) return { error: { code: err.code, message: err.message } };
      throw err;
    }
  }

  function manageSession(
    provider: AgentProvider,
    session: AgentSession,
    lease: WorkspaceLease,
    extras: { preparationId?: string; processId?: number } = {},
  ): AgentSessionInfo {
    const info: AgentSessionInfo = {
      agent: provider.kind,
      sessionId: session.sessionId,
      runtimeSessionId: session.runtimeSessionId,
      workspace: workspaceInfo(lease.workspace),
    };
    if (extras.preparationId !== undefined) info.preparationId = extras.preparationId;
    if (extras.processId !== undefined) info.processId = extras.processId;
    const conversation = new AgentConversationProjector();
    const unsubscribe = session.onEvent((envelope) => {
      if (!isCanonicalApplicationEvent(session, envelope)) return;
      conversation.consume(envelope);
      for (const listener of listeners) {
        try {
          listener(session.runtimeSessionId, envelope);
        } catch {
          // Listener faults stay out of the observation pipeline.
        }
      }
    });
    sessions.set(session.runtimeSessionId, {
      session,
      info,
      workspace: lease.workspace,
      unsubscribe,
      releaseClaim: lease.releaseClaim,
      conversation,
      preparationId: extras.preparationId,
    });
    return info;
  }

  async function destroyUnusedPreparation(
    preparation: ManagedPreparation,
    tombstone: PreparationTombstone,
  ): Promise<void> {
    if (preparations.get(preparation.id) !== preparation) return;
    preparations.delete(preparation.id);
    rememberTombstone(preparation.id, tombstone);
    clearTimeout(preparation.timer);
    const cleanup = (async () => {
      try {
        await preparation.prepared.dispose();
      } catch (err) {
        report(err);
      }
      await preparation.workspace.destroy().catch(report);
      preparation.releaseClaim();
    })();
    preparationCleanups.set(preparation.id, cleanup);
    await cleanup;
    if (preparationCleanups.get(preparation.id) === cleanup) preparationCleanups.delete(preparation.id);
  }

  async function tombstoneFailure(preparationId: string): Promise<PreparationFailure> {
    await preparationCleanups.get(preparationId);
    const tombstone = preparationTombstones.get(preparationId);
    if (tombstone === 'expired') {
      return preparationFailure('PREPARATION_EXPIRED', `prepared session expired: ${preparationId}`);
    }
    if (tombstone === 'cancelled') {
      return preparationFailure('PREPARATION_CANCELLED', `prepared session was cancelled or closed: ${preparationId}`);
    }
    return preparationFailure('PREPARATION_NOT_FOUND', `prepared session not found: ${preparationId}`);
  }

  async function cancelPrepared(preparationId: string): Promise<CancelPreparedSessionResult> {
    const preparation = preparations.get(preparationId);
    if (!preparation) {
      const tombstone = preparationTombstones.get(preparationId);
      if (tombstone === 'cancelled') return { cancelled: true };
      return tombstoneFailure(preparationId);
    }
    if (preparation.status === 'adopting') {
      await preparation.adoption;
      return cancelPrepared(preparationId);
    }
    if (preparation.status === 'adopted') {
      const managed = sessions.get(preparation.adoptedRuntimeSessionId!);
      if (managed) {
        await closeManaged(managed, {
          exitCode: null,
          signal: null,
          reason: 'spawn-failed',
        });
      }
      rememberTombstone(preparationId, 'cancelled');
      return { cancelled: true };
    }
    await destroyUnusedPreparation(preparation, 'cancelled');
    return { cancelled: true };
  }

  return {
    async createSession(request: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> {
      if (disposed) throw new Error('agent runtime is disposed');
      const provider = providers.get(request.agent);
      if (!provider) {
        return { error: { code: 'AGENT_NOT_FOUND', message: `unknown agent provider: ${request.agent}` } };
      }

      const lease = await acquireWorkspace(request);
      if ('error' in lease) return lease;

      let session: AgentSession;
      try {
        session = await provider.createSession({
          cwd: lease.workspace.root,
          resume: request.resume,
          title: request.title,
          host: options.host,
          agentOptions: request.agentOptions,
        });
      } catch (err) {
        await lease.workspace.destroy().catch(report);
        lease.releaseClaim();
        throw err;
      }

      return manageSession(provider, session, lease);
    },

    async prepareSession(request: CreateAgentSessionOptions): Promise<PrepareAgentSessionResult> {
      if (disposed) throw new Error('agent runtime is disposed');
      const provider = providers.get(request.agent);
      if (!provider) {
        return preparationFailure('AGENT_NOT_FOUND', `unknown agent provider: ${request.agent}`);
      }
      if (!provider.prepareSession) {
        return preparationFailure(
          'PREPARATION_UNSUPPORTED',
          `agent provider does not support caller-owned terminal preparation: ${request.agent}`,
        );
      }

      const lease = await acquireWorkspace(request);
      if ('error' in lease) return lease;

      let prepared: PreparedProviderSession;
      try {
        prepared = await provider.prepareSession({
          cwd: lease.workspace.root,
          resume: request.resume,
          title: request.title,
          host: options.host,
          agentOptions: request.agentOptions,
        });
      } catch (err) {
        await lease.workspace.destroy().catch(report);
        lease.releaseClaim();
        throw err;
      }

      const preparationId = randomUUID();
      const expiresAtMs = Date.now() + preparationTtlMs;
      const publicInfo: PreparedAgentSessionInfo = {
        preparationId,
        agent: provider.kind,
        sessionId: prepared.sessionId,
        launch: cloneLaunch(prepared.launch),
        workspace: workspaceInfo(lease.workspace),
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
      const timer = setTimeout(() => {
        const current = preparations.get(preparationId);
        if (current?.status === 'prepared') void destroyUnusedPreparation(current, 'expired');
      }, preparationTtlMs);
      timer.unref?.();
      const managed: ManagedPreparation = {
        id: preparationId,
        provider,
        prepared,
        status: 'prepared',
        timer,
        ...lease,
      };
      preparations.set(preparationId, managed);
      return publicInfo;
    },

    async adoptPrepared(
      preparationId: string,
      adoptOptions: AdoptPreparedSessionOptions,
    ): Promise<AdoptPreparedSessionResult> {
      if (disposed) throw new Error('agent runtime is disposed');
      const preparation = preparations.get(preparationId);
      if (!preparation) return tombstoneFailure(preparationId);
      if (!adoptOptions.runtimeSessionId) {
        return preparationFailure('PREPARATION_ADOPT_FAILED', 'runtimeSessionId must be non-empty');
      }
      if (
        adoptOptions.processId !== undefined &&
        (!Number.isSafeInteger(adoptOptions.processId) || adoptOptions.processId <= 0)
      ) {
        return preparationFailure('PREPARATION_ADOPT_FAILED', 'processId must be a positive safe integer');
      }
      if (preparation.status === 'adopted') {
        if (preparation.adoptedRuntimeSessionId !== adoptOptions.runtimeSessionId) {
          return preparationFailure(
            'PREPARATION_ALREADY_ADOPTED',
            `prepared session is already adopted by ${preparation.adoptedRuntimeSessionId}`,
          );
        }
        if (
          preparation.adoptedProcessId !== undefined &&
          adoptOptions.processId !== undefined &&
          preparation.adoptedProcessId !== adoptOptions.processId
        ) {
          return preparationFailure(
            'PREPARATION_ALREADY_ADOPTED',
            `prepared session is already adopted by process ${preparation.adoptedProcessId}`,
          );
        }
        if (preparation.adoptedProcessId === undefined && adoptOptions.processId !== undefined) {
          preparation.adoptedProcessId = adoptOptions.processId;
          preparation.adoptedInfo!.processId = adoptOptions.processId;
        }
        return preparation.adoptedInfo!;
      }
      if (preparation.status === 'adopting') {
        if (preparation.adoptedRuntimeSessionId !== adoptOptions.runtimeSessionId) {
          return preparationFailure(
            'PREPARATION_ALREADY_ADOPTED',
            `prepared session is being adopted by ${preparation.adoptedRuntimeSessionId}`,
          );
        }
        if (
          preparation.adoptedProcessId !== undefined &&
          adoptOptions.processId !== undefined &&
          preparation.adoptedProcessId !== adoptOptions.processId
        ) {
          return preparationFailure(
            'PREPARATION_ALREADY_ADOPTED',
            `prepared session is being adopted by process ${preparation.adoptedProcessId}`,
          );
        }
        if (preparation.adoptedProcessId === undefined) preparation.adoptedProcessId = adoptOptions.processId;
        return preparation.adoption!;
      }
      if (sessions.has(adoptOptions.runtimeSessionId)) {
        return preparationFailure(
          'RUNTIME_SESSION_CONFLICT',
          `terminal already has an active agent session: ${adoptOptions.runtimeSessionId}`,
        );
      }

      preparation.status = 'adopting';
      preparation.adoptedRuntimeSessionId = adoptOptions.runtimeSessionId;
      preparation.adoptedProcessId = adoptOptions.processId;
      clearTimeout(preparation.timer);
      preparation.adoption = (async (): Promise<AdoptPreparedSessionResult> => {
        try {
          const session = await preparation.prepared.adopt(adoptOptions.runtimeSessionId);
          if (session.runtimeSessionId !== adoptOptions.runtimeSessionId) {
            throw new Error(
              `provider adopted terminal ${session.runtimeSessionId}; expected ${adoptOptions.runtimeSessionId}`,
            );
          }
          if (session.sessionId !== preparation.prepared.sessionId) {
            throw new Error(
              `provider adopted native session ${session.sessionId}; expected ${preparation.prepared.sessionId}`,
            );
          }
          if (disposed) throw new Error('agent runtime was disposed during adoption');
          if (sessions.has(adoptOptions.runtimeSessionId)) {
            throw new Error(
              `terminal gained an active agent session during adoption: ${adoptOptions.runtimeSessionId}`,
            );
          }
          const info = manageSession(preparation.provider, session, preparation, {
            preparationId,
            processId: preparation.adoptedProcessId,
          });
          preparation.status = 'adopted';
          preparation.adoptedInfo = info;
          return info;
        } catch (err) {
          await destroyUnusedPreparation(preparation, 'cancelled');
          return preparationFailure('PREPARATION_ADOPT_FAILED', err instanceof Error ? err.message : String(err));
        }
      })();
      return preparation.adoption;
    },

    cancelPrepared,

    sessionInfo: (id) => sessions.get(id)?.info,
    sessionState: (id) => sessions.get(id)?.session.state(),
    observationLevel: (id) => sessions.get(id)?.session.observationLevel(),
    conversationSnapshot: (id) => sessions.get(id)?.conversation.snapshot(),

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async submitPrompt(runtimeSessionId, submission): Promise<PromptReceipt> {
      const managed = sessions.get(runtimeSessionId);
      if (!managed) return { status: 'rejected', reason: 'agent session not found' };
      const receipt = await managed.session.submitPrompt(submission);
      await options.recorder?.record({
        type: 'injection',
        sessionId: managed.session.sessionId,
        runtimeSessionId,
        text: submission.text,
        outcome: receipt.status,
        reason: receipt.status === 'confirmed' ? undefined : receipt.reason,
        turnId: receipt.status === 'confirmed' ? receipt.turnId : undefined,
      });
      return receipt;
    },

    async workspaceDiff(runtimeSessionId) {
      return (await sessions.get(runtimeSessionId)?.workspace.diff()) ?? null;
    },

    async handleProcessExit(runtimeSessionId, exit) {
      const managed = sessions.get(runtimeSessionId);
      return managed ? closeManaged(managed, exit) : undefined;
    },

    async dispose() {
      if (disposed) return [];
      disposed = true;
      const pendingAdoptions = [...preparations.values()]
        .filter((preparation) => preparation.status === 'adopting')
        .map((preparation) => preparation.adoption!);
      await Promise.all(pendingAdoptions);
      await Promise.all(
        [...preparations.values()]
          .filter((preparation) => preparation.status === 'prepared')
          .map((preparation) => destroyUnusedPreparation(preparation, 'cancelled')),
      );
      const finals = await Promise.all([...sessions.values()].map((managed) => closeManaged(managed)));
      await Promise.all([...providers.values()].map((provider) => Promise.resolve(provider.dispose?.()).catch(report)));
      listeners.clear();
      return finals.filter((value): value is AgentWorkspaceFinal => value !== undefined);
    },
  };
}
