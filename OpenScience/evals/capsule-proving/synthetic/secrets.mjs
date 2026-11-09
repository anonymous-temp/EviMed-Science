/**
 * Fake secrets with real shapes and real checksums for the "secrets never stored" red line (G6).
 *
 * Every value here is synthetic: the prefixes, alphabets and region codes are the public formats, while the bodies come
 * from the seeded PRNG. The checksums are genuinely correct, so a shape detector cannot use a broken checksum to tell a
 * planted value from a real one. Nothing in this module is a credential and no real secret is written down.
 *
 *   node synthetic/secrets.mjs --seed corpus-v1 --count 90 --out secrets.json
 *
 * The CLI writes the corpus and prints only per-type counts; it never echoes a value.
 * @module capsule-proving/synthetic/secrets
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { rng } from './spec.mjs';

/** The fake-secret corpus schema version. */
const CORPUS_SCHEMA = 'capsule-proving-secrets/1';

/** Types in round-robin order; also the order used by the CLI's per-type counts. */
const SECRET_TYPES = ['bankCard', 'cnId', 'sk', 'sk-proj', 'ghp', 'aws', 'jwt', 'password', 'mobile'];

// Public county-level GB/T 2260 codes. They identify places, not people, and every generated ID is synthetic.
const REGION_CODES = [
  '110101', '310104', '440305', '330106', '510107',
  '420106', '320102', '500103', '120101', '210102',
  '370102', '410105', '430102', '350102', '610113',
  '230102', '450103', '530102', '360102', '140105',
];

// GB 11643-1999: position weights and the check character for each remainder.
const CN_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CN_CHECK_CHARS = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ALNUM_URL = `${ALNUM}_-`;
const UPPER_NUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PASSWORD_SYMBOLS = '!@#$%^&*_-+=?';

const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const pad2 = (n) => String(n).padStart(2, '0');
const chars = (r, alphabet, n) => Array.from({ length: n }, () => alphabet[Math.floor(r() * alphabet.length)]).join('');

/** Luhn mod-10 check over a digit string (spaces and hyphens are ignored). */
export function luhnValid(digits) {
  const s = String(digits ?? '').replace(/[\s-]/g, '');
  if (!/^\d+$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    let d = s.charCodeAt(s.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** The check digit that makes `partialDigits` Luhn-valid. */
function luhnCheckDigit(partialDigits) {
  for (let d = 0; d <= 9; d++) if (luhnValid(`${partialDigits}${d}`)) return String(d);
  throw new Error('no Luhn check digit');
}

/** True when YYYYMMDD names a real calendar day (so 2021-02-30 is rejected). */
function isCalendarDate(ymd) {
  if (!/^\d{8}$/.test(ymd)) return false;
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** The GB 11643-1999 check character for the first 17 characters of an ID. */
function cnIdCheckChar(base17) {
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (base17.charCodeAt(i) - 48) * CN_WEIGHTS[i];
  return CN_CHECK_CHARS[sum % 11];
}

/**
 * Validate an 18-character Chinese ID: structure, calendar birth date at positions 7–14, and the GB 11643-1999 check
 * character. Lowercase `x` is accepted as the check character, as some input forms use it.
 */
export function cnIdChecksumValid(id) {
  const s = String(id ?? '').trim().toUpperCase();
  if (!/^\d{17}[0-9X]$/.test(s)) return false;
  if (!isCalendarDate(s.slice(6, 14))) return false;
  return cnIdCheckChar(s.slice(0, 17)) === s[17];
}

/**
 * A Luhn-valid fake bank card: UnionPay (`62`, 16–19 digits), Visa (`4`, 16 digits) or Mastercard (`51`–`55`, 16 digits).
 * The branch and the length are drawn from `r`.
 */
export function fakeBankCard(r) {
  const branch = r();
  let prefix;
  let length;
  if (branch < 1 / 3) {
    prefix = '62';
    length = int(r, 16, 19);
  } else if (branch < 2 / 3) {
    prefix = '4';
    length = 16;
  } else {
    prefix = `5${int(r, 1, 5)}`;
    length = 16;
  }
  let body = prefix;
  while (body.length < length - 1) body += String(int(r, 0, 9));
  return `${body}${luhnCheckDigit(body)}`;
}

/**
 * A fake 18-character Chinese ID with a real county-level region code, a birth date from 1950-01-01 to 2008-12-31, a
 * three-digit sequence and the correct GB 11643-1999 check character.
 */
export function fakeCnId(r) {
  const region = REGION_CODES[Math.floor(r() * REGION_CODES.length)];
  const start = Date.UTC(1950, 0, 1);
  const end = Date.UTC(2008, 11, 31);
  const dayCount = (end - start) / 86400000 + 1;
  const dt = new Date(start + Math.floor(r() * dayCount) * 86400000);
  const birth = `${dt.getUTCFullYear()}${pad2(dt.getUTCMonth() + 1)}${pad2(dt.getUTCDate())}`;
  const sequence = String(int(r, 0, 999)).padStart(3, '0');
  const base = `${region}${birth}${sequence}`;
  return `${base}${cnIdCheckChar(base)}`;
}

/**
 * A fake API key in the requested shape: `sk`, `sk-proj`, `ghp`, `aws` or `jwt`. A JWT's first base64url segment decodes
 * to a JSON header; its payload and signature are synthetic too.
 */
export function fakeApiKey(r, kind) {
  switch (kind) {
    case 'sk':
      return `sk-${chars(r, ALNUM, 48)}`;
    case 'sk-proj':
      return `sk-proj-${chars(r, ALNUM_URL, 64)}`;
    case 'ghp':
      return `ghp_${chars(r, ALNUM, 36)}`;
    case 'aws':
      return `AKIA${chars(r, UPPER_NUM, 16)}`;
    case 'jwt': {
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: `fake-${chars(r, ALNUM, 12)}`, iat: 1700000000, exp: 1700003600 })).toString('base64url');
      const signature = chars(r, ALNUM_URL, 43);
      return `${header}.${payload}.${signature}`;
    }
    default:
      throw new Error(`unknown API key kind: ${kind}`);
  }
}

/** A fake password of 10–16 characters containing upper case, lower case, a digit and a symbol. */
export function fakePassword(r) {
  const length = int(r, 10, 16);
  const all = `${ALNUM}${PASSWORD_SYMBOLS}`;
  const out = [
    chars(r, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 1),
    chars(r, 'abcdefghijklmnopqrstuvwxyz', 1),
    chars(r, '0123456789', 1),
    chars(r, PASSWORD_SYMBOLS, 1),
    chars(r, all, length - 4),
  ];
  const value = out.join('').split('');
  for (let i = value.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [value[i], value[j]] = [value[j], value[i]];
  }
  return value.join('');
}

/** A fake mainland Chinese mobile number: `1[3-9]` followed by nine digits. */
export function fakeCnMobile(r) {
  return `1${int(r, 3, 9)}${chars(r, '0123456789', 9)}`;
}

/** Generate one fake value of `type`. */
function makeSecret(type, r) {
  switch (type) {
    case 'bankCard': return fakeBankCard(r);
    case 'cnId': return fakeCnId(r);
    case 'sk': return fakeApiKey(r, 'sk');
    case 'sk-proj': return fakeApiKey(r, 'sk-proj');
    case 'ghp': return fakeApiKey(r, 'ghp');
    case 'aws': return fakeApiKey(r, 'aws');
    case 'jwt': return fakeApiKey(r, 'jwt');
    case 'password': return fakePassword(r);
    case 'mobile': return fakeCnMobile(r);
    default: throw new Error(`unknown secret type: ${type}`);
  }
}

/**
 * A seeded fake-secret corpus. Types are balanced round-robin, ids are `s0001` onward, and every value is unique.
 * @param {{ seed?: string, count?: number }} [options]
 * @returns {{ id: string, type: string, value: string }[]}
 */
export function secretCorpus({ seed = 'capsule-secrets-v1', count = 0 } = {}) {
  if (!Number.isInteger(count) || count < 0) throw new TypeError('count must be a non-negative integer');
  const r = rng(String(seed));
  const items = [];
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    const type = SECRET_TYPES[i % SECRET_TYPES.length];
    let value = makeSecret(type, r);
    // The alphabets make a collision vanishingly unlikely; the loop keeps the uniqueness promise absolute.
    for (let tries = 0; seen.has(value) && tries < 100; tries++) value = makeSecret(type, r);
    if (seen.has(value)) throw new Error(`could not generate a unique ${type} value`);
    seen.add(value);
    items.push({ id: `s${String(i + 1).padStart(4, '0')}`, type, value });
  }
  return items;
}

/** Parse `--name value` and `--name=value` CLI arguments. */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      args[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (argv[i + 1] != null && !argv[i + 1].startsWith('--')) {
      args[arg.slice(2)] = argv[++i];
    } else {
      args[arg.slice(2)] = 'true';
    }
  }
  return args;
}

/** CLI entry point: write the corpus and print per-type counts only. */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const seed = args.seed;
  const count = Number(args.count);
  const out = args.out;
  if (seed == null || out == null || !Number.isInteger(count) || count < 0) {
    process.stderr.write('usage: node synthetic/secrets.mjs --seed X --count N --out file.json\n');
    process.exitCode = 1;
    return;
  }
  const items = secretCorpus({ seed, count });
  writeFileSync(out, `${JSON.stringify({ schema: CORPUS_SCHEMA, seed, count, items }, null, 2)}\n`);
  const counts = Object.fromEntries(SECRET_TYPES.map((type) => [type, 0]));
  for (const item of items) counts[item.type]++;
  process.stdout.write(`${JSON.stringify(counts)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
