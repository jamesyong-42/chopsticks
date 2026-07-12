/**
 * Byte-bounded ring of recent terminal chunks (DESIGN §12.1 RecentOutputRingBuffer).
 * Backs renderer reconnection and desync recovery: keeps a contiguous tail
 * [firstHeld..lastPushed]; eviction only ever removes the oldest chunk.
 */

import type { TerminalChunk } from './distributor.js';

export interface RingReplay {
  chunks: TerminalChunk[];
  /**
   * True when the replay is gap-free from `afterSequence`: the consumer can
   * append these chunks directly. False means older output was evicted and
   * the consumer's view is a truncated snapshot, not a continuation.
   */
  complete: boolean;
}

export class TerminalRingBuffer {
  private chunks: TerminalChunk[] = [];
  private bytes = 0;
  private last = 0;

  constructor(private readonly capacityBytes: number) {}

  push(chunk: TerminalChunk): void {
    this.chunks.push(chunk);
    this.bytes += chunk.data.byteLength;
    this.last = chunk.sequence;
    // Always retain at least the newest chunk, even if oversized.
    while (this.bytes > this.capacityBytes && this.chunks.length > 1) {
      const evicted = this.chunks.shift()!;
      this.bytes -= evicted.data.byteLength;
    }
  }

  lastSequence(): number {
    return this.last;
  }

  /** All held chunks with sequence > afterSequence. */
  replayAfter(afterSequence: number): RingReplay {
    const chunks = this.chunks.filter((c) => c.sequence > afterSequence);
    const complete = chunks.length === 0 ? this.last <= afterSequence : chunks[0].sequence === afterSequence + 1;
    return { chunks, complete };
  }

  stats(): { chunks: number; bytes: number; firstSequence: number; lastSequence: number } {
    return {
      chunks: this.chunks.length,
      bytes: this.bytes,
      firstSequence: this.chunks[0]?.sequence ?? 0,
      lastSequence: this.last,
    };
  }
}
