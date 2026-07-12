import type { ChopsticksBridge } from '../protocol.js';

declare global {
  interface Window {
    chopsticks: ChopsticksBridge;
  }
}

export {};
