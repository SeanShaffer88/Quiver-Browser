import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { wrapScript } from '../main/boosts';

test('a Boost reports application only when synchronous initialization succeeds', () => {
  const errors: unknown[][] = [];
  const context = { console: { error: (...args: unknown[]) => errors.push(args) } };
  assert.equal(runInNewContext(wrapScript('return;', 'all.ts'), context), true);
  assert.equal(runInNewContext(wrapScript('throw new Error("fixture");', 'all.ts'), context), false);
  assert.equal(errors.length, 1);
});
