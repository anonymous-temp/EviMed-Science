/**
 * Whether 「虚拟临床研究」's statistics engine is answering, one reading for every
 * place that says so: the job a page shows, readiness, and the capability's
 * availability label.
 *
 * Hidden knowledge:
 *
 * - **Configured is not answering.** Readiness used to say `engine: wired` for an
 *   engine whose container was stopped, because the only thing it asked was
 *   whether a URL and a token were set. The three words are kept apart here:
 *   `not_configured` (the deployment has no engine, and says so by name),
 *   `answering`, `not_answering`, and `unknown` for the moment before anyone has
 *   asked — which is never reported as either, because a label that guesses is
 *   the thing this replaces.
 * - **A job's own contact is evidence.** The job queue talks to the engine every
 *   few seconds while anything runs, so each answer or failure it sees is
 *   reported here (`observe`) and a probe of `/health` is only needed when nothing
 *   has talked to the engine for a while. The readiness poll never waits for the
 *   engine: it reads the last reading and, if that is old, starts one refresh in
 *   the background (the precedent is `availabilityEngineProbe.mjs`).
 * - **Not answering is a label, never a stop.** An engine down means the
 *   capability that needs it reports blocked, not the platform (the layer-9 rule
 *   in `CLAUDE.md`): readiness stays green with a warning, a job keeps waiting and
 *   continues by itself, and nothing here refuses a request.
 * - A reading is process-local on purpose. The durable fact — that a particular
 *   job's last contact with the engine failed — is on the job's own row
 *   (`vcrJobs.mjs`), which is what another replica reads.
 *
 * @module vcrEngineProbe
 */

/** @typedef {{ state: "not_configured" | "unknown" | "answering" | "not_answering", code: string | null, checkedAt: string | null }} VcrEngineReading */

/**
 * @param {{ engine?: { configured?: () => boolean, health?: () => Promise<{ ok?: boolean }> } | null,
 *   ttlMs?: number, now?: () => number }} [options]
 */
export function createVcrEngineProbe({ engine = null, ttlMs = 15_000, now = () => Date.now() } = {}) {
  const configured = () => Boolean(engine?.configured?.());
  /** @type {VcrEngineReading} */
  let reading = { state: configured() ? "unknown" : "not_configured", code: null, checkedAt: null };
  let checkedMs = 0;
  /** @type {Promise<VcrEngineReading> | null} */
  let refreshing = null;

  /** @param {VcrEngineReading["state"]} state @param {string | null} code */
  const set = (state, code) => {
    checkedMs = now();
    reading = { state, code, checkedAt: new Date(checkedMs).toISOString() };
  };

  const probe = {
    /**
     * What the queue saw the last time it spoke to the engine. A transport failure
     * (the engine unreachable or silent past its deadline) is the only failure
     * that means "not answering"; anything the engine answered, even a refusal, was
     * an answer.
     * @param {boolean} answered @param {string | null} [code]
     */
    observe(answered, code = null) {
      if (!configured()) return;
      set(answered ? "answering" : "not_answering", answered ? null : (code ?? "vcr_engine_unreachable"));
    },

    /** The last reading, at once. A stale one starts a refresh and is still returned. @returns {VcrEngineReading} */
    snapshot() {
      if (!configured()) return { state: "not_configured", code: null, checkedAt: null };
      if (now() - checkedMs > ttlMs) void probe.refresh().catch(() => {});
      return { ...reading };
    },

    /** Ask the engine's `/health` now, at most one round at a time. @returns {Promise<VcrEngineReading>} */
    refresh() {
      if (!configured()) return Promise.resolve({ state: "not_configured", code: null, checkedAt: null });
      refreshing ??= (async () => {
        try {
          const health = await /** @type {any} */ (engine).health();
          if (health?.ok === true) set("answering", null);
          else set("not_answering", "vcr_engine_not_answering");
        } catch (error) {
          set("not_answering", typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "vcr_engine_unreachable");
        }
        return { ...reading };
      })().finally(() => { refreshing = null; });
      return refreshing;
    },
  };
  return probe;
}
