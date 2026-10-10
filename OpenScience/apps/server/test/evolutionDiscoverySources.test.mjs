// Which frontier entries are 循证进化's AI-discovery channel, and what the platform reads off the source that carried them.
// The plugin's contract has no field for it, so the id prefix is the marker: this file and the plugin's registry must agree.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AI_DISCOVERY_PREFIX, AI_LAB_FEED_SOURCE_IDS, LEGACY_DISCOVERY_SOURCE_ID, arxivIdOf, codeLinkOf, dedupeKey, discoverySourceTraits,
  isDiscoveryOnlySource, isSelfResearchSource,
} from "../src/evolutionDiscoverySources.mjs";

const registryFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../项目代码/knowledge-plugin/registry/sources.json");
const pluginPresent = existsSync(registryFile);
const registry = pluginPresent ? JSON.parse(readFileSync(registryFile, "utf8")).sources : [];

test("only the discovery rows and the legacy query are dropped from the medical feed; the lab feeds are read by both", () => {
  assert.equal(isDiscoveryOnlySource("ai-discovery-arxiv-agents-memory"), true);
  assert.equal(isDiscoveryOnlySource("ai-discovery-req-0123456789ab"), true, "a source the platform asked the plugin for carries the prefix");
  assert.equal(isDiscoveryOnlySource(LEGACY_DISCOVERY_SOURCE_ID), true, "entries stored before the set replaced the single query keep their meaning");
  for (const id of AI_LAB_FEED_SOURCE_IDS) {
    assert.equal(isDiscoveryOnlySource(id), false, id);
    assert.equal(isSelfResearchSource(id), true, id);
  }
  for (const id of ["pubmed-rct-core-journals", "j-0028-4793", "", null, undefined, "xai-ai-discovery-like"]) assert.equal(isSelfResearchSource(id), false, String(id));
});

test("the source says what kind of thing an entry is and what its being listed there means", () => {
  const traits = (/** @type {string} */ id) => discoverySourceTraits(id);
  assert.deepEqual(traits("ai-discovery-hf-daily-papers"), { kind: "paper", attention: true, venueRow: false });
  assert.deepEqual(traits("ai-discovery-arxiv-venue-accepted"), { kind: "paper", attention: false, venueRow: true });
  assert.deepEqual(traits("ai-discovery-arxiv-judges-evals"), { kind: "paper", attention: false, venueRow: false });
  assert.deepEqual(traits(LEGACY_DISCOVERY_SOURCE_ID), { kind: "paper", attention: false, venueRow: false });
  assert.equal(traits("ai-discovery-gh-langchain-ai-langgraph").kind, "release");
  assert.equal(traits("ai-discovery-hf-models-qwen").kind, "model");
  assert.equal(traits("ai-discovery-pmlr-volumes").kind, "venue-volume");
  assert.equal(traits("ai-discovery-acl-anthology-ingest").kind, "venue-volume");
  assert.equal(traits("ai-discovery-hf-blog").kind, "lab");
  assert.equal(traits("openai-news").kind, "lab");
  assert.equal(traits("ai-discovery-req-0123456789ab").kind, "lab");
});

test("a paper keeps one key however many rows list it: arXiv without its version, then DOI, then OpenReview, then the title", () => {
  const viaArxivRow = { doi: "10.48550/arxiv.2610.12083", sourceUrl: "https://arxiv.org/abs/2610.12083", title: "All Verdicts are Not Equal" };
  const viaDailyPapers = { doi: "10.48550/arxiv.2610.12083", sourceUrl: "https://arxiv.org/abs/2610.12083v2", title: "All verdicts are not equal!" };
  assert.equal(dedupeKey(viaArxivRow), "arxiv:2610.12083");
  assert.equal(dedupeKey(viaDailyPapers), "arxiv:2610.12083");
  assert.equal(arxivIdOf({ doi: "https://doi.org/10.48550/ARXIV.2610.12083v3" }), "2610.12083");
  assert.equal(arxivIdOf({ sourceUrl: "https://arxiv.org/html/2610.12083v1" }), "2610.12083");
  assert.equal(arxivIdOf({ sourceUrl: "https://arxiv.org/abs/hep-th/9901001" }), "hep-th/9901001");
  assert.equal(arxivIdOf({ doi: "10.1109/APCCAS62602.2024.10808959", sourceUrl: "https://example.org/x" }), null);
  assert.equal(dedupeKey({ doi: "DOI:10.1109/APCCAS62602.2024.10808959", title: "A" }), "doi:10.1109/apccas62602.2024.10808959");
  assert.equal(dedupeKey({ sourceUrl: "https://openreview.net/forum?id=AbC123xyz", title: "A" }), "openreview:AbC123xyz");
  const a = dedupeKey({ title: "Résumé of  LLM-Judges: A Study" }), b = dedupeKey({ title: "resume of llm judges - a study" });
  assert.match(a, /^title:[0-9a-f]{16}$/);
  assert.equal(a, b, "case, accents, punctuation and spacing do not make two papers");
  assert.notEqual(a, dedupeKey({ title: "A different study" }));
  // A release, a model or a post is its own address, whatever its title says.
  assert.notEqual(dedupeKey({ sourceUrl: "https://github.com/a/b/releases/tag/v1", title: "v1" }, "release"), dedupeKey({ sourceUrl: "https://github.com/a/b/releases/tag/v2", title: "v1" }, "release"));
});

test("a repository the text links is a format, found and trimmed", () => {
  assert.equal(codeLinkOf("Our code is available at https://github.com/thu-nics/TokenRouter."), "https://github.com/thu-nics/TokenRouter");
  assert.equal(codeLinkOf("Comments: 11 pages. Code and data: https://github.com/AlignmentResearch/caught-in-the-act-probes)"), "https://github.com/AlignmentResearch/caught-in-the-act-probes");
  assert.equal(codeLinkOf("see https://github.com/x/y.git for more"), "https://github.com/x/y.git");
  assert.equal(codeLinkOf("https://gitlab.com/x/y and https://example.org/github.com/x/y"), null);
  assert.equal(codeLinkOf(""), null);
});

// The id prefix is a contract between two codebases; a row on one side only is a row whose entries are read wrongly.
test("the plugin's registry and this file agree on which rows are the channel", { skip: !pluginPresent && "the plugin's registry is not in this checkout" }, () => {
  assert.ok(registry.length > 700, "the registry was read");
  const rows = new Map(registry.map((/** @type {any} */ row) => [row.id, row]));
  for (const row of registry) {
    const discoveryOnly = row.config?.discovery_only === true;
    assert.equal(discoveryOnly, row.id.startsWith(AI_DISCOVERY_PREFIX), `${row.id}: discovery_only and the id prefix must go together`);
    assert.equal(isDiscoveryOnlySource(row.id), discoveryOnly, row.id);
  }
  assert.equal(rows.has(LEGACY_DISCOVERY_SOURCE_ID), false, "the single arXiv query is replaced by the set, not kept beside it");
  for (const id of AI_LAB_FEED_SOURCE_IDS) {
    assert.equal(/** @type {any} */ (rows.get(id))?.lane, "ai", `${id} is a lane-ai row the plugin reads`);
    assert.notEqual(/** @type {any} */ (rows.get(id))?.config?.discovery_only, true, `${id} is shared with the medical feed`);
  }
  // What a row is for follows from how it reads: the traits this file derives from the id must match the row's own reader.
  const kindOfReader = (/** @type {any} */ row) => ({ "github-releases": "release", "github-commits": "venue-volume", "huggingface-models": "model" })[/** @type {string} */ (row.config?.family)] ?? null;
  for (const row of registry.filter((/** @type {any} */ item) => item.id.startsWith(AI_DISCOVERY_PREFIX))) {
    const traits = discoverySourceTraits(row.id);
    const reader = kindOfReader(row);
    if (reader) assert.equal(traits.kind, reader, row.id);
    if (row.config?.family === "huggingface-daily-papers") assert.equal(traits.attention, true, row.id);
    if (/co:accepted/.test(row.config?.url ?? "")) assert.equal(traits.venueRow, true, row.id);
    assert.equal(row.config.arxiv_comment === true, row.access === "atom", `${row.id}: every arXiv row carries the authors' comment, nothing else does`);
  }
});
