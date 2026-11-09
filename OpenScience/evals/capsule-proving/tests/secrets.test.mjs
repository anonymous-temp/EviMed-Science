import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cnIdChecksumValid,
  fakeApiKey,
  fakeBankCard,
  fakeCnId,
  fakeCnMobile,
  fakePassword,
  luhnValid,
  secretCorpus,
} from '../synthetic/secrets.mjs';
import { rng } from '../synthetic/spec.mjs';

const REGION_CODES = new Set([
  '110101', '310104', '440305', '330106', '510107',
  '420106', '320102', '500103', '120101', '210102',
  '370102', '410105', '430102', '350102', '610113',
  '230102', '450103', '530102', '360102', '140105',
]);

const CN_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CN_CHECK_CHARS = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

/** Recompute the checksum locally, so the impossible-date case can have a correct check character. */
function cnCheckChar(base17) {
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(base17[i]) * CN_WEIGHTS[i];
  return CN_CHECK_CHARS[sum % 11];
}

/** Shape plus checksum validators for the nine corpus types. */
const VALIDATORS = {
  bankCard(v) {
    assert.match(v, /^(?:62\d{14,17}|4\d{15}|5[1-5]\d{14})$/, `bank card shape: ${v}`);
    assert.ok(luhnValid(v), `bank card Luhn: ${v}`);
  },
  cnId(v) {
    assert.match(v, /^\d{17}[\dX]$/, `CN ID shape: ${v}`);
    assert.ok(REGION_CODES.has(v.slice(0, 6)), `CN ID region: ${v}`);
    const birth = v.slice(6, 14);
    assert.ok(birth >= '19500101' && birth <= '20081231', `CN ID birth date: ${v}`);
    assert.ok(cnIdChecksumValid(v), `CN ID checksum: ${v}`);
  },
  sk(v) {
    assert.match(v, /^sk-[A-Za-z0-9]{48}$/, `sk shape: ${v}`);
  },
  'sk-proj'(v) {
    assert.match(v, /^sk-proj-[A-Za-z0-9_-]{64}$/, `sk-proj shape: ${v}`);
  },
  ghp(v) {
    assert.match(v, /^ghp_[A-Za-z0-9]{36}$/, `ghp shape: ${v}`);
  },
  aws(v) {
    assert.match(v, /^AKIA[A-Z0-9]{16}$/, `aws shape: ${v}`);
  },
  jwt(v) {
    assert.match(v, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, `JWT shape: ${v}`);
    const [headerSegment] = v.split('.');
    const header = JSON.parse(Buffer.from(headerSegment, 'base64url').toString('utf8'));
    assert.equal(typeof header, 'object');
    assert.equal(header.typ, 'JWT');
    assert.ok(header.alg, 'JWT header has an algorithm');
  },
  password(v) {
    assert.ok(v.length >= 10 && v.length <= 16, `password length: ${v}`);
    assert.match(v, /[A-Z]/, `password upper: ${v}`);
    assert.match(v, /[a-z]/, `password lower: ${v}`);
    assert.match(v, /\d/, `password digit: ${v}`);
    assert.match(v, /[^A-Za-z0-9]/, `password symbol: ${v}`);
  },
  mobile(v) {
    assert.match(v, /^1[3-9]\d{9}$/, `mobile shape: ${v}`);
  },
};

test('Luhn accepts the standard example and rejects a one-digit change', () => {
  assert.equal(luhnValid('79927398713'), true);
  for (const changed of ['79927398712', '79927398723', '89927398713']) {
    assert.equal(luhnValid(changed), false, changed);
  }
  assert.equal(luhnValid(''), false);
  assert.equal(luhnValid('7992-7398-713'), true);
});

test('CN ID checksum accepts a correct check character and rejects a wrong one', () => {
  const valid = fakeCnId(rng('cn-id-check'));
  assert.equal(valid.length, 18);
  assert.equal(cnIdChecksumValid(valid), true);
  const wrong = `${valid.slice(0, 17)}${valid[17] === '0' ? '1' : '0'}`;
  assert.equal(cnIdChecksumValid(wrong), false);
  assert.equal(cnIdChecksumValid(''), false);
  assert.equal(cnIdChecksumValid('11010119900307123'), false);
});

test('CN ID rejects an impossible calendar date even with a correct check character', () => {
  const base17 = `110101${'20210230'}${'123'}`;
  const withCorrectCheck = `${base17}${cnCheckChar(base17)}`;
  assert.equal(withCorrectCheck.length, 18);
  assert.equal(cnIdChecksumValid(withCorrectCheck), false);
  // The same date made real (2021-02-28) passes, so the failure above is the date and not the checksum.
  const realBase17 = `110101${'20210228'}${'123'}`;
  assert.equal(cnIdChecksumValid(`${realBase17}${cnCheckChar(realBase17)}`), true);
});

test('500 generated items all pass their shape and checksum validators', () => {
  const items = secretCorpus({ seed: 'shape-check', count: 500 });
  assert.equal(items.length, 500);
  for (const [i, item] of items.entries()) {
    assert.equal(item.id, `s${String(i + 1).padStart(4, '0')}`);
    assert.ok(VALIDATORS[item.type], `known type: ${item.type}`);
    VALIDATORS[item.type](item.value);
  }
});

test('the corpus is seeded, balanced, uniquely identified and has unique values', () => {
  const a = secretCorpus({ seed: 'same-seed', count: 180 });
  const b = secretCorpus({ seed: 'same-seed', count: 180 });
  const c = secretCorpus({ seed: 'other-seed', count: 180 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(new Set(a.map((x) => x.value)).size, a.length);
  assert.equal(new Set(a.map((x) => x.id)).size, a.length);
  const counts = new Map();
  for (const item of a) counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
  assert.equal(counts.size, 9);
  assert.equal([...counts.values()].reduce((n, x) => n + x, 0), a.length);
  assert.ok(Math.max(...counts.values()) - Math.min(...counts.values()) <= 1, 'round-robin balance');
  assert.equal(a[0].type, 'bankCard');
  assert.equal(a[8].type, 'mobile');
  assert.equal(a[9].type, 'bankCard');
});

test('individual fake generators produce the requested shapes', () => {
  assert.match(fakeBankCard(rng('card')), /^(?:62\d{14,17}|4\d{15}|5[1-5]\d{14})$/);
  assert.match(fakeCnId(rng('id')), /^\d{17}[\dX]$/);
  assert.match(fakeApiKey(rng('sk'), 'sk'), /^sk-[A-Za-z0-9]{48}$/);
  assert.match(fakeApiKey(rng('proj'), 'sk-proj'), /^sk-proj-[A-Za-z0-9_-]{64}$/);
  assert.match(fakeApiKey(rng('ghp'), 'ghp'), /^ghp_[A-Za-z0-9]{36}$/);
  assert.match(fakeApiKey(rng('aws'), 'aws'), /^AKIA[A-Z0-9]{16}$/);
  assert.match(fakePassword(rng('password')), /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{10,16}$/);
  assert.match(fakeCnMobile(rng('mobile')), /^1[3-9]\d{9}$/);
  assert.throws(() => fakeApiKey(rng('bad'), 'unknown'), /unknown API key kind/);
});
