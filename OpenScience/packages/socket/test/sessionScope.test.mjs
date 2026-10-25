import assert from 'node:assert/strict';
import test from 'node:test';
import { planFileFor, runStateFileForSession, briefFileForSession } from '@evimed/domain';

test('scope paths reject traversal', () => {
  for (const value of ['../other','a/b','a\\b','', 'x'.repeat(257)]) {
    for (const fn of [planFileFor,runStateFileForSession,briefFileForSession]) assert.throws(()=>fn(value));
  }
});
