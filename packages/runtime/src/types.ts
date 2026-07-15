import type {
  AgentEventEnvelope,
  AgentHost,
  AgentSession,
  ObservationLevel,
  PromptReceipt,
  PromptSubmission,
  SessionRuntimeState,
} from '@vibecook/chopsticks-core';
import type { ActionRecorder } from '@vibecook/chopsticks-record';
import type {
  WorkspaceDiff,
  WorkspaceErrorCode,
  WorkspaceMode,
  WorkspaceSessionMetadata,
} from '@vibecook/chopsticks-workspaces';
import type { AgentConversationSnapshot } from './conversation.js';

/** Built-in provider ids. Applications select one; implementation stays here. */
export type BuiltinAgentKind = 'claude' | 'codex' | 'grok';

/** A provider is the only adapter-specific seam the unified runtime consumes. */
export interface AgentProvider {
  readonly kind: string;
  createSession(options: { cwd: string; resume?: string; title?: string; host: AgentHost }): Promise<AgentSession>;
  dispose?(): void | Promise<void>;
}

export interface AgentWorkspaceRequest {
  mode?: WorkspaceMode;
  path?: string;
  baseRef?: string;
  branchName?: string;
  resumeBranch?: string;
  resumeRoot?: string;
  workspacesRoot?: string;
}

export interface AgentWorkspaceInfo {
  mode: WorkspaceMode;
  root: string;
  sourcePath: string;
  branch?: string;
  initialCommit?: string;
}

export interface CreateAgentSessionOptions {
  agent: string;
  cwd?: string;
  resume?: string;
  title?: string;
  /** Defaults to direct mode rooted at cwd/defaultCwd. */
  workspace?: AgentWorkspaceRequest;
}

export interface AgentSessionInfo {
  agent: string;
  sessionId: string;
  runtimeSessionId: string;
  workspace: AgentWorkspaceInfo;
}

export interface AgentSessionFailure {
  error: { code: WorkspaceErrorCode | 'AGENT_NOT_FOUND'; message: string };
}

export type CreateAgentSessionResult = AgentSessionInfo | AgentSessionFailure;

export interface AgentProcessExit {
  exitCode: number | null;
  signal: string | null;
  reason: string;
}

export interface AgentWorkspaceFinal {
  runtimeSessionId: string;
  metadata: WorkspaceSessionMetadata;
  retained: boolean;
  reason?: string;
}

export interface AgentRuntimeOptions {
  host: AgentHost;
  defaultCwd: string;
  providers: readonly AgentProvider[];
  recorder?: ActionRecorder;
  onError?: (error: Error) => void;
}

/** The single application-facing surface for every agent provider. */
export interface AgentRuntime {
  createSession(options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
  sessionInfo(runtimeSessionId: string): AgentSessionInfo | undefined;
  sessionState(runtimeSessionId: string): SessionRuntimeState | undefined;
  observationLevel(runtimeSessionId: string): ObservationLevel | undefined;
  conversationSnapshot(runtimeSessionId: string): AgentConversationSnapshot | undefined;
  onEvent(listener: (runtimeSessionId: string, envelope: AgentEventEnvelope) => void): () => void;
  submitPrompt(runtimeSessionId: string, submission: PromptSubmission): Promise<PromptReceipt>;
  notifyUserInput(runtimeSessionId: string): void;
  workspaceDiff(runtimeSessionId: string): Promise<WorkspaceDiff | null>;
  handleProcessExit(runtimeSessionId: string, exit: AgentProcessExit): Promise<AgentWorkspaceFinal | undefined>;
  dispose(): Promise<AgentWorkspaceFinal[]>;
}
