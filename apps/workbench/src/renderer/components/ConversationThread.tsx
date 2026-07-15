import type { AgentConversationSnapshot, ConversationActivity } from '@vibecook/chopsticks-runtime';
import type { JSX } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export interface ConversationThreadProps {
  conversation: AgentConversationSnapshot;
  agentKind: string;
  workingFallback: boolean;
}

const ACTIVITY_ICON: Record<ConversationActivity['activity'], string> = {
  reasoning: '✦',
  command: '›_',
  'web-search': '◎',
  'file-read': '◫',
  'file-edit': '±',
  browser: '↗',
  mcp: '◇',
  other: '◆',
  permission: '!',
  subagent: '⑂',
  task: '○',
};

function Markdown({ children }: { children: string }): JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ children: label, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener">
              {label}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function Activity({ item }: { item: ConversationActivity }): JSX.Element {
  const active = item.status === 'running' || item.status === 'requested';
  return (
    <details className={`activity-card ${item.activity} ${item.status}`} open={active || item.status === 'failed'}>
      <summary>
        <span className="activity-icon" aria-hidden="true">
          {ACTIVITY_ICON[item.activity]}
        </span>
        <span className="activity-title">{item.title}</span>
        {active && <span className="activity-spinner" aria-label="in progress" />}
        {!active && <span className="activity-state">{item.status === 'failed' ? 'failed' : 'done'}</span>}
      </summary>
      {(item.detail || item.summary) && (
        <div className="activity-detail">
          {item.detail && <code>{item.detail}</code>}
          {item.summary && <Markdown>{item.summary}</Markdown>}
        </div>
      )}
    </details>
  );
}

export function ConversationThread({ conversation, agentKind, workingFallback }: ConversationThreadProps): JSX.Element {
  const hasActivePresentation = conversation.items.some(
    (item) =>
      (item.kind === 'activity' && (item.status === 'running' || item.status === 'requested')) ||
      (item.kind === 'assistant' && item.streaming),
  );

  if (conversation.items.length === 0 && !workingFallback) {
    return <div className="thread-empty">No messages yet. Send one below to get started.</div>;
  }

  return (
    <>
      {conversation.items.map((item) => {
        if (item.kind === 'activity') return <Activity key={item.id} item={item} />;
        if (item.kind === 'notice') {
          return (
            <div key={item.id} className={`msg note ${item.tone === 'error' ? 'error' : ''}`}>
              <div className="msg-note">{item.text}</div>
            </div>
          );
        }
        return (
          <article key={item.id} className={`msg ${item.kind}`}>
            <div className="msg-role" data-kind={item.kind === 'assistant' ? agentKind : undefined}>
              {item.kind === 'user' ? 'you' : agentKind}
            </div>
            <div className="msg-body">
              {item.kind === 'user' ? <Markdown>{item.text}</Markdown> : <Markdown>{item.markdown}</Markdown>}
              {item.kind === 'assistant' && item.streaming && <span className="stream-cursor">▍</span>}
            </div>
          </article>
        );
      })}
      {workingFallback && !hasActivePresentation && (
        <div className="activity-card transient running">
          <div className="activity-transient-row">
            <span className="activity-icon">○</span>
            <span className="activity-title">Working…</span>
            <span className="activity-spinner" aria-label="in progress" />
          </div>
        </div>
      )}
    </>
  );
}
