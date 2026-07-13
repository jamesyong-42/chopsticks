Native TUI Coding Agent Runtime

Architecture Design · v0.2 Draft · July 12, 2026 · Revised after Spaghetti-integration review

Status: Proposed
Primary language: TypeScript
Initial host: Electron
Initial agent integration: Claude Code
Target platforms: macOS, Windows, Linux
Primary user experience: Original, unmodified agent terminal interfaces

⸻

1. Summary

The Native TUI Coding Agent Runtime is a TypeScript library for discovering, launching, displaying, observing, controlling, and managing coding agents that run as terminal applications.

The runtime preserves each agent’s original terminal user interface. Claude Code should look and behave like Claude Code. Codex should retain Codex’s interface. Gemini CLI should retain Gemini CLI’s interface.

The runtime does not replace these interfaces with a generic chat UI. Instead, it hosts the agent inside a pseudoterminal and adds management capabilities around it:

* Process and PTY lifecycle management
* Exact terminal rendering through xterm.js
* Keyboard, mouse, paste, resize, and control-sequence forwarding
* Structured lifecycle and tool-event observation through native hooks
* Programmatic prompt submission through guarded PTY input
* Session recording and renderer reconnection
* Workspace isolation
* Process-tree termination
* Agent capability detection
* Cross-agent event normalization
* Optional structured or ACP execution modes for automation

The central architectural rule is:

In native-TUI mode, the agent owns its interface. The runtime owns the environment around the interface.

For Claude Code, native interactive mode and structured stream-json print mode are separate CLI modes. Therefore, one Claude process should not be expected to provide both the native TUI and the print-mode JSON stream. Claude’s native hooks provide the semantic side channel for native-TUI sessions. (Claude Platform Docs)

⸻

2. Problem Statement

Coding agents increasingly provide distinct terminal interfaces with their own:

* Input editors
* Permission dialogs
* Progress indicators
* Tool-call presentation
* Slash commands
* Keyboard shortcuts
* Session pickers
* Model and mode selectors
* Themes and visual identity
* Subagent and task presentation

A generic orchestration application usually loses these features by replacing the native interface with a normalized chat UI.

Conversely, simply spawning agent CLIs in terminals provides no reliable way to:

* Know when a turn begins or ends
* Identify tool calls
* Detect pending permissions
* Track active subagents
* Submit prompts safely
* Persist operational session state for replay and reconnection
* Coordinate multiple sessions
* Recover from renderer restarts
* Isolate concurrent write-capable agents
* Expose a stable TypeScript API

This runtime must solve both sides of the problem:

1. Preserve the agent’s native terminal experience.
2. Add structured management without scraping or replacing that experience.

2.1 Related system: Spaghetti (division of responsibility)

This runtime is layer #2 of a three-part system:

1. **Spaghetti** — static agent-data platform. Parses and indexes agent ground truth on disk (session transcripts, settings, todos, plans, subagents, workflows) into SQLite + FTS. Owns browsing, search, and historical timelines. Its index is a pure function of files on disk and is rebuildable at any time.
2. **This runtime (chopsticks)** — agent lifecycle. Spawns agents, owns their processes and PTYs, observes live activity through side channels, and controls behavior through guarded input.
3. **Application glue** — composes the two: fleet UI, pipelines, and agent-to-agent flows are app logic over runtime session handles plus Spaghetti queries.

The persistence boundary that keeps both libraries honest:

* The runtime persists **operational state only**: terminal byte recordings (information that exists nowhere else on disk), its own normalized/native event log for replay and receipts, and workspace metadata. This is the emitting side writing its own record; it never becomes a search index.
* Spaghetti persists the **historical index**: transcripts, sessions, and cross-session search. The runtime never grows browse or search features. If runtime records later become worth searching, Spaghetti indexes them as one more file source.

Two integration contracts follow:

* The runtime generates the agent-native session UUID at spawn (for Claude Code, `--session-id`). Correlation between a runtime session, its transcript on disk, and Spaghetti’s index is therefore deterministic — no fingerprinting or timing heuristics.
* The Claude transcript observer (Section 16.8) is implemented on the Spaghetti SDK rather than as a new parser.

⸻

3. Goals

3.1 Primary goals

The runtime shall:

1. Launch coding-agent CLIs inside real pseudoterminals.
2. Display their original TUI through xterm.js without reinterpretation.
3. Forward terminal input with minimal transformation.
4. Observe semantic activity through agent-native side channels.
5. Normalize common events without discarding native data.
6. Support multiple concurrent agent sessions.
7. Allow guarded programmatic prompt submission.
8. Persist enough information to replay, inspect, and reconnect sessions.
9. Clean up complete process trees.
10. Isolate write-capable sessions through independent workspaces.
11. expose a stable TypeScript API independent of individual agent CLIs.
12. Support Electron without coupling the core library to Electron.

3.2 Secondary goals

The runtime should eventually support:

* Headless structured sessions
* ACP clients
* Agent SDK integrations
* Remote agent hosts
* Container-backed workspaces
* Multi-agent workflows
* Scheduling and resource policies
* Session handoff
* Shared session observation
* CI execution

⸻

4. Non-Goals

The initial implementation shall not:

* Rebuild Claude Code’s TUI.
* Parse terminal text as the authoritative semantic event source.
* Promise identical semantic coverage across all agents.
* Merge output from two separate agent processes and present it as one session.
* Automatically approve privileged operations by default.
* Guarantee PTY reattachment after the Electron main process itself crashes.
* Depend on transcript formats for lifecycle correctness. Lifecycle derives from hooks and process state; transcript observation (via Spaghetti) enriches semantic history.
* Provide process isolation equivalent to a security sandbox.
* Run the terminal host with administrator or root privileges.
* Treat ACP as the controller of a simultaneously running native TUI session.

⸻

5. Architectural Decisions

ADR-001 — Native TUI is a first-class execution mode

The runtime will explicitly support:

type AgentExecutionMode =
  | "native-tui"
  | "structured"
  | "acp";

native-tui is not a fallback. It is the preferred mode when the user wants the original interface.

ADR-002 — A native session has one agent process

A native Claude Code session consists of one interactive Claude process attached to one PTY.

The runtime will not launch a second structured Claude process and attempt to synchronize it with the TUI process. Two processes would have separate model context, permission state, tool state, timing, and session ownership.

ADR-003 — Semantic events come from side channels

Semantic state shall be derived from, in priority order:

1. Native agent hooks or plugin APIs
2. Supported native logs or transcripts
3. Workspace and process observations
4. Terminal-screen inference

Terminal-screen inference is always optional and explicitly marked as inferred.

ADR-004 — PTY output is visually authoritative

Raw PTY output is the source of truth for what the user sees.

The runtime shall not parse, strip, reorder, or re-render the agent’s VT output before sending it to the visible terminal.

ADR-005 — Semantic state is not derived from xterm

xterm.js and @xterm/headless interpret terminal control sequences and maintain terminal state. They do not inherently understand agent turns, tool calls, permissions, or model output.

ADR-006 — Native and structured modes use separate drivers

An agent adapter may expose multiple drivers:

interface AgentAdapter {
  nativeTui?: NativeTuiDriver;
  structured?: StructuredDriver;
  acp?: AcpDriver;
}

The caller chooses the execution mode when creating a session.

ADR-007 — Electron main process owns PTYs

The Electron renderer shall never own or directly spawn agent processes.

The Electron main process, or a future external runtime daemon, owns:

* PTYs
* Processes
* Hook servers
* Session state
* Persistence
* Workspaces
* Secrets
* Process-tree cleanup

ADR-008 — Unknown native events are retained

Every adapter shall preserve the original native event alongside any normalized representation.

This prevents upstream additions from becoming data loss.

⸻

6. System Context

┌─────────────────────────────────────────────────────────┐
│ Electron renderer                                       │
│                                                         │
│  xterm.js        Session UI        Tool/activity panels │
│      │                │                    ▲             │
└──────┼────────────────┼────────────────────┼─────────────┘
       │ terminal IPC   │ control IPC        │ event IPC
       ▼                ▼                    │
┌─────────────────────────────────────────────────────────┐
│ Runtime host                                            │
│ Electron main process initially                         │
│                                                         │
│  Session manager                                        │
│  ├── NativeTerminalSession                              │
│  ├── SessionStateReducer                                │
│  ├── EventStore                                         │
│  ├── WorkspaceProvider                                  │
│  └── ProcessTreeController                              │
│                                                         │
│  Terminal pipeline                                      │
│  ├── node-pty                                           │
│  ├── TerminalFanout                                     │
│  ├── HeadlessTerminalSink                               │
│  ├── RecordingSink                                      │
│  └── RendererSink                                       │
│                                                         │
│  Observer pipeline                                      │
│  ├── NativeHookObserver                                 │
│  ├── TranscriptObserver                                 │
│  ├── WorkspaceObserver                                  │
│  └── ProcessObserver                                    │
└───────────────┬─────────────────────┬───────────────────┘
                │ PTY                 │ hook side channel
                ▼                     ▼
       ┌────────────────┐    ┌─────────────────────┐
       │ Agent CLI      │    │ Local hook bridge   │
       │ Claude Code    │───►│ authenticated IPC   │
       └────────────────┘    └─────────────────────┘

⸻

7. Execution Modes

7.1 Native TUI mode

Native TUI mode launches the normal interactive CLI inside a PTY.

const session = await runtime.createSession({
  agent: "claude-code",
  mode: "native-tui",
  workspace: {
    repository: process.cwd(),
    isolation: "worktree",
  },
});

Characteristics:

* The user sees the original TUI.
* User input goes to the PTY.
* Agent output goes directly to xterm.js.
* Native hooks provide semantic observations.
* Programmatic prompts are injected through guarded terminal input.
* Native permission dialogs remain visible and usable.
* ACP does not control the session.

7.2 Structured mode

Structured mode uses:

* An official SDK
* JSONL input/output
* A noninteractive CLI
* Another agent-specific protocol

Characteristics:

* The runtime owns presentation.
* Machine-readable messages are authoritative.
* Prompt submission is protocol-level.
* The original TUI is not present.

7.3 ACP mode

ACP mode treats the runtime as an ACP client and the agent as an ACP server or subprocess.

ACP uses request/response methods and notifications, including initialization, session creation, prompting, updates, permissions, cancellation, and optional client-managed command terminals. ACP’s terminal/create represents terminals requested by the agent for commands; it does not represent the agent’s own native TUI. (Agent Client Protocol)

⸻

8. Package Architecture

Recommended monorepo layout:

packages/
  core/
    src/
      runtime.ts
      session.ts
      events.ts
      state.ts
      capabilities.ts
      errors.ts
  node-runtime/
    src/
      pty/
      processes/
      persistence/
      observers/
      environment/
  electron/
    src/
      main/
      preload/
      renderer/
  xterm/
    src/
      terminal-controller.ts
      renderer-sink.ts
      headless-sink.ts
      snapshot.ts
  workspaces/
    src/
      local-directory.ts
      git-worktree.ts
  adapter-claude/
    src/
      detection.ts
      native-driver.ts
      hook-config.ts
      hook-normalizer.ts
      transcript-observer.ts
  adapter-codex/
  adapter-gemini/
  acp/
    src/
      client.ts
      transport.ts
      normalizer.ts
  testing/
    src/
      fake-agent.ts
      fake-hook-source.ts
      pty-fixtures.ts

Recommended published package boundaries:

@native-agent/core
@native-agent/node
@native-agent/electron
@native-agent/xterm
@native-agent/workspaces
@native-agent/adapter-claude
@native-agent/adapter-codex
@native-agent/adapter-gemini
@native-agent/acp
@native-agent/testing

The actual package prefix is a placeholder.

⸻

9. Core Public API

export interface AgentRuntime {
  discoverAgents(
    options?: DiscoverAgentsOptions,
  ): Promise<AgentInstallation[]>;
  createSession(
    options: CreateSessionOptions,
  ): Promise<AgentSession>;
  getSession(sessionId: string): AgentSession | undefined;
  listSessions(): readonly SessionSummary[];
  dispose(): Promise<void>;
}
export interface CreateSessionOptions {
  agent: string;
  mode: AgentExecutionMode;
  installation?: AgentInstallationRef;
  workspace: WorkspaceRequest;
  terminal?: {
    cols?: number;
    rows?: number;
    environment?: Record<string, string>;
  };
  agentOptions?: Record<string, unknown>;
  persistence?: "ephemeral" | "recorded";
}
export interface AgentSession {
  readonly id: string;
  readonly descriptor: AgentDescriptor;
  readonly capabilities: AgentSessionCapabilities;
  getSnapshot(): SessionSnapshot;
  terminalOutput(
    options?: TerminalSubscriptionOptions,
  ): AsyncIterable<TerminalChunk>;
  events(
    options?: EventSubscriptionOptions,
  ): AsyncIterable<AgentEventEnvelope>;
  writeInput(input: TerminalInput): Promise<void>;
  sendPrompt(prompt: PromptSubmission): Promise<PromptReceipt>;
  resize(size: TerminalSize): Promise<void>;
  interrupt(): Promise<void>;
  terminate(options?: TerminateOptions): Promise<void>;
  dispose(): Promise<void>;
}

⸻

10. Agent Adapter API

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  detect(
    context: DetectionContext,
  ): Promise<AgentInstallation[]>;
  inspect(
    installation: AgentInstallation,
  ): Promise<AgentDescriptor>;
  createNativeTuiDriver?(
    context: DriverContext,
  ): NativeTuiDriver;
  createStructuredDriver?(
    context: DriverContext,
  ): StructuredDriver;
  createAcpDriver?(
    context: DriverContext,
  ): AcpDriver;
  normalizeNativeEvent(
    event: NativeAdapterEvent,
  ): readonly AgentEvent[];
}
export interface AgentDescriptor {
  id: string;
  displayName: string;
  version: string;
  executable: string;
  modes: AgentExecutionMode[];
  capabilities: AgentCapabilities;
  compatibility: {
    testedRange?: string;
    detectedFeatures: string[];
    warnings: string[];
  };
}

Adapters must capability-probe instead of relying only on hard-coded version ranges.

Examples:

* Inspect claude --version.
* Inspect claude --help.
* Verify required hook event names.
* Verify required CLI flags.
* Verify whether the configured settings schema is accepted.
* Report degraded semantic observation when capabilities are missing.

⸻

11. Native Session Components

export interface NativeTuiDriver {
  prepare(
    options: NativeSessionPrepareOptions,
  ): Promise<PreparedNativeSession>;
  spawn(
    prepared: PreparedNativeSession,
  ): Promise<NativeProcessHandle>;
  createObservers(
    prepared: PreparedNativeSession,
  ): Promise<NativeObserver[]>;
}
export interface PreparedNativeSession {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  terminal: {
    name: string;
    cols: number;
    rows: number;
  };
  filesToCleanup: string[];
  metadata: Record<string, unknown>;
}
export interface NativeProcessHandle {
  readonly pid: number;
  onData(listener: (data: Uint8Array) => void): Disposable;
  onExit(listener: (exit: ProcessExit) => void): Disposable;
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  interrupt(): Promise<void>;
  terminate(): Promise<void>;
  killTree(): Promise<void>;
}

⸻

12. Terminal Pipeline

12.1 Output flow

Agent PTY output
      │
      ▼
OrderedTerminalDistributor
      │
      ├── RendererTerminalSink
      ├── HeadlessTerminalSink
      ├── TerminalRecordingSink
      └── RecentOutputRingBuffer

All sinks receive the same ordered terminal chunks.

export interface TerminalChunk {
  sessionId: string;
  sequence: number;
  monotonicTime: number;
  data: Uint8Array;
}

The sequence number is assigned when the runtime receives the PTY chunk, before fan-out.

12.2 Visible terminal

The Electron renderer uses xterm.js.

terminal.onData(data => {
  runtimeApi.writeTerminalInput({
    sessionId,
    data,
    encoding: "utf8",
  });
});
terminal.onBinary(data => {
  runtimeApi.writeTerminalInput({
    sessionId,
    data,
    encoding: "binary",
  });
});
terminal.onResize(({ cols, rows }) => {
  runtimeApi.resizeTerminal({
    sessionId,
    cols,
    rows,
  });
});

xterm.js documents onData as the normal path for typed or pasted terminal input and recommends passing that data to the backing PTY. Its binary input event exists for non-UTF-8 terminal reports such as certain mouse encodings. (xtermjs.org)

12.3 Headless terminal mirror

The runtime maintains an optional headless terminal receiving the same ordered output.

Responsibilities:

* Current terminal buffer
* Cursor position
* Terminal modes
* Recent scrollback
* Renderer reconnection support
* Thumbnail or preview generation
* Debugging
* Detecting alternate-screen usage
* Detecting bracketed-paste mode

Non-responsibilities:

* Detecting tool calls
* Identifying model turns
* Determining permission state
* Parsing the agent protocol
* Reconstructing authoritative assistant messages

12.4 Backpressure

The PTY must not be blocked indefinitely by a slow renderer.

Each sink declares its delivery policy:

type TerminalSinkPolicy =
  | { type: "required"; maxQueueBytes: number }
  | { type: "replayable"; maxQueueBytes: number }
  | { type: "droppable"; maxQueueBytes: number };

Recommended policies:

* Recorder: required
* Headless terminal: required
* Active renderer: replayable
* Inactive renderer: droppable
* Remote observer: droppable

When a renderer falls behind:

1. Stop queuing unbounded chunks.
2. Mark the renderer subscription as desynchronized.
3. Send a new terminal snapshot or replay checkpoint.
4. Continue with live chunks after synchronization.

⸻

13. Electron Process Boundaries

13.1 Main process

The main process owns:

* Runtime instance
* PTYs
* Agent processes
* Hook bridge
* Workspaces
* Persistence
* Environment variables
* Secrets
* Event normalization
* Session reducer

13.2 Preload bridge

The preload script exposes a narrow API:

export interface AgentRuntimeRendererApi {
  createSession(
    request: CreateRendererSessionRequest,
  ): Promise<RendererSessionDescriptor>;
  attachTerminal(
    sessionId: string,
  ): Promise<MessagePort>;
  attachEvents(
    sessionId: string,
  ): Promise<MessagePort>;
  writeTerminalInput(
    request: WriteTerminalInputRequest,
  ): void;
  resizeTerminal(
    request: ResizeTerminalRequest,
  ): void;
  sendPrompt(
    request: SendPromptRequest,
  ): Promise<PromptReceipt>;
  interrupt(sessionId: string): Promise<void>;
  terminate(sessionId: string): Promise<void>;
}

High-volume terminal output should use a MessagePort or equivalent streaming IPC rather than one request-response IPC call per chunk.

13.3 Renderer

The renderer owns:

* xterm.js instance
* Visual layout
* Session tabs
* Activity panels
* Optional normalized event views
* User permission notifications
* Prompt composer
* Terminal focus state

It does not receive arbitrary secrets or unrestricted process APIs.

⸻

14. Normalized Event Model

14.1 Event envelope

export interface AgentEventEnvelope<
  T extends AgentEvent = AgentEvent,
> {
  sequence: number;
  sessionId: string;
  nativeSessionId?: string;
  turnId?: string;
  timestamp: string;
  monotonicTime: number;
  source:
    | "native-hook"
    | "native-transcript"
    | "workspace"
    | "process"
    | "terminal-inference"
    | "runtime";
  confidence:
    | "authoritative"
    | "derived"
    | "inferred";
  event: T;
  nativeEvent?: unknown;
}

14.2 Core event union

export type AgentEvent =
  | SessionStartedEvent
  | SessionReadyEvent
  | SessionExitedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | AssistantMessageEvent
  | ToolRequestedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ToolFailedEvent
  | PermissionRequestedEvent
  | PermissionResolvedEvent
  | SubagentStartedEvent
  | SubagentStoppedEvent
  | TaskCreatedEvent
  | TaskCompletedEvent
  | WorkspaceChangedEvent
  | ProcessStartedEvent
  | ProcessExitedEvent
  | NativeNotificationEvent
  | UnknownNativeEvent;

14.3 Example event interfaces

export interface ToolRequestedEvent {
  type: "tool.requested";
  toolCallId: string;
  tool: string;
  input: unknown;
}
export interface PermissionRequestedEvent {
  type: "permission.requested";
  requestId: string;
  toolCallId?: string;
  tool?: string;
  input?: unknown;
  presentation: "native-tui" | "host-ui";
}
export interface TurnCompletedEvent {
  type: "turn.completed";
  stopReason?: string;
}
export interface UnknownNativeEvent {
  type: "adapter.native-event";
  adapter: string;
  nativeType?: string;
}

14.4 Correlation

Events should be correlated using the strongest available identifiers:

1. Native session ID
2. Native prompt or turn ID
3. Tool-use ID
4. Task or subagent ID
5. Runtime session ID
6. Timestamp and event fingerprint

Because the runtime generates the native session UUID at spawn (Section 16.3), identifier 1 is always available for Claude Code sessions, and the same UUID keys the session’s transcript on disk and its rows in Spaghetti’s index. This is the runtime ↔ Spaghetti join contract.

The normalizer must not invent a tool-call relationship solely from timing when a native identifier is available.

⸻

15. Session State Model

Session state, turn state, tool state, permission state, and terminal state are separate.

export interface SessionRuntimeState {
  lifecycle:
    | "preparing"
    | "starting"
    | "ready"
    | "running"
    | "interrupting"
    | "terminating"
    | "exited"
    | "failed";
  activeTurn?: {
    id: string;
    startedAt: string;
    state:
      | "submitted"
      | "running"
      | "completing";
  };
  tools: Map<string, ToolRuntimeState>;
  permissions: Map<string, PermissionRuntimeState>;
  subagents: Map<string, SubagentRuntimeState>;
  tasks: Map<string, TaskRuntimeState>;
  terminal: {
    cols: number;
    rows: number;
    attachedRenderers: number;
    alternateScreen: boolean;
  };
  control: {
    owner: "user" | "runtime" | null;
    queuedPrompts: number;
  };
}

15.1 Simplified state flow

PREPARING
    │
    ▼
STARTING
    │ native session-start event
    ▼
READY
    │ user prompt submitted
    ▼
RUNNING
    │
    ├── permission requested
    │       └── permission remains separate state
    │
    ├── tool calls start and finish
    │
    └── stop / turn complete
            ▼
          READY

15.2 State reducer

All normalized events pass through a deterministic reducer:

function reduceSessionState(
  state: SessionRuntimeState,
  envelope: AgentEventEnvelope,
): SessionRuntimeState;

The reducer:

* Must be deterministic.
* Must tolerate duplicate events.
* Must tolerate unknown events.
* Must not throw because an upstream event arrived out of order.
* Should emit diagnostics for invalid transitions.
* Must preserve the raw event log for later reprocessing.

⸻

16. Claude Code Native Adapter

16.1 Claude integration strategy

The Claude native adapter uses:

* Interactive claude
* node-pty
* xterm.js
* Claude Code hooks
* A local authenticated hook bridge
* Optional transcript observation
* Optional workspace and process observation

Claude Code hooks can deliver JSON context through command-hook stdin or HTTP POST bodies. Current hook lifecycle events include session, turn, tool, permission, task, subagent, message-display, notification, compaction, working-directory, configuration, and file-change events. (Claude Platform Docs)

16.2 Session preparation

The adapter:

1. Detects the Claude executable.
2. Reads its version.
3. Verifies required CLI flags.
4. Allocates a runtime session UUID.
5. Creates a session-specific settings file.
6. Starts the hook bridge.
7. Creates an isolated environment.
8. Builds the interactive command.
9. Spawns Claude in a PTY.

Claude Code supports an explicit UUID session ID, session naming, settings overrides, permission-mode selection, and session resumption. (Claude Platform Docs)

16.3 Recommended command

claude \
  --session-id <runtime-generated-uuid> \
  --name <display-name> \
  --settings <session-settings-path> \
  --permission-mode default

Do not include:

-p
--print
--output-format stream-json
--input-format stream-json

Those flags belong to structured print mode rather than the native interactive session. (Claude Platform Docs)

16.4 Hook bridge topology

Use a hybrid hook bridge:

Low-frequency lifecycle/control hooks
    └── command hook
        └── small forwarder process
            └── local authenticated bridge
High-frequency supported hooks
    └── direct HTTP hook
        └── local authenticated bridge

The command forwarder is necessary for events that do not support HTTP handlers. Direct HTTP is preferable for high-frequency events such as message display where supported, because it avoids launching a forwarding process for every event.

Claude’s hook documentation notes that command hooks receive JSON on stdin, while HTTP hooks receive the same JSON in a POST body. HTTP hooks support authenticated headers through explicitly allowlisted environment-variable interpolation. (Claude Platform Docs)

16.5 Session-specific settings

Illustrative generated settings:

{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "<hook-forwarder-command>"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:<port>/hooks",
            "headers": {
              "Authorization": "Bearer $AGENT_RUNTIME_HOOK_TOKEN"
            },
            "allowedEnvVars": [
              "AGENT_RUNTIME_HOOK_TOKEN"
            ],
            "timeout": 5
          }
        ]
      }
    ],
    "MessageDisplay": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:<port>/hooks",
            "headers": {
              "Authorization": "Bearer $AGENT_RUNTIME_HOOK_TOKEN"
            },
            "allowedEnvVars": [
              "AGENT_RUNTIME_HOOK_TOKEN"
            ],
            "timeout": 2
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:<port>/hooks",
            "headers": {
              "Authorization": "Bearer $AGENT_RUNTIME_HOOK_TOKEN"
            },
            "allowedEnvVars": [
              "AGENT_RUNTIME_HOOK_TOKEN"
            ],
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:<port>/hooks",
            "headers": {
              "Authorization": "Bearer $AGENT_RUNTIME_HOOK_TOKEN"
            },
            "allowedEnvVars": [
              "AGENT_RUNTIME_HOOK_TOKEN"
            ],
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:<port>/hooks",
            "headers": {
              "Authorization": "Bearer $AGENT_RUNTIME_HOOK_TOKEN"
            },
            "allowedEnvVars": [
              "AGENT_RUNTIME_HOOK_TOKEN"
            ],
            "timeout": 5
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "<hook-forwarder-command>"
          }
        ]
      }
    ]
  }
}

The adapter should generate this from an event registry rather than maintaining a large handwritten literal.

16.6 Hook bridge API

export interface HookBridge {
  readonly endpoint: string;
  readonly token: string;
  start(): Promise<void>;
  events(): AsyncIterable<NativeHookEnvelope>;
  respond(
    requestId: string,
    response: HookResponse,
  ): Promise<void>;
  dispose(): Promise<void>;
}

Each inbound event receives:

export interface NativeHookEnvelope {
  requestId: string;
  receivedAt: string;
  remoteAddress: string;
  body: unknown;
}

The bridge must:

* Bind only to loopback.
* Authenticate every request.
* Limit request-body size.
* Apply per-event timeouts.
* Parse JSON safely.
* Acknowledge observational events immediately.
* Avoid blocking the Claude interface on persistence.
* Log malformed events without crashing the session.
* Reject requests for unknown sessions.
* Redact secrets before persistence.

16.7 Claude event normalization

export function normalizeClaudeHook(
  input: ClaudeHookInput,
): readonly AgentEvent[] {
  switch (input.hook_event_name) {
    case "SessionStart":
      return [{
        type: "session.started",
        nativeSessionId: input.session_id,
      }];
    case "UserPromptSubmit":
      return [{
        type: "turn.started",
        turnId: input.prompt_id,
        prompt: input.prompt,
      }];
    case "MessageDisplay":
      return [{
        type: "assistant.message",
        text: input.text,
        messageId: input.message_id,
        displayOnly: true,
      }];
    case "PreToolUse":
      return [{
        type: "tool.requested",
        toolCallId: input.tool_use_id,
        tool: input.tool_name,
        input: input.tool_input,
      }];
    case "PermissionRequest":
      return [{
        type: "permission.requested",
        requestId:
          input.tool_use_id ?? crypto.randomUUID(),
        toolCallId: input.tool_use_id,
        tool: input.tool_name,
        input: input.tool_input,
        presentation: "native-tui",
      }];
    case "PostToolUse":
      return [{
        type: "tool.completed",
        toolCallId: input.tool_use_id,
        tool: input.tool_name,
        output: input.tool_response,
      }];
    case "PostToolUseFailure":
      return [{
        type: "tool.failed",
        toolCallId: input.tool_use_id,
        tool: input.tool_name,
        error: input.error,
      }];
    case "Stop":
      return [{
        type: "turn.completed",
      }];
    case "StopFailure":
      return [{
        type: "turn.failed",
        error: input.error_type,
      }];
    case "SessionEnd":
      return [{
        type: "session.ended",
        reason: input.reason,
      }];
    default:
      return [{
        type: "adapter.native-event",
        adapter: "claude-code",
        nativeType: input.hook_event_name,
      }];
  }
}

The real implementation must validate each event with versioned schemas rather than casting untrusted JSON.

Verification warning: the event registry above must be capability-probed, not assumed. Spaghetti’s canonical hook-event record (`packages/sdk/src/types/hook-events.ts`) confirms SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, Stop, StopFailure, and others — but does **not** include MessageDisplay. Until a live probe confirms MessageDisplay and payload fields such as `prompt_id`, the adapter must not depend on them; `assistant.message` events fall back to the transcript observer, which is the stronger source for message content in any case.

16.8 Transcript observer

Hook events commonly include a transcript path, and the runtime already knows the transcript identity a priori because it generated the session UUID. (Claude Platform Docs)

The Claude transcript observer shall be implemented as a thin wrapper over the Spaghetti SDK’s live plane (a scoped watch of the session’s transcript file), not as a new parser. Spaghetti maintains the most complete Claude Code transcript parser available — dual-engine (TypeScript and Rust) with zero-diff parity gates — so transcript observation is not best-effort enrichment: it is the strongest semantic source after hooks, and for message content it is stronger than hooks.

interface TranscriptObserver {
  support:
    | "supported"
    | "best-effort"
    | "disabled";
  events(): AsyncIterable<NativeTranscriptEvent>;
}

Rules:

* Hook events remain authoritative for lifecycle management; transcripts are authoritative for message content and history.
* Transcript parsing failure must not fail the session.
* Transcript schema evolution is handled by the Spaghetti dependency, not by adapter-local parser versions.
* Unknown records are persisted as raw native records (Spaghetti applies the same retention rule).
* Duplicate messages are deduplicated against hook events.

⸻

17. Prompt Submission

17.1 Direct user input

Direct xterm input is the preferred prompt path.

User keyboard
    │
    ▼
xterm.js onData/onBinary
    │
    ▼
Electron IPC
    │
    ▼
PTY.write
    │
    ▼
Claude native input editor

This preserves Claude’s:

* Editing behavior
* History
* Slash commands
* Completion menus
* Keyboard shortcuts
* Permission selection
* Pasted content handling

17.2 Programmatic prompt submission

Programmatic prompt submission uses PTY input and must be treated as terminal automation, not as a formal protocol request.

export interface PromptSubmission {
  text: string;
  mode?: "paste-and-submit" | "paste-only";
  queuePolicy?: "reject" | "queue" | "replace-queued";
  confirmationTimeoutMs?: number;
}

Algorithm:

1. Verify that the session is ready.
2. Verify that no native permission request is pending.
3. Verify that no runtime prompt injection is already active.
4. Acquire the runtime interaction lease.
5. Normalize line endings.
6. Send bracketed-paste start.
7. Send prompt text.
8. Send bracketed-paste end.
9. Send Enter when using paste-and-submit.
10. Wait for a native UserPromptSubmit event whose prompt payload matches the injected text.
11. Return a confirmed receipt, or an uncertain result on timeout or prompt mismatch.
12. Release the interaction lease.

Matching the prompt payload is required, not optional: if the user submits their own prompt inside the confirmation window, an unmatched wait would misattribute the user’s turn as confirmation of the injected prompt.

async function submitPromptThroughPty(
  session: NativeTerminalSession,
  submission: PromptSubmission,
): Promise<PromptReceipt> {
  await session.control.acquire("runtime");
  try {
    assertPromptCanBeInjected(session.state);
    const text = submission.text.replace(/\r\n/g, "\n");
    const confirmation = session.events.waitFor(
      event =>
        event.event.type === "turn.started" &&
        promptMatches(event.event.prompt, text),
      submission.confirmationTimeoutMs ?? 5_000,
    );
    session.pty.write(encode("\x1b[200~"));
    session.pty.write(encode(text));
    session.pty.write(encode("\x1b[201~"));
    if (submission.mode !== "paste-only") {
      session.pty.write(encode("\r"));
    }
    const event = await confirmation;
    return {
      status: "confirmed",
      turnId: event.turnId,
    };
  } catch (error) {
    return {
      status: "uncertain",
      error: normalizeError(error),
    };
  } finally {
    session.control.release("runtime");
  }
}

17.3 Interaction lease

interface TerminalControlLease {
  owner: "user" | "runtime" | null;
  acquire(
    owner: "user" | "runtime",
  ): Promise<void>;
  release(
    owner: "user" | "runtime",
  ): void;
}

User input has priority.

When the user types during queued runtime automation:

* Cancel the pending injection where possible.
* Return terminal control to the user.
* Preserve the queued prompt as unsent.
* Never interleave user keystrokes with injected prompt bytes.

17.4 Prompt limitations

Programmatic injection can fail when:

* A modal overlay is active.
* A slash-command picker is open.
* Claude is waiting for permission.
* The native TUI changed its input behavior.
* The terminal is disconnected.
* The session is busy.
* The prompt was pasted but not submitted.

Therefore, sendPrompt() returns a receipt instead of assuming success.

export type PromptReceipt =
  | {
      status: "confirmed";
      turnId?: string;
    }
  | {
      status: "queued";
      queuePosition: number;
    }
  | {
      status: "rejected";
      reason: string;
    }
  | {
      status: "uncertain";
      error?: RuntimeError;
    };

⸻

18. Permissions

18.1 Native permission presentation

Default behavior:

permissionPresentation: "native-tui"

Claude owns:

* Permission dialog rendering
* User selection
* Keyboard navigation
* Remembered permission rules
* Mode switching

The runtime observes permission events and may:

* Display a session badge
* Send an operating-system notification
* Mark the session as requiring attention
* Record the requested tool
* Prevent programmatic prompt injection

It does not automatically respond.

18.2 Optional host permission presentation

A later mode may allow:

permissionPresentation: "host-ui"

Claude’s permission hooks can return allow or deny decisions through structured hook responses. (Claude Platform Docs)

This mode is separate because it partially replaces the native interaction experience.

18.3 Runtime policy

Even when using native dialogs, the runtime may enforce an outer safety policy:

export interface RuntimePolicy {
  evaluate(
    action: ObservedAgentAction,
    context: PolicyContext,
  ): Promise<PolicyDecision>;
}
export type PolicyDecision =
  | { outcome: "observe" }
  | { outcome: "block"; reason: string }
  | { outcome: "require-host-approval"; reason: string };

Outer-policy blocking should be opt-in because it changes native behavior.

⸻

19. Observer Stack

Every native adapter declares its observation capabilities.

export interface ObservationCapabilities {
  nativeHooks: boolean;
  messageEvents: boolean;
  toolEvents: boolean;
  permissionEvents: boolean;
  taskEvents: boolean;
  subagentEvents: boolean;
  transcript: boolean;
  workspace: boolean;
  processTree: boolean;
}

19.1 Source hierarchy

Native hooks
    │ authoritative lifecycle and tool state
    ▼
Native transcript
    │ best-effort message and metadata enrichment
    ▼
Workspace observer
    │ file modifications, Git state
    ▼
Process observer
    │ child commands, resource usage
    ▼
Terminal inference
      last-resort UI inference

19.2 Generic fallback levels

type ObservationLevel =
  | "native-hooks"
  | "native-log"
  | "workspace-process"
  | "terminal-only";

The runtime must expose the current observation level to callers.

It must never silently describe a terminal-only session as fully structured.

⸻

20. Workspace Management

20.1 Workspace abstraction

export interface WorkspaceProvider {
  create(
    request: WorkspaceRequest,
  ): Promise<Workspace>;
  inspect(
    workspaceId: string,
  ): Promise<WorkspaceSnapshot>;
  diff(
    workspaceId: string,
  ): Promise<WorkspaceDiff>;
  reset(
    workspaceId: string,
  ): Promise<void>;
  destroy(
    workspaceId: string,
  ): Promise<void>;
}

20.2 Workspace modes

export type WorkspaceRequest =
  | {
      repository: string;
      isolation: "shared";
    }
  | {
      repository: string;
      isolation: "worktree";
      baseRef?: string;
      branchName?: string;
    }
  | {
      directory: string;
      isolation: "copy";
    };

20.3 Default policy

For one session:

shared workspace allowed

For multiple write-capable sessions:

worktree or copied workspace required by default

20.4 Recorded workspace metadata

interface WorkspaceSessionMetadata {
  root: string;
  initialCommit?: string;
  initialDirtyState?: WorkspaceDiff;
  branch?: string;
  finalCommit?: string;
  finalDiff?: WorkspaceDiff;
  filesTouched: string[];
}

The runtime owns workspace isolation. It should not depend on each agent independently implementing concurrency safety.

⸻

21. Process Lifecycle

21.1 Spawn sequence

createSession
    │
    ├── detect installation
    ├── inspect capabilities
    ├── allocate workspace
    ├── start persistence
    ├── start hook bridge
    ├── generate agent settings
    ├── create PTY
    ├── spawn process
    ├── start observers
    └── wait for ready signal

21.2 Interruption

Interruption escalation:

1. Agent-specific protocol interrupt, when available
2. PTY Ctrl+C
3. Graceful process signal
4. Termination request
5. Process-tree kill

export interface InterruptPolicy {
  ctrlCGraceMs: number;
  terminateGraceMs: number;
  killTreeAfterMs: number;
}

21.3 Process trees

Agents may start:

* Shells
* Test runners
* Build tools
* Language servers
* Browser processes
* MCP servers

The runtime must track and terminate the complete owned process tree.

Recommended implementations:

* POSIX: process groups and signals
* Windows: Job Objects through a native helper
* Fallback: descendant enumeration with repeated termination

21.4 Exit classification

export type ProcessExitReason =
  | "completed"
  | "user-terminated"
  | "runtime-terminated"
  | "signal"
  | "crash"
  | "spawn-failed"
  | "workspace-failed"
  | "unknown";

A zero process exit code does not necessarily mean a turn succeeded. Process exit and semantic turn completion are separate facts.

⸻

22. Persistence

22.1 Storage model

This store is operational — replay, receipts, reconnection — not a search index. Browsing and search over agent history belong to Spaghetti (Section 2.1).

**RESCOPED 2026-07-13.** The SQLite event store below is **rejected**, by the same invariant that removed runtime-event persistence from Spaghetti: hook events mirror transcript content, transcripts are the durable record, and Spaghetti indexes them — a hub-side event database would be a second write path duplicating truth that already exists on disk. What persistence remains is narrowed to:

1. **The own-action record** — the one class of data whose only emitter is this runtime: prompt-injection receipts, workspace finalize metadata (files touched, retained-dirty worktrees), exit classifications, policy conflicts. Appended as plain JSONL under `~/.chopsticks/`; if it ever deserves search, Spaghetti indexes it as one more file source (emitter-writes-a-file rule).
2. **Byte-exact terminal recording** (§22.3) — the only data with no other source (`--resume` continues a conversation; it does not replay what the screen showed). Stays opt-in (§23.3 `persistent-raw`) until a real consumer exists.
3. **Session resumption** is the agent's native capability, not ours: the runtime holds every session's `--session-id` UUID, so resume is spawn configuration (`claude --resume <uuid>` through the normal prepared-spawn path), not storage.

~~SQLite: sessions / normalized_events / native_events / workspace_snapshots / prompt_submissions / process_records~~ — rejected (above).

Filesystem
├── own-actions.jsonl        (receipts, workspace finals, exit classifications)
├── terminal/<session-id>.bin  (OPT-IN raw recording, §23.3)
├── generated-settings/        (already implemented; cleaned per session)
└── diagnostics/               (on-demand export, §27.3)

22.2 Session record

interface PersistedSession {
  id: string;
  agentId: string;
  agentVersion: string;
  mode: AgentExecutionMode;
  nativeSessionId?: string;
  workspaceRoot: string;
  command: string;
  args: string[];
  createdAt: string;
  exitedAt?: string;
  exitReason?: ProcessExitReason;
  exitCode?: number;
  capabilities: AgentSessionCapabilities;
}

Do not persist secrets in command arguments or session metadata.

22.3 Terminal recording

Terminal data should be stored as framed binary chunks:

interface PersistedTerminalFrame {
  sequence: bigint;
  monotonicTimeNs: bigint;
  payloadLength: number;
  payload: Uint8Array;
}

This supports:

* Exact replay
* Timing-aware playback
* Debugging
* Rebuilding headless state
* Renderer reconnection

22.4 Normalized event log

**Rejected with the event store (2026-07-13, see §22.1)** — normalized events are derivable from transcripts plus the own-action record; persisting the stream would duplicate durable truth. The append-only/correction discipline below stays the contract for the IN-MEMORY event stream and for the own-action JSONL:

interface EventCorrection {
  type: "runtime.event-correction";
  targetSequence: number;
  replacement?: AgentEvent;
  reason: string;
}

22.5 Renderer reconnection

**Delivered (M1.5):** the avocado hub proxy's output buffer restores the renderer on reload — no persistence layer involved. The protocol below is the shape it implements:

1. Renderer requests session attachment.
2. Main process returns current metadata.
3. Runtime supplies a terminal checkpoint or replay window.
4. Renderer restores terminal state.
5. Runtime begins live streaming after the checkpoint sequence.
6. Renderer subscribes to normalized events from a requested sequence.

Version 1 does not guarantee PTY recovery after the main process exits.

Full application restart recovery requires moving the runtime host into a separate local daemon.

⸻

23. Security

A browser-rendered terminal exposes real shell access through JavaScript. xterm.js explicitly warns that terminal integration raises the application’s security requirements and that JavaScript with access to the terminal can observe keystrokes and control the shell. (xtermjs.org)

23.1 Required controls

* Electron context isolation enabled
* Node integration disabled in the renderer
* Narrow preload API
* Strict Content Security Policy
* No remote renderer content with terminal access
* No third-party analytics scripts on terminal pages
* No arbitrary renderer IPC channels
* Session-scoped authorization tokens
* Loopback-only hook bridge
* Random hook tokens
* Request-size limits
* Explicit environment-variable allowlist
* Secret redaction
* No root or administrator runtime
* No shell interpolation for executable arguments
* Workspace path validation
* Symlink-aware containment checks
* Audit logging for host-side actions

23.2 Environment construction

Do not forward the complete parent environment by default.

function buildAgentEnvironment(
  request: AgentEnvironmentRequest,
): Record<string, string> {
  return {
    PATH: request.path,
    HOME: request.sessionHome,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: request.locale,
    ...request.allowedCredentials,
    ...request.adapterVariables,
  };
}

23.3 Sensitive terminal data

Terminal recordings may contain:

* Tokens
* Passwords
* Source code
* Proprietary output
* Environment values
* User prompts

Recording policy must be explicit:

type RecordingPolicy =
  | "disabled"
  | "memory-only"
  | "persistent-raw";

Default:

memory-only

memory-only still supports renderer reconnection within the host process lifetime (headless mirror + ring buffer); replay across host restarts requires the persistent-raw opt-in, which stays local-only and requires explicit application configuration.

A persistent-redacted tier is deliberately absent. Redaction over a raw VT byte stream is not credibly implementable — secrets span chunk boundaries, interleave with escape sequences, and reappear in scrollback repaints — and a redacted default that leaks is worse than an honest opt-in raw tier. Reintroduce it only if a redactor is built and tested against those failure modes.

⸻

24. Error Model

export type RuntimeErrorCode =
  | "AGENT_NOT_FOUND"
  | "AGENT_VERSION_UNSUPPORTED"
  | "CAPABILITY_MISSING"
  | "PTY_SPAWN_FAILED"
  | "PROCESS_EXITED"
  | "HOOK_BRIDGE_FAILED"
  | "HOOK_AUTH_FAILED"
  | "HOOK_EVENT_INVALID"
  | "PROMPT_REJECTED"
  | "PROMPT_CONFIRMATION_TIMEOUT"
  | "TERMINAL_DISCONNECTED"
  | "WORKSPACE_CREATE_FAILED"
  | "WORKSPACE_CONFLICT"
  | "PERSISTENCE_FAILED"
  | "PROCESS_TREE_KILL_FAILED"
  | "SESSION_STATE_INVALID";
export interface RuntimeError {
  code: RuntimeErrorCode;
  message: string;
  recoverable: boolean;
  sessionId?: string;
  adapterId?: string;
  cause?: unknown;
  metadata?: Record<string, unknown>;
}

Errors are separated into:

* User-visible session errors
* Recoverable diagnostics
* Adapter compatibility warnings
* Internal invariant violations

A failed semantic observer must not necessarily terminate a healthy PTY session.

Example degradation:

Claude TUI running
Hook bridge failed
    │
    ├── terminal remains usable
    ├── observation level becomes workspace-process
    └── UI displays degraded-observation warning

⸻

25. Scheduling and Multi-Session Management

Scheduling is not required for the first Claude integration, but core APIs should avoid blocking it.

interface SessionResourceRequest {
  agentSlots: number;
  cpuWeight: number;
  memoryMb?: number;
  filesystemWeight?: number;
  networkWeight?: number;
  provider?: string;
}

Policies may include:

* Maximum concurrent agent sessions
* Maximum active turns
* One writer per shared workspace
* Per-provider concurrency
* Per-repository concurrency
* Per-session cost limit
* Per-session runtime limit
* Fair queueing

Native TUI sessions should normally remain alive even while idle, because the session and UI state belong to the persistent process.

⸻

26. Testing Strategy

26.1 Fake terminal agents

Create fixture executables that simulate:

* ANSI color output
* Alternate-screen usage
* Cursor movement
* Mouse tracking
* Bracketed paste
* Permission dialogs
* Long-running turns
* Child process trees
* Malformed UTF-8
* Large output floods
* Ignored interrupts
* Crashes
* Hook events
* Duplicate hook events
* Out-of-order hook events

26.2 Adapter conformance suite

Every native adapter shall pass:

detect executable
inspect version
spawn PTY
render initial TUI
forward keyboard input
forward binary input
resize PTY
receive native ready event
submit prompt
confirm prompt through native event
detect tool request
detect permission request
detect tool completion
detect turn completion
interrupt running turn
terminate process tree
record terminal output
restore renderer state
handle malformed native event
handle hook bridge loss
clean temporary settings
clean workspace

26.3 Claude integration tests

Real Claude tests are opt-in and require local authentication.

Test groups:

* CLI capability probe
* Settings-file validity
* Hook delivery
* Message-display event volume
* Prompt confirmation
* Native permission observation
* Session resumption
* Session naming
* Process termination
* Renderer reload

26.4 Electron integration tests

Use an Electron-compatible browser automation framework to test:

* Terminal mounting
* Key forwarding
* Clipboard paste
* Resize behavior
* Multiple tabs
* Renderer reload
* IPC isolation
* Session attachment
* Terminal snapshot restoration

26.5 State reducer tests

Use event-sequence fixtures and property testing.

Required properties:

* Replaying the same log produces the same state.
* Duplicate events do not corrupt state.
* Unknown events do not throw.
* Completed tools leave the active-tool map.
* Session exit ends active turns.
* Permission events cannot overwrite unrelated tool state.

⸻

27. Observability

The runtime should emit OpenTelemetry-compatible traces and metrics without requiring them.

27.1 Metrics

runtime_sessions_active
runtime_sessions_created_total
runtime_sessions_failed_total
runtime_terminal_bytes_total
runtime_terminal_sink_lag_bytes
runtime_hook_events_total
runtime_hook_events_invalid_total
runtime_prompt_confirmation_seconds
runtime_prompt_uncertain_total
runtime_process_kill_escalations_total
runtime_observer_degradations_total

27.2 Trace hierarchy

session.create
├── agent.detect
├── workspace.create
├── hook_bridge.start
├── settings.generate
├── pty.spawn
└── observer.start
turn
├── prompt.submit
├── tool.call
├── permission.wait
├── tool.complete
└── turn.complete

27.3 Diagnostics bundle

A user-exportable diagnostics bundle should contain:

* Runtime version
* Adapter version
* Agent version
* Capability probe results
* Sanitized spawn command
* Sanitized environment keys
* Normalized events
* Native event schemas
* Terminal tail
* Process exit information
* Workspace metadata

It should not include secrets by default.

⸻

28. Initial Implementation Plan

Scope guidance: Milestones 0–2 are the substantive v0.1 for a single implementer — everything after them should be re-scoped against real usage before starting. Within Milestones 3–4, defer the workspace diff and process observers first (git status polling covers most of their value); never defer terminal-pipeline work, which is the product’s spine.

Milestone 0 — Core contracts

Implement:

* Monorepo
* Core types
* Event envelopes
* Session state reducer
* Async event queues
* Error model
* Adapter registry

Exit criteria:

* Fake sessions can produce terminal chunks and semantic events.
* State can be replayed deterministically.

Milestone 1 — PTY and Electron terminal

Implement:

* node-pty transport
* xterm.js renderer
* Binary and text input forwarding
* Resize forwarding
* Terminal fan-out
* Ring buffer
* Renderer attachment
* Basic terminal recording

Exit criteria:

* Arbitrary full-screen TUIs render and accept input correctly.
* Renderer reload restores a usable terminal view.

Note: node-pty is a native module and must be rebuilt per Electron version. Set up electron-rebuild (or prebuilds) in CI during this milestone, not later — native-module drift discovered at Milestone 4 is far more expensive.

Milestone 2 — Claude native adapter

Implement:

* Claude detection
* Capability probing
* Generated settings
* Hook bridge
* Hook normalizer
* Claude state reducer integration
* Interactive spawning
* Native session ID and name
* Permission observation
* Prompt confirmation

Exit criteria:

* Claude’s original TUI is preserved.
* Turns, tools, permissions, and session lifecycle are visible as normalized events.
* A programmatic prompt can be submitted and confirmed.

Milestone 3 — Workspaces and cleanup

Implement:

* Shared directory provider
* Git worktree provider
* Process group or Job Object management
* Termination escalation
* Workspace snapshots
* Final diff recording

Exit criteria:

* Multiple Claude sessions can safely operate in separate worktrees.
* Terminating a session removes its owned descendants.

Milestone 4 — Persistence and recovery (RESCOPED 2026-07-13, see §22.1)

The event store and native-event storage are rejected (they duplicate
transcript truth that Spaghetti already indexes); renderer reconnection
shipped with the avocado adoption (M1.5). What remains, both thin:

* Own-action JSONL record (injection receipts, workspace finals, exit
  classifications, policy conflicts) under ~/.chopsticks/
* Native resume as spawn configuration (`claude --resume <session-id>`
  through the prepared-spawn path; a Resume affordance on exited sessions)

Exit criteria:

* Chopsticks' own actions are on disk and attributable per session.
* An exited session can be resumed into a new terminal tab.

Milestone 5 — Second native adapter

Implement either Codex or Gemini.

The purpose is to validate that:

* Core abstractions are not Claude-specific.
* Observation levels degrade honestly.
* Adapter-specific UI remains untouched.
* The normalized event model is extensible.

Milestone 6 — Structured and ACP modes

Implement:

* Structured session driver
* ACP client driver
* Capability negotiation
* Protocol-level prompting
* Protocol-level permissions
* Client-managed command terminals

These modes reuse workspace, persistence, event, policy, and scheduling infrastructure while bypassing the native-TUI driver.

⸻

29. Version 0.1 Acceptance Criteria

Version 0.1 is complete when:

1. Claude Code launches in an Electron xterm terminal.
2. The displayed interface is the real Claude Code TUI.
3. Keyboard, paste, resize, mouse, and control sequences work.
4. No structured print-mode process is required.
5. Session start and end are detected.
6. User prompt submission is detected.
7. Tool requests and completions are detected.
8. Permission requests are detected while remaining inside the native TUI.
9. Turn completion is detected.
10. Programmatic prompt submission uses a guarded PTY handshake.
11. Prompt submission reports confirmed, queued, rejected, or uncertain.
12. Renderer reload can restore the current session view.
13. Terminal output and semantic events are persisted separately.
14. Unknown native events are retained.
15. Hook failure degrades observation without killing the terminal.
16. Complete owned process trees can be terminated.
17. Concurrent sessions can use separate worktrees.
18. Renderer JavaScript cannot access unrestricted Node APIs or secrets.
19. The core package contains no Electron dependency.
20. At least one fake-agent conformance suite runs in CI.

⸻

30. Final Architecture Principle

The runtime is not a universal replacement UI for coding agents.

It is a host for their native experiences:

Agent owns
├── visual interface
├── input editor
├── shortcuts
├── permission interaction
├── slash commands
└── agent-specific personality
Runtime owns
├── PTY
├── process lifecycle
├── workspace
├── observation
├── event normalization
├── persistence
├── reconnection
├── security boundary
└── multi-session coordination

The resulting product can present Claude Code, Codex, Gemini CLI, and future agents exactly as their creators designed them, while still providing a coherent TypeScript runtime for session management and orchestration.
