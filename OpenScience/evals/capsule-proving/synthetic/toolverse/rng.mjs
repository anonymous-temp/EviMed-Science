/** Seeded randomness shared by the ToolVerse-style generators. */
import { createHash } from 'node:crypto';

/** @param {string|number} seed @returns {() => number} mulberry32 over a hash of the seed. */
export function makeRng(seed) {
  let a = createHash('sha256').update(String(seed)).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const pick = (rng, xs) => xs[Math.floor(rng() * xs.length)];
export const int = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
export const hex = (rng, n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rng() * 16)]).join('');
export const digits = (rng, n) => Array.from({ length: n }, (_, i) => (i === 0 ? int(rng, 1, 9) : int(rng, 0, 9))).join('');
export function shuffle(rng, xs) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
