/**
 * Preload bridge (DESIGN §13.2, §23.1).
 *
 * The only channel between renderer and main. contextBridge exposes a fixed set
 * of functions on `window.chopsticks`; no Node APIs and no raw ipcRenderer reach
 * the page. Runs sandboxed, so this file is bundled to CommonJS.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type {
  AgentStateMessage,
  ChopsticksBridge,
  ChunkEvent,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  CreateSessionOptions,
  ExitEvent,
  PromptReceipt,
  ReplayResult,
  SessionDescriptor,
  SubmitPromptOptions,
  WorkspaceDiff,
  WorkspaceFinalEvent,
} from '../protocol.js';

const bridge: ChopsticksBridge = {
  createSession: (opts: CreateSessionOptions): Promise<SessionDescriptor> =>
    ipcRenderer.invoke('chopsticks:createSession', opts),
  write: (sessionId: string, dataBase64: string): Promise<void> =>
    ipcRenderer.invoke('chopsticks:write', sessionId, dataBase64),
  resize: (sessionId: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('chopsticks:resize', sessionId, cols, rows),
  terminate: (sessionId: string): Promise<void> => ipcRenderer.invoke('chopsticks:terminate', sessionId),
  replay: (sessionId: string): Promise<ReplayResult> => ipcRenderer.invoke('chopsticks:replay', sessionId),
  list: (): Promise<SessionDescriptor[]> => ipcRenderer.invoke('chopsticks:list'),
  onChunk: (cb: (chunks: ChunkEvent[]) => void): (() => void) => {
    const listener = (_e: unknown, chunks: ChunkEvent[]): void => cb(chunks);
    ipcRenderer.on('chopsticks:chunks', listener);
    return () => ipcRenderer.removeListener('chopsticks:chunks', listener);
  },
  onExit: (cb: (exit: ExitEvent) => void): (() => void) => {
    const listener = (_e: unknown, exit: ExitEvent): void => cb(exit);
    ipcRenderer.on('chopsticks:exit', listener);
    return () => ipcRenderer.removeListener('chopsticks:exit', listener);
  },
  createAgentSession: (opts: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> =>
    ipcRenderer.invoke('chopsticks:createAgentSession', opts),
  submitPrompt: (opts: SubmitPromptOptions): Promise<PromptReceipt> =>
    ipcRenderer.invoke('chopsticks:submitPrompt', opts),
  onAgentState: (cb: (state: AgentStateMessage) => void): (() => void) => {
    const listener = (_e: unknown, state: AgentStateMessage): void => cb(state);
    ipcRenderer.on('chopsticks:agentState', listener);
    return () => ipcRenderer.removeListener('chopsticks:agentState', listener);
  },
  workspaceDiff: (runtimeSessionId: string): Promise<WorkspaceDiff | null> =>
    ipcRenderer.invoke('chopsticks:workspaceDiff', runtimeSessionId),
  onWorkspaceFinal: (cb: (event: WorkspaceFinalEvent) => void): (() => void) => {
    const listener = (_e: unknown, event: WorkspaceFinalEvent): void => cb(event);
    ipcRenderer.on('chopsticks:workspaceFinal', listener);
    return () => ipcRenderer.removeListener('chopsticks:workspaceFinal', listener);
  },
};

contextBridge.exposeInMainWorld('chopsticks', bridge);

/** BrowserWindow focus/blur from main — restty hollow cursor on OS unfocus. */
contextBridge.exposeInMainWorld('chopsticksWindow', {
  onFocusChange: (cb: (focused: boolean) => void): (() => void) => {
    const listener = (_e: unknown, focused: boolean): void => cb(focused);
    ipcRenderer.on('chopsticks:windowFocus', listener);
    return () => ipcRenderer.removeListener('chopsticks:windowFocus', listener);
  },
});

/** Host clipboard for restty (copy-on-select + OSC 52). */
const hostClipboard = {
  writeText: async (text: string): Promise<void> => {
    const result = (await ipcRenderer.invoke('chopsticks:clipboardWrite', text)) as {
      success: boolean;
      error?: string;
    };
    if (!result?.success) {
      throw new Error(result?.error ?? 'clipboard write failed');
    }
  },
  readText: async (): Promise<string | null> => {
    const result = (await ipcRenderer.invoke('chopsticks:clipboardRead')) as {
      success: boolean;
      text?: string;
      error?: string;
    };
    if (!result?.success) return null;
    return result.text ?? '';
  },
};
// restty looks for window.ghosttyClipboard / window.__resttyClipboard
contextBridge.exposeInMainWorld('ghosttyClipboard', hostClipboard);
contextBridge.exposeInMainWorld('__resttyClipboard', hostClipboard);
