/**
 * OrderedTerminalDistributor (DESIGN §12).
 *
 * One writer stamps sequence numbers before fan-out; every sink observes the
 * same order. Sinks declare a delivery policy (§12.4):
 * - required:   never dropped; a high-water callback fires if it lags
 * - replayable: on overflow the queue is cleared, the sink is marked
 *               desynchronized, and it is resynchronized from the ring buffer
 * - droppable:  same mechanism; `complete: false` replays mean the sink shows
 *               a truncated snapshot rather than a continuation
 *
 * The PTY is never blocked: enqueue is synchronous and bounded; sink writes
 * drain in per-sink async loops.
 */

import { performance } from 'node:perf_hooks';
import { TerminalRingBuffer, type RingReplay } from './ring-buffer.js';

export interface TerminalChunk {
  sessionId: string;
  sequence: number;
  monotonicTime: number;
  data: Uint8Array;
}

export type TerminalSinkPolicyType = 'required' | 'replayable' | 'droppable';

export interface TerminalSinkPolicy {
  type: TerminalSinkPolicyType;
  maxQueueBytes: number;
}

export interface TerminalSink {
  readonly id: string;
  readonly policy: TerminalSinkPolicy;
  write(chunk: TerminalChunk): void | Promise<void>;
  /**
   * Desync recovery: replace the sink's view from a ring replay. Sinks without
   * reset() receive the replay chunks through write() instead.
   */
  reset?(replay: RingReplay): void | Promise<void>;
}

export interface TerminalDistributorOptions {
  sessionId: string;
  /** Ring capacity backing reconnection and desync recovery. Default 1 MiB. */
  ringCapacityBytes?: number;
  now?: () => number;
  onSinkDesync?: (sinkId: string, droppedBytes: number) => void;
  onSinkError?: (sinkId: string, error: unknown) => void;
  onRequiredHighWater?: (sinkId: string, queuedBytes: number) => void;
}

export interface AttachOptions {
  /**
   * Deliver history first: resynchronize from the ring starting after this
   * sequence (0 = from the oldest held output), then continue live.
   * Omitted = live only, starting at the next chunk.
   */
  replayAfter?: number;
}

export interface TerminalDistributor {
  push(data: Uint8Array): TerminalChunk;
  attach(sink: TerminalSink, options?: AttachOptions): void;
  detach(sinkId: string): void;
  replayAfter(afterSequence: number): RingReplay;
  lastSequence(): number;
  /** Resolves once every sink queue has drained. Test/shutdown helper. */
  idle(): Promise<void>;
}

interface SinkState {
  sink: TerminalSink;
  queue: TerminalChunk[];
  queuedBytes: number;
  delivered: number;
  desynced: boolean;
  draining: boolean;
  errored: boolean;
  highWater: boolean;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createTerminalDistributor(options: TerminalDistributorOptions): TerminalDistributor {
  const ring = new TerminalRingBuffer(options.ringCapacityBytes ?? 1024 * 1024);
  const now = options.now ?? (() => performance.now());
  const sinks = new Map<string, SinkState>();
  let sequence = 0;

  function fail(state: SinkState, error: unknown): void {
    state.errored = true;
    state.queue = [];
    state.queuedBytes = 0;
    options.onSinkError?.(state.sink.id, error);
  }

  function needsWork(state: SinkState): boolean {
    if (state.errored) return false;
    return state.desynced ? ring.lastSequence() > state.delivered : state.queue.length > 0;
  }

  async function drainLoop(state: SinkState): Promise<void> {
    for (;;) {
      if (state.errored) return;
      if (state.desynced) {
        const replay = ring.replayAfter(state.delivered);
        try {
          if (state.sink.reset) await state.sink.reset(replay);
          else for (const chunk of replay.chunks) await state.sink.write(chunk);
        } catch (error) {
          fail(state, error);
          return;
        }
        if (replay.chunks.length > 0) state.delivered = replay.chunks[replay.chunks.length - 1].sequence;
        if (ring.lastSequence() <= state.delivered) state.desynced = false;
        continue;
      }
      const chunk = state.queue.shift();
      if (!chunk) return;
      state.queuedBytes -= chunk.data.byteLength;
      if (chunk.sequence <= state.delivered) continue;
      try {
        await state.sink.write(chunk);
      } catch (error) {
        fail(state, error);
        return;
      }
      state.delivered = chunk.sequence;
    }
  }

  function kick(state: SinkState): void {
    if (state.draining || state.errored) return;
    state.draining = true;
    void drainLoop(state).finally(() => {
      state.draining = false;
      if (needsWork(state)) kick(state);
    });
  }

  function enqueue(state: SinkState, chunk: TerminalChunk): void {
    if (state.errored || state.desynced) return;
    state.queue.push(chunk);
    state.queuedBytes += chunk.data.byteLength;
    const { type, maxQueueBytes } = state.sink.policy;
    if (state.queuedBytes <= maxQueueBytes) {
      state.highWater = false;
      return;
    }
    if (type === 'required') {
      if (!state.highWater) {
        state.highWater = true;
        options.onRequiredHighWater?.(state.sink.id, state.queuedBytes);
      }
      return;
    }
    const dropped = state.queuedBytes;
    state.queue = [];
    state.queuedBytes = 0;
    state.desynced = true;
    options.onSinkDesync?.(state.sink.id, dropped);
  }

  return {
    push(data: Uint8Array): TerminalChunk {
      sequence += 1;
      const chunk: TerminalChunk = { sessionId: options.sessionId, sequence, monotonicTime: now(), data };
      ring.push(chunk);
      for (const state of sinks.values()) {
        enqueue(state, chunk);
        kick(state);
      }
      return chunk;
    },

    attach(sink: TerminalSink, attachOptions?: AttachOptions): void {
      const replayAfter = attachOptions?.replayAfter;
      const state: SinkState = {
        sink,
        queue: [],
        queuedBytes: 0,
        delivered: replayAfter ?? sequence,
        desynced: replayAfter !== undefined && replayAfter < ring.lastSequence(),
        draining: false,
        errored: false,
        highWater: false,
      };
      sinks.set(sink.id, state);
      if (state.desynced) kick(state);
    },

    detach(sinkId: string): void {
      sinks.delete(sinkId);
    },

    replayAfter: (afterSequence: number) => ring.replayAfter(afterSequence),
    lastSequence: () => sequence,

    async idle(): Promise<void> {
      for (;;) {
        const busy = [...sinks.values()].some((s) => s.draining || needsWork(s));
        if (!busy) return;
        await delay(5);
      }
    },
  };
}
