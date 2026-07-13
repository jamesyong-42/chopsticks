/**
 * AgentSession conformance suite (DESIGN §26.2).
 *
 * Adapter-agnostic assertions that every driver's `AgentSession` must satisfy,
 * applied to Claude (hook + PTY) and Codex (structured app-server) through each
 * adapter's own harness. This is what gives the lifted core `AgentSession`
 * contract (M5 C3) teeth — and what a future Gemini/ACP adapter runs to prove
 * itself against the same bar.
 *
 * Deliberately tests only the UNIVERSAL contract. Adapter-specific behaviour
 * (Claude's transcript observer, Codex's structured injection determinism) is
 * covered by each adapter's own tests, not here — conformance is about what all
 * drivers share.
 */

import { describe, it, expect } from 'vitest';
import type { AgentSession, ObservationLevel } from '@vibecook/chopsticks-core';

const OBSERVATION_LEVELS: ObservationLevel[] = [
  'structured',
  'native-hooks',
  'native-log',
  'workspace-process',
  'terminal-only',
];

export interface AgentSessionHarness {
  session: AgentSession;
  /** Drive one full user turn; resolves when the turn is observably complete. */
  driveTurn(prompt: string): Promise<void>;
  /** The assistant reply text `driveTurn` produces (for the lastAssistantMessage check). */
  reply: string;
}

/**
 * Register the conformance `describe` block for one adapter. Call at the top
 * level of an adapter test file: `runAgentSessionConformance('codex', setup)`.
 * `createHarness` returns a fresh, ready-to-drive session per assertion.
 */
export function runAgentSessionConformance(label: string, createHarness: () => Promise<AgentSessionHarness>): void {
  describe(`AgentSession conformance: ${label}`, () => {
    it('exposes non-empty session and runtime identities', async () => {
      const h = await createHarness();
      try {
        expect(typeof h.session.sessionId).toBe('string');
        expect(h.session.sessionId.length).toBeGreaterThan(0);
        expect(typeof h.session.runtimeSessionId).toBe('string');
        expect(h.session.runtimeSessionId.length).toBeGreaterThan(0);
      } finally {
        await h.session.dispose();
      }
    });

    it('reports a valid, honest observation level', async () => {
      const h = await createHarness();
      try {
        expect(OBSERVATION_LEVELS).toContain(h.session.observationLevel());
      } finally {
        await h.session.dispose();
      }
    });

    it('transitions through a turn: running while active, ready after', async () => {
      const h = await createHarness();
      const lifecycles = new Set<string>([h.session.state().lifecycle]);
      const off = h.session.onEvent(() => lifecycles.add(h.session.state().lifecycle));
      try {
        await h.driveTurn('do the thing');
        expect(lifecycles.has('running')).toBe(true);
        expect(h.session.state().lifecycle).toBe('ready');
        expect(h.session.state().activeTurn).toBeUndefined();
      } finally {
        off();
        await h.session.dispose();
      }
    });

    it('records the assistant reply as lastAssistantMessage', async () => {
      const h = await createHarness();
      try {
        await h.driveTurn('say the reply');
        expect(h.session.state().lastAssistantMessage).toBe(h.reply);
      } finally {
        await h.session.dispose();
      }
    });

    it('stamps observed events with strictly increasing sequence numbers', async () => {
      const h = await createHarness();
      const seqs: number[] = [];
      const off = h.session.onEvent((e) => seqs.push(e.sequence));
      try {
        await h.driveTurn('emit some events');
        expect(seqs.length).toBeGreaterThan(0);
        for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
      } finally {
        off();
        await h.session.dispose();
      }
    });

    it('dispose() is idempotent', async () => {
      const h = await createHarness();
      await h.session.dispose();
      await expect(h.session.dispose()).resolves.toBeUndefined();
    });
  });
}
