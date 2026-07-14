/**
 * TerminalBackend adapter: window.chopsticks → avocado-sdk/react.
 *
 * TerminalSurface / useTerminalCore talk only to this surface:
 *   - keys:  pty.write(sessionId, text)
 *   - out:   pty.onOutput(terminalId, sessionId, base64)
 *   - size:  terminal.resize(terminalId, cols, rows)
 *
 * Workbench uses terminalId === sessionId so the map stays 1:1.
 */

import type { TerminalBackend } from '@vibecook/avocado-sdk/types';

type OutputCb = (terminalId: string, sessionId: string, base64Data: string) => void;
type ExitCb = (sessionId: string, exitCode: number) => void;

const enc = new TextEncoder();

function textToB64(text: string): string {
  const bytes = enc.encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export type ChopsticksTerminalBackend = TerminalBackend & {
  /** Push bytes into every VirtualTerminal subscribed to this terminalId (replay / exit banner). */
  injectOutput(terminalId: string, sessionId: string, dataBase64: string): void;
};

export function createChopsticksBackend(): ChopsticksTerminalBackend {
  const chopsticks = window.chopsticks;
  const outputListeners = new Set<OutputCb>();
  const exitListeners = new Set<ExitCb>();

  chopsticks.onChunk((chunks) => {
    for (const chunk of chunks) {
      for (const cb of outputListeners) {
        // terminalId === sessionId (see WorkbenchTerminal).
        cb(chunk.sessionId, chunk.sessionId, chunk.dataBase64);
      }
    }
  });

  chopsticks.onExit((exit) => {
    for (const cb of exitListeners) {
      cb(exit.sessionId, exit.exitCode ?? 0);
    }
  });

  const injectOutput = (terminalId: string, sessionId: string, dataBase64: string): void => {
    for (const cb of outputListeners) cb(terminalId, sessionId, dataBase64);
  };

  const backend: ChopsticksTerminalBackend = {
    injectOutput,

    pty: {
      async create() {
        return { success: false, error: 'use chopsticks.createSession from the workbench UI' };
      },
      async destroy(sessionId) {
        await chopsticks.terminate(sessionId).catch(() => undefined);
        return { success: true };
      },
      async list() {
        const sessions = await chopsticks.list();
        return {
          success: true,
          sessions: sessions.map((s) => ({
            id: s.sessionId,
            source: 'ipc',
            command: s.command,
            cwd: s.cwd,
            createdAt: 0,
            pid: s.pid,
            cols: s.cols,
            rows: s.rows,
            isRunning: !s.exited,
            exitCode: s.exited ? 0 : null,
          })),
        };
      },
      async write(sessionId, data) {
        await chopsticks.write(sessionId, textToB64(data));
      },
      async resize(sessionId, cols, rows) {
        await chopsticks.resize(sessionId, cols, rows);
        return { success: true };
      },
      onOutput(cb) {
        outputListeners.add(cb);
        return () => {
          outputListeners.delete(cb);
        };
      },
      onExit(cb) {
        exitListeners.add(cb);
        return () => {
          exitListeners.delete(cb);
        };
      },
    },

    terminal: {
      async createVirtual(_sessionId, _options) {
        // Renderer-owned view; no main-side virtual terminal registry.
        return { success: true, terminalId: _sessionId };
      },
      async createHeadless(_sessionId, _options) {
        return { success: true, terminalId: _sessionId };
      },
      async destroy() {
        return { success: true };
      },
      async list() {
        return { success: true, terminals: [] };
      },
      async resize(terminalId, cols, rows) {
        // terminalId === sessionId in this workbench.
        await chopsticks.resize(terminalId, cols, rows);
        return { success: true };
      },
      async setActive() {
        return { success: true };
      },
    },
  };

  return backend;
}
