import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { stringify } from "yaml";
import {
  DELEGATION_BASE_TOOLS,
  MAX_DELEGATION_DEPTH,
  MCP_TOOL_NAMES,
  SOCKET_TOOL_NAME_LIST,
  delegationToolFilter,
  validateCapabilityManifest,
} from "@evimed/domain";
import {
  EVIMED_AGENT_COMPLETION_CHECKS,
  EVIMED_AGENT_DATA_SOURCES,
  EVIMED_AGENT_TOOL_IDS,
  loadAgentRegistry,
} from "../src/agentRegistry.mjs";

const validManifest = {
  id: "adr-analysis",
  version: "1.0.0",
  title: "Drug Safety Analysis",
  category: "Pharmacovigilance",
  description: "Mine adverse-event signals and synthesize evidence.",
  skill: "adr-analysis",
  estimatedMinutes: [20, 40],
  starterPrompts: ["Analyze cardiac safety signals for osimertinib."],
  requiredInputs: ["drug"],
  optionalInputs: ["adverseEvent", "dateRange", "uploadedFiles"],
  requiredTools: ["drug_term_normalize", "adr_case_query", "adr_signal_analysis"],
  optionalTools: ["drug_label_search", "literature_search"],
  dataSources: ["faers", "meddra", "drug-labels"],
  outputs: [
    { path: "reports/adr-analysis.md", required: true },
    { path: "artifacts/adr-analysis.json", required: true },
  ],
  completionChecks: ["requiredOutputsExist", "citationsResolvable"],
};

const officialPackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../runtime/skills/evimed",
);

async function writePackage(root, manifest = validManifest, options = {}) {
  const directoryName = options.directoryName ?? manifest.skill;
  const packageDir = path.join(root, directoryName);
  await mkdir(packageDir, { recursive: true });
  await writeFile(path.join(packageDir, "agent.yaml"), stringify(manifest), "utf8");
  if (!options.omitSkill) {
    await writeFile(
      path.join(packageDir, "SKILL.md"),
      `---\nname: ${options.skillName ?? manifest.skill}\ndescription: Test specialty.\n---\n\n# Test specialty\n`,
      "utf8",
    );
  }
  return packageDir;
}

async function withPackageRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "evimed-agents-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("loads the final package contract and derives runtime identity", async () => {
  await withPackageRoot(async (root) => {
    await writePackage(root, validManifest);
    const registry = await loadAgentRegistry({ packageDirs: [root] });
    assert.deepEqual(registry.list(), [{
      ...validManifest,
      companionSkills: [],
      runtimeAgent: "evimed-adr-analysis",
    }]);
    assert.equal(Object.hasOwn(registry.list()[0], "packageDir"), false);
    assert.equal(Object.hasOwn(registry.list()[0], "skillText"), false);
    assert.ok(EVIMED_AGENT_TOOL_IDS.has("adr_signal_analysis"));
    assert.ok(EVIMED_AGENT_TOOL_IDS.has("drug_safety_analysis"));
    assert.ok(EVIMED_AGENT_TOOL_IDS.has("data_source_catalog"));
    assert.ok(EVIMED_AGENT_TOOL_IDS.has("biomedical_source_search"));
    assert.ok(EVIMED_AGENT_TOOL_IDS.has("open_access_full_text"));
    assert.ok(EVIMED_AGENT_TOOL_IDS.has("official_page_fetch"));
    assert.ok(EVIMED_AGENT_TOOL_IDS.has("patent_search"));
    assert.ok(EVIMED_AGENT_TOOL_IDS.has("pharmacy_reference_search"));
    assert.ok(EVIMED_AGENT_DATA_SOURCES.has("faers"));
    assert.ok(EVIMED_AGENT_COMPLETION_CHECKS.has("citationsResolvable"));
  });
});

test("official skills name every output declared by their manifest", async () => {
  const registry = await loadAgentRegistry({ packageDirs: [officialPackageRoot] });
  assert.deepEqual(registry.list().map((agent) => agent.id), [
    "adr-analysis",
    "bibliometric-analysis",
    "clinical-evidence-synthesis",
    "comprehensive-drug-evaluation",
    "dataset-research-scoping",
    "drug-selection",
    "mendelian-randomization",
    "meta-analysis",
    "off-label-analysis",
    "open-domain-answer",
    "peer-review",
    "research-topic-selection",
  ]);
  for (const agent of registry.list()) {
    const skillText = registry.getPackage(agent.id).skillText;
    for (const output of agent.outputs) {
      assert.match(skillText, new RegExp(`\\\`${output.path.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\\``));
    }
  }
  for (const id of ["adr-analysis", "comprehensive-drug-evaluation", "drug-selection", "off-label-analysis"]) {
    const agent = registry.get(id);
    assert.ok(agent.optionalTools.includes("data_source_catalog"));
    assert.ok(agent.optionalTools.includes("biomedical_source_search"));
  }
});

test("official specialist packages preserve domain-specific evidence and release boundaries", async () => {
  const registry = await loadAgentRegistry({ packageDirs: [officialPackageRoot] });
  const expectedVersions = new Map([
    ["adr-analysis", "1.2.2"],
    ["bibliometric-analysis", "1.0.1"],
    ["clinical-evidence-synthesis", "2.9.0"],
    ["comprehensive-drug-evaluation", "2.2.1"],
    ["dataset-research-scoping", "1.7.0"],
    ["drug-selection", "2.1.1"],
    ["mendelian-randomization", "1.0.1"],
    ["meta-analysis", "1.0.0"],
    ["off-label-analysis", "2.2.1"],
    ["open-domain-answer", "1.0.0"],
    ["peer-review", "1.0.1"],
    ["research-topic-selection", "1.1.0"],
  ]);
  const evidenceSnapshotAgents = new Set(["comprehensive-drug-evaluation", "drug-selection", "off-label-analysis"]);
  for (const agent of registry.list()) {
    assert.equal(agent.version, expectedVersions.get(agent.id));
    assert.ok(agent.requiredTools.length > 0);
    let expectedChecks = ["requiredOutputsExist", "citationsResolvable"];
    if (agent.id === "clinical-evidence-synthesis") {
      expectedChecks = ["requiredOutputsExist", "citationsResolvable", "evidenceClaimsTraceable", "skillsLoaded"];
    } else if (agent.id === "dataset-research-scoping") {
      // The profiling step is only meaningful if the skill stack that defines it
      // actually loaded, so skill loading is part of this contract's floor.
      expectedChecks = ["requiredOutputsExist", "citationsResolvable", "skillsLoaded"];
    } else if (agent.id === "research-topic-selection") {
      // The specialist job it drives searches one index; the skill's own
      // evidence expansion is only real if the skill actually loaded.
      expectedChecks = ["requiredOutputsExist", "citationsResolvable", "skillsLoaded"];
    } else if (agent.id === "open-domain-answer") {
      // Answer-mode contract: the reply is the deliverable, so the floor is
      // skill loading plus citation hygiene and integrity, instead of file outputs.
      expectedChecks = ["skillsLoaded", "citationsResolvable", "citationIntegrity"];
    } else if (evidenceSnapshotAgents.has(agent.id)) {
      expectedChecks = ["requiredOutputsExist", "citationsResolvable", "citedSourcesRecorded"];
    }
    assert.deepEqual(agent.completionChecks, expectedChecks);
  }
  const clinicalEvidence = registry.get("clinical-evidence-synthesis");
  // manuscript-humanize is a companion rather than an optional afterthought
  // because skillsLoaded then requires it to have actually loaded: a report
  // assembled section by section reads like one, and the editing pass that
  // fixes it is worth as little as any other step nobody ran.
  assert.deepEqual(clinicalEvidence.companionSkills, [
    "deep-research",
    "biomedical-database-search",
    "citation-integrity",
    "manuscript-humanize",
  ]);
  assert.deepEqual(
    clinicalEvidence.outputs.filter((output) => output.required).map((output) => output.path),
    [
      "clinical-evidence-report.md",
      "clinical-evidence-matrix.json",
      "clinical-evidence-search.json",
      "citation-ledger.csv",
      "references.bib",
      "citation-audit.md",
      "clinical-evidence-run.json",
      // The run's own account of the brief's sub-questions. It is required
      // because a question that disappears from the body without a word is the
      // commonest confirmed defect in delivered work, and the gate cannot see
      // the brief to notice it.
      "question-coverage.json",
    ],
  );

  const skills = Object.fromEntries(
    registry.list().map((agent) => [agent.id, registry.getPackage(agent.id).skillText]),
  );
  assert.match(skills["adr-analysis"], /do not\s+convert any disproportionality metric into incidence/i);
  assert.match(skills["adr-analysis"], /statistical signal proves causality/i);
  // Two skill trees, two spellings, and they must not be swept together.
  // `officialPackageRoot` is the server-side contract tree: nothing ships it to
  // a runtime, so it names tools the way the MCP server publishes them, bare.
  // `capability-skills/` is the tree delegation injects into a child, and the
  // kernel prefixes every MCP tool there with mcp__<server>__. A rewrite that
  // put the prefixed spelling here would name tools this tree never refers to.
  assert.match(skills["adr-analysis"], /drug_safety_analysis/i);
  assert.doesNotMatch(skills["adr-analysis"], /mcp__evimed__/);
  assert.match(skills["adr-analysis"], /suspect_binding/i);
  assert.match(skills["adr-analysis"], /never describe it as PS-only/i);
  assert.match(skills["adr-analysis"], /gps_prior_fitted/i);
  assert.match(skills["adr-analysis"], /never call it a paper-grade/i);
  assert.match(skills["off-label-analysis"], /Bibliographic search results are metadata/i);
  assert.match(skills["off-label-analysis"], /Do not infer regulatory approval, legality/i);
  assert.match(skills["comprehensive-drug-evaluation"], /Never invent an HTA conclusion, price, budget impact/i);
  assert.match(skills["comprehensive-drug-evaluation"], /currency, price date, jurisdiction, perspective/i);
  assert.match(skills["drug-selection"], /missing-data rule/i);
  assert.match(skills["drug-selection"], /avoid a definitive ranking/i);
  assert.match(skills["meta-analysis"], /deterministic statistical engines/i);
  assert.match(skills["meta-analysis"], /preserve the exact `releaseStatus`/i);
  assert.match(skills["meta-analysis"], /do not manufacture interim study counts/i);
  assert.match(skills["mendelian-randomization"], /do not invent SNPs/i);
  assert.match(skills["bibliometric-analysis"], /does not estimate clinical efficacy/i);
  assert.match(skills["research-topic-selection"], /absence from a small search is not proof of novelty/i);
  assert.match(skills["peer-review"], /do not turn an exception into a\s+synthetic completed review/i);
});

test("rejects workflow and deprecated presentation fields", async (t) => {
  for (const field of ["steps", "runtimeAgent", "name", "icon", "tools", "outputPaths"]) {
    await t.test(field, async () => {
      await withPackageRoot(async (root) => {
        await writePackage(root, { ...validManifest, [field]: field === "steps" ? 6 : "unexpected" });
        await assert.rejects(loadAgentRegistry({ packageDirs: [root] }), new RegExp(`unknown field.*${field}`, "i"));
      });
    });
  }
});

test("rejects duplicate package ids across roots", async () => {
  const first = await mkdtemp(path.join(tmpdir(), "evimed-agents-first-"));
  const second = await mkdtemp(path.join(tmpdir(), "evimed-agents-second-"));
  try {
    await writePackage(first, validManifest);
    await writePackage(second, validManifest);
    await assert.rejects(loadAgentRegistry({ packageDirs: [first, second] }), /duplicate agent id.*adr-analysis/i);
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test("accepts an answer-mode package with zero file outputs", async () => {
  await withPackageRoot(async (root) => {
    await writePackage(root, {
      ...validManifest,
      id: "open-domain-answer",
      skill: "open-domain-answer",
      outputs: [],
      completionChecks: ["skillsLoaded", "citationsResolvable"],
    });
    const registry = await loadAgentRegistry({ packageDirs: [root] });
    const agent = registry.get("open-domain-answer");
    assert.deepEqual(agent.outputs, []);
    assert.deepEqual(agent.completionChecks, ["skillsLoaded", "citationsResolvable"]);
  });
});

test("rejects a requiredOutputsExist contract without any required output", async () => {
  await withPackageRoot(async (root) => {
    await writePackage(root, {
      ...validManifest,
      outputs: [{ path: "reports/optional-notes.md", required: false }],
      completionChecks: ["requiredOutputsExist"],
    });
    await assert.rejects(loadAgentRegistry({ packageDirs: [root] }), /no required output/i);
  });
  await withPackageRoot(async (root) => {
    await writePackage(root, {
      ...validManifest,
      outputs: [],
      completionChecks: ["requiredOutputsExist"],
    });
    await assert.rejects(loadAgentRegistry({ packageDirs: [root] }), /outputs must contain between 1 and 64 entries/i);
  });
});

test("rejects invalid versions, identifiers, estimates, and overlapping inputs", async (t) => {
  const cases = [
    ["version", { version: "v1" }, /version.*semantic/i],
    ["numeric prerelease", { version: "1.0.0-alpha.01" }, /version.*semantic/i],
    ["id", { id: "ADR_Analysis" }, /invalid agent id/i],
    ["estimate order", { estimatedMinutes: [40, 20] }, /estimatedMinutes/i],
    ["input id", { requiredInputs: ["drug-name"] }, /input identifier/i],
    ["input overlap", { requiredInputs: ["drug"], optionalInputs: ["drug"] }, /requiredInputs.*optionalInputs/i],
    ["companion skill id", { companionSkills: ["Deep_Research"] }, /invalid companion skill/i],
    ["companion self reference", { companionSkills: ["adr-analysis"] }, /must not repeat/i],
  ];
  for (const [name, replacement, expected] of cases) {
    await t.test(name, async () => {
      await withPackageRoot(async (root) => {
        await writePackage(root, { ...validManifest, ...replacement });
        await assert.rejects(loadAgentRegistry({ packageDirs: [root] }), expected);
      });
    });
  }
});

test("rejects a missing or mismatched SKILL.md", async (t) => {
  await t.test("missing skill file", async () => {
    await withPackageRoot(async (root) => {
      await writePackage(root, validManifest, { omitSkill: true });
      await assert.rejects(loadAgentRegistry({ packageDirs: [root] }), /SKILL\.md.*missing/i);
    });
  });
  await t.test("manifest skill differs from package directory", async () => {
    await withPackageRoot(async (root) => {
      await writePackage(root, validManifest, { directoryName: "wrong-directory" });
      await assert.rejects(loadAgentRegistry({ packageDirs: [root] }), /skill.*package directory/i);
    });
  });
  await t.test("skill frontmatter differs from manifest", async () => {
    await withPackageRoot(async (root) => {
      await writePackage(root, validManifest, { skillName: "other-skill" });
      await assert.rejects(loadAgentRegistry({ packageDirs: [root] }), /SKILL\.md.*name/i);
    });
  });
});

test("rejects unknown tools, data sources, and completion checks", async (t) => {
  const cases = [
    ["tool", { requiredTools: ["evimed_unregistered_tool"] }, /unknown tool/i],
    ["data source", { dataSources: ["unregistered-source"] }, /unknown data source/i],
    ["completion check", { completionChecks: ["manualSignoff"] }, /unknown completion check/i],
  ];
  for (const [name, replacement, expected] of cases) {
    await t.test(name, async () => {
      await withPackageRoot(async (root) => {
        await writePackage(root, { ...validManifest, ...replacement });
        await assert.rejects(loadAgentRegistry({ packageDirs: [root] }), expected);
      });
    });
  }
});

test("accepts only normalized relative output paths with boolean required flags", async (t) => {
  for (const badPath of ["../secret.txt", "/tmp/report.md", "reports/../secret.md", "reports\\secret.md", "."]) {
    await t.test(badPath, async () => {
      await withPackageRoot(async (root) => {
        await writePackage(root, { ...validManifest, outputs: [{ path: badPath, required: true }] });
        await assert.rejects(loadAgentRegistry({ packageDirs: [root] }), /output path/i);
      });
    });
  }
  await t.test("required must be boolean", async () => {
    await withPackageRoot(async (root) => {
      await writePackage(root, { ...validManifest, outputs: [{ path: "report.md", required: "yes" }] });
      await assert.rejects(loadAgentRegistry({ packageDirs: [root] }), /output.*required.*boolean/i);
    });
  });
});

test("rejects symlinked roots, package directories, and package files", async (t) => {
  await t.test("root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "evimed-agent-root-link-"));
    try {
      const target = path.join(parent, "target");
      await mkdir(target);
      await symlink(target, path.join(parent, "linked"), "dir");
      await assert.rejects(loadAgentRegistry({ packageDirs: [path.join(parent, "linked")] }), /root.*symlink/i);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
  await t.test("package directory", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "evimed-agent-package-link-"));
    try {
      const root = path.join(parent, "root");
      const target = path.join(parent, "target");
      await mkdir(root);
      await writePackage(target, validManifest);
      await symlink(path.join(target, validManifest.skill), path.join(root, validManifest.skill), "dir");
      await assert.rejects(loadAgentRegistry({ packageDirs: [root] }), /package.*symlink/i);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
  await t.test("agent manifest", async () => {
    await withPackageRoot(async (root) => {
      const packageDir = path.join(root, validManifest.skill);
      await mkdir(packageDir, { recursive: true });
      const target = path.join(root, "outside.yaml");
      await writeFile(target, stringify(validManifest), "utf8");
      await symlink(target, path.join(packageDir, "agent.yaml"));
      await writeFile(path.join(packageDir, "SKILL.md"), "---\nname: adr-analysis\n---\n", "utf8");
      await assert.rejects(loadAgentRegistry({ packageDirs: [root] }), /agent\.yaml.*symlink/i);
    });
  });
});

// `generatedRuntimeAgent` rendered these facts as one agent markdown file per
// package for the retired kernel: a `mode: primary` frontmatter, the required
// skills in load order, the declared tool allow-list, the declared output paths
// with their required flags, and the rule that the work is what gets delivered
// rather than the list of files it produced.
//
// That file format is gone with the kernel. The facts are not: they are the
// capability manifests the runtime image carries, generated from
// `capabilities/<id>/capability.yaml` by
// `scripts/build/generate-capability-manifests.mjs` and read by the delegation
// tool, and the two tests below check the same properties there.
const dshCapabilityDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../deploy/runtime-dsh/capabilities",
);

async function dshCapabilities() {
  const files = (await readdir(dshCapabilityDir)).filter((name) => name.endsWith(".json")).sort();
  // A directory read that silently returned nothing would make every loop below
  // vacuously true, which is the failure mode this whole file exists to prevent.
  assert.ok(files.length >= 10, `only ${files.length} capability manifests found; the catalogue read nothing`);
  return Promise.all(files.map(async (name) => ({
    id: name.replace(/\.json$/, ""),
    manifest: JSON.parse(await readFile(path.join(dshCapabilityDir, name), "utf8")),
  })));
}

test("a capability that writes files declares its skills, its tools and every output path", async () => {
  const catalogue = await dshCapabilities();
  const knownTools = new Set([...MCP_TOOL_NAMES, ...SOCKET_TOOL_NAME_LIST, ...DELEGATION_BASE_TOOLS]);
  for (const { id, manifest } of catalogue) {
    // The shipped manifest still passes the gate that generated it. A catalogue
    // entry that no longer validates is one the build would refuse to produce
    // today, and the runtime reads these files without revalidating them.
    const revalidated = validateCapabilityManifest(manifest);
    assert.deepEqual(revalidated.issues, [], `${id} no longer passes the generator's own validation`);
    assert.equal(manifest.id, id);

    // Required-skill load order. The generated agent said "load and follow every
    // required skill below, in order"; delegation pre-injects the same bodies in
    // the same order, which is what makes `skillsLoaded` true by construction.
    assert.ok(manifest.skills.length > 0, `${id} declares no skills`);
    assert.equal(manifest.skills[0], id, `${id} must load its own skill first`);
    assert.equal(new Set(manifest.skills).size, manifest.skills.length, `${id} repeats a skill`);

    // The declared tool allow-list, spelled the way the model actually sees it.
    for (const tool of manifest.tools) {
      assert.ok(knownTools.has(tool), `${id} declares "${tool}", which no server publishes`);
    }

    // Declared output paths, each with an explicit required flag, each relative
    // to the deliverable directory.
    assert.ok(manifest.produces.length > 0, `${id} produces nothing`);
    for (const contract of manifest.produces) {
      assert.ok(contract.outputs.length > 0, `${id}/${contract.contractKind} declares no outputs`);
      for (const output of contract.outputs) {
        assert.equal(typeof output.required, "boolean", `${id} leaves "${output.path}" without a required flag`);
        assert.ok(!path.isAbsolute(output.path) && !output.path.includes(".."), `${id} declares an escaping output path`);
      }
      assert.ok(
        contract.outputs.some((output) => output.required),
        `${id}/${contract.contractKind} has no required output, so nothing decides whether it was delivered`,
      );
      // Writing the files is not delivering the work. The generated agent said so
      // in prose to the model; the contract says it to the gate, and the gate is
      // what returns the verdict the run repairs against.
      assert.ok(
        contract.checks.includes("requiredOutputsExist"),
        `${id}/${contract.contractKind} declares outputs nothing checks`,
      );
    }

    // The delegated child's persona and the orchestrator's reason to delegate at
    // all: the two fields that replaced the generated file's frontmatter.
    assert.ok(manifest.persona.length > 0, `${id} has no persona for its delegated child`);
    assert.ok(manifest.whenToUse.length > 0, `${id} gives the orchestrator no reason to delegate to it`);
  }

  const clinicalEvidence = catalogue.find((entry) => entry.id === "clinical-evidence-synthesis").manifest;
  assert.deepEqual(clinicalEvidence.skills, [
    "clinical-evidence-synthesis",
    "deep-research",
    "biomedical-database-search",
    "citation-integrity",
    "manuscript-humanize",
  ]);
  assert.deepEqual(
    clinicalEvidence.produces[0].outputs.filter((output) => output.required).map((output) => output.path),
    [
      "clinical-evidence-report.md",
      "clinical-evidence-matrix.json",
      "clinical-evidence-search.json",
      "citation-ledger.csv",
      "references.bib",
      "citation-audit.md",
      "clinical-evidence-run.json",
      "question-coverage.json",
    ],
  );

  // The required/optional distinction is live, not a field nobody sets: at least
  // one shipped capability declares an output it may skip.
  assert.ok(
    catalogue.some(({ manifest }) => manifest.produces.some((contract) => contract.outputs.some((output) => !output.required))),
    "no capability declares an optional output; the required flag has stopped meaning anything",
  );
});

test("a delegated capability is the last step in its chain", async () => {
  // "Do not delegate any part of this work further; you are the last step in the
  // chain" used to be a sentence in the generated subagent file, which a model
  // could read and ignore. It is now the child's tool allow-list plus a depth
  // ceiling: the delegate tool is simply not in the set the child is given.
  assert.equal(MAX_DELEGATION_DEPTH, 1);
  assert.equal(DELEGATION_BASE_TOOLS.includes("evimed_delegate"), false);
  for (const { id, manifest } of await dshCapabilities()) {
    const filter = delegationToolFilter(manifest);
    assert.equal(filter.includes("evimed_delegate"), false, `${id}'s child could delegate again`);
    assert.ok(filter.includes("evimed_submit_deliverable"), `${id}'s child cannot submit what it wrote`);
    assert.ok(filter.includes("write"), `${id}'s child cannot write, so it cannot deliver`);
    assert.ok(filter.includes("read"), `${id}'s child cannot read back a large tool result`);
    for (const tool of manifest.tools) assert.ok(filter.includes(tool), `${id} declares "${tool}" but its child is not given it`);
  }
});

test("an answer-only package keeps its reply contract: the reply is the deliverable", async () => {
  // The other half of what `generatedRuntimeAgent` encoded. A package with no
  // file outputs was told "this package delivers its answer directly in the
  // assistant reply" and was pointedly not given the file-list contract.
  //
  // Under one composition that is no longer a package at all: an answerable
  // question is answered by the orchestrator itself, with no plan, no
  // deliverable and no delegation, so `open-domain-answer` has no capability
  // manifest. Delegation always produces files; the direct answer never does.
  const catalogue = await dshCapabilities();
  assert.equal(
    catalogue.some((entry) => entry.id === "open-domain-answer"),
    false,
    "answering directly must not be reachable as a file-producing delegation",
  );

  // And the answer-mode contract itself still exists where the server enforces
  // it: zero declared outputs, and a floor of skill loading plus citation
  // hygiene rather than `requiredOutputsExist`.
  const registry = await loadAgentRegistry({ packageDirs: [officialPackageRoot] });
  const answer = registry.get("open-domain-answer");
  assert.deepEqual(answer.outputs, []);
  assert.equal(answer.completionChecks.includes("requiredOutputsExist"), false);
  assert.deepEqual(answer.completionChecks, ["skillsLoaded", "citationsResolvable", "citationIntegrity"]);
});
