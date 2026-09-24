// What a reader calls a source (plan 2026-09-23 §6.5 #5): the institution by
// its owner entity, never the feed; the table's own sanity; and the table
// against the knowledge-source plugin's registry, when the registry is checked
// out beside it.
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import { FRONTIER_SOURCE_DISPLAY_NAMES, frontierSourceDisplayName } from "../index.mjs";

// The plugin's registry, in the same repository today; the plugin team's own
// repository some day, when the registry test below says so and is skipped.
const registryUrl = new URL("../../../../项目代码/knowledge-plugin/registry/sources.json", import.meta.url);

test("a feed of an institution reads as the institution; the most specific name wins; an unknown source keeps its own name", () => {
  const fda = { id: "openfda-drug-enforcement-api", name: "openFDA 药品召回（enforcement）API", ownerEntity: "U.S. Food and Drug Administration" };
  assert.equal(frontierSourceDisplayName(fda), "FDA");
  assert.equal(frontierSourceDisplayName({ id: "mhra-alerts-recalls", name: "英国MHRA 警示与召回 Alerts and recalls",
    ownerEntity: "Medicines and Healthcare products Regulatory Agency" }), "英国 MHRA");
  assert.equal(frontierSourceDisplayName({ id: "nmpa-ggtg", name: "国家药监局 公告通告 NMPA Announcements", ownerEntity: "国家药品监督管理局" }), "国家药监局");
  // One owner, two public faces: the source id decides before the owner does.
  assert.equal(frontierSourceDisplayName({ id: "pubmed-rct-core-journals", name: "PubMed 检索流 · 核心临床期刊 RCT",
    ownerEntity: "U.S. National Library of Medicine" }), "PubMed");
  assert.equal(frontierSourceDisplayName({ id: "ctgov-results-first-posted", name: "ClinicalTrials.gov · 首次公布结果的试验",
    ownerEntity: "U.S. National Library of Medicine" }), "ClinicalTrials.gov");
  // A journal of a publisher of many journals is named by its own title.
  assert.equal(frontierSourceDisplayName({ id: "j-0140-6736", name: "柳叶刀 The Lancet", ownerEntity: "Elsevier" }), "柳叶刀 The Lancet");
  assert.equal(frontierSourceDisplayName({ id: "x", name: "  ", ownerEntity: "nobody" }), "x", "no name at all: the id, never an empty source");
  assert.equal(frontierSourceDisplayName(null), "");
});

test("the table holds short names only, frozen, and none is an interface's name", () => {
  const { sources, ownerEntities } = FRONTIER_SOURCE_DISPLAY_NAMES;
  assert.ok(Object.isFrozen(FRONTIER_SOURCE_DISPLAY_NAMES) && Object.isFrozen(sources) && Object.isFrozen(ownerEntities));
  const names = [...Object.values(sources), ...Object.values(ownerEntities)];
  // The walk proves it walked: an empty import would pass every check below.
  assert.ok(Object.keys(ownerEntities).length >= 40 && Object.keys(sources).length >= 5, "the table is the one written, not an empty object");
  for (const name of names) {
    assert.ok(name.trim() === name && name.length > 0 && [...name].length <= 40, JSON.stringify(name));
    // What a reader must never see: the words the registry names its feeds by.
    assert.doesNotMatch(name, /API|接口|检索流|RSS|频道|预印本流|主题流|OData/, `${name} reads as a feed, not an institution`);
  }
});

test("every name in the table names a source or an owner the plugin's registry has, and every registry feed name is covered", async (t) => {
  try {
    await access(registryUrl);
  } catch {
    t.skip("the knowledge-source plugin's registry is not checked out beside this package");
    return;
  }
  const rows = JSON.parse(await readFile(registryUrl, "utf8")).sources;
  assert.ok(Array.isArray(rows) && rows.length > 300, "the registry was read: it lists hundreds of sources");
  const owners = new Set(rows.map((row) => row.owner_entity));
  const ids = new Set(rows.map((row) => row.id));
  const strayOwners = Object.keys(FRONTIER_SOURCE_DISPLAY_NAMES.ownerEntities).filter((owner) => !owners.has(owner));
  assert.deepEqual(strayOwners, [], "a key that matches no owner entity names nothing (a typo, or an owner the plugin renamed)");
  const strayIds = Object.keys(FRONTIER_SOURCE_DISPLAY_NAMES.sources).filter((id) => !ids.has(id));
  assert.deepEqual(strayIds, [], "a key that matches no source id names nothing");
  // Every enabled source whose registry name is an interface's or a search
  // stream's gets an institution: this is the set the owner saw on the page.
  const uncovered = rows.filter((row) => row.enabled && /API|接口|检索流|OData/.test(row.name))
    .filter((row) => frontierSourceDisplayName({ id: row.id, name: row.name, ownerEntity: row.owner_entity }) === row.name)
    .map((row) => `${row.id}: ${row.name}`);
  assert.deepEqual(uncovered, []);
});
