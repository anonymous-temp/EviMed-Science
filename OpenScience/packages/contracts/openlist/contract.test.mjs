/**
 * The openlist pin's contract test.
 *
 * Hidden knowledge: what has to hold before this dependency's pin may move.
 * The service itself is not deployed here yet, so what can be asserted today is
 * the discipline rather than the endpoints: the version is defined once, the
 * contract directory the nightly matrix loops over exists, and the endpoints we
 * actually call are written down so a later upgrade knows what to replay.
 *
 * The endpoint assertions land here when the service is deployed. Recording
 * that now, in the same shape as the DSH test, is what keeps one mechanism for
 * four dependencies instead of four mechanisms.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const depsVersions = JSON.parse(await readFile(new URL("../../../deps-version.json", import.meta.url), "utf8"));

test("the pin is defined once, in the one place pins live", () => {
  const pin = depsVersions["openlist"];
  assert.ok(pin, "openlist is missing from deps-version.json");
  assert.match(pin.version, /^\d+\.\d+/, "a pin must be an exact version, not a range");
  assert.equal(pin.contractDir, "packages/contracts/openlist");
  assert.ok(String(pin.notes ?? "").length > 20, "a pin carries the reason it is what it is");
});
