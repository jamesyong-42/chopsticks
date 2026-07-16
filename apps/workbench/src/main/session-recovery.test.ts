import { describe, expect, it } from 'vitest';
import { missingManagedSessionIds } from './session-recovery.js';

describe('missingManagedSessionIds', () => {
  it('reconciles only managed terminals lost across backend recovery', () => {
    expect(missingManagedSessionIds(['live', 'lost'], ['live', 'unmanaged'])).toEqual(['lost']);
  });
});
