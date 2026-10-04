// The method records of the admitted calculations, held equal across the three languages that state them.
//
// `packages/domain/src/method-records.json` is the one place a method's assumptions, inputs, refusals,
// diagnostics, seeding and reference cases are written. The specialist adapter ships a byte-identical copy
// and cuts every result's `methodRecord` identity from it (in Python); the control plane reads it here
// (in JavaScript); the calculation tool keeps its own table of refusal sentences, because the runtime's
// delta image copies only `*.py`. Asking is the point, as in engineToolContract.test.mjs: each comparison
// reads what a module answers, so a digest is compared by computing it on both sides.
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RESULT_REPLAY_METHODS, VCR_ENGINE_METHODS } from "@evimed/domain";
import { METHOD_RECORDS, METHOD_REFUSAL_CODES, methodRecord } from "@evimed/domain/method-records";
import { RESULT_WORKBENCH_ERROR_MESSAGES } from "../../../packages/domain/src/resultErrors.mjs";
import { replayDigest } from "../src/resultReplayClient.mjs";

const execFile = promisify(execFileCallback);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const adapterDir = `${root}deploy/specialist-adapter/`;
const mcpDir = `${root}runtime/mcp/evimed-research/`;

/** One expression answered by a Python module; the result arrives as JSON. */
async function python(cwd, script) {
  const { stdout } = await execFile("python3", ["-c", script], { cwd, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, EVIMED_RESULT_GATEWAY_URL: "", EVIMED_DISABLED_TOOLS: "" } });
  return JSON.parse(stdout);
}

test("every admitted method has a record, and the records name no method that is not admitted", () => {
  assert.deepEqual(Object.keys(METHOD_RECORDS).sort(), [...RESULT_REPLAY_METHODS].sort());
  for (const method of RESULT_REPLAY_METHODS) {
    const record = methodRecord(method);
    assert.equal(record.id, method);
    assert.match(record.version, /^\d+\.\d+\.\d+$/, method);
    for (const field of ["title", "estimand", "assumptions", "inputs", "refusals", "diagnostics", "dependencies", "references"]) {
      assert.ok(record[field]?.length > 0, `${method}.${field} is written`);
    }
    assert.equal(record.seeded, false, `${method}: no admitted method draws a random number`);
    // Every assumption says what checks it, and each named check exists in the record.
    const named = new Set([...record.refusals, ...record.diagnostics].map((item) => item.code));
    for (const assumption of record.assumptions) {
      for (const check of assumption.checkedBy.split(",").map((part) => part.trim())) {
        if (check === "none" || check.startsWith("output:")) continue;
        assert.ok(named.has(check.split(":")[1]), `${method}.${assumption.id} names ${check}, which the record does not have`);
      }
    }
    // Strings, integers and booleans only: a float would not hash alike in Python and JavaScript.
    const scalars = (value) => (value && typeof value === "object" ? Object.values(value).flatMap(scalars) : [value]);
    assert.ok(scalars(record).every((value) => ["string", "boolean"].includes(typeof value) || Number.isInteger(value)), method);
  }
  assert.equal(methodRecord("imported.script"), null);
});

test("every reference a record cites names a test file that exists, and each states its tolerance", async () => {
  const repository = `${root}../`;
  for (const method of RESULT_REPLAY_METHODS) {
    for (const reference of methodRecord(method).references) {
      assert.ok(["published", "other-implementation", "analytic"].includes(reference.kind), `${method}/${reference.id}`);
      assert.ok(reference.source.length > 30 && reference.tolerance.length > 0, `${method}/${reference.id} says what it was checked against and how closely`);
      // A reference may name two files ("a and b"), or a file and the case in it ("a (case N12)"): the first is the test.
      const file = reference.test.split(" (")[0].split(" and ")[0];
      await access(`${repository}${file}`).catch(() => assert.fail(`${method}/${reference.id} cites ${file}, which is not in the repository`));
    }
  }
});

test("the two R-run methods are recorded at the version the R engine publishes", () => {
  for (const method of ["design.analytic", "comparator.evalue"]) {
    assert.equal(methodRecord(method).version, VCR_ENGINE_METHODS[method].version, method);
    assert.equal(methodRecord(method).engine, "vcr-engine");
  }
});

test("the adapter ships the domain's records byte for byte and cuts the same digest from them", async () => {
  const domain = await readFile(`${root}packages/domain/src/method-records.json`);
  const adapter = await readFile(`${adapterDir}evimed_specialist_adapter/method_records.json`);
  assert.ok(domain.equals(adapter), "the adapter's copy of method-records.json drifted from the domain's; copy it over");
  // Asked, not spelled: the digest Python computes over each canonical record is the one JavaScript does.
  const identities = await python(adapterDir, [
    "import json, sys",
    "sys.path.insert(0, '.')",
    "from evimed_specialist_adapter import deterministic_replay as replay",
    "print(json.dumps({method: replay.record_identity(method) for method in replay.METHODS}))",
  ].join("\n"));
  assert.deepEqual(Object.keys(identities).sort(), ["bibliometric.network", "faers.signals", "meta.dl"]);
  for (const [method, identity] of Object.entries(identities)) {
    assert.deepEqual(identity, { id: method, version: methodRecord(method).version, digest: replayDigest(methodRecord(method)) }, method);
  }
});

test("the refusals the control plane lets through are the records' own, each with a message and a sentence for the model", async () => {
  assert.ok(METHOD_REFUSAL_CODES.size >= 9, "the vocabulary was read");
  for (const code of METHOD_REFUSAL_CODES) {
    assert.match(code, /^replay_[a-z_]{1,80}$/);
    assert.ok(RESULT_WORKBENCH_ERROR_MESSAGES[code], `${code} has a message for the researcher`);
  }
  // The calculation tool answers a named refusal with a sentence of its own; its table is the records' vocabulary.
  const sentences = await python(mcpDir, [
    "import json, sys",
    "sys.path[:0] = ['.', 'test']",
    "import research_calculate as calculate",
    "print(json.dumps(calculate.REFUSAL_REASONS))",
  ].join("\n"));
  assert.deepEqual(Object.keys(sentences).sort(), [...METHOD_REFUSAL_CODES].sort(), "the tool and the records disagree on what a calculation can be declined for");
  for (const sentence of Object.values(sentences)) assert.ok(sentence.length > 20 && sentence.length < 200);
});

test("the tool's table of inputs and the records agree on what each executed method reads", async () => {
  const described = await python(mcpDir, [
    "import json, sys",
    "sys.path[:0] = ['.', 'test']",
    "import research_calculate as calculate",
    "print(json.dumps({'methods': list(calculate.METHODS), 'parameters': {m: calculate.METHOD_INPUTS[m].get('parameters', {}) for m in calculate.METHODS}}))",
  ].join("\n"));
  assert.deepEqual(described.methods.sort(), Object.keys(METHOD_RECORDS).sort());
  for (const method of RESULT_REPLAY_METHODS) {
    const parameterNames = new Set(Object.values(described.parameters[method]).flat());
    const recorded = new Set(methodRecord(method).inputs.filter((item) => item.name.startsWith("parameters.")).map((item) => item.name.slice("parameters.".length)));
    assert.deepEqual([...recorded].sort(), [...parameterNames].sort(), `${method}: the tool offers parameters its record does not name, or the reverse`);
  }
});
