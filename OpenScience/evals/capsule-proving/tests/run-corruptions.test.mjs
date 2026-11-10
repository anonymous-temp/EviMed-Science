/**
 * Tests for applying a synthetic user's corruptions to memory files and for
 * checking whether consolidation restored them. All text is invented.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { applyCorruptions, checkRestored } from '../run/corruptions.mjs';

/** @returns {Record<string, string>} */
function filesFixture() {
  return {
    'people/depot.md': '- depot\n  person: Mira (community volunteer)\n- boiled water\n  person: Rowan (spouse)\n',
    'notes/trip.md': '- departure: Monday afternoon\n- deck temperature: below 30C\n',
    'notes/sources.md': [
      '- step-free boarding The document says the ferry has a ramp.',
      '- ask the doctor the assistant suggested asking the doctor.',
      '- online booking the user believes online booking is faster.',
    ].join('\n') + '\n',
  };
}

test('a find/replace corruption edits the first matching line only', () => {
  const input = filesFixture();
  const before = JSON.stringify(input);
  const corruption = {
    id: 'x-e01',
    kind: 'number',
    find: 'below 30C',
    replace: 'below 00C',
    restore: 'below 30C',
  };

  const result = applyCorruptions(input, [corruption]);
  assert.equal(JSON.stringify(input), before, 'the input map is never mutated');
  assert.equal(result.skipped.length, 0);
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].id, 'x-e01');
  assert.equal(result.applied[0].kind, 'number');
  assert.equal(result.applied[0].path, 'notes/trip.md');
  assert.equal(result.applied[0].line, 2);
  assert.match(result.applied[0].before, /below 30C/);
  assert.match(result.applied[0].after, /below 00C/);
  assert.match(result.files['notes/trip.md'], /below 00C/);
  assert.doesNotMatch(result.files['notes/trip.md'], /below 30C/);

  const again = applyCorruptions(input, [corruption]);
  assert.deepEqual(again, result, 'the edit is deterministic');
});

test('near may sit on another line of the same bullet', () => {
  const input = {
    'people/list.md': '- depot\n  person: Mira (community volunteer)\n- boiled water\n  person: Rowan (spouse)\n',
  };
  const result = applyCorruptions(input, [
    { id: 'x-e02', kind: 'swap-person', find: 'Mira (community volunteer)', replace: 'Rowan (spouse)', near: 'depot', restore: 'Mira (community volunteer)' },
  ]);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.applied[0].path, 'people/list.md');
  assert.equal(result.applied[0].line, 2);
  assert.match(result.files['people/list.md'], /person: Rowan \(spouse\)/);
  assert.match(result.files['people/list.md'], /depot/);
});

test('a corruption that cannot be placed is skipped with a reason', () => {
  const input = filesFixture();
  const result = applyCorruptions(input, [
    { id: 'x-e03', kind: 'number', find: 'never present', replace: 'x' },
    { id: 'x-e04', kind: 'number', find: 'below 30C' },
    { id: 'x-e05', kind: 'attribution', near: 'ferry', expectAttribution: 'document', path: 'missing.md' },
    { id: 'x-e06', kind: 'attribution', expectAttribution: 'document' },
    { id: 'x-e07', kind: 'attribution', near: 'ferry', expectAttribution: 'nobody' },
    { id: 'x-e08', kind: 'attribution', near: 'missing anchor', expectAttribution: 'document' },
  ]);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 6);
  assert.match(result.skipped[0].reason, /not found/);
  assert.match(result.skipped[1].reason, /no replace/);
  assert.match(result.skipped[2].reason, /path not found/);
  assert.match(result.skipped[3].reason, /needs near/);
  assert.match(result.skipped[4].reason, /expectAttribution/);
  assert.match(result.skipped[5].reason, /near text not found/);
  assert.deepEqual(result.files, input);
});

test('attribution corruptions lose the true source deterministically', () => {
  const input = filesFixture();
  const corruptions = [
    { id: 'x-a01', kind: 'attribution', near: 'ferry', expectAttribution: 'document', restoreRule: 'the line must again name its true source' },
    { id: 'x-a02', kind: 'attribution', near: 'asking the doctor', expectAttribution: 'assistant', restoreRule: 'the line must again name its true source' },
    { id: 'x-a03', kind: 'attribution', near: 'online booking', expectAttribution: 'user_belief', restoreRule: 'the line must again name its true source' },
  ];
  const result = applyCorruptions(input, corruptions);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.applied.length, 3);

  const text = result.files['notes/sources.md'];
  assert.match(text, /the user states as their own fact: the ferry has a ramp/);
  assert.doesNotMatch(text, /The document says/);
  assert.match(text, /the user decided this themselves: asking the doctor/);
  assert.doesNotMatch(text, /the assistant suggested/);
  assert.match(text, /established fact: online booking is faster/);
  assert.doesNotMatch(text, /the user believes/);
  assert.equal(JSON.stringify(input), JSON.stringify(filesFixture()), 'the input is unchanged');
});

test('an attribution corruption prefixes a line with no recognisable source phrase', () => {
  const input = { 'notes/plain.md': '- The deck has a step-free boarding ramp.\n' };
  const result = applyCorruptions(input, [
    { id: 'x-a04', kind: 'attribution', near: 'step-free boarding', expectAttribution: 'document' },
  ]);
  assert.equal(result.applied.length, 1);
  assert.match(result.applied[0].after, /^- the user states as their own fact: The deck has a step-free boarding ramp\./);
});

test('checkRestored reports restored, still_corrupt and line_gone for find/replace kinds', () => {
  const input = filesFixture();
  const corruption = { id: 'x-r01', kind: 'number', find: 'below 30C', replace: 'below 00C', restore: 'below 30C' };
  const planted = applyCorruptions(input, [corruption]);

  assert.deepEqual(checkRestored(input, planted.applied, [corruption]), [{ id: 'x-r01', status: 'restored' }]);
  assert.deepEqual(checkRestored(planted.files, planted.applied, [corruption]), [{ id: 'x-r01', status: 'still_corrupt' }]);
  assert.deepEqual(checkRestored({ 'notes/trip.md': '- departure: Monday afternoon\n' }, planted.applied, [corruption]), [
    { id: 'x-r01', status: 'line_gone' },
  ]);
  assert.deepEqual(checkRestored({}, planted.applied, [corruption]), [{ id: 'x-r01', status: 'line_gone' }]);
});

test('checkRestored handles a near line elsewhere in the bullet', () => {
  const input = { 'people/list.md': '- depot\n  person: Mira (community volunteer)\n' };
  const corruption = { id: 'x-r02', kind: 'swap-person', find: 'Mira (community volunteer)', replace: 'Rowan (spouse)', near: 'depot', restore: 'Mira (community volunteer)' };
  const planted = applyCorruptions(input, [corruption]);
  assert.deepEqual(checkRestored(input, planted.applied, [corruption]), [{ id: 'x-r02', status: 'restored' }]);
  assert.deepEqual(checkRestored(planted.files, planted.applied, [corruption]), [{ id: 'x-r02', status: 'still_corrupt' }]);
});

test('checkRestored judges attributions by their true source phrase', () => {
  const input = filesFixture();
  const corruptions = [
    { id: 'x-a11', kind: 'attribution', near: 'ferry', expectAttribution: 'document' },
    { id: 'x-a12', kind: 'attribution', near: 'asking the doctor', expectAttribution: 'assistant' },
    { id: 'x-a13', kind: 'attribution', near: 'online booking', expectAttribution: 'user_belief' },
  ];
  const planted = applyCorruptions(input, corruptions);

  assert.deepEqual(checkRestored(input, planted.applied, corruptions).map((entry) => entry.status), [
    'restored',
    'restored',
    'restored',
  ]);
  assert.deepEqual(checkRestored(planted.files, planted.applied, corruptions).map((entry) => entry.status), [
    'still_corrupt',
    'still_corrupt',
    'still_corrupt',
  ]);

  const partly = { ...planted.files };
  const originalLine = input['notes/sources.md'].split('\n').find((line) => line.includes('online booking'));
  partly['notes/sources.md'] = planted.files['notes/sources.md']
    .split('\n')
    .map((line) => (line.includes('online booking') ? originalLine : line))
    .join('\n');
  assert.deepEqual(checkRestored(partly, planted.applied, corruptions).map((entry) => entry.status), [
    'still_corrupt',
    'still_corrupt',
    'restored',
  ]);
});

test('checkRestored includes a corruption that was never planted as line_gone', () => {
  assert.deepEqual(checkRestored({}, [], [{ id: 'x-r03', kind: 'number', find: 'a', replace: 'b' }]), [
    { id: 'x-r03', status: 'line_gone' },
  ]);
});
