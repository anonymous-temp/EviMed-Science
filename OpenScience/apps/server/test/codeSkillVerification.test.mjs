// Proving a code skill runs before it is mounted, through the execution path
// that already exists rather than a second privileged one.
import assert from "node:assert/strict";
import test from "node:test";

import { codeSkillGroups, verifyCodeSkill } from "../src/codeSkillVerification.mjs";

const SCRIPT = [
  "def normalize_identifier(value, scheme='doi'):",
  "    return f'{scheme}:{value.strip().lower()}'",
  "",
  "if __name__ == '__main__':",
  "    assert normalize_identifier(' 10.1/AB ') == 'doi:10.1/ab'",
  "",
].join("\n");

const CONFIG = JSON.stringify({
  name: "normalize_identifier",
  description: "Normalise a bibliographic identifier.",
  parameters: {
    type: "object",
    properties: {
      value: { type: "string", description: "the raw identifier" },
      scheme: { type: "string", description: "the identifier scheme" },
    },
    required: ["value"],
  },
});

const TEST = "assert normalize_identifier('10.1/X') == 'doi:10.1/x'\n";

/** @param {Record<string, string>} [overrides] */
const files = (overrides = {}) => ({
  "scripts/normalize_identifier.py": SCRIPT,
  "scripts/normalize_identifier.tool.json": CONFIG,
  "tests/test_normalize_identifier.py": TEST,
  ...overrides,
});

/** A kernel that reports whatever the caller says, and records what it ran. */
function fakeKernel(behaviour = () => ({ status: "ok", output: "" })) {
  /** @type {string[]} */
  const programs = [];
  return {
    programs,
    runKernel: async (_project, code) => {
      programs.push(code);
      const result = behaviour(code);
      // The real kernel echoes the program's own stdout, so the marker only
      // appears when the program ran to the end.
      if (result.output === "") {
        const marker = /print\('code-skill-verified:([A-Za-z0-9_-]+)'\)/.exec(code);
        return { ...result, output: marker ? `code-skill-verified:${marker[1]}\n` : "" };
      }
      return result;
    },
  };
}

test("the three files of a code skill are found by their shared stem", () => {
  const groups = codeSkillGroups(files({ "scripts/other.py": "x", "references/note.md": "y" }));
  assert.deepEqual([...groups.keys()].sort(), ["normalize_identifier", "other"]);
  assert.deepEqual(groups.get("normalize_identifier"), {
    script: "scripts/normalize_identifier.py",
    config: "scripts/normalize_identifier.tool.json",
    test: "tests/test_normalize_identifier.py",
  });
  assert.deepEqual(codeSkillGroups({}).size, 0);
});

test("a method with no attached script needs no container at all", async () => {
  const kernel = fakeKernel();
  const verdict = await verifyCodeSkill({ files: { }, project: {}, runKernel: kernel.runKernel });
  assert.deepEqual(verdict, { ok: true, issues: [], executions: [] });
  assert.deepEqual(kernel.programs, []);
});

test("a well-formed code skill runs its own test and passes", async () => {
  const kernel = fakeKernel();
  const verdict = await verifyCodeSkill({ files: files(), project: {}, runKernel: kernel.runKernel });
  assert.deepEqual(verdict.issues, []);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.executions.length, 1);
  assert.equal(verdict.executions[0].status, "passed");
  // One round trip per code skill, carrying the script, its test, and the marker.
  assert.equal(kernel.programs.length, 1);
  assert.match(kernel.programs[0], /def normalize_identifier/);
  assert.match(kernel.programs[0], /assert normalize_identifier\('10\.1\/X'\)/);
});

test("nothing is executed while a static check is failing", async () => {
  const kernel = fakeKernel();
  const verdict = await verifyCodeSkill({
    files: files({ "scripts/normalize_identifier.py": `import requests\n${SCRIPT}` }),
    project: {},
    runKernel: kernel.runKernel,
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.issues.some((issue) => issue.code === "method_script_import_denied"));
  assert.deepEqual(kernel.programs, [], "running a script that reaches the network only restates the finding");
});

test("a schema that describes a different function is caught before execution", async () => {
  const renamed = JSON.parse(CONFIG);
  renamed.parameters.required = ["value", "scheme"];
  const kernel = fakeKernel();
  const verdict = await verifyCodeSkill({
    files: files({ "scripts/normalize_identifier.tool.json": JSON.stringify(renamed) }),
    project: {},
    runKernel: kernel.runKernel,
  });
  assert.ok(verdict.issues.some((issue) => issue.code === "method_tool_config_mismatch"));
  assert.deepEqual(kernel.programs, []);
});

test("an incomplete group is reported by what it is missing", async () => {
  for (const [missing, code] of [
    ["scripts/normalize_identifier.py", "script"],
    ["tests/test_normalize_identifier.py", "test"],
    ["scripts/normalize_identifier.tool.json", "tool schema"],
  ]) {
    const partial = files();
    delete partial[missing];
    const verdict = await verifyCodeSkill({ files: partial, project: {}, runKernel: fakeKernel().runKernel });
    assert.equal(verdict.ok, false, missing);
    const issue = verdict.issues.find((entry) => entry.code === "method_files_incomplete");
    assert.ok(issue, `${missing} produced no incompleteness issue`);
    assert.match(issue.message, new RegExp(code));
  }
});

test("a self test that fails is a failed verification, with the output attached", async () => {
  const kernel = fakeKernel(() => ({ status: "error", output: "AssertionError\n" }));
  const verdict = await verifyCodeSkill({ files: files(), project: {}, runKernel: kernel.runKernel });
  assert.equal(verdict.ok, false);
  const issue = verdict.issues.find((entry) => entry.code === "method_script_self_test_failed");
  assert.ok(issue);
  assert.match(issue.message, /AssertionError/);
  assert.equal(verdict.executions[0].status, "failed");
});

test("a program that produced no marker did not run to the end, whatever it says", async () => {
  // The exit status of a container command is not proof the test inside it ran.
  const kernel = fakeKernel(() => ({ status: "ok", output: "some unrelated output\n" }));
  const verdict = await verifyCodeSkill({ files: files(), project: {}, runKernel: kernel.runKernel });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.issues.some((issue) => issue.code === "method_script_self_test_failed"));
});

test("a runtime that cannot execute is an unavailability, not a failed skill", async () => {
  await assert.rejects(
    () => verifyCodeSkill({
      files: files(),
      project: {},
      runKernel: async () => { const error = new Error("down"); /** @type {any} */ (error).code = "runtime_not_running"; throw error; },
    }),
    (error) => error.code === "code_skill_verification_unavailable" && /runtime_not_running/.test(error.message),
  );
});
