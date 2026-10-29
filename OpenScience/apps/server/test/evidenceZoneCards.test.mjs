// The card port of a topic zone's page: nothing today, the team's interface when it is connected, and never a thrown error.
import assert from "node:assert/strict";
import test from "node:test";
import { EVIDENCE_ZONE_CARDS_MAX, createEvidenceZoneCards } from "../src/evidenceZoneCards.mjs";

const zone = { id: "ez_1", slug: "glp1-obesity", title: "GLP-1 受体激动剂减重", definition: { type: "drug-indication" } };
const card = (id, extra = {}) => ({ provider: "team", id, version: "1", updatedAt: null, status: "current", title: `card ${id}`, conclusion: "x", certainty: null,
  producer: { name: "团队", kind: "team" }, sourceCount: 2, detail: { kind: "link", url: "https://example.org/c" }, ...extra });

test("the default provider is none: an empty list, and a status that says nothing is connected", async () => {
  for (const config of [undefined, null, {}, { evidenceCardProvider: "none" }, { evidenceCardProvider: "anything else" }]) {
    const port = createEvidenceZoneCards({ config });
    assert.equal(port.provider, "none");
    assert.deepEqual(await port.list(zone, { limit: 3 }), []);
  }
  const port = createEvidenceZoneCards({ config: { evidenceCardProvider: "none" }, external: { list: async () => { throw new Error("must not be asked"); } } });
  assert.deepEqual(await port.list(zone), [], "an adapter is ignored while the provider is none");
  assert.deepEqual(port.status(), { provider: "none", configured: false, lists: 1, failures: 0 });
});

test("external without an adapter is a stub that says so; with one it hands the zone and a bounded limit over", async () => {
  const stub = createEvidenceZoneCards({ config: { evidenceCardProvider: "external" } });
  assert.deepEqual(await stub.list(zone), []);
  assert.deepEqual(stub.status(), { provider: "external", configured: false, lists: 1, failures: 0 });

  /** @type {any[]} */ const asked = [];
  const port = createEvidenceZoneCards({ config: { evidenceCardProvider: "external" }, external: { async list(given, options) { asked.push([given, options]); return [card("a"), card("b"), { id: "no-title", title: "" }, null, card("c")]; } } });
  assert.deepEqual((await port.list(zone, { limit: 2 })).map((entry) => entry.id), ["a", "b"], "the limit holds, and an entry without an id or a title is not a card");
  assert.deepEqual(asked[0], [{ id: "ez_1", slug: "glp1-obesity", title: "GLP-1 受体激动剂减重", definition: { type: "drug-indication" } }, { limit: 2 }]);
  await port.list(zone, { limit: 9999 });
  await port.list({ id: "ez_2", title: "t" }, { limit: 0 });
  assert.deepEqual([asked[1][1], asked[2][1]], [{ limit: EVIDENCE_ZONE_CARDS_MAX }, { limit: 3 }], "a limit past the port's bound is cut; a nonsense one is the default");
  assert.equal(asked[2][0].slug, null);
  assert.deepEqual(port.status(), { provider: "external", configured: true, lists: 3, failures: 0 });
});

test("an interface that fails costs the cards and nothing else", async () => {
  const port = createEvidenceZoneCards({ config: { evidenceCardProvider: "external" }, external: { list: async () => { throw Object.assign(new Error("502"), { code: "upstream" }); } } });
  assert.deepEqual(await port.list(zone), []);
  assert.deepEqual(await port.list(zone), []);
  assert.deepEqual(port.status(), { provider: "external", configured: true, lists: 2, failures: 2 });
  const odd = createEvidenceZoneCards({ config: { evidenceCardProvider: "external" }, external: { list: async () => ({ not: "a list" }) } });
  assert.deepEqual(await odd.list(zone), []);
});
