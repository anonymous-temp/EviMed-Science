/**
 * The producer snapshot of a result version (plan 2026-10-02 §11.3 N06): what
 * produced its bytes — the script or method identity and its bytes digest, each
 * input's preserved version, the environment facts a producer actually
 * reported — and, as a closed list, what the platform did *not* observe. An
 * arbitrary shell command's dependencies are on that list and stay visible;
 * nothing fills them in.
 *
 * Hidden knowledge:
 *
 * - **Unknown is a value.** A producer the platform did not observe is an
 *   `unobserved` snapshot with its unknowns listed; it is not an empty object
 *   and it is not inferred from a filename or a neighbouring file.
 * - **Generated code is never an observed execution.** A script a run wrote
 *   beside its report is authored bytes. Only an owned producer's own receipt
 *   (a deterministic engine job, an admitted skill script's execution record)
 *   may say code ran, and the projection downgrades the claim of anything else.
 * - **No credential can enter a snapshot.** The projection is a closed schema
 *   of bounded scalars: environment facts are a fixed set of fields, package
 *   versions are name→version pairs, parameters are numbers and booleans.
 *   Environment variables, argv, tokens and paths outside the workspace have no
 *   field to be carried in.
 * - **Transformations are N03's records.** A dataset transformation is
 *   `dataSemantics`' versioned `TransformationRecord`; a snapshot names it by
 *   (dataset id, name, version) and never restates it.
 * - **The method identity is read in one place** (`methodIdentityFromResult`),
 *   which is where the validated-method record of the method work (N05) plugs in.
 *
 * Pure, browser-safe, no I/O.
 * @module @evimed/domain/producerSnapshot
 */

import {
  RESULT_LINEAGE_LIMITS, boundedText as text, digestOrNull, isRecord as isObject, isoTimestamp as isoTime, nonNegativeInteger as integer,
  pathOrNull, projectResultInput, scalarMap,
} from "./resultIdentity.mjs";

/**
 * How a version's bytes came about, as far as the platform can say.
 * `engine_job`: a deterministic engine job (a specialist adapter, `research_calculate`, the VCR engine).
 * `skill_script`: an admitted skill script's own execution record (`run_analysis.py`).
 * `authored`: bytes a native write/edit tool call carried; nothing was computed.
 * `render`: the platform's own number rendering of a template.
 * `unobserved`: nothing about how the bytes were produced was observed.
 */
export const PRODUCER_SNAPSHOT_KINDS = Object.freeze(["engine_job", "skill_script", "authored", "render", "unobserved"]);

/**
 * Who vouches for the facts: `platform_measured` — the control plane (or an
 * engine service it owns) measured them; `receipt_declared` — a producer's own
 * record states them and the platform re-checked what it could; `unknown`.
 */
export const SNAPSHOT_ORIGINS = Object.freeze(["platform_measured", "receipt_declared", "unknown"]);

/**
 * What the platform did not observe. `script`: which code ran. `inputs`: what
 * it read. `environment`: what it ran on. `undeclared_dependencies`: anything
 * the process read that no record lists — a shell command's files and network,
 * a script's own reads.
 */
export const SNAPSHOT_UNKNOWNS = Object.freeze(["script", "inputs", "environment", "undeclared_dependencies"]);

/**
 * Whether code ran, as a record rather than a hope. `observed_execution`: an owned producer says it ran and the platform
 * confirmed the code it names. `declared_execution`: a producer's own receipt says it ran and the platform could not
 * confirm the bytes (the script changed afterwards, or is gone). `generated_not_executed`: code that was written and has
 * no record of running.
 */
export const REPRODUCTION_STATES = Object.freeze(["observed_execution", "declared_execution", "generated_not_executed", "not_applicable"]);


const CODE_EXTENSIONS = new Set([".py", ".r", ".rmd", ".qmd", ".ipynb", ".js", ".mjs", ".ts", ".sh", ".jl", ".sas", ".do"]);

/** Whether a path names a source file by its extension (a closed list of file types, not a reading of content). @param {string} path */
export function isCodePath(path) {
  const dot = path.lastIndexOf(".");
  return dot > 0 && CODE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/**
 * The method identity a calculation result already carries, read in one place.
 *
 * Today that is the recipe's method and version, the engine method version the
 * VCR capability reports, the pooling engine's own `executedMethod` block and a
 * seed named in the parameters. **N05 hook**: the validated-method record
 * (identity, version, seed, assumptions) the method work attaches to a
 * calculation result is read here — `output.methodRecord` — and nowhere else, so
 * a snapshot never learns a second spelling of it. Until a result carries one,
 * the record is absent and nothing is made up for it.
 *
 * @param {{ recipe?: any, capability?: any, output?: any }} source
 * @returns {{ id: string, version: string | null, engineVersion: string | null, executed: Record<string, string | number | boolean> | null,
 *   seed: number | null, parameters: Record<string, string | number | boolean> | null, record: Record<string, string | number | boolean> | null } | null}
 */
export function methodIdentityFromResult({ recipe, capability, output } = {}) {
  const id = text(recipe?.method ?? capability?.method ?? output?.method, 64);
  if (!id) return null;
  const parameters = scalarMap(recipe?.parameters, 16);
  const seedCandidate = parameters?.seed ?? output?.job?.seed;
  const executedBlock = output?.result?.executedMethod ?? output?.executedMethod ?? null;
  /** @param {unknown} value */
  const named = (value) => (value == null ? null : text(String(value), 64));
  return {
    id,
    version: named(recipe?.version ?? capability?.version),
    engineVersion: named(capability?.engineMethodVersion ?? output?.manifest?.engineVersion),
    executed: scalarMap(executedBlock, 16),
    seed: typeof seedCandidate === "number" ? integer(seedCandidate) : null,
    parameters,
    // The validated-method record, when a result carries one (N05).
    record: scalarMap(output?.methodRecord, 16),
  };
}

/** @param {unknown} raw */
function projectMethod(raw) {
  if (!isObject(raw)) return null;
  const id = text(raw.id, 64);
  if (!id) return null;
  return { id, version: text(raw.version, 64), engineVersion: text(raw.engineVersion, 64), executed: scalarMap(raw.executed, 16),
    seed: integer(raw.seed), parameters: scalarMap(raw.parameters, 16), record: scalarMap(raw.record, 16) };
}

/** @param {unknown} raw */
function projectScript(raw) {
  if (!isObject(raw)) return null;
  const files = Array.isArray(raw.files) ? raw.files.slice(0, RESULT_LINEAGE_LIMITS.files).flatMap((file) => {
    const path = isObject(file) ? text(file.path, 300) : null;
    const sha = isObject(file) ? digestOrNull(file.sha256) : null;
    return path && sha ? [{ path, sha256: sha, bytes: isObject(file) ? integer(file.bytes) : null }] : [];
  }) : null;
  const script = { path: pathOrNull(raw.path) ?? text(raw.name, 120), digest: digestOrNull(raw.digest), bytes: integer(raw.bytes),
    files: files?.length ? files : null, executed: raw.executed === true, verified: raw.verified === true };
  return script.path || script.digest || script.files ? script : null;
}

/** @param {unknown} raw */
function projectEnvironment(raw) {
  if (!isObject(raw)) return { status: "unknown", digest: null, facts: null };
  const facts = isObject(raw.facts) ? raw.facts : {};
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of ["imageId", "interpreter", "implementation", "platform", "machine", "lockDigest"]) {
    const value = text(facts[key], 200);
    if (value !== null) out[key] = value;
  }
  let truncated = false;
  if (isObject(facts.packages)) {
    /** @type {Record<string, string>} */
    const packages = {};
    const listed = Object.entries(facts.packages);
    truncated = listed.length > RESULT_LINEAGE_LIMITS.packages;
    for (const [name, version] of listed.slice(0, RESULT_LINEAGE_LIMITS.packages)) {
      if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name) && text(version, 80) !== null) packages[name] = /** @type {string} */ (version);
    }
    if (Object.keys(packages).length) out.packages = packages;
  }
  const digest = digestOrNull(raw.digest);
  const reported = Object.keys(out).length > 0 || digest !== null;
  return { status: reported ? "reported" : "unknown", digest, facts: Object.keys(out).length ? out : null, ...(truncated ? { truncated: true } : {}) };
}

/** @param {unknown} raw */
function projectExecution(raw) {
  if (!isObject(raw)) return null;
  const exitCode = Number.isSafeInteger(raw.exitCode) ? raw.exitCode : null;
  const execution = { exitCode, startedAt: isoTime(raw.startedAt), endedAt: isoTime(raw.endedAt),
    sourcesUnchanged: typeof raw.sourcesUnchanged === "boolean" ? raw.sourcesUnchanged : null, observation: text(raw.observation, 40) };
  return Object.values(execution).some((value) => value !== null) ? execution : null;
}

/** @param {unknown} raw */
function projectTransformations(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, RESULT_LINEAGE_LIMITS.transformations).flatMap((item) => {
    const datasetId = isObject(item) ? text(item.datasetId, 64) : null;
    const name = isObject(item) ? text(item.name, 64) : null;
    const version = isObject(item) ? integer(item.version) : null;
    return datasetId && name && version ? [{ datasetId, name, version, codeDigest: digestOrNull(item.codeDigest) }] : [];
  });
}

/**
 * The closed, credential-free projection of a producer snapshot. Anything the
 * schema does not name is dropped; a claim the producer is not entitled to make
 * is downgraded rather than believed: only an engine job or an admitted skill
 * script whose origin is not `unknown` can say code was executed.
 * @param {unknown} raw
 */
export function projectProducerSnapshot(raw) {
  return isObject(raw) ? snapshotFrom(raw) : null;
}

/** @param {Record<string, any>} raw */
function snapshotFrom(raw) {
  const kind = /** @type {string} */ (PRODUCER_SNAPSHOT_KINDS.includes(raw.kind) ? raw.kind : "unobserved");
  const origin = /** @type {string} */ (SNAPSHOT_ORIGINS.includes(raw.origin) ? raw.origin : "unknown");
  const executes = (kind === "engine_job" || kind === "skill_script") && origin !== "unknown";
  const script = projectScript(raw.script);
  if (script && !executes) { script.executed = false; script.verified = false; }
  const inputs = Array.isArray(raw.inputs) ? raw.inputs.slice(0, RESULT_LINEAGE_LIMITS.inputs).flatMap((item) => {
    try { return [projectResultInput(item)]; } catch { return []; }
  }) : [];
  const claimed = /** @type {string} */ (REPRODUCTION_STATES.includes(raw.reproduction) ? raw.reproduction : "not_applicable");
  // Generated code is never promoted to an observed execution, and a receipt's claim that is not confirmed stays a declaration.
  const entitled = claimed === "observed_execution" ? executes && script?.executed === true
    : claimed === "declared_execution" ? kind === "skill_script" && origin !== "unknown" : true;
  const reproduction = entitled ? claimed : script ? "generated_not_executed" : "not_applicable";
  const unknown = [...new Set(Array.isArray(raw.unknown) ? raw.unknown.filter((item) => SNAPSHOT_UNKNOWNS.includes(item)) : [])];
  return { schemaVersion: 1, kind, origin, method: projectMethod(raw.method), script, inputs, transformations: projectTransformations(raw.transformations),
    environment: projectEnvironment(raw.environment), execution: projectExecution(raw.execution), reproduction, unknown,
    recorded: raw.recorded !== false };
}

/** What a version with no recorded snapshot says: nothing was observed, and each part of that is named. */
export function unobservedSnapshot() {
  return snapshotFrom({ kind: "unobserved", origin: "unknown", unknown: [...SNAPSHOT_UNKNOWNS], recorded: false });
}

/**
 * Bytes a native write or edit tool call carried: the model typed them, nothing
 * was computed. A source file written this way is generated code, not an
 * execution.
 * @param {{ tool?: string | null, path?: string | null }} [input]
 */
export function authoredSnapshot({ tool = null, path = null } = {}) {
  const code = typeof path === "string" && isCodePath(path);
  return snapshotFrom({ kind: "authored", origin: "platform_measured", method: tool ? { id: String(tool).slice(0, 64) } : null,
    script: code ? { path, executed: false } : null, reproduction: code ? "generated_not_executed" : "not_applicable", unknown: [] });
}

/**
 * A deterministic engine job. The identities are the engine's own receipt: the
 * code files and installed packages it measured, the parameters and seed of its
 * recipe, and the exact preserved input versions.
 * @param {{ recipe: any, capability?: any, output?: any, inputs?: any[] }} input
 */
export function engineJobSnapshot({ recipe, capability = null, output = null, inputs = [] }) {
  const method = methodIdentityFromResult({ recipe, capability, output });
  // The engine's own receipt names the files it measured and what it ran on; the capability the control plane asked is the other witness.
  const measured = Array.isArray(capability?.codeFiles) ? capability.codeFiles : Array.isArray(output?.receipt?.codeFiles) ? output.receipt.codeFiles : null;
  const files = measured ? measured.map((/** @type {any} */ file) => ({ path: file?.path, sha256: file?.sha256, bytes: file?.bytes })) : null;
  const facts = capability?.environment ?? output?.receipt?.environment ?? null;
  const manifest = output?.manifest;
  return snapshotFrom({
    kind: "engine_job", origin: "platform_measured", method,
    script: { name: method?.id, digest: recipe?.codeDigest ?? capability?.codeDigest, files, executed: true, verified: true },
    inputs,
    environment: { digest: recipe?.environmentDigest ?? capability?.environmentDigest,
      facts: isObject(facts) ? { interpreter: facts.python ? `Python ${facts.python}` : facts.interpreter, implementation: facts.implementation,
        platform: facts.platform, machine: facts.machine, packages: facts.packages }
        : isObject(manifest) ? { interpreter: manifest.rVersion ? `R ${manifest.rVersion}` : undefined, lockDigest: manifest.packageLockHash } : null },
    reproduction: "observed_execution", unknown: [],
  });
}

/**
 * An admitted skill script's own execution record, with what the control plane
 * could re-check against the preserved bytes. A script whose bytes no longer
 * match its receipt is `verified: false` — recorded as what it says, never as
 * what was measured.
 * @param {{ script: {path: string, digest: string | null, verified: boolean}, inputs: any[], transformations?: any[], environment?: any,
 *   execution?: any, interpreter?: string | null }} facts
 */
export function skillScriptSnapshot({ script, inputs, transformations = [], environment = null, execution = null, interpreter = null }) {
  const succeeded = execution?.exitCode === 0 && execution?.sourcesUnchanged !== false;
  const confirmed = succeeded && Boolean(script?.verified);
  // Every input is a preserved, digest-confirmed version; otherwise what the script read is only partly known.
  const everyChecked = Boolean(script?.verified) && inputs.length > 0 && inputs.every((input) => input?.versionId && input?.digest);
  return snapshotFrom({
    kind: "skill_script", origin: "receipt_declared",
    method: interpreter ? { id: interpreter } : null,
    script: { path: script?.path, digest: script?.digest, executed: confirmed, verified: Boolean(script?.verified) },
    inputs, transformations, environment, execution,
    reproduction: confirmed ? "observed_execution" : succeeded ? "declared_execution" : "generated_not_executed",
    // The script ran as a process: anything it read that its receipt does not list is unknown.
    unknown: ["undeclared_dependencies", ...(everyChecked ? [] : ["inputs"])],
  });
}

/**
 * The platform's own rendering of a template. The code is the platform's
 * (`version` is the rule version of the number binding), the inputs are the template and the calculations.
 * @param {{ inputs: any[], version: string }} input
 */
export function renderSnapshot({ inputs, version }) {
  return snapshotFrom({ kind: "render", origin: "platform_measured", method: { id: "number-binding", version },
    inputs, reproduction: "not_applicable", unknown: [] });
}

/**
 * The gaps a snapshot adds to a version's coverage, as the closed codes the
 * reader labels. Nothing here refuses anything.
 * @param {any} snapshot @returns {string[]}
 */
export function snapshotGaps(snapshot) {
  if (!snapshot) return [];
  /** @type {string[]} */
  const gaps = [];
  if (snapshot.unknown?.includes("undeclared_dependencies")) gaps.push("dependencies_not_observed");
  if (snapshot.reproduction === "generated_not_executed") gaps.push("code_not_executed");
  return gaps;
}
