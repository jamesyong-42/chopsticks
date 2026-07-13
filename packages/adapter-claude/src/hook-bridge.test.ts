import { afterEach, describe, expect, it } from 'vitest';
import { fakeClaudeHookPayload } from '@vibecook/chopsticks-testing';
import { createHookBridge, type HookBridge, type NativeHookEnvelope } from './hook-bridge.js';

const OWNED_SESSION = '00000000-0000-4000-8000-00000000cafe';

let bridge: HookBridge | null = null;
afterEach(async () => {
  await bridge?.dispose();
  bridge = null;
});

async function startBridge(options?: { maxBodyBytes?: number }) {
  const errors: Array<{ kind: string; detail: string }> = [];
  const events: NativeHookEnvelope[] = [];
  bridge = createHookBridge({
    allowSession: (id) => id === OWNED_SESSION,
    maxBodyBytes: options?.maxBodyBytes,
    onProtocolError: (kind, detail) => errors.push({ kind, detail }),
  });
  bridge.onEvent((e) => events.push(e));
  await bridge.start();
  return { bridge: bridge!, errors, events };
}

function post(url: string, token: string | null, body: string) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
}

describe('createHookBridge', () => {
  it('accepts an authenticated hook POST and emits the envelope', async () => {
    const { bridge: b, events } = await startBridge();
    const payload = fakeClaudeHookPayload('UserPromptSubmit', { session_id: OWNED_SESSION, prompt: 'hi' });
    const res = await post(b.endpoint(), b.token, JSON.stringify(payload));
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0].body).toEqual(payload);
    expect(Date.parse(events[0].receivedAt)).toBeGreaterThan(0);
  });

  it('rejects a missing or wrong bearer token with 401 and emits nothing', async () => {
    const { bridge: b, events, errors } = await startBridge();
    const payload = JSON.stringify(fakeClaudeHookPayload('Stop', { session_id: OWNED_SESSION }));
    expect((await post(b.endpoint(), null, payload)).status).toBe(401);
    expect((await post(b.endpoint(), 'wrong-token', payload)).status).toBe(401);
    expect(events).toHaveLength(0);
    expect(errors.filter((e) => e.kind === 'auth')).toHaveLength(2);
  });

  it('rejects events for sessions it does not own with 403 (DESIGN §16.6)', async () => {
    const { bridge: b, events, errors } = await startBridge();
    const foreign = fakeClaudeHookPayload('Stop', { session_id: 'someone-elses-session' });
    expect((await post(b.endpoint(), b.token, JSON.stringify(foreign))).status).toBe(403);
    expect(events).toHaveLength(0);
    expect(errors[0].kind).toBe('unknown-session');
  });

  it('rejects malformed JSON with 400 without crashing', async () => {
    const { bridge: b, events, errors } = await startBridge();
    expect((await post(b.endpoint(), b.token, '{nope')).status).toBe(400);
    expect((await post(b.endpoint(), b.token, '"a string"')).status).toBe(400);
    expect(events).toHaveLength(0);
    expect(errors.every((e) => e.kind === 'malformed')).toBe(true);
    // Still serving afterwards.
    const ok = await post(
      b.endpoint(),
      b.token,
      JSON.stringify(fakeClaudeHookPayload('Stop', { session_id: OWNED_SESSION })),
    );
    expect(ok.status).toBe(200);
  });

  it('kills oversized bodies at the socket and reports too-large', async () => {
    const { bridge: b, events, errors } = await startBridge({ maxBodyBytes: 1024 });
    const huge = JSON.stringify(
      fakeClaudeHookPayload('Stop', { session_id: OWNED_SESSION, blob: 'x'.repeat(64 * 1024) }),
    );
    await post(b.endpoint(), b.token, huge).catch(() => undefined); // socket destroyed mid-request
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toHaveLength(0);
    expect(errors.some((e) => e.kind === 'too-large')).toBe(true);
  });

  it('a throwing consumer does not break the agent-facing endpoint', async () => {
    const { bridge: b, events } = await startBridge();
    b.onEvent(() => {
      throw new Error('bad consumer');
    });
    const res = await post(
      b.endpoint(),
      b.token,
      JSON.stringify(fakeClaudeHookPayload('Stop', { session_id: OWNED_SESSION })),
    );
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
  });
});
