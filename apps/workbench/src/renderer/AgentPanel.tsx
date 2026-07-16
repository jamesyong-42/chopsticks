import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AgentConversationSnapshot } from '@vibecook/chopsticks-runtime';
import type {
  AgentStateMessage,
  PromptReceipt,
  WorkspaceDiff,
  WorkspaceFinalEvent,
  WorkspaceInfo,
} from '../protocol.js';
import { ConversationThread } from './components/ConversationThread.js';

const WS_FILES_MAX = 12;
const EMPTY_CONVERSATION: AgentConversationSnapshot = { items: [], responding: false };

export interface WorkspacePanelData {
  info: WorkspaceInfo;
  diff?: WorkspaceDiff;
  final?: WorkspaceFinalEvent;
  note?: string;
}

interface AgentPanelProps {
  runtimeSessionId: string;
  agentKind: string;
  message: AgentStateMessage | undefined;
  workspace: WorkspacePanelData | undefined;
  exited: boolean;
  canResume: boolean;
  onSubmit: (runtimeSessionId: string, text: string) => Promise<PromptReceipt>;
  onResume: (runtimeSessionId: string) => void;
}

function truncatePath(path: string, max = 42): string {
  return path.length <= max ? path : `…${path.slice(path.length - (max - 1))}`;
}

function WorkspaceDetails({ data }: { data: WorkspacePanelData }) {
  const { info, diff, final } = data;
  const files = final ? final.metadata.filesTouched : (diff?.filesTouched ?? []);
  const commit = final?.metadata.finalCommit ?? info.initialCommit;
  return (
    <details className="ws-disclosure">
      <summary className="ws-summary">
        <span className="ws-tag">{info.mode}</span>
        <span className="ws-branch">{info.branch ?? ''}</span>
        <span className="ws-count">
          {files.length} file{files.length === 1 ? '' : 's'}
        </span>
      </summary>
      <div className="ws-body">
        <div className="ws-root" title={info.root}>
          {truncatePath(info.root)}
        </div>
        {commit ? (
          <div className="ws-commit">
            {final ? 'final' : 'base'} {commit.slice(0, 8)}
          </div>
        ) : null}
        {data.note ? <div className="ws-note">{data.note}</div> : null}
        {final?.retained ? (
          <div className="ws-retained">worktree retained — {final.reason ?? 'uncommitted changes kept'}</div>
        ) : null}
        {files.length ? (
          <ul className="ws-files">
            {files.slice(0, WS_FILES_MAX).map((file) => (
              <li key={file} className="ws-file" title={file}>
                {file}
              </li>
            ))}
            {files.length > WS_FILES_MAX ? (
              <li className="ws-file more">… +{files.length - WS_FILES_MAX} more</li>
            ) : null}
          </ul>
        ) : null}
      </div>
    </details>
  );
}

export function AgentPanel({
  runtimeSessionId,
  agentKind,
  message,
  workspace,
  exited,
  canResume,
  onSubmit,
  onResume,
}: AgentPanelProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [receipt, setReceipt] = useState<{ tone: string; text: string }>({
    tone: '',
    text: 'Enter to send · Shift+Enter for newline',
  });
  const [now, setNow] = useState(Date.now());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const state = message?.state;
  const conversation = message?.conversation ?? EMPTY_CONVERSATION;
  const activeTool = state?.tools.find((tool) => tool.state === 'running' || tool.state === 'requested');
  const liveLabel = state?.permissions.length
    ? 'Waiting for permission'
    : activeTool
      ? (activeTool.presentation?.title ?? `Using ${activeTool.tool ?? 'tool'}`)
      : state?.activeReasoning
        ? 'Thinking'
        : conversation.responding
          ? 'Responding'
          : state?.activeTurn
            ? 'Working'
            : '';
  const activityStartedAt = state?.activeReasoning?.startedAt ?? state?.activeTurn?.startedAt;
  const active = Boolean(activityStartedAt || liveLabel);
  const lifecycle = state?.lifecycle ?? 'preparing';
  const statusTone = active
    ? 'working'
    : lifecycle === 'failed'
      ? 'failed'
      : lifecycle === 'exited' || exited
        ? 'exited'
        : lifecycle === 'ready'
          ? 'ready'
          : 'idle';
  const statusText = active
    ? `${liveLabel || 'Working'} · ${activityStartedAt ? Math.max(0, Math.round((now - Date.parse(activityStartedAt)) / 1000)) : 0}s`
    : lifecycle === 'exited' || exited
      ? 'exited'
      : lifecycle;

  useEffect(() => {
    setText('');
    setSending(false);
    setReceipt({ tone: '', text: 'Enter to send · Shift+Enter for newline' });
    stickToBottomRef.current = true;
  }, [runtimeSessionId]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => {
    const thread = threadRef.current;
    if (thread && stickToBottomRef.current) thread.scrollTop = thread.scrollHeight;
  }, [conversation]);

  const resizeInput = (): void => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  };

  const submit = async (): Promise<void> => {
    if (sending || exited || !text.trim()) return;
    const submittedText = text;
    setSending(true);
    setReceipt({ tone: 'pending', text: 'sending…' });
    let result: PromptReceipt;
    try {
      result = await onSubmit(runtimeSessionId, submittedText);
    } catch (cause) {
      result = { status: 'rejected', reason: cause instanceof Error ? cause.message : String(cause) };
    }
    setReceipt({
      tone: result.status,
      text: result.status === 'confirmed' ? 'sent' : `${result.status}: ${result.reason}`,
    });
    setSending(false);
    if (result.status === 'confirmed') {
      setText('');
      window.requestAnimationFrame(resizeInput);
    }
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  return (
    <div id="activity" className="activity chat" data-busy={active ? '1' : '0'}>
      <div className="chat-header">
        <span className="kind-badge" data-kind={agentKind}>
          {agentKind}
        </span>
        <span className="status-pill">
          <span className="status-dot" data-tone={statusTone} />
          <span className="status-text">{statusText}</span>
        </span>
        {exited && canResume ? (
          <button type="button" className="resume-btn" onClick={() => onResume(runtimeSessionId)}>
            ⟲ Resume
          </button>
        ) : null}
      </div>

      {state?.permissions.length ? (
        <div className="perms-banner">
          <span className="perms-icon">⚠</span>
          <span className="perms-text">
            Waiting for permission:{' '}
            {state.permissions.map((permission) => permission.tool ?? permission.requestId).join(', ')}
          </span>
        </div>
      ) : null}

      {workspace ? <WorkspaceDetails data={workspace} /> : null}

      <div
        ref={threadRef}
        className="chat-thread"
        onScroll={(event) => {
          const thread = event.currentTarget;
          stickToBottomRef.current = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
        }}
      >
        <ConversationThread
          conversation={conversation}
          agentKind={agentKind}
          workingFallback={Boolean(state?.activeTurn)}
        />
      </div>

      <div className="composer">
        <textarea
          ref={inputRef}
          className="composer-input"
          rows={1}
          value={text}
          disabled={sending || exited}
          placeholder={exited ? 'Agent session exited' : 'Message the agent…'}
          onChange={(event) => {
            setText(event.currentTarget.value);
            resizeInput();
          }}
          onKeyDown={onComposerKeyDown}
        />
        <div className="composer-row">
          <div className={`composer-receipt ${receipt.tone}`}>{receipt.text}</div>
          <button type="button" className="composer-send" disabled={sending || exited} onClick={() => void submit()}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
