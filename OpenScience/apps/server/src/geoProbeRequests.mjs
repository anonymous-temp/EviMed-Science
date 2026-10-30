/**
 * The tasks the probe host accepted for a project's runtime (`geo_visibility_probe`, `op: "ask"`), kept so one that outlives the tool's
 * deadline is read later by its id and never asked a second time.
 *
 * Hidden knowledge:
 *
 * - **Acceptance is recorded before anything is waited for.** A five-engine task measured 487 s against the tool's 150 s ceiling. The
 *   host has taken the task and the ask is paid for; what the run still lacks is a way back to it. The gateway writes a row here the
 *   moment the host answers 202 (`probeUpstream`'s `onAccepted`), and the answer to an ask that outlives its deadline is `pending`
 *   with that id, not an error.
 * - **The row is the ask, not the answer.** It keeps the host's id, the question, the vendors and the two surface flags, because a
 *   later read checks the host's reply against what was asked. The answers are read from the host when they are asked for, so no
 *   vendor text is kept here.
 * - **Scoped to who asked.** A lookup names the account and the control-plane project whose runtime asked; another account's or
 *   project's id is not found, exactly as one never accepted is. (The key is the control-plane project, not a GEO project: the tool
 *   answers in any conversation of an account the module is open to.)
 * - **Kept for a while, then gone.** Rows older than `OPEN_SCIENCE_GEO_PROBE_RESULT_KEEP_HOURS` are deleted whenever a new one is
 *   written, and the deletion paths of a project and of an account remove the rest (`geoStore.mjs`).
 *
 * @module geoProbeRequests
 */

import { migrateGeo } from "./geoPersistence.mjs";

/** How long an accepted task's row is kept, unless the deployment says another (`OPEN_SCIENCE_GEO_PROBE_RESULT_KEEP_HOURS`). */
export const GEO_PROBE_RESULT_KEEP_HOURS = 24;

export class GeoProbeRequests {
  /**
   * @param {{ query: (text: string, values?: unknown[]) => Promise<any>, transaction: (operation: (client: any) => Promise<any>) => Promise<any> }} database  the control-plane database
   * @param {{ keepHours?: number, now?: () => Date }} [options]
   */
  constructor(database, { keepHours = GEO_PROBE_RESULT_KEEP_HOURS, now = () => new Date() } = {}) {
    if (!database || typeof database.query !== "function" || typeof database.transaction !== "function") {
      throw new TypeError("The GEO probe request ledger needs the control-plane database.");
    }
    this.database = database;
    this.keepMs = (Number.isFinite(keepHours) && keepHours > 0 ? keepHours : GEO_PROBE_RESULT_KEEP_HOURS) * 3_600_000;
    this.now = now;
  }

  /** The row for a task the host accepted. Writing the same id again keeps the first row. @param {{ requestId: string, userId: string, projectId: string, question: string, providers: string[], deep: 0 | 1, newChat: 0 | 1 }} task */
  async record({ requestId, userId, projectId, question, providers, deep, newChat }) {
    await migrateGeo(this.database);
    const at = this.now();
    await this.database.query(`DELETE FROM evimed_geo.probe_requests WHERE accepted_at < $1`, [new Date(at.getTime() - this.keepMs).toISOString()]);
    await this.database.query(`INSERT INTO evimed_geo.probe_requests (request_id, user_id, project_id, question, providers, deep, new_chat, accepted_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) ON CONFLICT (request_id) DO NOTHING`,
    [requestId, userId, projectId, question, JSON.stringify(providers), deep, newChat, at.toISOString()]);
  }

  /**
   * The ask a task was accepted for, when it was accepted for this account and this project and its row has not expired; else null.
   * @param {{ requestId: string, userId: string, projectId: string }} key
   */
  async lookup({ requestId, userId, projectId }) {
    await migrateGeo(this.database);
    const found = await this.database.query(`SELECT request_id, question, providers, deep, new_chat, accepted_at FROM evimed_geo.probe_requests
      WHERE request_id = $1 AND user_id = $2 AND project_id = $3 AND accepted_at >= $4`,
    [requestId, userId, projectId, new Date(this.now().getTime() - this.keepMs).toISOString()]);
    const row = found.rows[0];
    if (!row) return null;
    return {
      requestId: String(row.request_id),
      question: String(row.question),
      providers: Array.isArray(row.providers) ? row.providers.map(String) : [],
      deep: /** @type {0 | 1} */ (Number(row.deep) === 1 ? 1 : 0),
      newChat: /** @type {0 | 1} */ (Number(row.new_chat) === 0 ? 0 : 1),
      acceptedAt: new Date(row.accepted_at).toISOString(),
    };
  }
}
