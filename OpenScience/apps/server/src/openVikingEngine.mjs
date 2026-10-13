import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  OPENVIKING_MEMORY_TYPES, OPENVIKING_SKILLS_ROOT, OPENVIKING_SKILL_NAMES, skillUri,
} from "./openVikingLayout.mjs";

/**
 * What must be true of the OpenViking engine before anything built on it can work, read off the running service.
 *
 * Hidden knowledge: every one of these fails silently upstream.
 *
 *  - A server of another version starts healthy on the same configuration (from v0.4.22 an unknown key only warns),
 *    and the routes the knowledge and memory modules call simply answer 404.
 *  - A memory-template directory that is not mounted where `memory.custom_templates_dir` points makes the server fall
 *    back to its built-in types without a word; the type allowlist then names types that do not exist, and what it
 *    extracts is upstream's policy — which copies quoted messages into memory files — not ours.
 *  - `GET /compile/capabilities` says `can_create: true` from configuration alone. With the identity shim down a
 *    submission is accepted and fails eighteen seconds later.
 *  - A skill that was never installed is a compile that fails at `loading_skill`; one whose bytes differ from the pin
 *    is a compile that follows instructions nobody reviewed.
 *
 * So the control plane asks. Each fact is one cheap, no-spend exchange with the engine, the answers are kept and
 * reported under `memoryIndex.engine` in `/api/ready`, and the two modules built on the engine ask `ready(feature)`
 * before they depend on it. A failed fact degrades the feature it belongs to and is named; it never fails readiness
 * and never touches a conversation (root `CLAUDE.md`, principle 18: an optional memory or knowledge service being
 * down returns a status and the conversation continues).
 *
 * The one write this makes: a skill that is missing is installed from the pinned bytes this repository ships
 * (`openVikingSkills/`), as the engine's install identity. A skill that is present with other bytes is reported and
 * left alone — replacing it is an operator's decision, because somebody put it there.
 *
 * Build to delete: the shim fact goes with the shim, on the first pin whose Compile forwards identity itself
 * (upstream PR #5750); the template fact goes if upstream ever reports the loaded template directory in `/health`.
 *
 * @module openVikingEngine
 */

/** The facts, in the order they are read. Their names are the keys of `memoryIndex.engine.facts` in `/api/ready`. */
export const OPENVIKING_ENGINE_FACTS = Object.freeze(["version", "modelKey", "memoryTemplates", "skills", "compileShim"]);

/** Which facts each feature built on the engine needs. `ready(feature)` answers from these. */
export const OPENVIKING_ENGINE_FEATURES = Object.freeze({
  /** Sessions, the engine's own extraction, the memory plugin (`OPEN_SCIENCE_OV_NATIVE_MEMORY_ENABLED`). */
  nativeMemory: Object.freeze(["version", "modelKey", "memoryTemplates"]),
  /** Resources, Compile, the wiki and the graph (`OPEN_SCIENCE_OV_KNOWLEDGE_ENABLED`). */
  knowledge: Object.freeze(["version", "modelKey", "skills", "compileShim"]),
});

/**
 * The identity the control plane installs skills and probes as. Not a person and not derivable from one: every
 * account's engine id is `u-<24 hex>` (`openVikingUserId`), which this can never equal.
 */
export const OPENVIKING_ENGINE_USER = "evimed-engine";

/** Where the Compile probe's target points: a shared root the identity shim refuses by rule, so nothing is written. */
const SHIM_PROBE_TARGET = "viking://resources/evimed-shim-probe";
/** How long the probe waits for its submission to fail. The shim answers in a third of a second; without it the
 *  engine gives up after about eighteen. */
const SHIM_PROBE_WAIT_MS = 25_000;
const SHIM_PROBE_POLL_MS = 500;

const sha256 = (/** @type {Buffer | string} */ bytes) => createHash("sha256").update(bytes).digest("hex");
const codeOf = (/** @type {any} */ error) => (typeof error?.code === "string" && error.code ? error.code : "memory_index_unavailable");
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
/**
 * Whether an admin route refused because the account or the user is not in the engine's registry yet. In trusted mode
 * identities are registered in batches, up to five minutes after their first data request, and until then every admin
 * route answers 404 about the account — on a new volume, that is the first minutes after the first start.
 */
const notRegisteredYet = (/** @type {any} */ error) => error?.upstreamStatus === 404 && ["account", "user"].includes(String(error?.upstreamDetails?.type ?? ""));

/** @typedef {{ ok: boolean, code?: string, [detail: string]: unknown }} EngineFact */

/** The pinned bytes of one official skill, as this repository ships them. @param {string} name */
export async function readPinnedSkill(name) {
  return readFile(new URL(`./openVikingSkills/${name}.skill.md`, import.meta.url), "utf8");
}

export class OpenVikingEngine {
  /**
   * @param {{ client: any, config: Record<string, any>, pin: any, readSkill?: (name: string) => Promise<string>,
   *   now?: () => Date, wait?: (ms: number) => Promise<unknown>, report?: (line: string) => void }} dependencies
   *   `pin` is `deps-version.json`'s `openviking` entry; `client` an `OpenVikingClient`.
   */
  constructor({ client, config, pin, readSkill = readPinnedSkill, now = () => new Date(), wait = sleep, report = () => {} }) {
    this.client = client;
    this.config = config ?? {};
    this.pin = pin ?? {};
    this.readSkill = readSkill;
    this.now = now;
    this.wait = wait;
    this.report = report;
    /** @type {{ checkedAt: string, facts: Record<string, EngineFact> } | null} */
    this.last = null;
    /** Observable counters (principle 15). */
    this.counters = { checks: 0, failedChecks: 0, skillInstalls: 0, shimProbes: 0 };
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
    /** @type {Promise<unknown> | null} */
    this.running = null;
  }

  /** Whether there is an engine to ask at all. */
  get applicable() {
    return Boolean(this.client?.configured);
  }

  /** Read every fact once, now. Never throws: a fact that could not be read is a failed fact with the reason. */
  async check() {
    if (this.running) return this.running;
    this.running = this.#check().finally(() => { this.running = null; });
    return this.running;
  }

  async #check() {
    /** @type {Record<string, EngineFact>} */
    const facts = {};
    const read = async (/** @type {string} */ name, /** @type {() => Promise<EngineFact>} */ fn) => {
      try {
        facts[name] = await fn();
      } catch (error) {
        facts[name] = { ok: false, code: codeOf(error) };
      }
    };
    await read("version", () => this.#version());
    await read("modelKey", async () => this.#modelKey());
    // With no answer on /health nothing below can be read; say that once per fact rather than time out four times.
    if (facts.version.code && /^memory_index_(?:unavailable|timeout|url_|auth)|_api_key_/.test(facts.version.code)) {
      for (const name of ["memoryTemplates", "skills", "compileShim"]) facts[name] = { ok: false, code: facts.version.code };
    } else {
      await read("memoryTemplates", () => this.#memoryTemplates());
      await read("skills", () => this.#skills());
      // The probe names an installed skill as its source, so it is only meaningful once the skills are there.
      if (facts.skills.ok) await read("compileShim", () => this.#compileShim());
      else facts.compileShim = { ok: false, code: "openviking_shim_unprobed" };
    }
    this.last = { checkedAt: this.now().toISOString(), facts };
    this.counters.checks += 1;
    const failed = OPENVIKING_ENGINE_FACTS.filter((name) => !facts[name]?.ok);
    if (failed.length) {
      this.counters.failedChecks += 1;
      this.report(`openviking engine check: ${failed.map((name) => `${name}=${facts[name]?.code ?? "failed"}`).join(" ")}`);
    }
    return this.status();
  }

  /** The pinned release is the one answering. */
  async #version() {
    const status = await this.client.status();
    const expected = `v${this.pin.version}`;
    if (!status.connected) return { ok: false, code: status.code ?? "memory_index_unavailable", expected };
    return status.version === expected
      ? { ok: true, version: status.version }
      : { ok: false, code: "openviking_version_mismatch", expected, version: status.version ?? null };
  }

  /** The bearer the engine's own model calls arrive with is loaded here; without it every one of them is refused. */
  #modelKey() {
    if (this.config.openVikingModelKeyError) return { ok: false, code: String(this.config.openVikingModelKeyError) };
    return this.config.openVikingModelKey ? { ok: true } : { ok: false, code: "openviking_model_key_missing" };
  }

  /**
   * The template directory is in effect and the allowlist is the deployment's.
   *
   * Two readings, because they fail apart. The types this deployment adds exist in the server's registry only when the
   * directory was loaded: asking for one answers 400 `not editable` when it is there and 404 when it is not. And the
   * allowlist is what a registered user's settings read back: without `server.user_config_defaults` that list is every
   * registered type, upstream's included.
   */
  async #memoryTemplates() {
    const account = this.client.account;
    const missing = [];
    for (const type of OPENVIKING_MEMORY_TYPES) {
      try {
        await this.client.request({ path: `/api/v1/admin/accounts/${account}/memory-templates/${type}`, openVikingUser: OPENVIKING_ENGINE_USER });
      } catch (error) {
        if (notRegisteredYet(error)) return { ok: false, code: "openviking_registration_pending" };
        if (/** @type {any} */ (error)?.upstreamStatus === 404) missing.push(type);
        else if (/** @type {any} */ (error)?.upstreamStatus !== 400) throw error;
      }
    }
    if (missing.length) return { ok: false, code: "openviking_memory_templates_missing", missing };
    try {
      await this.#registerEngineUser();
    } catch (error) {
      if (notRegisteredYet(error)) return { ok: false, code: "openviking_registration_pending" };
      throw error;
    }
    const settings = await this.client.request({
      path: `/api/v1/admin/accounts/${account}/users/${OPENVIKING_ENGINE_USER}/settings`, openVikingUser: OPENVIKING_ENGINE_USER,
    });
    const types = Array.isArray(settings?.result?.memory_policy?.memory_types) ? [...settings.result.memory_policy.memory_types].sort() : [];
    const expected = [...OPENVIKING_MEMORY_TYPES].sort();
    return types.length === expected.length && types.every((type, index) => type === expected[index])
      ? { ok: true, types }
      : { ok: false, code: "openviking_memory_types_mismatch", types };
  }

  /** The admin routes do not know a trusted user until it is registered; a second registration answers 409. */
  async #registerEngineUser() {
    try {
      await this.client.request({
        method: "POST", path: `/api/v1/admin/accounts/${this.client.account}/users`, openVikingUser: OPENVIKING_ENGINE_USER,
        body: { user_id: OPENVIKING_ENGINE_USER, role: "user" },
      });
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== "memory_index_conflict") throw error;
    }
  }

  /** The stored bytes of one installed skill, or null when it is not installed. @param {string} name */
  async #installedSkillDigest(name) {
    try {
      const file = await this.client.request({
        path: "/api/v1/content/download", query: { uri: `${skillUri(name)}/SKILL.md` }, openVikingUser: OPENVIKING_ENGINE_USER, responseType: "bytes",
      });
      return sha256(file.bytes);
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "memory_index_not_found") return null;
      throw error;
    }
  }

  /**
   * The two official skills are installed with the pinned bytes; one that is missing is installed here.
   *
   * Two digests per skill, because the server rewrites what it stores (it re-wraps the frontmatter `description` and
   * drops the final newline): the upstream file's, which the shipped copy is held to, and the installed file's, which
   * this compares with.
   */
  async #skills() {
    /** @type {Record<string, { state: string, sha256?: string }>} */
    const skills = {};
    let ok = true;
    let code = "";
    for (const name of OPENVIKING_SKILL_NAMES) {
      const pinned = String(this.pin.skills?.[name]?.installedSha256 ?? "");
      let installed = await this.#installedSkillDigest(name);
      let state = "installed";
      if (installed == null) {
        const text = await this.readSkill(name);
        if (sha256(text) !== String(this.pin.skills?.[name]?.upstreamSha256 ?? "")) {
          skills[name] = { state: "source-drifted" };
          ok = false; code ||= "openviking_skill_source_drifted";
          continue;
        }
        await this.client.request({
          method: "POST", path: "/api/v1/skills", openVikingUser: OPENVIKING_ENGINE_USER,
          body: { data: text, target_uri: OPENVIKING_SKILLS_ROOT, wait: true }, timeoutMs: 60_000,
        });
        this.counters.skillInstalls += 1;
        installed = await this.#installedSkillDigest(name);
        state = "installed-now";
      }
      if (installed == null) { skills[name] = { state: "missing" }; ok = false; code ||= "openviking_skill_missing"; continue; }
      if (installed !== pinned) { skills[name] = { state: "drifted", sha256: installed }; ok = false; code ||= "openviking_skill_drifted"; continue; }
      skills[name] = { state, sha256: installed };
    }
    return ok ? { ok: true, skills } : { ok: false, code, skills };
  }

  /**
   * The identity shim answers, asked through the path a real compile takes.
   *
   * A submission whose target is outside every user's root is refused by the shim by rule (`identity_shim.py`), in a
   * third of a second, before the bot is involved: nothing is written and no model is called. The task's error text
   * is the shim's own sentence, which is the proof it was the shim that answered. With the shim down the same
   * submission fails with `UNAVAILABLE` instead. Each probe leaves one failed task record, which the engine keeps for
   * seven days — the reason this is read on a slow cadence and not on every readiness request.
   */
  async #compileShim() {
    this.counters.shimProbes += 1;
    const submitted = await this.client.request({
      method: "POST", path: "/api/v1/compile", openVikingUser: OPENVIKING_ENGINE_USER,
      idempotencyKey: `evimed-shim-probe-${randomBytes(12).toString("hex")}`,
      body: { from: [skillUri(OPENVIKING_SKILL_NAMES[0])], to: SHIM_PROBE_TARGET, skill: skillUri(OPENVIKING_SKILL_NAMES[0]) },
    });
    const taskId = String(submitted?.result?.task_id ?? "");
    if (!taskId) return { ok: false, code: "openviking_shim_probe_unreadable" };
    for (let waited = 0; waited <= SHIM_PROBE_WAIT_MS; waited += SHIM_PROBE_POLL_MS) {
      const task = (await this.client.request({ path: `/api/v1/tasks/${taskId}`, openVikingUser: OPENVIKING_ENGINE_USER }))?.result ?? {};
      if (task.status === "failed") {
        return /identity shim/.test(String(task.error ?? ""))
          ? { ok: true }
          : { ok: false, code: "openviking_shim_unreachable", reason: String(task.error ?? "").slice(0, 200) };
      }
      // A probe that was accepted and is running means the target rule no longer refuses: stop it, and say so.
      if (task.status === "completed" || /^compile: (?:agent|writing)/.test(String(task.stage ?? ""))) {
        await this.client.request({ method: "POST", path: `/api/v1/tasks/${taskId}/cancel`, openVikingUser: OPENVIKING_ENGINE_USER }).catch(() => {});
        return { ok: false, code: "openviking_shim_absent" };
      }
      await this.wait(SHIM_PROBE_POLL_MS);
    }
    return { ok: false, code: "openviking_shim_unreachable", reason: "the probe did not end" };
  }

  /**
   * What readiness reports (`memoryIndex.engine`): when the facts were last read, each fact, and which features a
   * failed fact degrades. Before the first read every fact is `openviking_engine_unchecked`.
   */
  status() {
    const facts = Object.fromEntries(OPENVIKING_ENGINE_FACTS.map((name) => [
      name, this.last?.facts[name] ?? { ok: false, code: "openviking_engine_unchecked" },
    ]));
    const degraded = Object.keys(OPENVIKING_ENGINE_FEATURES).filter((feature) => !this.ready(feature).ok);
    return { checkedAt: this.last?.checkedAt ?? null, ok: degraded.length === 0, facts, degraded, counters: { ...this.counters } };
  }

  /**
   * Whether a feature built on the engine can be relied on now, and the first fact that says it cannot.
   * @param {keyof typeof OPENVIKING_ENGINE_FEATURES | string} feature
   * @returns {{ ok: boolean, code: string | null, fact: string | null }}
   */
  ready(feature) {
    const needed = /** @type {Record<string, readonly string[]>} */ (OPENVIKING_ENGINE_FEATURES)[feature];
    if (!needed) return { ok: false, code: "openviking_feature_unknown", fact: null };
    for (const name of needed) {
      const fact = this.last?.facts[name];
      if (!fact?.ok) return { ok: false, code: String(fact?.code ?? "openviking_engine_unchecked"), fact: name };
    }
    return { ok: true, code: null, fact: null };
  }

  /** Read the facts now and again every `openVikingEngineCheckMs`; a failed read is retried sooner. */
  start() {
    if (this.timer || !this.applicable) return;
    const every = Math.max(60_000, Number(this.config.openVikingEngineCheckMs) || 1_800_000);
    let since = 0;
    const tick = () => {
      since += 60_000;
      // While something is failing the check runs every five minutes, so a restarted engine is noticed without a
      // deploy; a healthy engine is asked on the configured cadence.
      if (since >= (this.last && this.status().ok ? every : Math.min(every, 300_000))) {
        since = 0;
        void this.check();
      }
    };
    void this.check();
    this.timer = setInterval(tick, 60_000);
    this.timer.unref?.();
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
