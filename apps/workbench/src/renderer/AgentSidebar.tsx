import { useCallback, useEffect, useState } from 'react';
import type { GhostteaWorkspaceContext } from '@vibecook/ghosttea-react/workspace';
import type {
  AgentKind,
  AgentSessionInfo,
  AgentStateMessage,
  CreateAgentSessionOptions,
  WorkspaceFinalEvent,
} from '../protocol.js';
import { AgentPanel, type WorkspacePanelData } from './AgentPanel.js';

interface AgentSidebarProps {
  workspace: GhostteaWorkspaceContext;
}

type SpawnMode = 'default' | 'exclusive' | 'worktree';

export function AgentSidebar({ workspace }: AgentSidebarProps) {
  const [agentKind, setAgentKind] = useState<AgentKind>('claude');
  const [agents, setAgents] = useState(() => new Map<string, AgentSessionInfo>());
  const [states, setStates] = useState(() => new Map<string, AgentStateMessage>());
  const [workspaces, setWorkspaces] = useState(() => new Map<string, WorkspacePanelData>());
  const [spawning, setSpawning] = useState<SpawnMode>();
  const [error, setError] = useState<string>();

  const rememberAgent = useCallback((info: AgentSessionInfo, note?: string): void => {
    setAgents((current) => new Map(current).set(info.runtimeSessionId, info));
    setWorkspaces((current) =>
      new Map(current).set(info.runtimeSessionId, {
        info: info.workspace,
        ...(note ? { note } : {}),
      }),
    );
  }, []);

  const spawnAgent = useCallback(
    async (
      mode: SpawnMode,
      resume?: { nativeSessionId: string; previous: WorkspacePanelData },
      selectedAgent: AgentKind = agentKind,
    ): Promise<void> => {
      if (spawning) return;
      setSpawning(mode);
      setError(undefined);
      try {
        const workspaceOptions: CreateAgentSessionOptions['workspace'] = resume
          ? resume.previous.info.mode === 'worktree'
            ? {
                mode: 'worktree',
                path: resume.previous.info.sourcePath,
                resumeBranch: resume.previous.info.branch,
                resumeRoot: resume.previous.final?.retained ? resume.previous.info.root : undefined,
              }
            : {
                mode: resume.previous.info.mode === 'exclusive' ? 'exclusive' : 'direct',
                path: resume.previous.info.root,
              }
          : mode === 'default'
            ? undefined
            : { mode };
        const result = await window.chopsticks.createAgentSession({
          agent: selectedAgent,
          ...(workspaceOptions ? { workspace: workspaceOptions } : {}),
          ...(resume ? { resume: resume.nativeSessionId } : {}),
        });
        if ('error' in result) {
          setError(result.error.message);
          return;
        }
        rememberAgent(result, resume ? 'resumed agent session' : undefined);
        workspace.addSession(result.session);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSpawning(undefined);
      }
    },
    [agentKind, rememberAgent, spawning, workspace],
  );

  const resumeAgent = useCallback(
    (runtimeSessionId: string): void => {
      const agent = agents.get(runtimeSessionId);
      const previous = workspaces.get(runtimeSessionId);
      if (!agent || !previous) return;
      setAgentKind(agent.agent);
      void spawnAgent(
        previous.info.mode === 'worktree' ? 'worktree' : previous.info.mode === 'exclusive' ? 'exclusive' : 'default',
        { nativeSessionId: agent.sessionId, previous },
        agent.agent,
      );
    },
    [agents, spawnAgent, workspaces],
  );

  useEffect(() => {
    let alive = true;
    const unsubscribeState = window.chopsticks.onAgentState((message) => {
      setStates((current) => new Map(current).set(message.runtimeSessionId, message));
    });
    const unsubscribeFinal = window.chopsticks.onWorkspaceFinal((final: WorkspaceFinalEvent) => {
      setWorkspaces((current) => {
        const existing = current.get(final.runtimeSessionId);
        if (!existing) return current;
        return new Map(current).set(final.runtimeSessionId, {
          ...existing,
          final,
          diff: final.metadata.finalDiff,
        });
      });
    });
    void window.chopsticks.listAgentSessions().then((snapshots) => {
      if (!alive) return;
      const nextAgents = new Map<string, AgentSessionInfo>();
      const nextStates = new Map<string, AgentStateMessage>();
      const nextWorkspaces = new Map<string, WorkspacePanelData>();
      for (const snapshot of snapshots) {
        nextAgents.set(snapshot.info.runtimeSessionId, snapshot.info);
        if (snapshot.state) nextStates.set(snapshot.info.runtimeSessionId, snapshot.state);
        nextWorkspaces.set(snapshot.info.runtimeSessionId, {
          info: snapshot.info.workspace,
          final: snapshot.final,
          diff: snapshot.final?.metadata.finalDiff,
        });
      }
      setAgents(nextAgents);
      setStates((current) => new Map([...nextStates, ...current]));
      setWorkspaces((current) => new Map([...nextWorkspaces, ...current]));
    });
    return () => {
      alive = false;
      unsubscribeState();
      unsubscribeFinal();
    };
  }, []);

  const activeId = workspace.activeSession?.id;
  const activeAgent = activeId ? agents.get(activeId) : undefined;
  const activeWorkspace = activeId ? workspaces.get(activeId) : undefined;

  useEffect(() => {
    if (!activeId || !activeAgent || activeWorkspace?.final) return;
    let alive = true;
    const refresh = (): void => {
      void window.chopsticks.workspaceDiff(activeId).then((diff) => {
        if (!alive || !diff) return;
        setWorkspaces((current) => {
          const existing = current.get(activeId);
          return existing ? new Map(current).set(activeId, { ...existing, diff }) : current;
        });
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [activeAgent, activeId, activeWorkspace?.final]);

  return (
    <div className="agent-sidebar">
      <div className="agent-launcher">
        <div className="agent-launcher-row">
          <label htmlFor="agent-kind">Agent</label>
          <select id="agent-kind" value={agentKind} onChange={(event) => setAgentKind(event.target.value as AgentKind)}>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
            <option value="grok">Grok</option>
          </select>
        </div>
        <div className="agent-launch-actions">
          <button type="button" disabled={Boolean(spawning)} onClick={() => void spawnAgent('default')}>
            {spawning === 'default' ? 'Starting…' : 'Default'}
          </button>
          <button type="button" disabled={Boolean(spawning)} onClick={() => void spawnAgent('exclusive')}>
            {spawning === 'exclusive' ? 'Starting…' : 'Exclusive'}
          </button>
          <button type="button" disabled={Boolean(spawning)} onClick={() => void spawnAgent('worktree')}>
            {spawning === 'worktree' ? 'Starting…' : 'Worktree'}
          </button>
        </div>
        {error ? <div className="agent-launch-error">{error}</div> : null}
      </div>
      {activeId && activeAgent ? (
        <AgentPanel
          runtimeSessionId={activeId}
          agentKind={activeAgent.agent}
          message={states.get(activeId)}
          workspace={activeWorkspace}
          exited={activeAgent.session.exited || Boolean(activeWorkspace?.final)}
          canResume={Boolean(activeWorkspace?.final)}
          onSubmit={(runtimeSessionId, text) => window.chopsticks.submitPrompt({ runtimeSessionId, text })}
          onResume={resumeAgent}
        />
      ) : (
        <div className="agent-empty">
          <span>
            {agents.size
              ? 'Focus an agent pane to observe and control it.'
              : 'Start an agent in an isolated workspace.'}
          </span>
          {agents.size ? (
            <div className="agent-session-list">
              {[...agents.values()].map((agent) => {
                const paneOpen = workspace.sessions.some((session) => session.id === agent.runtimeSessionId);
                const resumable = Boolean(workspaces.get(agent.runtimeSessionId)?.final);
                return (
                  <button
                    key={agent.runtimeSessionId}
                    type="button"
                    disabled={!paneOpen && !resumable}
                    onClick={() =>
                      paneOpen ? workspace.activateSession(agent.runtimeSessionId) : resumeAgent(agent.runtimeSessionId)
                    }
                  >
                    {agent.agent} · {agent.workspace.mode}
                    {!paneOpen && resumable ? ' · resume' : ''}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
