import type { AgentEventEnvelope, AgentSession, PromptReceipt } from '@vibecook/chopsticks-core';
import {
  createWorkspace,
  workspaceIdentity,
  WorkspaceError,
  type Workspace,
  type WorkspaceMode,
  type WorkspaceRequest,
} from '@vibecook/chopsticks-workspaces';
import type {
  AgentProcessExit,
  AgentRuntime,
  AgentRuntimeOptions,
  AgentSessionInfo,
  AgentWorkspaceFinal,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
} from './types.js';

interface ManagedSession {
  session: AgentSession;
  info: AgentSessionInfo;
  workspace: Workspace;
  unsubscribe: () => void;
  releaseClaim: () => void;
}

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

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  const providers = new Map(options.providers.map((provider) => [provider.kind, provider]));
  const sessions = new Map<string, ManagedSession>();
  const claims = new Map<string, Map<symbol, 'direct' | 'exclusive'>>();
  const listeners = new Set<(runtimeSessionId: string, envelope: AgentEventEnvelope) => void>();
  let disposed = false;

  const report = (err: unknown): void => options.onError?.(err instanceof Error ? err : new Error(String(err)));

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

  return {
    async createSession(request: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> {
      if (disposed) throw new Error('agent runtime is disposed');
      const provider = providers.get(request.agent);
      if (!provider) {
        return { error: { code: 'AGENT_NOT_FOUND', message: `unknown agent provider: ${request.agent}` } };
      }

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

      let workspace: Workspace;
      try {
        workspace = await createWorkspace(workspaceRequest);
      } catch (err) {
        releaseClaim();
        if (err instanceof WorkspaceError) return { error: { code: err.code, message: err.message } };
        throw err;
      }

      let session: AgentSession;
      try {
        session = await provider.createSession({
          cwd: workspace.root,
          resume: request.resume,
          title: request.title,
          host: options.host,
        });
      } catch (err) {
        await workspace.destroy().catch(report);
        releaseClaim();
        throw err;
      }

      const info: AgentSessionInfo = {
        agent: provider.kind,
        sessionId: session.sessionId,
        runtimeSessionId: session.runtimeSessionId,
        workspace: {
          mode: workspace.mode,
          root: workspace.root,
          sourcePath: workspace.sourcePath,
          branch: workspace.branch,
          initialCommit: workspace.initialCommit,
        },
      };
      const unsubscribe = session.onEvent((envelope) => {
        if (!isCanonicalApplicationEvent(session, envelope)) return;
        for (const listener of listeners) {
          try {
            listener(session.runtimeSessionId, envelope);
          } catch {
            // Listener faults stay out of the observation pipeline.
          }
        }
      });
      sessions.set(session.runtimeSessionId, { session, info, workspace, unsubscribe, releaseClaim });
      return info;
    },

    sessionInfo: (id) => sessions.get(id)?.info,
    sessionState: (id) => sessions.get(id)?.session.state(),
    observationLevel: (id) => sessions.get(id)?.session.observationLevel(),

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

    notifyUserInput(runtimeSessionId) {
      sessions.get(runtimeSessionId)?.session.notifyUserInput();
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
      const finals = await Promise.all([...sessions.values()].map((managed) => closeManaged(managed)));
      await Promise.all([...providers.values()].map((provider) => Promise.resolve(provider.dispose?.()).catch(report)));
      listeners.clear();
      return finals.filter((value): value is AgentWorkspaceFinal => value !== undefined);
    },
  };
}
