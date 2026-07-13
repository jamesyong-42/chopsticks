/**
 * Preload bridge (DESIGN §13.2, §23.1).
 *
 * The only channel between renderer and main. contextBridge exposes a fixed set
 * of functions on `window.chopsticks`; no Node APIs and no raw ipcRenderer reach
 * the page. Runs sandboxed, so this file is bundled to CommonJS.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type {
  AgentEventMessage,
  AgentStateMessage,
  ChopsticksBridge,
  ChunkEvent,
  ClaudeSessionInfo,
  CreateClaudeSessionOptions,
  CreateSessionOptions,
  ExitEvent,
  PromptReceipt,
  ReplayResult,
  SessionDescriptor,
  SubmitPromptOptions,
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
  createClaudeSession: (opts: CreateClaudeSessionOptions): Promise<ClaudeSessionInfo> =>
    ipcRenderer.invoke('chopsticks:createClaudeSession', opts),
  submitPrompt: (opts: SubmitPromptOptions): Promise<PromptReceipt> =>
    ipcRenderer.invoke('chopsticks:submitPrompt', opts),
  onAgentEvents: (cb: (events: AgentEventMessage[]) => void): (() => void) => {
    const listener = (_e: unknown, events: AgentEventMessage[]): void => cb(events);
    ipcRenderer.on('chopsticks:agentEvents', listener);
    return () => ipcRenderer.removeListener('chopsticks:agentEvents', listener);
  },
  onAgentState: (cb: (state: AgentStateMessage) => void): (() => void) => {
    const listener = (_e: unknown, state: AgentStateMessage): void => cb(state);
    ipcRenderer.on('chopsticks:agentState', listener);
    return () => ipcRenderer.removeListener('chopsticks:agentState', listener);
  },
};

contextBridge.exposeInMainWorld('chopsticks', bridge);
