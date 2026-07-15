/**
 * Workbench renderer — Ghostty-fashion chrome (avocado/apps/ghostty) on
 * chopsticks' avocado hub + pty-host.
 *
 * Terminal behavior from SDK `TerminalSurface` (engine lifecycle, PTY I/O,
 * auto-fit, click-to-focus). This file owns Ghostty-shaped chrome: tabs,
 * splits, keybindings, dimming — plus chopsticks agent tabs/panel.
 *
 * Keybindings (⌘ on macOS, Ctrl elsewhere), matching Ghostty:
 *   mod+T            new shell tab
 *   mod+W            close focused split (last split closes the tab)
 *   mod+D            split right          mod+Shift+D   split down
 *   mod+]  /  mod+[  focus next / previous split
 *   mod+Shift+] / [  next / previous tab
 *   mod+1..8, mod+9  select tab N / last tab
 */

import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { AvocadoProvider, TerminalSurface, type TerminalCoreActions } from '@vibecook/avocado-sdk/react';
import type { AgentEventEnvelope } from '@vibecook/chopsticks-core';
import type {
  AgentEventMessage,
  AgentStateMessage,
  CreateClaudeSessionOptions,
  ExitEvent,
  WorkspaceFinalEvent,
} from '../protocol.js';
import { AgentPanel, type WorkspacePanelData } from './agent-panel.js';
import { createChopsticksBackend, type ChopsticksTerminalBackend } from './backend.js';
import {
  leaf,
  neighborPane,
  panesOf,
  removePane,
  setSplitRatio,
  splitPane,
  type SplitDirection,
  type SplitTree,
} from './split-tree.js';
import { SplitView } from './components/SplitView.js';
import { TabBar } from './components/TabBar.js';
import './styles.css';

const chopsticks = window.chopsticks;
const backend: ChopsticksTerminalBackend = createChopsticksBackend();

const isMac = navigator.platform.toLowerCase().includes('mac');
const shellName = 'shell';

const EVENT_TAIL_MAX = 50;
const SPAWN_COLS = 80;
const SPAWN_ROWS = 24;

type AgentKind = 'claude' | 'codex' | 'grok';

interface PaneState {
  id: string;
  sessionId: string;
  terminalId: string;
  title: string;
  agentKind?: AgentKind;
  /** Hub buffer to inject once restty reports data-ready (reload recovery). */
  snapshotBase64?: string;
}

interface TabState {
  id: string;
  tree: SplitTree;
  panes: Record<string, PaneState>;
  focusedPaneId: string;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

function textToB64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

async function spawnShellPane(title = shellName): Promise<PaneState> {
  const desc = await chopsticks.createSession({
    kind: 'shell',
    cols: SPAWN_COLS,
    rows: SPAWN_ROWS,
  });
  return {
    id: crypto.randomUUID(),
    sessionId: desc.sessionId,
    terminalId: desc.sessionId,
    title,
  };
}

function releasePane(pane: PaneState, killSession: boolean): void {
  if (killSession) {
    chopsticks.terminate(pane.sessionId).catch(() => undefined);
  }
}

/** One Ghostty-style pane: TerminalSurface + optional snapshot inject + dim overlay. */
function PaneView({
  pane,
  focused,
  dimmed,
  onFocus,
  onActions,
  onInjected,
  alreadyInjected,
}: {
  pane: PaneState;
  focused: boolean;
  dimmed: boolean;
  onFocus: () => void;
  onActions: (actions: TerminalCoreActions | null) => void;
  onInjected: () => void;
  alreadyInjected: boolean;
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<TerminalCoreActions | null>(null);

  // Bridge object ref → parent map (useImperativeHandle needs a RefObject).
  useEffect(() => {
    const tick = (): void => {
      if (actionsRef.current) onActions(actionsRef.current);
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => {
      window.clearInterval(id);
      onActions(null);
    };
  }, [onActions, pane.id]);

  // Inject hub replay once TerminalSurface sets data-ready.
  useEffect(() => {
    if (alreadyInjected || !pane.snapshotBase64) return;
    const root = rootRef.current;
    if (!root) return;
    const inject = (): void => {
      if (!root.querySelector('[data-ready]')) return;
      onInjected();
      if (pane.snapshotBase64) {
        backend.injectOutput(pane.terminalId, pane.sessionId, pane.snapshotBase64);
      }
    };
    const obs = new MutationObserver(inject);
    obs.observe(root, { attributes: true, subtree: true, attributeFilter: ['data-ready'] });
    inject();
    return () => obs.disconnect();
  }, [alreadyInjected, onInjected, pane.sessionId, pane.snapshotBase64, pane.terminalId]);

  return (
    <div ref={rootRef} className={`term-pane${focused ? ' focused' : ''}`}>
      <TerminalSurface
        sessionId={pane.sessionId}
        terminalId={pane.terminalId}
        engine="restty"
        // Each split owns its own PTY — always active for resize (ghostty demo).
        // Hollow cursor on unfocused splits is driven by focus()/blur() in App.
        isActive
        autoResize
        className="term-surface"
        // Match avocado/apps/ghostty: WebGPU when available, WebGL2 fallback.
        resttyRenderer="auto"
        onFocus={onFocus}
        actionsRef={actionsRef}
      />
      {dimmed && <div className="pane-dim" />}
    </div>
  );
}

export function App(): JSX.Element {
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isolation, setIsolation] = useState<'shared' | 'worktree'>('shared');

  const [agentState, setAgentState] = useState(() => new Map<string, AgentStateMessage>());
  const [agentEvents, setAgentEvents] = useState(() => new Map<string, AgentEventEnvelope[]>());
  const [agentWorkspace, setAgentWorkspace] = useState(() => new Map<string, WorkspacePanelData>());
  const [claudeSessionId, setClaudeSessionId] = useState(() => new Map<string, string>());
  const [codexThreadId, setCodexThreadId] = useState(() => new Map<string, string>());
  const [grokSessionId, setGrokSessionId] = useState(() => new Map<string, string>());

  const paneActionsRef = useRef(new Map<string, TerminalCoreActions>());
  const tabsRef = useRef(tabs);
  const activeTabIdRef = useRef(activeTabId);
  tabsRef.current = tabs;
  activeTabIdRef.current = activeTabId;

  const activityRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<AgentPanel | null>(null);
  const diffPollers = useRef(new Map<string, ReturnType<typeof setInterval>>());
  const injectedReady = useRef(new Set<string>());

  const fail = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
  }, []);

  const stopDiffPoll = useCallback((id: string): void => {
    const t = diffPollers.current.get(id);
    if (t) clearInterval(t);
    diffPollers.current.delete(id);
  }, []);

  const startDiffPoll = useCallback((runtimeSessionId: string): void => {
    if (diffPollers.current.has(runtimeSessionId)) return;
    const timer = setInterval(() => {
      void chopsticks.workspaceDiff(runtimeSessionId).then((diff) => {
        if (!diff) return;
        setAgentWorkspace((cur) => {
          const d = cur.get(runtimeSessionId);
          if (!d || d.final) return cur;
          const next = new Map(cur);
          next.set(runtimeSessionId, { ...d, diff });
          return next;
        });
      });
    }, 10_000);
    diffPollers.current.set(runtimeSessionId, timer);
  }, []);

  // ─── Tab / pane operations ────────────────────────────────────────────

  const newTab = useCallback(async () => {
    try {
      const pane = await spawnShellPane();
      const tabId = crypto.randomUUID();
      setTabs((prev) => [
        ...prev,
        { id: tabId, tree: leaf(pane.id), panes: { [pane.id]: pane }, focusedPaneId: pane.id },
      ]);
      setActiveTabId(tabId);
    } catch (err) {
      fail(err);
    }
  }, [fail]);

  const addAgentTab = useCallback((pane: PaneState) => {
    const tabId = crypto.randomUUID();
    setTabs((prev) => [
      ...prev,
      { id: tabId, tree: leaf(pane.id), panes: { [pane.id]: pane }, focusedPaneId: pane.id },
    ]);
    setActiveTabId(tabId);
  }, []);

  const splitFocused = useCallback(
    async (dir: SplitDirection) => {
      const tabId = activeTabIdRef.current;
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;
      const targetPaneId = tab.focusedPaneId;
      try {
        const pane = await spawnShellPane();
        setTabs((prev) =>
          prev.map((t) =>
            t.id !== tabId
              ? t
              : {
                  ...t,
                  tree: splitPane(t.tree, targetPaneId, pane.id, dir, crypto.randomUUID()),
                  panes: { ...t.panes, [pane.id]: pane },
                  focusedPaneId: pane.id,
                },
          ),
        );
      } catch (err) {
        fail(err);
      }
    },
    [fail],
  );

  const removePaneById = useCallback(
    (paneId: string, opts: { killSession: boolean }) => {
      const prev = tabsRef.current;
      const tab = prev.find((t) => paneId in t.panes);
      if (!tab) return;

      const pane = tab.panes[paneId];
      if (pane) {
        releasePane(pane, opts.killSession);
        stopDiffPoll(pane.sessionId);
        setAgentState((m) => {
          const n = new Map(m);
          n.delete(pane.sessionId);
          return n;
        });
        setAgentEvents((m) => {
          const n = new Map(m);
          n.delete(pane.sessionId);
          return n;
        });
        setAgentWorkspace((m) => {
          const n = new Map(m);
          n.delete(pane.sessionId);
          return n;
        });
        setClaudeSessionId((m) => {
          const n = new Map(m);
          n.delete(pane.sessionId);
          return n;
        });
        setCodexThreadId((m) => {
          const n = new Map(m);
          n.delete(pane.sessionId);
          return n;
        });
        setGrokSessionId((m) => {
          const n = new Map(m);
          n.delete(pane.sessionId);
          return n;
        });
      }
      paneActionsRef.current.delete(paneId);
      injectedReady.current.delete(paneId);

      const nextTree = removePane(tab.tree, paneId);
      if (!nextTree) {
        const rest = prev.filter((t) => t.id !== tab.id);
        setTabs(rest);
        if (rest.length === 0) {
          setActiveTabId(null);
          return;
        }
        if (activeTabIdRef.current === tab.id) {
          const index = prev.findIndex((t) => t.id === tab.id);
          const fallback = rest[Math.min(Math.max(index - 1, 0), rest.length - 1)];
          setActiveTabId(fallback ? fallback.id : rest[rest.length - 1]!.id);
        }
        return;
      }

      const panes = { ...tab.panes };
      delete panes[paneId];
      const focusedPaneId =
        tab.focusedPaneId === paneId ? (panesOf(nextTree)[0] ?? tab.focusedPaneId) : tab.focusedPaneId;
      setTabs(prev.map((t) => (t.id === tab.id ? { ...t, tree: nextTree, panes, focusedPaneId } : t)));
    },
    [stopDiffPoll],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      const prev = tabsRef.current;
      const tab = prev.find((t) => t.id === tabId);
      if (!tab) return;
      for (const pane of Object.values(tab.panes)) {
        releasePane(pane, true);
        stopDiffPoll(pane.sessionId);
        paneActionsRef.current.delete(pane.id);
        injectedReady.current.delete(pane.id);
      }
      const rest = prev.filter((t) => t.id !== tabId);
      setTabs(rest);
      if (rest.length === 0) {
        setActiveTabId(null);
        return;
      }
      if (activeTabIdRef.current === tabId) {
        const index = prev.findIndex((t) => t.id === tabId);
        const fallback = rest[Math.min(Math.max(index - 1, 0), rest.length - 1)];
        setActiveTabId(fallback ? fallback.id : rest[rest.length - 1]!.id);
      }
    },
    [stopDiffPoll],
  );

  const focusPane = useCallback((tabId: string, paneId: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId && t.focusedPaneId !== paneId ? { ...t, focusedPaneId: paneId } : t)),
    );
  }, []);

  const cyclePane = useCallback(
    (offset: 1 | -1) => {
      const tab = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
      if (!tab) return;
      const next = neighborPane(tab.tree, tab.focusedPaneId, offset);
      if (next) focusPane(tab.id, next);
    },
    [focusPane],
  );

  const cycleTab = useCallback((offset: 1 | -1) => {
    const prev = tabsRef.current;
    if (prev.length < 2) return;
    const index = prev.findIndex((t) => t.id === activeTabIdRef.current);
    const next = prev[(index + offset + prev.length) % prev.length];
    if (next) setActiveTabId(next.id);
  }, []);

  const selectTabIndex = useCallback((digit: number) => {
    const prev = tabsRef.current;
    if (prev.length === 0) return;
    const tab = digit === 9 ? prev[prev.length - 1] : prev[digit - 1];
    if (tab) setActiveTabId(tab.id);
  }, []);

  const changeRatio = useCallback((tabId: string, splitId: string, ratio: number) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, tree: setSplitRatio(t.tree, splitId, ratio) } : t)));
  }, []);

  // ─── Agent spawn ──────────────────────────────────────────────────────

  const startClaude = useCallback(
    async (opts: CreateClaudeSessionOptions, title: string, note?: string) => {
      try {
        const result = await chopsticks.createClaudeSession(opts);
        if ('error' in result) {
          fail(`${result.error.code}: ${result.error.message}`);
          return;
        }
        setAgentWorkspace((prev) => {
          const next = new Map(prev);
          next.set(result.runtimeSessionId, { info: result.workspace, note });
          return next;
        });
        setClaudeSessionId((prev) => {
          const next = new Map(prev);
          next.set(result.runtimeSessionId, result.sessionId);
          return next;
        });
        startDiffPoll(result.runtimeSessionId);
        addAgentTab({
          id: crypto.randomUUID(),
          sessionId: result.runtimeSessionId,
          terminalId: result.runtimeSessionId,
          title,
          agentKind: 'claude',
        });
      } catch (err) {
        fail(err);
      }
    },
    [addAgentTab, fail, startDiffPoll],
  );

  const newClaude = useCallback(
    () => void startClaude({ workspace: { isolation } }, isolation === 'worktree' ? 'claude ⑂' : 'claude'),
    [isolation, startClaude],
  );

  const newCodex = useCallback(async () => {
    try {
      const result = await chopsticks.createCodexSession({});
      addAgentTab({
        id: crypto.randomUUID(),
        sessionId: result.runtimeSessionId,
        terminalId: result.runtimeSessionId,
        title: 'codex',
        agentKind: 'codex',
      });
    } catch (err) {
      fail(err);
    }
  }, [addAgentTab, fail]);

  const newGrok = useCallback(async () => {
    try {
      const result = await chopsticks.createGrokSession({});
      setGrokSessionId((prev) => {
        const next = new Map(prev);
        next.set(result.runtimeSessionId, result.sessionId);
        return next;
      });
      addAgentTab({
        id: crypto.randomUUID(),
        sessionId: result.runtimeSessionId,
        terminalId: result.runtimeSessionId,
        title: 'grok',
        agentKind: 'grok',
      });
    } catch (err) {
      fail(err);
    }
  }, [addAgentTab, fail]);

  const newFakeAgent = useCallback(async () => {
    try {
      const desc = await chopsticks.createSession({
        kind: 'fake-agent',
        cols: SPAWN_COLS,
        rows: SPAWN_ROWS,
      });
      addAgentTab({
        id: crypto.randomUUID(),
        sessionId: desc.sessionId,
        terminalId: desc.sessionId,
        title: 'fake agent',
      });
    } catch (err) {
      fail(err);
    }
  }, [addAgentTab, fail]);

  const resumeClaude = useCallback(
    async (runtimeSessionId: string) => {
      const sessionId = claudeSessionId.get(runtimeSessionId);
      const data = agentWorkspace.get(runtimeSessionId);
      if (!sessionId || !data) return;
      const { info, final } = data;
      let workspace: { isolation: 'shared'; path?: string };
      let note: string | undefined;
      if (info.isolation === 'worktree') {
        if (final?.retained) {
          workspace = { isolation: 'shared', path: info.root };
        } else {
          workspace = { isolation: 'shared' };
          note = 'worktree gone — resumed on repo root';
        }
      } else {
        workspace = { isolation: 'shared', path: info.root };
      }
      await startClaude({ resume: sessionId, workspace }, 'claude ⟲', note);
    },
    [claudeSessionId, agentWorkspace, startClaude],
  );

  const resumeCodex = useCallback(
    async (runtimeSessionId: string) => {
      const threadId = codexThreadId.get(runtimeSessionId);
      if (!threadId) return;
      try {
        const result = await chopsticks.createCodexSession({ resume: threadId });
        addAgentTab({
          id: crypto.randomUUID(),
          sessionId: result.runtimeSessionId,
          terminalId: result.runtimeSessionId,
          title: 'codex ⟲',
          agentKind: 'codex',
        });
      } catch (err) {
        fail(err);
      }
    },
    [addAgentTab, codexThreadId, fail],
  );

  const resumeGrok = useCallback(
    async (runtimeSessionId: string) => {
      const sessionId = grokSessionId.get(runtimeSessionId);
      if (!sessionId) return;
      try {
        const result = await chopsticks.createGrokSession({ resume: sessionId });
        setGrokSessionId((prev) => {
          const next = new Map(prev);
          next.set(result.runtimeSessionId, result.sessionId);
          return next;
        });
        addAgentTab({
          id: crypto.randomUUID(),
          sessionId: result.runtimeSessionId,
          terminalId: result.runtimeSessionId,
          title: 'grok ⟲',
          agentKind: 'grok',
        });
      } catch (err) {
        fail(err);
      }
    },
    [addAgentTab, fail, grokSessionId],
  );

  const resumeAgent = useCallback(
    async (runtimeSessionId: string) => {
      for (const tab of tabsRef.current) {
        const pane = Object.values(tab.panes).find((p) => p.sessionId === runtimeSessionId);
        if (!pane) continue;
        if (pane.agentKind === 'codex') return resumeCodex(runtimeSessionId);
        if (pane.agentKind === 'grok') return resumeGrok(runtimeSessionId);
        if (pane.agentKind === 'claude') return resumeClaude(runtimeSessionId);
      }
      return resumeClaude(runtimeSessionId);
    },
    [resumeClaude, resumeCodex, resumeGrok],
  );

  const resumeAgentRef = useRef(resumeAgent);
  resumeAgentRef.current = resumeAgent;

  // ─── Claude panel (imperative DOM, kept for agent observation) ────────

  useEffect(() => {
    const el = activityRef.current;
    if (!el || panelRef.current) return;
    panelRef.current = new AgentPanel(
      el,
      (runtimeSessionId, text) => chopsticks.submitPrompt({ runtimeSessionId, text }),
      (runtimeSessionId) => void resumeAgentRef.current(runtimeSessionId),
    );
  }, []);

  const focusedSession = (() => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return undefined;
    return tab.panes[tab.focusedPaneId];
  })();

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const pane = focusedSession;
    if (pane?.agentKind) {
      const workspace = pane.agentKind === 'claude' ? agentWorkspace.get(pane.sessionId) : undefined;
      const canResume =
        pane.agentKind === 'claude'
          ? claudeSessionId.has(pane.sessionId)
          : pane.agentKind === 'grok'
            ? grokSessionId.has(pane.sessionId)
            : codexThreadId.has(pane.sessionId);
      // Treat as exited if session no longer running in maps and we saw exit —
      // panel uses exited for Resume affordance; we pass false until exit wire.
      panel.render(
        pane.sessionId,
        pane.agentKind,
        agentState.get(pane.sessionId),
        agentEvents.get(pane.sessionId) ?? [],
        workspace,
        false,
        canResume,
      );
    } else {
      panel.hide();
    }
  }, [focusedSession, agentState, agentEvents, agentWorkspace, claudeSessionId, codexThreadId, grokSessionId]);

  // ─── Lifecycle: first tab, exit, IPC, restore, keybindings ────────────

  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;
    void (async () => {
      // Reload recovery: rebuild tabs for sessions still in the hub.
      const sessions = await chopsticks.list();
      if (cancelled) return;
      if (sessions.length === 0) {
        await newTab();
        return;
      }
      const restored: TabState[] = [];
      for (const descriptor of sessions) {
        const { snapshotBase64 } = await chopsticks.replay(descriptor.sessionId);
        if (cancelled) return;
        const paneId = crypto.randomUUID();
        const pane: PaneState = {
          id: paneId,
          sessionId: descriptor.sessionId,
          terminalId: descriptor.sessionId,
          title: basename(descriptor.command),
          snapshotBase64: snapshotBase64 || undefined,
        };
        restored.push({
          id: crypto.randomUUID(),
          tree: leaf(paneId),
          panes: { [paneId]: pane },
          focusedPaneId: paneId,
        });
      }
      if (cancelled || restored.length === 0) return;
      setTabs(restored);
      setActiveTabId(restored[0]!.id);
    })();

    return () => {
      cancelled = true;
    };
  }, [newTab]);

  useEffect(() => {
    return backend.pty.onExit((sessionId) => {
      for (const tab of tabsRef.current) {
        const pane = Object.values(tab.panes).find((p) => p.sessionId === sessionId);
        if (pane) {
          // Keep agent panes mounted so the panel can offer Resume; shell
          // panes close like Ghostty (exit / ctrl+d).
          if (pane.agentKind) {
            stopDiffPoll(sessionId);
            backend.injectOutput(
              pane.terminalId,
              pane.sessionId,
              textToB64(`\r\n\x1b[2m— session exited —\x1b[0m\r\n`),
            );
            return;
          }
          removePaneById(pane.id, { killSession: false });
          return;
        }
      }
    });
  }, [removePaneById, stopDiffPoll]);

  useEffect(() => {
    const unsubs = [
      chopsticks.onExit((exit: ExitEvent) => {
        // Banner is also emitted via backend.pty.onExit above.
        void exit;
      }),
      chopsticks.onAgentEvents((events: AgentEventMessage[]) => {
        setAgentEvents((prev) => {
          const next = new Map(prev);
          for (const { runtimeSessionId, envelope } of events) {
            const buf = [...(next.get(runtimeSessionId) ?? []), envelope];
            if (buf.length > EVENT_TAIL_MAX) buf.splice(0, buf.length - EVENT_TAIL_MAX);
            next.set(runtimeSessionId, buf);
          }
          return next;
        });
        setCodexThreadId((prev) => {
          let changed = false;
          const next = new Map(prev);
          for (const { runtimeSessionId, envelope } of events) {
            for (const tab of tabsRef.current) {
              const pane = Object.values(tab.panes).find((p) => p.sessionId === runtimeSessionId);
              if (pane?.agentKind === 'codex' && envelope.nativeSessionId) {
                next.set(runtimeSessionId, envelope.nativeSessionId);
                changed = true;
              }
            }
          }
          return changed ? next : prev;
        });
      }),
      chopsticks.onAgentState((state: AgentStateMessage) => {
        setAgentState((prev) => {
          const next = new Map(prev);
          next.set(state.runtimeSessionId, state);
          return next;
        });
        void chopsticks.workspaceDiff(state.runtimeSessionId).then((diff) => {
          if (!diff) return;
          setAgentWorkspace((cur) => {
            const d = cur.get(state.runtimeSessionId);
            if (!d || d.final) return cur;
            const next = new Map(cur);
            next.set(state.runtimeSessionId, { ...d, diff });
            return next;
          });
        });
      }),
      chopsticks.onWorkspaceFinal((event: WorkspaceFinalEvent) => {
        stopDiffPoll(event.runtimeSessionId);
        setAgentWorkspace((prev) => {
          const data = prev.get(event.runtimeSessionId);
          if (!data) return prev;
          const next = new Map(prev);
          next.set(event.runtimeSessionId, {
            ...data,
            final: event,
            diff: event.metadata.finalDiff,
          });
          return next;
        });
      }),
    ];
    return () => {
      for (const u of unsubs) u();
      for (const id of diffPollers.current.keys()) stopDiffPoll(id);
    };
  }, [stopDiffPoll]);

  // Bridge BrowserWindow focus → restty hollow cursor (restty:window-focus).
  useEffect(() => {
    return window.chopsticksWindow?.onFocusChange((focused) => {
      window.dispatchEvent(new CustomEvent('restty:window-focus', { detail: { focused } }));
    });
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const focusedPaneId = activeTab?.focusedPaneId ?? null;
  // Focus the active split and blur the rest so unfocused panes show a hollow
  // cursor (Ghostty / avocado demo). Each pane owns its own PTY so isActive
  // stays true for resize; cursor state is driven here via focus/blur.
  useEffect(() => {
    if (!focusedPaneId) return;
    for (const [paneId, actions] of paneActionsRef.current) {
      if (paneId === focusedPaneId) actions.focus();
      else actions.blur();
    }
  }, [activeTabId, focusedPaneId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey) return;
      const go = (fn: () => void): void => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      };
      const key = e.key.toLowerCase();
      if (key === 't' && !e.shiftKey) return go(() => void newTab());
      if (key === 'w' && !e.shiftKey)
        return go(() => {
          const tab = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
          if (tab) removePaneById(tab.focusedPaneId, { killSession: true });
        });
      if (key === 'd') return go(() => void splitFocused(e.shiftKey ? 'column' : 'row'));
      if ((key === ']' || key === '}') && e.shiftKey) return go(() => cycleTab(1));
      if ((key === '[' || key === '{') && e.shiftKey) return go(() => cycleTab(-1));
      if (key === ']') return go(() => cyclePane(1));
      if (key === '[') return go(() => cyclePane(-1));
      if (!e.shiftKey && /^[1-9]$/.test(e.key)) return go(() => selectTabIndex(Number(e.key)));
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [newTab, removePaneById, splitFocused, cyclePane, cycleTab, selectTabIndex]);

  // ─── Rendering ────────────────────────────────────────────────────────

  const renderPane = (tab: TabState, paneId: string): ReactNode => {
    const pane = tab.panes[paneId];
    if (!pane) return <div className="term-pane" />;
    const focused = tab.focusedPaneId === paneId;
    const dimmed = !focused && Object.keys(tab.panes).length > 1;
    return (
      <PaneView
        key={paneId}
        pane={pane}
        focused={focused}
        dimmed={dimmed}
        onFocus={() => focusPane(tab.id, paneId)}
        onActions={(actions) => {
          if (actions) paneActionsRef.current.set(paneId, actions);
          else paneActionsRef.current.delete(paneId);
        }}
        onInjected={() => injectedReady.current.add(paneId)}
        alreadyInjected={injectedReady.current.has(paneId)}
      />
    );
  };

  const showPanel = Boolean(focusedSession?.agentKind);

  return (
    <AvocadoProvider backend={backend}>
      <div className="app">
        <TabBar
          tabs={tabs.map((t) => ({
            id: t.id,
            title: t.panes[t.focusedPaneId]?.title ?? shellName,
          }))}
          activeTabId={activeTabId}
          isMac={isMac}
          onSelect={setActiveTabId}
          onClose={closeTab}
          onNew={() => void newTab()}
          actions={
            <>
              <button type="button" onClick={() => void newFakeAgent()}>
                fake
              </button>
              <select
                value={isolation}
                title="Claude workspace isolation"
                onChange={(e) => setIsolation(e.target.value === 'worktree' ? 'worktree' : 'shared')}
              >
                <option value="shared">shared</option>
                <option value="worktree">worktree</option>
              </select>
              <button type="button" className="accent" onClick={() => void newClaude()}>
                claude
              </button>
              <button type="button" onClick={() => void newCodex()}>
                codex
              </button>
              <button type="button" onClick={() => void newGrok()}>
                grok
              </button>
            </>
          }
        />
        <div className="work-body">
          <div className="surface-area">
            {tabs.map((tab) => (
              <div key={tab.id} className={`tab-content${tab.id === activeTabId ? '' : ' hidden'}`}>
                <SplitView
                  tree={tab.tree}
                  renderPane={(paneId) => renderPane(tab, paneId)}
                  onRatioChange={(splitId, ratio) => changeRatio(tab.id, splitId, ratio)}
                />
              </div>
            ))}
            {error && (
              <div className="error-toast" onClick={() => setError(null)} title="Dismiss">
                {error}
              </div>
            )}
          </div>
          <aside
            id="activity"
            className={!showPanel ? 'hidden' : undefined}
            ref={(el) => {
              activityRef.current = el;
            }}
          />
        </div>
      </div>
    </AvocadoProvider>
  );
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('workbench #root not found');
// Strict mode off: terminal engines need real mount/unmount (ghostty convention).
createRoot(rootEl).render(<App />);
