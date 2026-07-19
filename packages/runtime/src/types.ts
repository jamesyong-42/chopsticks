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
import type { CreateAcpSessionOptions } from '@vibecook/chopsticks-adapter-acp';
import type { CreateCodexTuiSessionOptions } from '@vibecook/chopsticks-adapter-codex';
import type { CreateGrokSessionOptions } from '@vibecook/chopsticks-adapter-grok';
import type { AgentConversationSnapshot } from './conversation.js';

/** Built-in provider ids. Applications select one; implementation stays here. */
export type BuiltinAgentKind = 'claude' | 'codex' | 'acp' | 'grok';
export type BuiltinExecutableAgentKind = Exclude<BuiltinAgentKind, 'acp'>;

export interface ClaudeAgentOptions {
  /** Claude Code permission mode. Kept open because the CLI's modes evolve. */
  permissionMode?: string;
  /** Claude model alias or full model id. */
  model?: string;
}

export type CodexAgentOptions = Pick<
  CreateCodexTuiSessionOptions,
  'model' | 'sandbox' | 'approvalPolicy' | 'onApproval'
>;

export type AcpAgentOptions = Omit<CreateAcpSessionOptions, 'cwd' | 'resume' | 'connector'> & {
  /** Per-session connector override; otherwise the runtime's configured ACP connector is used. */
  connector?: CreateAcpSessionOptions['connector'];
};

export type GrokAgentOptions = Omit<CreateGrokSessionOptions, 'cwd' | 'resume'>;

/** A provider is the only adapter-specific seam the unified runtime consumes. */
export interface AgentProvider {
  readonly kind: string;
  createSession(options: {
    cwd: string;
    resume?: string;
    title?: string;
    host: AgentHost;
    /** Provider-owned launch options. Built-in callers get a discriminated typed facade below. */
    agentOptions?: unknown;
  }): Promise<AgentSession>;
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
  /** Opaque to the runtime; interpreted only by the selected provider. */
  agentOptions?: unknown;
}

type BuiltinCreateBase = Omit<CreateAgentSessionOptions, 'agent' | 'agentOptions'>;

/** Type-safe launch options for the turn-key built-in provider set. */
export type BuiltinCreateAgentSessionOptions =
  | (BuiltinCreateBase & { agent: 'claude'; agentOptions?: ClaudeAgentOptions })
  | (BuiltinCreateBase & { agent: 'codex'; agentOptions?: CodexAgentOptions })
  | (BuiltinCreateBase & { agent: 'acp'; agentOptions?: AcpAgentOptions })
  | (BuiltinCreateBase & { agent: 'grok'; agentOptions?: GrokAgentOptions });

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
  workspaceDiff(runtimeSessionId: string): Promise<WorkspaceDiff | null>;
  handleProcessExit(runtimeSessionId: string, exit: AgentProcessExit): Promise<AgentWorkspaceFinal | undefined>;
  dispose(): Promise<AgentWorkspaceFinal[]>;
}

/** Built-in runtime facade whose selected agent discriminates its launch options. */
export type BuiltinAgentRuntime = Omit<AgentRuntime, 'createSession'> & {
  createSession(options: BuiltinCreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
};
