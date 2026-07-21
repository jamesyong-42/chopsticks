import type {
  AgentEventEnvelope,
  AgentHost,
  AgentSession,
  ObservationLevel,
  PromptReceipt,
  PromptSubmission,
  SessionRuntimeState,
  TerminalSpec,
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

/** Provider-owned live preparation. The runtime keeps this handle private and exposes only its serializable recipe. */
export interface PreparedProviderSession {
  readonly sessionId: string;
  readonly launch: TerminalSpec;
  adopt(runtimeSessionId: string): Promise<AgentSession>;
  dispose(): void | Promise<void>;
}

export interface AgentProviderSessionOptions {
  cwd: string;
  resume?: string;
  title?: string;
  host: AgentHost;
  /** Provider-owned launch options. Built-in callers get a discriminated typed facade below. */
  agentOptions?: unknown;
}

/** A provider is the only adapter-specific seam the unified runtime consumes. */
export interface AgentProvider {
  readonly kind: string;
  createSession(options: AgentProviderSessionOptions): Promise<AgentSession>;
  /** Optional split-phase launch for caller-owned terminals. Generic ACP intentionally omits this capability. */
  prepareSession?(options: AgentProviderSessionOptions): Promise<PreparedProviderSession>;
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
  /** Present when this session was bound to a caller-owned terminal through spawn-through. */
  preparationId?: string;
  /** External shim/vendor PID retained across exec, for caller-side lifecycle correlation. */
  processId?: number;
  workspace: AgentWorkspaceInfo;
}

export interface AgentSessionFailure {
  error: { code: WorkspaceErrorCode | 'AGENT_NOT_FOUND'; message: string };
}

export type CreateAgentSessionResult = AgentSessionInfo | AgentSessionFailure;

export type PreparationErrorCode =
  | WorkspaceErrorCode
  | 'AGENT_NOT_FOUND'
  | 'PREPARATION_UNSUPPORTED'
  | 'PREPARATION_NOT_FOUND'
  | 'PREPARATION_EXPIRED'
  | 'PREPARATION_CANCELLED'
  | 'PREPARATION_ALREADY_ADOPTED'
  | 'RUNTIME_SESSION_CONFLICT'
  | 'PREPARATION_ADOPT_FAILED';

export interface PreparationFailure {
  error: { code: PreparationErrorCode; message: string };
}

export interface PreparedAgentSessionInfo {
  preparationId: string;
  agent: string;
  sessionId: string;
  /** Execute this recipe exactly after binding the existing terminal with adoptPrepared. */
  launch: TerminalSpec;
  workspace: AgentWorkspaceInfo;
  expiresAt: string;
}

export type PrepareAgentSessionResult = PreparedAgentSessionInfo | PreparationFailure;

export interface AdoptPreparedSessionOptions {
  /** Routing id of the already-existing pane/PTY. */
  runtimeSessionId: string;
  /** PID of the shim that will be retained when it execs the real vendor CLI. */
  processId?: number;
}

export type AdoptPreparedSessionResult = AgentSessionInfo | PreparationFailure;

export type CancelPreparedSessionResult = { cancelled: true } | PreparationFailure;

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
  /** How long an unadopted preparation remains live. Default: 30 seconds. */
  preparationTtlMs?: number;
}

/** The single application-facing surface for every agent provider. */
export interface AgentRuntime {
  createSession(options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
  prepareSession(options: CreateAgentSessionOptions): Promise<PrepareAgentSessionResult>;
  adoptPrepared(preparationId: string, options: AdoptPreparedSessionOptions): Promise<AdoptPreparedSessionResult>;
  cancelPrepared(preparationId: string): Promise<CancelPreparedSessionResult>;
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
export type BuiltinAgentRuntime = Omit<AgentRuntime, 'createSession' | 'prepareSession'> & {
  createSession(options: BuiltinCreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
  prepareSession(options: BuiltinCreateAgentSessionOptions): Promise<PrepareAgentSessionResult>;
};
