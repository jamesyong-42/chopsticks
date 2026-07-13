/**
 * ActionRecorder — serialized JSONL appender for the own-action record.
 *
 * Appends are chained on a single promise so concurrent record() calls can
 * never interleave partial lines, and a write failure surfaces on onError
 * without throwing into the caller's hot path (recording an action must never
 * break the operation being recorded). The parent directory is created on
 * first write. Default location: ~/.chopsticks/own-actions.jsonl.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { OwnAction, OwnActionInput } from './actions.js';

export interface ActionRecorderOptions {
  /** Override the log path (tests). Default ~/.chopsticks/own-actions.jsonl. */
  path?: string;
  onError?: (error: Error) => void;
  /** Injectable clock for deterministic tests; default () => new Date(). */
  now?: () => Date;
}

export interface ActionRecorder {
  readonly path: string;
  record(action: OwnActionInput): Promise<void>;
  /** Read the log back as parsed actions (tooling/tests); [] if absent. */
  read(): Promise<OwnAction[]>;
}

const DEFAULT_PATH = path.join(homedir(), '.chopsticks', 'own-actions.jsonl');

export function createActionRecorder(options: ActionRecorderOptions = {}): ActionRecorder {
  const filePath = options.path ?? DEFAULT_PATH;
  const now = options.now ?? (() => new Date());
  let dirReady = false;
  let chain: Promise<void> = Promise.resolve();

  async function append(action: OwnAction): Promise<void> {
    if (!dirReady) {
      await mkdir(path.dirname(filePath), { recursive: true });
      dirReady = true;
    }
    await appendFile(filePath, `${JSON.stringify(action)}\n`, 'utf8');
  }

  return {
    path: filePath,

    record(input: OwnActionInput): Promise<void> {
      const action = { ts: now().toISOString(), ...input } as OwnAction;
      const next = chain
        .then(() => append(action))
        .catch((err) => {
          options.onError?.(err instanceof Error ? err : new Error(String(err)));
        });
      // Keep the chain rejection-free so one failed write can't wedge the queue.
      chain = next;
      return next;
    },

    async read(): Promise<OwnAction[]> {
      let contents: string;
      try {
        contents = await readFile(filePath, 'utf8');
      } catch {
        return [];
      }
      return contents
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as OwnAction);
    },
  };
}
