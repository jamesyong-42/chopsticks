import type { ChopsticksBridge } from '../protocol.js';

type HostClipboardBridge = {
  writeText: (text: string) => void | Promise<void>;
  readText?: () => string | null | Promise<string | null>;
};

declare global {
  interface Window {
    chopsticks: ChopsticksBridge;
    /** BrowserWindow focus/blur from main process. */
    chopsticksWindow?: {
      onFocusChange: (cb: (focused: boolean) => void) => () => void;
    };
    /** Electron main-process clipboard preferred by restty. */
    ghosttyClipboard?: HostClipboardBridge;
    __resttyClipboard?: HostClipboardBridge;
  }
}

export {};
