import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assistantMessageEvent,
  createTranscriptObserver,
  type TranscriptObserver,
  type TranscriptRecordEvent,
} from './transcript-observer.js';

const SESSION_ID = '00000000-0000-4000-8000-0000000000f5';

const assistantLine = (id: string, text: string) =>
  `${JSON.stringify({
    type: 'assistant',
    uuid: `${id}-uuid`,
    timestamp: '2026-07-13T00:00:00.000Z',
    requestId: 'req_1',
    message: {
      model: 'claude-fable-5',
      id,
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text },
        { type: 'tool_use', id: 'toolu_x', name: 'Bash', input: {} },
      ],
      stop_reason: null,
    },
  })}\n`;

let observers: TranscriptObserver[] = [];
afterEach(() => {
  for (const o of observers) o.stop();
  observers = [];
});

function startObserver(path: string) {
  const records: TranscriptRecordEvent[] = [];
  // Long fallback interval: tests use notifyActivity(), the hook-signal path.
  const observer = createTranscriptObserver(path, { pollIntervalMs: 60_000 });
  observer.onRecord((r) => records.push(r));
  observers.push(observer);
  return { observer, records };
}

describe('createTranscriptObserver', () => {
  it('streams transcript records on notifyActivity (the hook-signal path)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'observer-'));
    const file = join(dir, `${SESSION_ID}.jsonl`);
    writeFileSync(file, assistantLine('msg_1', 'first answer'));

    const { observer, records } = startObserver(file);
    await observer.notifyActivity();
    expect(records).toHaveLength(1);
    expect(records[0].msgIndex).toBe(0);

    appendFileSync(file, assistantLine('msg_2', 'second answer'));
    await observer.notifyActivity();
    expect(records).toHaveLength(2);
  });

  it('tolerates a transcript that does not exist yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'observer-'));
    const file = join(dir, `${SESSION_ID}.jsonl`);
    const { observer, records } = startObserver(file);
    await observer.notifyActivity();
    expect(records).toHaveLength(0);

    writeFileSync(file, assistantLine('msg_1', 'late'));
    await observer.notifyActivity();
    expect(records).toHaveLength(1);
  });
});

describe('assistantMessageEvent', () => {
  it('extracts authoritative text from assistant records (displayOnly: false)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'observer-'));
    const file = join(dir, `${SESSION_ID}.jsonl`);
    writeFileSync(file, assistantLine('msg_1', 'the real text'));

    const { observer, records } = startObserver(file);
    await observer.notifyActivity();
    const event = assistantMessageEvent(records[0].message);
    expect(event).toEqual({
      type: 'assistant.message',
      messageId: 'msg_1',
      text: 'the real text',
      final: true,
      displayOnly: false,
    });
  });

  it('returns null for non-assistant records', () => {
    expect(assistantMessageEvent({ type: 'user', message: { content: 'hi' } } as never)).toBeNull();
  });
});
