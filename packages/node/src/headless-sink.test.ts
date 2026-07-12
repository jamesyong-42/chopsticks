import { describe, expect, it } from 'vitest';
import { createHeadlessMirror } from './headless-sink.js';
import { createTerminalDistributor, type TerminalChunk } from './distributor.js';
import type { RingReplay } from './ring-buffer.js';

const encoder = new TextEncoder();
const chunk = (sequence: number, text: string): TerminalChunk => ({
  sessionId: 's',
  sequence,
  monotonicTime: sequence,
  data: encoder.encode(text),
});

/** Feed chunks straight through the sink, awaiting each write. */
async function feed(mirror: ReturnType<typeof createHeadlessMirror>, ...texts: string[]): Promise<void> {
  let sequence = 0;
  for (const text of texts) await mirror.sink.write(chunk(++sequence, text));
}

/** Viewport joined and right-trimmed to a single string for easy assertions. */
const screen = (mirror: ReturnType<typeof createHeadlessMirror>) => mirror.visibleText().join('\n').trimEnd();

describe('createHeadlessMirror', () => {
  it('renders plain text and ANSI-colored text into the buffer', async () => {
    const mirror = createHeadlessMirror();
    await feed(mirror, 'hello ', '\x1b[31mred\x1b[0m world');
    expect(screen(mirror)).toBe('hello red world');
    expect(mirror.sink.id).toBe('headless-mirror');
    expect(mirror.sink.policy).toEqual({ type: 'required', maxQueueBytes: 8 * 1024 * 1024 });
    mirror.dispose();
  });

  it('applies cursor movement and overwrites cells in place', async () => {
    const mirror = createHeadlessMirror();
    // Write 'abc', move the cursor two columns left, overwrite with 'XY'.
    await feed(mirror, 'abc', '\x1b[2D', 'XY');
    expect(mirror.visibleText()[0]).toBe('aXY');
    mirror.dispose();
  });

  it('tracks alternate-screen enter and leave', async () => {
    const mirror = createHeadlessMirror();
    expect(mirror.snapshot().alternateScreen).toBe(false);
    await feed(mirror, '\x1b[?1049h');
    expect(mirror.snapshot().alternateScreen).toBe(true);
    await feed(mirror, '\x1b[?1049l');
    expect(mirror.snapshot().alternateScreen).toBe(false);
    mirror.dispose();
  });

  it('reset() with a complete replay reproduces the directly-written buffer', async () => {
    const direct = createHeadlessMirror();
    await feed(direct, 'line one\r\n', 'line two\r\n', 'line \x1b[32mthree\x1b[0m');

    const restored = createHeadlessMirror();
    const replay: RingReplay = {
      complete: true,
      chunks: [chunk(1, 'line one\r\n'), chunk(2, 'line two\r\n'), chunk(3, 'line \x1b[32mthree\x1b[0m')],
    };
    await restored.sink.reset?.(replay);

    expect(restored.visibleText()).toEqual(direct.visibleText());
    direct.dispose();
    restored.dispose();
  });

  it('reset() with an incomplete replay marks the buffer as truncated', async () => {
    const mirror = createHeadlessMirror();
    const replay: RingReplay = { complete: false, chunks: [chunk(9, 'tail output')] };
    await mirror.sink.reset?.(replay);
    const text = screen(mirror);
    expect(text).toContain('output truncated');
    expect(text).toContain('tail output');
    mirror.dispose();
  });

  it('snapshot serialization round-trips into a fresh terminal', async () => {
    const mirror = createHeadlessMirror();
    await feed(mirror, 'row A\r\n', 'row \x1b[1;34mB\x1b[0m\r\n', 'row C');
    const { serializedAnsi } = mirror.snapshot();

    const restored = createHeadlessMirror();
    await restored.sink.write(chunk(1, serializedAnsi));
    expect(restored.visibleText()).toEqual(mirror.visibleText());
    mirror.dispose();
    restored.dispose();
  });

  it('resize() changes the reported geometry', async () => {
    const mirror = createHeadlessMirror({ cols: 80, rows: 24 });
    expect(mirror.snapshot()).toMatchObject({ cols: 80, rows: 24 });
    mirror.resize(120, 40);
    expect(mirror.snapshot()).toMatchObject({ cols: 120, rows: 40 });
    mirror.dispose();
  });

  it('mirrors output distributed through a TerminalDistributor', async () => {
    const mirror = createHeadlessMirror();
    const distributor = createTerminalDistributor({ sessionId: 's' });
    distributor.attach(mirror.sink);
    distributor.push(encoder.encode('progress: '));
    distributor.push(encoder.encode('\x1b[33m75%\x1b[0m'));
    await distributor.idle();
    expect(screen(mirror)).toBe('progress: 75%');
    mirror.dispose();
  });
});
