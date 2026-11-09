import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { rng } from '../synthetic/spec.mjs';
import {
  G4_DELETE_VIA,
  G4_PLANT_VIA,
  G4_RELEARN,
  G4_SCAN,
  G5_PROBES,
  G5_READERS,
  TRIALS_SCHEMA,
  deletionTrials,
  isolationExpectation,
  isolationTrials,
  makeMarker,
} from '../synthetic/trialPlans.mjs';

const carriers = [
  { id: 'gym-locker', text: '我健身房的柜子号是 {marker}，别忘了' },
  { id: 'parcel', text: '快递柜取件码是 {marker}，明天中午前取' },
  { id: 'bike', text: '自行车停车位编号是 {marker}，在负一层' },
];

const MARKER_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ]-\d{5}$/;
const isDestructive = (trial) => trial.deleteVia === 'memory-reset' || trial.deleteVia === 'delete-account';
const fill = (carrier, marker) => carrier.text.replace('{marker}', marker);

test('deletion plans balance every plant/delete combination and rotate relearn inside it', () => {
  const trials = deletionTrials({ seed: 'balance', count: 47, carriers });
  assert.equal(trials.length, 47);
  const combinations = new Map();
  for (const trial of trials) {
    const key = `${trial.plantVia}|${trial.deleteVia}`;
    if (!combinations.has(key)) combinations.set(key, []);
    combinations.get(key).push(trial);
  }
  assert.equal(combinations.size, G4_PLANT_VIA.length * G4_DELETE_VIA.length);
  for (const plantVia of G4_PLANT_VIA) {
    for (const deleteVia of G4_DELETE_VIA) {
      const group = combinations.get(`${plantVia}|${deleteVia}`);
      assert.ok(group, `${plantVia} × ${deleteVia} missing`);
      assert.ok(Math.abs(group.length - 47 / 18) <= 1, `${plantVia} × ${deleteVia}: ${group.length}`);
      group.forEach((trial, i) => assert.equal(trial.relearn, G4_RELEARN[i % G4_RELEARN.length]));
    }
  }
  for (const value of G4_RELEARN) assert.ok(trials.some((trial) => trial.relearn === value), value);
  for (const trial of trials) {
    assert.deepEqual(trial.scan, G4_SCAN);
    assert.equal(trial.expect.markerAfterDelete, 0);
  }
});

test('markers are unique across both plan files and keep the ordinary code shape', () => {
  const g4 = deletionTrials({ seed: 'marker-space', count: 36, carriers });
  const g5 = isolationTrials({ seed: 'marker-space', count: 12, carriers });
  const entries = [
    ...g4.flatMap((trial) => [{ marker: trial.marker, plantText: trial.plantText }, ...trial.controls]),
    ...g5,
  ];
  const markers = entries.map((entry) => entry.marker);
  assert.equal(new Set(markers).size, markers.length);
  for (const marker of markers) assert.match(marker, MARKER_PATTERN);

  const used = new Set();
  const r = rng('direct-markers');
  const direct = Array.from({ length: 200 }, () => makeMarker(r, used));
  assert.equal(new Set(direct).size, direct.length);
  for (const marker of direct) assert.match(marker, MARKER_PATTERN);
});

test('destructive trials own unique accounts and lose their controls; shared accounts hold at most 25', () => {
  const trials = deletionTrials({ seed: 'accounts', count: 180, carriers });
  const destructive = trials.filter(isDestructive);
  const shared = trials.filter((trial) => !isDestructive(trial));
  assert.ok(destructive.length > 0 && shared.length > 0);

  assert.equal(new Set(destructive.map((trial) => trial.account)).size, destructive.length);
  for (const trial of destructive) {
    assert.equal(trial.expect.controlsSurvive, false);
    assert.equal(trial.expect.markerAfterDelete, 0);
  }

  const destructiveAccounts = new Set(destructive.map((trial) => trial.account));
  const sizes = new Map();
  for (const trial of shared) {
    assert.ok(!destructiveAccounts.has(trial.account), `${trial.trialId} shares a destroyed account`);
    assert.equal(trial.expect.controlsSurvive, true);
    sizes.set(trial.account, (sizes.get(trial.account) ?? 0) + 1);
  }
  assert.ok([...sizes.values()].every((n) => n <= 25), JSON.stringify([...sizes.entries()]));
  assert.equal([...sizes.values()].reduce((a, b) => a + b, 0), shared.length);
});

test('isolationExpectation matches the table for every reader and writer case', () => {
  const cases = [
    ['other-account', { project: null, geoShared: false }, false],
    ['other-account', { project: 'p1', geoShared: true }, false],
    ['geo-nonmember', { project: 'geo-proj-001', geoShared: true }, false],
    ['geo-nonmember', { project: null, geoShared: false }, false],
    ['after-member-removed', { project: 'geo-proj-001', geoShared: true }, false],
    ['after-member-removed', { project: null, geoShared: false }, false],
    ['geo-member', { project: 'geo-proj-001', geoShared: true }, true],
    ['geo-member', { project: 'geo-proj-002', geoShared: false }, false],
    ['geo-member', { project: null, geoShared: true }, true],
    ['same-account-other-project', { project: 'proj-001', geoShared: false }, false],
    ['same-account-other-project', { project: null, geoShared: false }, true],
    ['same-account-no-project', { project: 'proj-001', geoShared: false }, false],
    ['same-account-no-project', { project: null, geoShared: false }, true],
  ];
  for (const [reader, writer, expected] of cases) {
    assert.equal(isolationExpectation(writer, reader), expected, `${reader} with ${JSON.stringify(writer)}`);
  }
});

test('the same seed gives an identical plan and another seed does not', () => {
  const a4 = deletionTrials({ seed: 'repeatable', count: 60, carriers });
  const b4 = deletionTrials({ seed: 'repeatable', count: 60, carriers });
  assert.deepEqual(a4, b4);
  assert.notDeepEqual(deletionTrials({ seed: 'different', count: 60, carriers }), a4);

  const a5 = isolationTrials({ seed: 'repeatable', count: 24, carriers });
  const b5 = isolationTrials({ seed: 'repeatable', count: 24, carriers });
  assert.deepEqual(a5, b5);
  assert.notDeepEqual(isolationTrials({ seed: 'different', count: 24, carriers }), a5);
});

test('plantText is the carrier text with its own marker filled in', () => {
  const g4 = deletionTrials({ seed: 'plant-text', count: 36, carriers });
  const g5 = isolationTrials({ seed: 'plant-text', count: 12, carriers });
  for (const trial of [...g4, ...g5]) {
    const carrier = carriers.find((c) => c.id === trial.carrierId);
    assert.ok(carrier, trial.carrierId);
    assert.equal(trial.plantText, fill(carrier, trial.marker));
    assert.ok(trial.plantText.includes(trial.marker));
    assert.ok(!trial.plantText.includes('{marker}'));
  }
  for (const trial of g4) {
    assert.equal(trial.controls.length, 2);
    for (const control of trial.controls) {
      const carrier = carriers.find((c) => c.id === control.carrierId);
      assert.ok(carrier, control.carrierId);
      assert.equal(control.plantText, fill(carrier, control.marker));
      assert.ok(control.plantText.includes(control.marker));
    }
  }
});

test('isolation plans rotate readers, mark a seeded 30% concurrent and assign writers by rule', () => {
  const trials = isolationTrials({ seed: 'isolation', count: 60, carriers });
  assert.equal(trials.length, 60);
  assert.equal(trials.filter((trial) => trial.concurrent).length, Math.round(60 * 0.3));
  trials.forEach((trial, i) => {
    assert.equal(trial.reader, G5_READERS[i % G5_READERS.length]);
    assert.deepEqual(trial.probes, G5_PROBES);
    assert.equal(trial.expectVisible, isolationExpectation(trial.writer, trial.reader));
    assert.match(trial.writer.account, /^acct-g5-\d{3,}$/);
  });

  for (const reader of G5_READERS) {
    const group = trials.filter((trial) => trial.reader === reader);
    assert.equal(group.length, 10);
    if (['geo-member', 'geo-nonmember', 'after-member-removed'].includes(reader)) {
      assert.equal(group.filter((trial) => trial.writer.geoShared).length, 5);
      for (const trial of group) {
        if (trial.writer.geoShared) assert.match(trial.writer.project, /^geo-proj-\d{3}$/);
        else assert.equal(trial.writer.project, null);
      }
    } else {
      assert.equal(group.filter((trial) => trial.writer.project !== null).length, 5);
      assert.ok(group.every((trial) => trial.writer.geoShared === false));
      for (const trial of group) {
        if (trial.writer.project !== null) assert.match(trial.writer.project, /^proj-\d{3}$/);
      }
    }
  }
});

test('the CLI writes both plan files with the shared schema and a seeded count', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trial-plans-'));
  try {
    const carriersPath = join(dir, 'carriers.json');
    const out = join(dir, 'out');
    writeFileSync(carriersPath, `${JSON.stringify(carriers)}\n`);
    const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'synthetic', 'trialPlans.mjs');
    const run = spawnSync(process.execPath, [script, '--carriers', carriersPath, '--seed', 'cli-seed', '--out', out, '--g4-count', '36', '--g5-count', '12'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const g4 = JSON.parse(readFileSync(join(out, 'g4-trials.json'), 'utf8'));
    const g5 = JSON.parse(readFileSync(join(out, 'g5-trials.json'), 'utf8'));
    assert.equal(g4.schema, TRIALS_SCHEMA);
    assert.equal(g5.schema, TRIALS_SCHEMA);
    assert.equal(g4.seed, 'cli-seed');
    assert.equal(g5.seed, 'cli-seed');
    assert.equal(g4.count, g4.trials.length);
    assert.equal(g5.count, g5.trials.length);
    assert.equal(g4.trials.length, 36);
    assert.equal(g5.trials.length, 12);
    const markers = [
      ...g4.trials.flatMap((trial) => [trial.marker, ...trial.controls.map((control) => control.marker)]),
      ...g5.trials.map((trial) => trial.marker),
    ];
    assert.equal(new Set(markers).size, markers.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
