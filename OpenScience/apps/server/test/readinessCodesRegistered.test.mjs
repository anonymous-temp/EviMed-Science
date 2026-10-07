import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { READINESS_ERROR_CODES, ALL_ERROR_CODES, errorCodeOutcome, knownErrorCodeMessage } from "@evimed/domain";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * The operator console prints a Chinese sentence for the code a configuration
 * check failed with, or for the warning it passed with (2026-10-07 audit, 设置 ·
 * 运维). This walks the server's own source for every literal it can emit, so a
 * code added there without a sentence in the domain's registry fails here
 * rather than printing as an identifier in the console. The counts are asserted:
 * a walk that matches nothing passes forever.
 */
function sourceText() {
  return fs.readdirSync(SRC).filter((name) => name.endsWith(".mjs")).map((name) => [name, fs.readFileSync(path.join(SRC, name), "utf8")]);
}

test("every code a readiness check can fail with has a Chinese sentence in the registry", () => {
  const failures = new Set();
  for (const [, text] of sourceText()) for (const match of text.matchAll(/readinessFailure\(\s*"([a-z0-9_]+)"/g)) failures.add(match[1]);
  assert.ok(failures.size > 100, `the walk found only ${failures.size} readiness failures`);
  const missing = [...failures].filter((code) => !knownErrorCodeMessage(code));
  assert.deepEqual(missing, [], `readiness failures with no sentence: ${missing.join(", ")}`);
  const sentences = [...failures].filter((code) => /[一-鿿]/.test(knownErrorCodeMessage(code) ?? ""));
  assert.equal(sentences.length, failures.size);
});

test("every warning a green readiness check carries has a sentence of its own, not a family's", () => {
  const warnings = new Set();
  const named = [
    /warnings\.push\(\s*"([a-z0-9_]+)"/g,
    /warning:\s*"([a-z0-9_]+)"/g,
    /\?\s*\["([a-z0-9_]+)"\]\s*:\s*\[\]/g,
  ];
  for (const [name, text] of sourceText()) {
    if (!/^(geo|vcr|frontier|evimedCredits|server|reviewService)/.test(name)) continue;
    for (const pattern of named) for (const match of text.matchAll(pattern)) if (/^(geo|vcr|frontier|evimed|openlist)_/.test(match[1])) warnings.add(match[1]);
  }
  // The frontier plugin's three states are a lookup table, not a push.
  for (const state of ["unreachable", "incompatible", "unconfigured"]) warnings.add(`frontier_plugin_${state}`);
  assert.ok(warnings.size >= 14, `the walk found only ${warnings.size} warnings`);
  const loose = [...warnings].filter((code) => !READINESS_ERROR_CODES.includes(code) && !ALL_ERROR_CODES.includes(code));
  assert.deepEqual(loose, [], `warnings in no registry list: ${loose.join(", ")}`);
  // geo_* would otherwise read as the family's 「稍后再试」, which is not what an unconfigured market is.
  for (const code of ["geo_market_unconfigured", "geo_social_unconfigured", "geo_worker_missing", "evimed_credits_wallet_not_wired", "openlist_storage_missing"]) {
    assert.ok(knownErrorCodeMessage(code), code);
    assert.doesNotMatch(knownErrorCodeMessage(code) ?? "", /稍后再试/, code);
  }
});

test("a readiness code describes the deployment, never a run", () => {
  for (const code of READINESS_ERROR_CODES) {
    assert.notEqual(errorCodeOutcome(code), "unknown", code);
    assert.ok(ALL_ERROR_CODES.includes(code), code);
  }
});
