/**
 * Transcript observer (DESIGN §16.8) — authoritative message history from the
 * session's transcript, via spaghetti's scoped tail (`watchSessionTranscript`,
 * spaghetti-sdk ≥0.5.16). No second parser: cold-ingest parity is inherited.
 *
 * Latency model: hook events fire 1:1 with transcript appends, so the driver
 * calls `notifyActivity()` on every bridge envelope and the tail's poll
 * interval is only a fallback. Hooks remain authoritative for LIFECYCLE;
 * the transcript is authoritative for MESSAGE CONTENT (hook MessageDisplay
 * deltas are displayOnly) — consumers prefer `assistantMessageEvent` output
 * over display-sourced text when both exist.
 *
 * Observer failure must never fail the session (§16.8 rules): errors surface
 * on onError and the tail keeps retrying with backoff.
 */

import { watchSessionTranscript } from '@vibecook/spaghetti-sdk';
import type { SessionMessage, SessionTranscriptTail } from '@vibecook/spaghetti-sdk';
import type { AssistantMessageEvent } from '@vibecook/chopsticks-core';

export interface TranscriptRecordEvent {
  message: SessionMessage;
  msgIndex: number;
  /** True when the transcript was rewritten and indexing restarted. */
  rewrite: boolean;
}

export interface TranscriptObserverOptions {
  /** Fallback cadence; notifyActivity() is the primary signal. Default 1s. */
  pollIntervalMs?: number;
}

export interface TranscriptObserver {
  onRecord(listener: (event: TranscriptRecordEvent) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  /** Low-latency poke — call on every hook envelope for this session. */
  notifyActivity(): Promise<void>;
  stop(): void;
}

export function createTranscriptObserver(
  transcriptPath: string,
  options: TranscriptObserverOptions = {},
): TranscriptObserver {
  const tail: SessionTranscriptTail = watchSessionTranscript(transcriptPath, {
    pollIntervalMs: options.pollIntervalMs ?? 1000,
  });
  const recordListeners = new Set<(e: TranscriptRecordEvent) => void>();
  const errorListeners = new Set<(e: Error) => void>();

  tail.onMessage((event) => {
    const record: TranscriptRecordEvent = {
      message: event.message,
      msgIndex: event.msgIndex,
      rewrite: event.rewrite,
    };
    for (const listener of recordListeners) {
      try {
        listener(record);
      } catch {
        // Consumer faults stay out of the tail.
      }
    }
  });
  tail.onError((error) => {
    for (const listener of errorListeners) listener(error);
  });

  return {
    onRecord(listener) {
      recordListeners.add(listener);
      return () => recordListeners.delete(listener);
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    notifyActivity: () => tail.poll(),
    stop: () => tail.stop(),
  };
}

/**
 * Authoritative assistant text from a transcript record, or null for
 * non-assistant records. `displayOnly: false` marks it as the transcript
 * (durable) source, ranking above hook MessageDisplay accumulation.
 */
export function assistantMessageEvent(message: SessionMessage): AssistantMessageEvent | null {
  const record = message as {
    type?: string;
    message?: { id?: string; content?: Array<{ type?: string; text?: string }> };
  };
  if (record.type !== 'assistant' || !Array.isArray(record.message?.content)) return null;
  const text = record.message.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
  if (text.length === 0) return null;
  return {
    type: 'assistant.message',
    messageId: record.message.id,
    text,
    final: true,
    displayOnly: false,
  };
}
