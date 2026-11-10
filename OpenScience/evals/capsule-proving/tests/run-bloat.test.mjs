/**
 * Tests for the bloat metrics. All paths and text are invented.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { bloatMetrics } from '../run/bloat.mjs';

test('bloatMetrics reads the latest snapshot and excludes observations', () => {
  const snapshots = [
    { afterSession: 1, files: { 'profile.md': 'old', 'people/a.md': 'old' } },
    {
      afterSession: 2,
      files: {
        'profile.md': 'abcd',
        'people/a.md': '12345',
        'people/b.md': '12',
        'notes/n.md': '1234567',
        'observations/o.md': 'not memory',
        'people/observations/private.md': 'not memory either',
      },
    },
  ];
  const ingestRows = [
    { sessionId: 's1', messages: 4, operations: { adds: 2, updates: 1, deletes: 0 } },
    { sessionId: 's2', messages: 5, operations: { adds: 1, updates: 0, deletes: 1 } },
    { sessionId: 's3', userTurns: 0, messages: 10, operations: { adds: 0, updates: 0, deletes: 0 } },
    { sessionId: 's4', userTurns: 3, messages: 20, operations: { adds: 0, updates: 0, deletes: 0 } },
  ];

  const before = JSON.stringify({ snapshots, ingestRows });
  const metrics = bloatMetrics({ snapshots, ingestRows });
  assert.equal(JSON.stringify({ snapshots, ingestRows }), before, 'inputs are not mutated');

  assert.equal(metrics.files, 4);
  assert.equal(metrics.chars, 'abcd'.length + '12345'.length + '12'.length + '1234567'.length);
  assert.deepEqual(metrics.byType, {
    'profile.md': { files: 1, chars: 4 },
    people: { files: 2, chars: 7 },
    notes: { files: 1, chars: 7 },
  });
  assert.equal(metrics.turns, 8);
  assert.equal(metrics.addedPer100Turns, (3 / 8) * 100);
  assert.equal(metrics.updatesPer100Turns, (1 / 8) * 100);
  assert.equal(metrics.deletesPer100Turns, (1 / 8) * 100);
});

test('a missing userTurns falls back to half the messages, rounded up', () => {
  const metrics = bloatMetrics({
    snapshots: [],
    ingestRows: [
      { messages: 0 },
      { messages: 1 },
      { messages: 2 },
      { messages: 3 },
      { messages: [1, 2, 3, 4, 5] },
    ],
  });
  assert.equal(metrics.turns, 0 + 1 + 1 + 2 + 3);
  assert.equal(metrics.files, 0);
  assert.equal(metrics.byType && Object.keys(metrics.byType).length, 0);
});

test('userTurns wins over messages when present, including zero', () => {
  const metrics = bloatMetrics({
    snapshots: [],
    ingestRows: [{ userTurns: 0, messages: 100 }, { userTurns: 4, messages: 1 }],
  });
  assert.equal(metrics.turns, 4);
});

test('empty input and zero turns produce zero rates instead of NaN', () => {
  assert.deepEqual(bloatMetrics(), {
    files: 0,
    chars: 0,
    byType: {},
    addedPer100Turns: 0,
    updatesPer100Turns: 0,
    deletesPer100Turns: 0,
    turns: 0,
  });

  const metrics = bloatMetrics({ snapshots: [{ files: { 'a.md': 'x' } }], ingestRows: [{ messages: 0, operations: { adds: 5 } }] });
  assert.equal(metrics.files, 1);
  assert.equal(metrics.chars, 1);
  assert.equal(metrics.addedPer100Turns, 0);
});

test('a memories/ prefix is stripped for the top-level type', () => {
  const metrics = bloatMetrics({
    snapshots: [{ files: { 'memories/people/a.md': 'abc', 'memories/profile.md': 'de' } }],
    ingestRows: [],
  });
  assert.deepEqual(metrics.byType, {
    'profile.md': { files: 1, chars: 2 },
    people: { files: 1, chars: 3 },
  });
});
