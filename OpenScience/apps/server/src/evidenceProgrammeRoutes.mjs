import { HttpError, readJson, sendJson } from "./security.mjs";
import { summariseProgrammeDecision } from "./evidenceProgramme.mjs";

/**
 * The operator's surface of the platform's evidence programme (evidence-flywheel plan §5.1, 2026-10-06): the programme decides once a day
 * and its decisions are ledger documents no other route reads, so nobody could see why a topic was chosen or run a day by hand.
 *
 * - `GET  /api/ops/evidence-programme` — the programme's status, its last fourteen decisions (who chose, the signals as counts, the actions
 *   with what became of each, the cost), the six official zones with who may write them, and today's budget spent and left;
 * - `POST /api/ops/evidence-programme/run` — today's decision now, through the same `runDay` the leased job uses: a day that is already
 *   decided is applied and not decided again, so a second call is the recorded no-op, and the answer is the day's decision.
 *
 * Operators only (`config.operatorUsers`), a signed-in session, CSRF checked; anyone else is told 403 before anything is read. With the
 * programme off (`OPEN_SCIENCE_EVIDENCE_PROGRAMME_ENABLED`) both answer 404 `evidence_programme_not_enabled` and no table is read.
 *
 * @param {{ store: any, programme: { enabled: boolean, overview: (options?: { decisions?: number }) => Promise<any>, runDay: () => Promise<any> } | null,
 *   config: { operatorUsers?: string[] }, maxJsonBytes: number }} options
 */
export function createEvidenceProgrammeRoutes({ store, programme, config, maxJsonBytes }) {
  const BASE = "/api/ops/evidence-programme";
  return async (/** @type {any} */ req, /** @type {any} */ res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== BASE && url.pathname !== `${BASE}/run`) return false;
    const method = req.method ?? "GET";
    const run = url.pathname === `${BASE}/run`;
    if (method !== (run ? "POST" : "GET")) throw new HttpError(404, "not_found", "No such evidence programme route.");
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!(config.operatorUsers ?? []).includes(user.id)) throw new HttpError(403, "evidence_programme_operator_required", "The evidence programme is available to operators only.");
    if (!programme?.enabled) throw new HttpError(404, "evidence_programme_not_enabled", "The evidence programme is not enabled.");
    const reply = (/** @type {any} */ data) => {
      sendJson(res, 200, { data }, { "Cache-Control": "private, no-store" });
      return true;
    };
    if (!run) return reply(await programme.overview({ decisions: 14 }));
    await readJson(req, maxJsonBytes);
    const result = await programme.runDay();
    return reply({ state: result.state, decision: result.decision && result.id ? summariseProgrammeDecision({ id: result.id, payload: result.decision }) : null });
  };
}
