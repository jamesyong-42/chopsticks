import type { TerminalMenuAction } from '@vibecook/ghosttea-react';
import type { ChopsticksBridge } from '../protocol.js';

declare global {
  interface Window {
    chopsticks: ChopsticksBridge;
    desktop: {
      platform: string;
      defaultShell: string;
      writeClipboard: (text: string) => void;
      readClipboard: () => string;
      showContextMenu: (canCopy: boolean) => void;
      toggleFullscreen: () => void;
      closeWindow: () => void;
      onMenuAction: (listener: (action: TerminalMenuAction) => void) => () => void;
    };
  }
}

export {};
