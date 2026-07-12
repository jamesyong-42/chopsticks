import { describe, expect, it } from 'vitest';
import {
  createTerminalDistributor,
  type TerminalChunk,
  type TerminalSink,
  type TerminalSinkPolicy,
} from './distributor.js';
import type { RingReplay } from './ring-buffer.js';
import { TerminalRingBuffer } from './ring-buffer.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Collector extends TerminalSink {
  written: TerminalChunk[];
  resets: RingReplay[];
}

function collector(id: string, policy: TerminalSinkPolicy, writeDelayMs = 0): Collector {
  const written: TerminalChunk[] = [];
  const resets: RingReplay[] = [];
  return {
    id,
    policy,
    written,
    resets,
    async write(chunk) {
      if (writeDelayMs > 0) await delay(writeDelayMs);
      written.push(chunk);
    },
    async reset(replay) {
      resets.push(replay);
    },
  };
}

/** Sequences the sink has seen, combining resets and live writes, in arrival order. */
function seenSequences(sink: Collector): number[] {
  const fromResets = sink.resets.flatMap((r) => r.chunks.map((c) => c.sequence));
  const fromWrites = sink.written.map((c) => c.sequence);
  return [...fromResets, ...fromWrites].sort((a, b) => a - b);
}

describe('createTerminalDistributor', () => {
  it('stamps monotonic sequences and delivers in order to every sink', async () => {
    const d = createTerminalDistributor({ sessionId: 's' });
    const a = collector('a', { type: 'required', maxQueueBytes: 1 << 20 });
    const b = collector('b', { type: 'droppable', maxQueueBytes: 1 << 20 });
    d.attach(a);
    d.attach(b);
    d.push(bytes('one'));
    d.push(bytes('two'));
    d.push(bytes('three'));
    await d.idle();
    expect(a.written.map((c) => c.sequence)).toEqual([1, 2, 3]);
    expect(b.written.map((c) => c.sequence)).toEqual([1, 2, 3]);
    expect(new TextDecoder().decode(a.written[2].data)).toBe('three');
  });

  it('attach with replayAfter resynchronizes history through reset, then goes live', async () => {
    const d = createTerminalDistributor({ sessionId: 's' });
    d.push(bytes('h1'));
    d.push(bytes('h2'));
    const late = collector('late', { type: 'replayable', maxQueueBytes: 1 << 20 });
    d.attach(late, { replayAfter: 0 });
    await d.idle();
    d.push(bytes('live'));
    await d.idle();
    expect(late.resets.length).toBeGreaterThan(0);
    expect(late.resets[0].complete).toBe(true);
    expect(seenSequences(late)).toEqual([1, 2, 3]);
    expect(late.written.map((c) => c.sequence)).toContain(3);
  });

  it('droppable overflow desyncs, then recovers every sequence exactly once from the ring', async () => {
    let desyncs = 0;
    const d = createTerminalDistributor({
      sessionId: 's',
      onSinkDesync: () => desyncs++,
    });
    const slow = collector('slow', { type: 'droppable', maxQueueBytes: 32 }, 5);
    d.attach(slow);
    for (let i = 0; i < 50; i++) d.push(bytes(`chunk-${String(i).padStart(3, '0')}`));
    await d.idle();
    expect(desyncs).toBeGreaterThan(0);
    const seen = seenSequences(slow);
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    expect(seen[seen.length - 1]).toBe(50); // caught up to the tip
  });

  it('required sinks never drop: high-water fires but all chunks arrive in order', async () => {
    let highWater = 0;
    const d = createTerminalDistributor({ sessionId: 's', onRequiredHighWater: () => highWater++ });
    const slow = collector('rec', { type: 'required', maxQueueBytes: 16 }, 2);
    d.attach(slow);
    for (let i = 0; i < 20; i++) d.push(bytes(`c${i}`));
    await d.idle();
    expect(highWater).toBeGreaterThan(0);
    expect(slow.written.map((c) => c.sequence)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('a throwing sink is isolated and reported; other sinks continue', async () => {
    let errored = '';
    const d = createTerminalDistributor({ sessionId: 's', onSinkError: (id) => (errored = id) });
    const bad: TerminalSink = {
      id: 'bad',
      policy: { type: 'droppable', maxQueueBytes: 1 << 20 },
      write() {
        throw new Error('boom');
      },
    };
    const good = collector('good', { type: 'required', maxQueueBytes: 1 << 20 });
    d.attach(bad);
    d.attach(good);
    d.push(bytes('x'));
    d.push(bytes('y'));
    await d.idle();
    expect(errored).toBe('bad');
    expect(good.written.length).toBe(2);
  });
});

describe('TerminalRingBuffer', () => {
  const chunk = (sequence: number, size = 10): TerminalChunk => ({
    sessionId: 's',
    sequence,
    monotonicTime: sequence,
    data: new Uint8Array(size),
  });

  it('evicts oldest first and reports incomplete replays after eviction', () => {
    const ring = new TerminalRingBuffer(25);
    ring.push(chunk(1));
    ring.push(chunk(2));
    ring.push(chunk(3)); // 30 bytes > 25: chunk 1 evicted
    const replay = ring.replayAfter(0);
    expect(replay.chunks.map((c) => c.sequence)).toEqual([2, 3]);
    expect(replay.complete).toBe(false);
  });

  it('replays are complete when nothing in range was evicted', () => {
    const ring = new TerminalRingBuffer(1024);
    ring.push(chunk(1));
    ring.push(chunk(2));
    expect(ring.replayAfter(0).complete).toBe(true);
    expect(ring.replayAfter(1).chunks.map((c) => c.sequence)).toEqual([2]);
    expect(ring.replayAfter(2)).toEqual({ chunks: [], complete: true });
  });

  it('always retains the newest chunk even when oversized', () => {
    const ring = new TerminalRingBuffer(4);
    ring.push(chunk(1, 100));
    expect(ring.stats().chunks).toBe(1);
    expect(ring.replayAfter(0).chunks.length).toBe(1);
  });
});
