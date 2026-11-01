import assert from "node:assert/strict";
import test from "node:test";
import { validWebVital } from "@evimed/domain";
import { WebVitals } from "../src/webVitals.mjs";

const opening = { route: "/app/chat", device: "desktop", name: "OPEN_COLD", id: "abc", value: 9_000 };

test("a conversation's opening is a measure the shell may report, and only with the usual bounds", () => {
  assert.ok(validWebVital(opening));
  assert.ok(validWebVital({ ...opening, name: "OPEN_WARM" }));
  assert.equal(validWebVital({ ...opening, name: "OPEN_OTHER" }), false);
  assert.equal(validWebVital({ ...opening, value: 600_001 }), false);
});

test("it reaches the operators' figures under its own name", () => {
  const vitals = new WebVitals(() => 1_000);
  vitals.record(opening);
  vitals.record({ ...opening, id: "def", value: 3_000 });
  assert.match(vitals.metrics().join("\n"), /evimed_web_vital_p75\{route="\/app\/chat",device="desktop",metric="OPEN_COLD",scope="document"\} 9000/);
});
