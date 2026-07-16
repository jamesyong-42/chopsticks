import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  GhostteaProvider,
  createGhostteaTerminalRuntime,
  waitForGhostteaRendererPorts,
} from '@vibecook/ghosttea-react';
import { GhostteaWorkspace } from '@vibecook/ghosttea-react/workspace';
import { AgentSidebar } from './AgentSidebar.js';
import '@vibecook/ghosttea-react/styles.css';
import '@vibecook/ghosttea-react/workspace.css';
import './styles.css';

const terminalRuntime = createGhostteaTerminalRuntime({
  ports: waitForGhostteaRendererPorts(),
  clientBuild: 'chopsticks-workbench',
  platform: {
    writeClipboard: (text) => window.desktop.writeClipboard(text),
    forceCanvasFallback: () => sessionStorage.getItem('ghosttea:force-canvas-fallback') === '1',
    setForceCanvasFallback: (enabled) => {
      if (enabled) sessionStorage.setItem('ghosttea:force-canvas-fallback', '1');
      else sessionStorage.removeItem('ghosttea:force-canvas-fallback');
    },
    reload: () => window.location.reload(),
  },
});

const platform = {
  defaultShell: window.desktop.defaultShell,
  readClipboard: window.desktop.readClipboard,
  showContextMenu: window.desktop.showContextMenu,
  toggleFullscreen: window.desktop.toggleFullscreen,
  closeWindow: window.desktop.closeWindow,
  onMenuAction: window.desktop.onMenuAction,
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GhostteaProvider runtime={terminalRuntime}>
      <GhostteaWorkspace platform={platform} storageKey="chopsticks:ghosttea-workspace:v1" sidebar={AgentSidebar} />
    </GhostteaProvider>
  </StrictMode>,
);
