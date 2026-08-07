import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { stringify } from "yaml";
import { generatedRuntimeAgent } from "../src/runtimeManager.mjs";
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
  requiredTools: ["evimed_drug_term_normalize", "evimed_adr_case_query", "evimed_adr_signal_analysis"],
  optionalTools: ["evimed_drug_label_search", "evimed_literature_search"],
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
    assert.ok(EVIMED_AGENT_TOOL_IDS.has("evimed_adr_signal_analysis"));
    assert.ok(EVIMED_AGENT_TOOL_IDS.has("evimed_drug_safety_analysis"));
    assert.ok(EVIMED_AGENT_TOOL_IDS.has("evimed_data_source_catalog"));
    assert.ok(EVIMED_AGENT_TOOL_IDS.has("evimed_biomedical_source_search"));
    assert.ok(EVIMED_AGENT_TOOL_IDS.has("evimed_open_access_full_text"));
    assert.ok(EVIMED_AGENT_TOOL_IDS.has("evimed_official_page_fetch"));
    assert.ok(EVIMED_AGENT_TOOL_IDS.has("evimed_patent_search"));
    assert.ok(EVIMED_AGENT_TOOL_IDS.has("evimed_pharmacy_reference_search"));
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
    assert.ok(agent.optionalTools.includes("evimed_data_source_catalog"));
    assert.ok(agent.optionalTools.includes("evimed_biomedical_source_search"));
  }
});

test("official specialist packages preserve domain-specific evidence and release boundaries", async () => {
  const registry = await loadAgentRegistry({ packageDirs: [officialPackageRoot] });
  const expectedVersions = new Map([
    ["adr-analysis", "1.2.2"],
    ["bibliometric-analysis", "1.0.1"],
    ["clinical-evidence-synthesis", "2.1.0"],
    ["comprehensive-drug-evaluation", "2.2.1"],
    ["dataset-research-scoping", "1.3.0"],
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
  assert.deepEqual(clinicalEvidence.companionSkills, [
    "deep-research",
    "biomedical-database-search",
    "citation-integrity",
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
    ],
  );

  const skills = Object.fromEntries(
    registry.list().map((agent) => [agent.id, registry.getPackage(agent.id).skillText]),
  );
  assert.match(skills["adr-analysis"], /do not\s+convert any disproportionality metric into incidence/i);
  assert.match(skills["adr-analysis"], /statistical signal proves causality/i);
  assert.match(skills["adr-analysis"], /evimed_drug_safety_analysis/i);
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

test("a specialist that writes outputs is told to deliver the report, not the file list", () => {
  const prompt = generatedRuntimeAgent({
    title: "Clinical Evidence Synthesis",
    description: "synthesize clinical evidence",
    skill: "clinical-evidence-synthesis",
    runtimeAgent: "evimed-clinical-evidence-synthesis",
    companionSkills: [],
    requiredTools: ["evimed_literature_search"],
    optionalTools: [],
    outputs: [{ path: "clinical-evidence-report.md", required: true }],
  });
  assert.match(prompt, /Open with the conclusion/);
  assert.match(prompt, /A list of file names is not an answer\./);
  assert.match(prompt, /Never paste a tool log, a JSON artifact, a hash, or an internal marker/);
});

test("an answer-only package keeps its reply contract unchanged", () => {
  const prompt = generatedRuntimeAgent({
    title: "Open-Domain Answer",
    description: "answer open-domain questions",
    skill: "open-domain-answer",
    runtimeAgent: "evimed-open-domain-answer",
    companionSkills: [],
    requiredTools: ["evimed_literature_search"],
    optionalTools: [],
    outputs: [],
  });
  assert.match(prompt, /delivers its answer directly in the assistant reply/);
  assert.doesNotMatch(prompt, /A list of file names is not an answer\./);
});
