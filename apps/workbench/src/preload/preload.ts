import { clipboard, contextBridge, ipcRenderer } from 'electron';
import { forwardGhostteaRendererPorts } from '@vibecook/ghosttea-electron/preload';
import type {
  AgentSessionSnapshot,
  AgentStateMessage,
  ChopsticksBridge,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  PromptReceipt,
  SubmitPromptOptions,
  WorkspaceDiff,
  WorkspaceFinalEvent,
} from '../protocol.js';

forwardGhostteaRendererPorts(ipcRenderer);

const chopsticks: ChopsticksBridge = {
  createAgentSession: (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> =>
    ipcRenderer.invoke('chopsticks:create-agent-session', options),
  listAgentSessions: (): Promise<AgentSessionSnapshot[]> => ipcRenderer.invoke('chopsticks:list-agent-sessions'),
  submitPrompt: (options: SubmitPromptOptions): Promise<PromptReceipt> =>
    ipcRenderer.invoke('chopsticks:submit-prompt', options),
  onAgentState: (callback: (state: AgentStateMessage) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AgentStateMessage): void => callback(state);
    ipcRenderer.on('chopsticks:agent-state', listener);
    return () => ipcRenderer.removeListener('chopsticks:agent-state', listener);
  },
  workspaceDiff: (runtimeSessionId: string): Promise<WorkspaceDiff | null> =>
    ipcRenderer.invoke('chopsticks:workspace-diff', runtimeSessionId),
  onWorkspaceFinal: (callback: (event: WorkspaceFinalEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, final: WorkspaceFinalEvent): void => callback(final);
    ipcRenderer.on('chopsticks:workspace-final', listener);
    return () => ipcRenderer.removeListener('chopsticks:workspace-final', listener);
  },
};

contextBridge.exposeInMainWorld('chopsticks', chopsticks);
contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  defaultShell:
    process.platform === 'win32' ? (process.env.COMSPEC ?? 'powershell.exe') : (process.env.SHELL ?? '/bin/zsh'),
  writeClipboard: (text: string) => clipboard.writeText(text),
  readClipboard: () => clipboard.readText(),
  showContextMenu: (canCopy: boolean) => ipcRenderer.send('terminal-context-menu', canCopy),
  toggleFullscreen: () => ipcRenderer.send('terminal-toggle-fullscreen'),
  closeWindow: () => ipcRenderer.send('terminal-close-window'),
  onMenuAction: (listener: (action: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: string): void => listener(action);
    ipcRenderer.on('terminal-menu-action', handler);
    return () => ipcRenderer.removeListener('terminal-menu-action', handler);
  },
});
