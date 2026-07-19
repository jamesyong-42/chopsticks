import assert from 'node:assert/strict';
import test from 'node:test';

import { isAlreadyPublishedError } from './publish-errors.mjs';

test('recognizes pnpm already-published E403 output', () => {
  const output = `[E403] 403 Forbidden - PUT https://registry.npmjs.org/@vibecook%2fchopsticks-core - You cannot publish over the previously published versions: 0.1.0.`;

  assert.equal(isAlreadyPublishedError(output, '0.1.0'), true);
});

test('recognizes npm already-published E403 output with ANSI escapes', () => {
  const output = `\u001b[31mnpm error code E403\u001b[39m\nnpm error You cannot publish over the previously published versions: 0.1.0`;

  assert.equal(isAlreadyPublishedError(output, '0.1.0'), true);
});

test('does not hide unrelated forbidden errors or a different version', () => {
  assert.equal(isAlreadyPublishedError('E403 You do not have permission to publish', '0.1.0'), false);
  assert.equal(
    isAlreadyPublishedError('E403 You cannot publish over the previously published versions: 0.0.9', '0.1.0'),
    false,
  );
});
