import assert from 'node:assert/strict';
import test from 'node:test';
import { lowerConfidenceBound, recommendThreshold } from './statistics.mjs';

test('exact one-sided bounds cannot turn twelve successes into 95% certainty', () => {
  assert.equal(lowerConfidenceBound(0, 0), 0);
  assert.ok(Math.abs(lowerConfidenceBound(12, 12) - 0.7790778) < 1e-6);
  assert.ok(lowerConfidenceBound(59, 59) > 0.95);
  assert.ok(lowerConfidenceBound(58, 58) < 0.95);
  assert.ok(lowerConfidenceBound(95, 100) < 0.91);
});

test('threshold recommendations account for mistakes and remain exploratory', () => {
  const rows = Array.from({ length: 60 }, () => ({ confidence: 0.9, correct: true }));
  rows.push({ confidence: 0.8, correct: false });
  const recommendation = recommendThreshold(rows);
  assert.equal(recommendation.threshold, 0.9);
  assert.equal(recommendation.exploratory, true);
  assert.equal(recommendThreshold(rows.slice(0, 12)), null);
});
