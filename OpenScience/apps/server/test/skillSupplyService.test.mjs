// "Installed" is not "runnable": a package whose method needs software, weights or data the deployment lacks reads
// limited, with the reason in the product's words, and is still listed and still usable. These pin the named cases of
// the row over the real generated table and the real capability registry.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildSkillPackageRecord } from "@evimed/domain";
import { IMAGE_RECIPE, SKILL_PACKAGES } from "@evimed/domain/skill-packages";
import { loadAgentRegistry } from "../src/agentRegistry.mjs";
import { loadConfig } from "../src/config.mjs";
import { AvailabilityService } from "../src/availabilityService.mjs";
import { SkillSupply } from "../src/skillSupplyService.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const loaded = loadConfig({ rootDir: repoRoot });
const registry = loadAgentRegistry({ packageDirs: loaded.agentPackageDirs, capabilityDirs: loaded.capabilityDirs });
const alice = { id: "alice" };
const adapters = {
  metaAnalysis: "http://meta:8024/x", mendelianRandomization: "http://mr:8026/x", bibliometricAnalysis: "http://bib:8027/x",
  researchTopicSelection: "http://topic:8028/x", peerReview: "http://review:8029/x", drugSafetyAnalysis: "http://safety:8025/x",
};
const config = (overrides = {}) => ({
  runtimeMode: "kernel", runtimeProvider: "docker", evimedDisabledTools: "", evimedAdapterUrls: adapters, specialistAgents: {},
  publicSourceGatewayInternalUrl: "http://127.0.0.1:8787/internal/sources/v1/fetch", modelGatewayInternalUrl: "http://127.0.0.1:8787/internal/model/v1",
  operatorUsers: [], publicSourceCredentials: {}, availabilityEnabled: true, ...overrides,
});
const supply = (overrides = {}) => new SkillSupply({ config: config(overrides) });
/** The packages that are subjects of their own: every one but the capabilities and the extension. */
const skillCount = [...SKILL_PACKAGES.values()].filter((record) => !["capability", "extension"].includes(record.origin)).length;
const byId = (/** @type {any[]} */ entries, /** @type {string} */ id) => entries.find((entry) => entry.id === id);

test("a skill whose method needs software the image lacks is limited, with the software named and what still works said", () => {
  const entries = supply().skills(alice);
  for (const [id, software] of [["curated/cheminformatics", "rdkit"], ["curated/pathway-enrichment", "gseapy"], ["curated/biosequence-analysis", "biopython"], ["curated/single-cell-analysis", "anndata"]]) {
    const entry = byId(entries, id);
    assert.equal(entry.state, "limited", id);
    assert.equal(entry.reason.code, "dependency-software-missing");
    assert.equal(entry.reason.detail, software);
    assert.match(entry.text, new RegExp(software));
    assert.match(entry.text, /其余部分照常/);
  }
  assert.equal(byId(entries, "curated/single-cell-analysis").also.length, 1, "the second missing library is carried beside the deciding one");
});

test("an installed skill with nothing missing reads installed, never executable: its use is not collected", () => {
  const entries = supply().skills(alice);
  for (const id of ["curated/statistical-analysis", "curated/matplotlib", "office/xlsx", "community/dsh-ppt", "core/stats-integrity"]) {
    assert.equal(byId(entries, id).state, "installed", id);
    assert.equal(byId(entries, id).reason.code, "no-successful-operation");
  }
  assert.equal(entries.filter((entry) => entry.state === "executable").length, 0);
  assert.equal(entries.length, skillCount, "every non-capability, non-extension package is walked");
});

test("software a skill only touches on a guarded path is a note beside an installed one, not a limit", () => {
  const view = supply().view(/** @type {any} */ (SKILL_PACKAGES.get("core/large-file")), alice);
  assert.equal(view.state, "installed");
  assert.deepEqual(view.notes.map((note) => note.detail).sort(), ["astropy", "cfgrib", "h5py", "netCDF4", "pyarrow", "pygrib", "pysam", "uproot"].sort());
  assert.equal(view.package.origin, "core");
  assert.equal(view.package.scripts, 1);
  assert.ok(view.package.dependencies.every((dependency) => dependency.basis === "observed"));
});

test("a mock runtime never lets a skill read installed", () => {
  assert.equal(byId(supply({ runtimeMode: "mock" }).skills(alice), "office/xlsx").state, "unverified");
});

test("an image that cannot be read makes the dependencies unverified, never present", () => {
  const blind = new SkillSupply({ config: config(), image: null });
  const entry = byId(blind.skills(alice), "curated/statistical-analysis");
  assert.equal(entry.state, "unverified");
  assert.equal(entry.reason.code, "dependency-unchecked");
  assert.match(entry.text, /无法确认/);
});

test("a pin the image does not satisfy is named with both versions", () => {
  const record = buildSkillPackageRecord({ id: "personal/x", name: "x", origin: "personal", files: [], dependencies: [{ kind: "python-package", name: "scipy", constraint: "==1.9.0" }] });
  const entry = supply().project(/** @type {any} */ (record), alice);
  assert.equal(entry.state, "limited");
  assert.equal(entry.reason.code, "dependency-version-differs");
  assert.match(entry.text, /scipy.*==1\.9\.0.*1\.15\.3/);
});

test("weights the deployment does not mount are missing; a researcher's data and a platform tool it offers are not", () => {
  const record = buildSkillPackageRecord({ id: "personal/y", name: "y", origin: "personal", files: [], dependencies: [
    { kind: "model-weights", name: "esm2-650m" }, { kind: "dataset", name: "my-cohort" }, { kind: "compute", name: "gpu" }, { kind: "platform-tool", name: "literature_search" },
  ] });
  const entry = supply().project(/** @type {any} */ (record), alice);
  assert.equal(entry.state, "limited");
  assert.equal(entry.reason.code, "dependency-data-missing");
  assert.equal(entry.reason.detail, "esm2-650m");
  assert.equal(entry.also.length, 0, "data, compute and an offered tool are no reason");
  const withheld = supply({ evimedDisabledTools: "literature_search" }).reasons(/** @type {any} */ (record), alice).limits.map((reason) => reason.code);
  assert.ok(withheld.includes("required-tool-not-offered"), "a tool the deployment withholds is a limit");
});

test("a native catalogue item resolves to the package its name stands for, in the order the roots are searched, and an unknown name to none", () => {
  const supplied = supply();
  assert.equal(supplied.catalogued("cheminformatics")?.id, "curated/cheminformatics");
  assert.equal(supplied.catalogued("statistical-analysis")?.id, "curated/statistical-analysis", "the capability of the same name is not a mounted skill root");
  assert.equal(supplied.catalogued("dsh-ppt")?.origin, "community");
  assert.equal(supplied.catalogued("a-skill-nobody-ships"), null);
});

test("the availability projection carries the skills and the capabilities' software reasons, and lists nothing less", async () => {
  const service = new AvailabilityService({ config: config(), registry, skillSupply: supply(), now: () => new Date("2026-10-04T12:00:00.000Z") });
  const body = await service.forAccount(alice);
  assert.equal(body.skills.length, skillCount);
  const cheminformatics = body.skills.find((entry) => entry.id === "curated/cheminformatics");
  assert.equal(cheminformatics.state, "limited");
  assert.equal(cheminformatics.package.source.kind, "derived");
  assert.match(cheminformatics.package.sourceText, /提交未记录/, "the unrecorded commit is stated, not filled in");
  assert.ok(cheminformatics.package.unknown.some((entry) => entry.field === "source.commit"));
  const capability = body.capabilities.find((entry) => entry.id === "statistical-analysis");
  assert.equal(capability.package.id, "capability/statistical-analysis");
  // The shipped version, read from the registry: a capability's version moves with every edit of its skill.
  assert.equal(capability.package.version, (await registry).get("statistical-analysis").version);
  assert.match(capability.package.version, /^\d+\.\d+\.\d+$/);
  assert.equal(body.capabilities.length, (await service.capabilities(alice)).length, "no capability is hidden");
  assert.equal(JSON.stringify(body).includes("sha256\":\"" + "0".repeat(64)), false);
  // A capability whose own scripts need software the image lacks says so, and is still listed and still asked.
  const lacking = new SkillSupply({ config: config(), packages: new Map([["capability/meta-analysis", /** @type {any} */ (buildSkillPackageRecord({
    id: "capability/meta-analysis", name: "meta-analysis", origin: "capability", version: "1", files: [{ path: "scripts/x.py", sha256: "a".repeat(64), text: "import lifelines\n" }],
  }))]]) });
  const limited = await new AvailabilityService({ config: config(), registry, skillSupply: lacking }).capabilities(alice);
  const meta = limited.find((entry) => entry.id === "meta-analysis");
  assert.equal(meta.state, "limited");
  assert.equal(meta.reason.code, "dependency-software-missing");
  assert.equal(meta.reason.source, "image-recipe");
});

test("the operator's export and the series count skills as a kind of their own", async () => {
  const service = new AvailabilityService({ config: config(), registry, skillSupply: supply(), now: () => new Date("2026-10-04T12:00:00.000Z") });
  const exported = await service.export();
  assert.equal(exported.counts.skill.limited, 4);
  assert.ok(exported.counts.skill.installed >= 40);
  assert.equal(exported.states.filter((entry) => entry.kind === "skill").length, skillCount);
  const metrics = await service.metrics();
  assert.equal(metrics.states.skill.limited, 4);
  const without = await new AvailabilityService({ config: config(), registry }).metrics();
  assert.equal(without.states.skill, undefined, "no supply composed, no skill series");
});

test("the image recipe the labels read is the generated one", () => {
  assert.equal(supply().image, IMAGE_RECIPE);
  assert.equal(IMAGE_RECIPE.python.scipy, "1.15.3");
});

test("an installed extension carries the package it was admitted as: exact commit, licence, digest and supported operations, beside its own state", async () => {
  const views = async () => [{
    id: "extension:installed", catalogueId: "cowork-portable", coordinate: { kind: "github", repository: "Jesse-njx/dsh-cowork", commit: "2ae5cf755c4294a1e988eebf3b12dd062425d84c" },
    phase: "waiting", evidenceState: "source-assessed", policyState: "current", preparation: { outcome: "prepared" },
  }];
  const service = new AvailabilityService({ config: config(), registry, skillSupply: supply(), extensionViews: views });
  const [entry] = (await service.forAccount(alice)).extensions;
  assert.equal(entry.version, "2ae5cf755c42");
  assert.equal(entry.state, "unverified", "its state is its own: the package record does not make it runnable");
  assert.equal(entry.package.sourceText, "公开仓库 Jesse-njx/dsh-cowork @ 2ae5cf755c42");
  assert.equal(entry.package.licenceText, "MIT");
  assert.deepEqual(entry.package.operations.map((operation) => operation.name), ["doc_read", "doc_write"]);
  assert.equal(entry.package.unknown.length, 0, "everything a reader needs about it is recorded");
  // An extension the table does not know has no package, and says nothing about one.
  const other = new AvailabilityService({ config: config(), registry, skillSupply: supply(), extensionViews: async () => [{ id: "extension:other", catalogueId: "unlisted-tool", coordinate: { kind: "npm", name: "x", version: "1.0.0" }, phase: "waiting" }] });
  assert.equal((await other.forAccount(alice)).extensions[0].package, null);
});
