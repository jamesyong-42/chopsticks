/**
 * Headless terminal mirror (DESIGN §12.3).
 *
 * A `required` sink that feeds the ordered output stream into an off-screen
 * @xterm/headless terminal. It owns no rendering; it maintains the authoritative
 * buffer, cursor, and modes so the runtime can produce reconnection snapshots,
 * thumbnails, and answer questions like "is the app on the alternate screen?".
 *
 * Writes are awaited to completion (xterm parses on its own tick) so a snapshot
 * taken after the distributor drains reflects every byte delivered so far.
 */

// @xterm/headless is CommonJS; cjs-module-lexer can't see `Terminal` as a named
// export, so real-ESM consumers must reach it through the default export. The class
// is imported for its type (aliased to avoid colliding with the value below).
import headless from '@xterm/headless';
import type { ITerminalAddon, Terminal as XtermTerminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { TerminalChunk, TerminalSink } from './distributor.js';
import type { RingReplay } from './ring-buffer.js';

const { Terminal } = headless;

export interface HeadlessMirrorOptions {
  cols?: number;
  rows?: number;
}

export interface HeadlessMirrorSnapshot {
  /** ANSI that reproduces the current buffer when written into a fresh terminal. */
  serializedAnsi: string;
  cols: number;
  rows: number;
  alternateScreen: boolean;
}

export interface HeadlessMirror {
  /** The distribution sink; attach it to a TerminalDistributor. */
  readonly sink: TerminalSink;
  snapshot(): HeadlessMirrorSnapshot;
  resize(cols: number, rows: number): void;
  /** Viewport lines of the active buffer, right-trimmed (tests, thumbnails). */
  visibleText(): string[];
  dispose(): void;
}

const TRUNCATED_MARKER = '\x1b[2m…output truncated…\x1b[0m\r\n';

/** Resolve once xterm has parsed the written bytes into the buffer. */
function write(terminal: XtermTerminal, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

export function createHeadlessMirror(options: HeadlessMirrorOptions = {}): HeadlessMirror {
  // xterm rejects an explicit `undefined` geometry, so fall back to the standard
  // 80x24 rather than passing the option through unset.
  const terminal = new Terminal({ cols: options.cols ?? 80, rows: options.rows ?? 24, allowProposedApi: true });
  const serializer = new SerializeAddon();
  // SerializeAddon is typed against the browser Terminal; the headless Terminal is
  // structurally compatible for the addon's needs. Cast only to satisfy loadAddon.
  terminal.loadAddon(serializer as unknown as ITerminalAddon);

  const sink: TerminalSink = {
    id: 'headless-mirror',
    policy: { type: 'required', maxQueueBytes: 8 * 1024 * 1024 },
    write: (chunk: TerminalChunk) => write(terminal, chunk.data),
    async reset(replay: RingReplay) {
      terminal.reset();
      // An incomplete replay is a snapshot of the tail, not a continuation from the
      // start; flag it so the mirrored buffer reads as truncated rather than whole.
      if (!replay.complete) await write(terminal, TRUNCATED_MARKER);
      for (const chunk of replay.chunks) await write(terminal, chunk.data);
    },
  };

  return {
    sink,
    snapshot(): HeadlessMirrorSnapshot {
      return {
        serializedAnsi: serializer.serialize(),
        cols: terminal.cols,
        rows: terminal.rows,
        alternateScreen: terminal.buffer.active.type === 'alternate',
      };
    },
    resize(cols: number, rows: number): void {
      terminal.resize(cols, rows);
    },
    visibleText(): string[] {
      const buffer = terminal.buffer.active;
      const lines: string[] = [];
      for (let row = 0; row < terminal.rows; row++) {
        lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
      }
      return lines;
    },
    dispose(): void {
      terminal.dispose();
    },
  };
}
