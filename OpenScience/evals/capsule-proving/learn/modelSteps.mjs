/**
 * The product's learning model steps without a kernel: the `dispatch` / `readResult` pair `MethodDistillationRuns` and `MethodConsolidation`
 * are constructed with, answered by one direct DeepSeek call per attempt instead of a bounded capability run in a container.
 *
 * What is the product's and what stands in for it:
 *  - the instruction is the capability's own text, verbatim: its `persona` (capability.yaml) and its whole SKILL.md as the system message;
 *  - the task is the product's own dispatch `question`, inside the `<evimed-learning-step>` tag the runtime wraps it in
 *    (`learningRuntime.dispatch`), followed by the frozen input the run would have read from its input file;
 *  - stand-in (transport): the run has no tools and no files, so it is asked to reply with one JSON object of the files it would have
 *    written. The package is graded by the product's own contract gate (`runGate` with the capability's declared outputs, the check
 *    `evimed_submit_deliverable` runs), and a rejection is handed back as the next message with the gate's issues, up to `maxAttempts`
 *    times — SKILL.md's "submit until the contract returns ok". The accepted files are decoded by the product's `decodeLearningOutput`;
 *  - stand-in: the companion skill `manuscript-humanize` is not loaded (no file reads), and no usage receipt or budget applies.
 *
 * Every model call is one line of `callsLog` (tokens, attempt, verdict). Answers are cached by the exact prompt (`cacheDir`), so a step that
 * is run again — a resumed build, or another library variant whose input is byte-identical — reads the answer it already paid for.
 * @module modelSteps
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runGate, METHOD_SKILL_SCHEMA } from "@evimed/domain";
import { decodeLearningOutput, learningInputFile } from "../../../apps/server/src/learningRuntime.mjs";
import { learnedMethodId } from "../../../apps/server/src/learningService.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CAPABILITIES = path.resolve(here, "../../../capabilities");
const YAML = createRequire(path.resolve(here, "../../../apps/server/package.json"))("yaml");

const sha256 = (/** @type {string} */ text) => createHash("sha256").update(text, "utf8").digest("hex");

/** @type {Map<string, Promise<{ system: string, outputs: { path: string, required: boolean }[], checks: string[], version: string }>>} */
const loaded = new Map();

/** A learning capability as the run is given it: persona and SKILL.md, the outputs its contract expects. @param {string} capabilityId */
export function learningCapability(capabilityId) {
  if (!loaded.has(capabilityId)) {
    loaded.set(capabilityId, (async () => {
      const directory = path.join(CAPABILITIES, capabilityId);
      const manifest = YAML.parse(await readFile(path.join(directory, "capability.yaml"), "utf8"));
      const skill = await readFile(path.join(directory, "SKILL.md"), "utf8");
      const produced = manifest.produces?.[0] ?? {};
      return {
        system: `${String(manifest.persona ?? "").trim()}\n\n${skill}`,
        outputs: (produced.outputs ?? []).map((/** @type {any} */ output) => ({ path: String(output.path), required: output.required === true })),
        checks: Array.isArray(produced.checks) ? produced.checks.map(String) : [],
        version: String(manifest.version ?? ""),
      };
    })());
  }
  return /** @type {Promise<any>} */ (loaded.get(capabilityId));
}

/** The user message of a step: the product's question as the runtime sends it, the frozen input, and the transport note. */
function stepMessage(/** @type {any} */ request, /** @type {{path: string, required: boolean}[]} */ outputs) {
  const file = learningInputFile(request.capabilityId);
  const names = outputs.map((output) => `\`${output.path}\`${output.required ? "" : " (optional)"}`).join(", ");
  return [
    `<evimed-learning-step>\n${request.question}\n</evimed-learning-step>`,
    `The frozen input \`${file}\` follows; it is the whole of what you may read.`,
    "```json\n" + JSON.stringify(request.input, null, 1) + "\n```",
    "This step runs without tools or a file system. Instead of writing the package's files and calling evimed_submit_deliverable, reply "
      + `with exactly one JSON object whose keys are the file names you would write (${names}) and whose values are each file's complete `
      + "text (a JSON file's value is its JSON text). When the contract rejects the package its verdict comes back as the next message: "
      + "repair what it names, in place, and reply with the whole package again.",
  ].join("\n\n");
}

/** The files a reply carries, or null. @param {string} text @returns {Record<string, string> | null} */
export function filesOfReply(text) {
  const source = String(text ?? "");
  const fenced = source.match(/```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  const candidates = [fenced?.[1], source.slice(source.indexOf("{"), source.lastIndexOf("}") + 1)].filter(Boolean);
  for (const candidate of candidates) {
    try {
      let value = JSON.parse(/** @type {string} */ (candidate));
      if (value && typeof value === "object" && value.files && typeof value.files === "object" && !Array.isArray(value.files)) value = value.files;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      /** @type {Record<string, string>} */
      const files = {};
      for (const [name, content] of Object.entries(value)) {
        if (typeof content === "string") files[name] = content;
        else if (content && typeof content === "object") files[name] = JSON.stringify(content, null, 2);
      }
      if (Object.keys(files).length) return files;
    } catch { /* try the next reading */ }
  }
  return null;
}

/**
 * @param {{ model: { complete: (request: { messages: any[] }) => Promise<{ message: any, usage: any, model?: string }> }, cacheDir?: string | null,
 *   callsLog?: string | null, label?: string, maxAttempts?: number }} options
 */
export function createModelSteps({ model, cacheDir = null, callsLog = null, label = "", maxAttempts = 3 }) {
  /** @type {Map<string, any>} */
  const results = new Map();
  const usage = { calls: 0, cacheHits: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, steps: 0, rejected: 0, failed: 0 };

  /** @param {any} line */
  const log = async (line) => {
    if (!callsLog) return;
    await appendFile(callsLog, `${JSON.stringify({ at: new Date().toISOString(), label, ...line })}\n`);
  };

  /** One step: the model asked, the package gated, repaired until it passes or the attempts are spent. @param {any} request */
  async function run(request) {
    const capability = await learningCapability(request.capabilityId);
    const user = stepMessage(request, capability.outputs);
    const key = sha256(JSON.stringify({ capabilityId: request.capabilityId, version: capability.version, system: capability.system, user }));
    const cached = cacheDir ? await readFile(path.join(cacheDir, `${key}.json`), "utf8").then(JSON.parse).catch(() => null) : null;
    if (cached) {
      usage.cacheHits += 1;
      await log({ capability: request.capabilityId, action: request.input?.action ?? request.input?.trigger ?? null, dispatchId: request.dispatchId, cached: true, key, ok: cached.ok });
      return cached;
    }
    /** @type {any[]} */
    const messages = [{ role: "system", content: capability.system }, { role: "user", content: user }];
    /** @type {any} */
    let outcome = { ok: false, attempts: 0, files: null, issues: [] };
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const started = Date.now();
      const reply = await model.complete({ messages });
      const text = String(reply?.message?.content ?? "");
      const tokens = { promptTokens: Number(reply?.usage?.promptTokens) || 0, completionTokens: Number(reply?.usage?.completionTokens) || 0, cachedTokens: Number(reply?.usage?.cachedTokens) || 0 };
      usage.calls += 1;
      usage.promptTokens += tokens.promptTokens;
      usage.completionTokens += tokens.completionTokens;
      usage.cachedTokens += tokens.cachedTokens;
      const files = filesOfReply(text);
      const verdict = files
        ? runGate({ contractKind: request.contractKind, files: new Map(Object.entries(files)), expectedOutputs: capability.outputs, checks: capability.checks })
        : { ok: false, issues: [{ code: "reply_unreadable", message: "The reply was not one JSON object of file names to file contents.", severity: "required" }] };
      const required = (verdict.issues ?? []).filter((/** @type {any} */ issue) => issue.severity === "required");
      await log({ capability: request.capabilityId, action: request.input?.action ?? request.input?.trigger ?? null, dispatchId: request.dispatchId, key, attempt,
        ...tokens, ms: Date.now() - started, model: reply?.model ?? null, ok: verdict.ok, issues: required.slice(0, 6).map((/** @type {any} */ issue) => issue.code) });
      outcome = { ok: Boolean(verdict.ok), attempts: attempt, files, issues: required.map((/** @type {any} */ issue) => `${issue.code}: ${issue.message}`).slice(0, 20) };
      if (verdict.ok) break;
      usage.rejected += 1;
      messages.push({ role: "assistant", content: text });
      messages.push({ role: "user", content: `The contract rejected the package (evimed_submit_deliverable verdict):\n${outcome.issues.map((/** @type {string} */ line) => `- ${line}`).join("\n")}\n\nRepair these issues in place and reply with the whole package again as one JSON object.` });
    }
    if (cacheDir) {
      await mkdir(cacheDir, { recursive: true });
      const target = path.join(cacheDir, `${key}.json`);
      await writeFile(`${target}.tmp`, JSON.stringify({ key, capabilityId: request.capabilityId, dispatchId: request.dispatchId, ...outcome }));
      await rename(`${target}.tmp`, target);
    }
    return outcome;
  }

  return {
    usage,
    /** The bounded-run dispatcher's shape: an identity for the step, whose answer `readResult` reads. @param {any} request */
    async dispatch(request) {
      usage.steps += 1;
      const outcome = await run(request);
      if (!outcome.ok) usage.failed += 1;
      results.set(request.dispatchId, outcome.ok
        ? { status: "succeeded", output: decodeLearningOutput(/** @type {Record<string, string>} */ (outcome.files)), attempts: outcome.attempts }
        : { status: "failed", issues: outcome.issues, attempts: outcome.attempts });
      return { runId: `lr-${request.dispatchId}`, sessionId: `ls-${request.dispatchId}`, dispatchId: request.dispatchId };
    },
    /** @param {{dispatchId: string}} identity */
    async readResult(identity) {
      return results.get(identity.dispatchId) ?? { status: "failed" };
    },
  };
}

/* ------------------------------------------------------------------------------------------------ a fake model for --dry-run and tests */

const FAKE_BODY = (/** @type {string} */ purpose, /** @type {string} */ workflow) => [
  "## Purpose", purpose, "",
  "## When to Use", "When the same kind of game task comes up.", "",
  "## Inputs", "The task sentence and the room description.", "",
  "## Workflow", workflow, "",
  "## Verification", "- The target object ended where the task asked.", "",
  "## Constraints", "- Use only objects the room description names.", "",
  "## Output", "The task completed.",
].join("\n");

/** @param {Record<string, any>} frontmatter @param {string} body */
const renderSkill = (frontmatter, body) => `---\n${YAML.stringify(frontmatter).trim()}\n---\n\n${body}\n`;

/** The frozen input a step message carries. @param {any[]} messages */
function inputOf(messages) {
  const text = String(messages.find((message) => message.role === "user")?.content ?? "");
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  return match ? JSON.parse(match[1]) : {};
}

/**
 * A deterministic stand-in for DeepSeek that answers both capabilities with packages the contract accepts: a distillation creates one
 * method per distinct first request (`fake-<hash>`); DECIDE names an abstract pattern over a group of three or more; BUILD writes the
 * abstract parent. Usage is counted as one token per character, so the logs have numbers in them.
 */
export function fakeLearningModel() {
  return {
    model: "fake", thinking: "disabled",
    async complete({ messages }) {
      const system = String(messages[0]?.content ?? "");
      const input = inputOf(messages);
      /** @type {Record<string, string>} */
      let files;
      if (system.includes("name: method-distillation")) {
        const request = String(input.trajectory?.requests?.[0]?.text ?? "a game task");
        const name = `fake-${sha256(request).slice(0, 8)}`;
        const quote = request.replace(/\s+/g, " ").trim().slice(0, 80);
        const frontmatter = { name, description: `Plays one kind of text-game task (${name}).`, whenToUse: "When the same kind of game task comes up.",
          metadata: { role: "functional", applies_when: "A game task of this kind.", not_when: "Another kind of task.", derived_from: `run:${input.runId}`, evimed_schema: METHOD_SKILL_SCHEMA } };
        const scenarios = [1, 2, 3].map((n) => ({ id: `t${n}`, runId: input.runId, situation: "The same task.", expected: "The task is done." }));
        files = {
          "SKILL.md": renderSkill(frontmatter, FAKE_BODY("Do the task in the observed order.", `1. ${(input.trajectory?.tools ?? []).join(", then ") || "act"}.`)),
          "method-candidate.json": JSON.stringify({ schemaVersion: 1, signal: input.signal, operation: "create", baseDigest: null,
            evidence: [{ runId: input.runId, seqRange: [0, 0], quote }], applicability: "A game task of this kind.", counterexamples: ["Another kind of task."],
            risk: { touchesSafety: false, widensTools: false }, testScenarios: scenarios, display: { title: "按顺序完成同类任务", summary: "同类任务按观察到的顺序完成。", steps: "1. 按顺序完成。" } }),
        };
      } else if (input.action === "decide") {
        const ids = (input.methods ?? []).filter((/** @type {any} */ method) => !method.readOnly).map((/** @type {any} */ method) => method.id);
        const assignments = ids.length >= 3 ? [{ ASSIGNMENT: "A1", SKILLS: ids, RELATION_TYPE: "abstract_pattern", REASON: "They follow one pattern." }] : [];
        files = { "method-relations.json": JSON.stringify({ schemaVersion: 1, action: "decide", jobId: "consolidate:fake", assignments }) };
      } else {
        const assignment = (input.assignments ?? [])[0];
        const members = (input.methods ?? []).filter((/** @type {any} */ method) => assignment?.SKILLS?.includes(method.id));
        const name = `fake-pattern-${sha256(members.map((/** @type {any} */ member) => member.id).join(",")).slice(0, 6)}`;
        const frontmatter = { name, description: "The pattern the game methods share.", whenToUse: "When a game task needs a frame.",
          metadata: { role: "abstract", applies_when: "Any game task of these kinds.", not_when: "Other work.", derived_from: members.map((/** @type {any} */ member) => member.name).join(", "), evimed_schema: METHOD_SKILL_SCHEMA } };
        const revisions = assignment?.RELATION_TYPE === "abstract_pattern"
          ? [{ assignment: assignment.ASSIGNMENT, methodId: learnedMethodId(name), name, operation: "create", baseDigest: null, skill: renderSkill(frontmatter, FAKE_BODY("Frame the task before acting.", "1. Find the object, act on it, place it.")) }]
          : [];
        files = { "method-relations.json": JSON.stringify({ schemaVersion: 1, action: "build", jobId: "consolidate:fake", assignments: input.assignments ?? [], revisions, notices: [] }) };
      }
      const content = JSON.stringify(files);
      return { message: { role: "assistant", content }, usage: { promptTokens: JSON.stringify(messages).length, completionTokens: content.length, cachedTokens: 0 }, model: "fake" };
    },
  };
}
