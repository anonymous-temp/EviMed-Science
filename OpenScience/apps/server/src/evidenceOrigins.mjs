/**
 * Where a research conversation came from, when it came from an evidence card (evidence-flywheel plan §5.2, F06 and
 * F07, 2026-10-05) — and how many research runs a card has started.
 *
 * Hidden knowledge:
 *
 * - **The binding is the conversation's, not the prompt's.** 「用这张卡继续研究」 binds a new research session to the
 *   card before the person types anything. A run starts in that session by two different roads — the dispatch route,
 *   and a message typed into the kernel's own application, which the control plane adopts — and both reserve their
 *   run against the same research-session record. The run ledger asks `originCardOf` at that one place, so a card
 *   cannot be forgotten by one road and remembered by the other, and nothing about dispatch changes.
 * - **Two small tables, the module's own.** `evidence_card_origins` is the binding (account, project, session → card);
 *   `evidence_card_runs` is the citation index (one row per run that started from a card), because the run ledgers are
 *   files in each project and a count across projects cannot be read from them. Both belong to the researcher's
 *   account and cascade with it and with the card.
 * - **A citation is another account's run.** The author's own runs from their own card are recorded and labelled,
 *   and not counted as the card being cited by research — an author cannot thank themselves. The count is the
 *   only citation signal that exists today: runs started, not runs trusted.
 * - **A label never stops a run.** Reading a binding that cannot be read, or recording a citation that cannot be
 *   written, leaves the run exactly as it would have been; the card link is simply absent.
 *
 * @module evidenceOrigins
 */

import { EVIDENCE_CITATION_MILESTONES } from "./evidenceCitationGift.mjs";
import { recordCardRun } from "./evidencePublishMetrics.mjs";
import { migrateEvidenceZones } from "./evidenceZonePersistence.mjs";

export const EVIDENCE_ORIGINS_SQL = `
CREATE TABLE IF NOT EXISTS evimed_frontier.evidence_card_origins (
 user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
 project_id text NOT NULL, session_id text NOT NULL,
 card_id text NOT NULL REFERENCES evimed_frontier.evidence_cards(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,project_id,session_id)
);
CREATE TABLE IF NOT EXISTS evimed_frontier.evidence_card_runs (
 user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
 project_id text NOT NULL, run_id text NOT NULL,
 card_id text NOT NULL REFERENCES evimed_frontier.evidence_cards(id) ON DELETE CASCADE,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,project_id,run_id)
);
CREATE INDEX IF NOT EXISTS evidence_card_runs_card_idx ON evimed_frontier.evidence_card_runs(card_id,started_at);
`;

const migrations = new WeakMap();
/** The module's tables, after the zones' own (the card table they refer to). @param {any} database */
export async function migrateEvidenceOrigins(database) {
  if (!migrations.has(database)) {
    migrations.set(database, (async () => {
      await migrateEvidenceZones(database);
      await database.transaction(async (/** @type {any} */ client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-evidence-origins-v1'))");
        await client.query(EVIDENCE_ORIGINS_SQL);
      });
    })().catch((/** @type {unknown} */ error) => {
      migrations.delete(database);
      throw error;
    }));
  }
  await migrations.get(database);
}

/** The shape of a card id; a value of any other shape is never looked up or written. */
export const EVIDENCE_CARD_ID = /^ec_[A-Za-z0-9]{8,64}$/;

export class EvidenceOrigins {
  /**
   * @param {{ database: any,
   *   cited?: ((input: { cardId: string, authorId: string, count: number }) => Promise<unknown>) | null,
   *   report?: ((code: string) => void) | null }} options
   *   `cited` is the citation gift's hook (`cardCitedByResearch`), called when another account's runs reach a milestone.
   */
  constructor({ database, cited = null, report = null }) {
    this.database = database;
    this.cited = cited;
    this.report = report;
  }

  async ready() { await migrateEvidenceOrigins(this.database); }

  /**
   * Bind a conversation to the card it starts from. Once per conversation: a second binding of the same session keeps the first.
   * @param {{ userId: string, id: string }} project @param {string} sessionId @param {string} cardId
   */
  async bind(project, sessionId, cardId) {
    await this.ready();
    await this.database.query(
      `INSERT INTO evimed_frontier.evidence_card_origins(user_id,project_id,session_id,card_id) VALUES($1,$2,$3,$4)
        ON CONFLICT(user_id,project_id,session_id) DO NOTHING`,
      [project.userId, project.id, sessionId, cardId],
    );
  }

  /**
   * The card a research session was bound to, or null — also when it cannot be read: a label never stops a run.
   * @param {{ userId: string, id: string }} project @param {{ sessionId?: string }} session
   * @returns {Promise<string | null>}
   */
  async originCardOf(project, session) {
    if (typeof session?.sessionId !== "string") return null;
    try {
      await this.ready();
      const { rows } = await this.database.query(
        "SELECT card_id FROM evimed_frontier.evidence_card_origins WHERE user_id=$1 AND project_id=$2 AND session_id=$3",
        [project.userId, project.id, session.sessionId],
      );
      const cardId = rows[0]?.card_id;
      return typeof cardId === "string" && EVIDENCE_CARD_ID.test(cardId) ? cardId : null;
    } catch {
      this.report?.("evidence_origin_unreadable");
      return null;
    }
  }

  /**
   * A run started from a card: recorded once, labelled by whose it is, and — when it is another account's and brings the
   * card's count to a milestone — handed to the citation gift. Never throws.
   * @param {{ userId: string, id: string }} project @param {{ id: string, originCardId?: string }} run
   */
  async runStarted(project, run) {
    if (typeof run?.originCardId !== "string" || !EVIDENCE_CARD_ID.test(run.originCardId)) return;
    try {
      await this.ready();
      const outcome = await this.database.transaction(async (/** @type {any} */ client) => {
        // One card's runs are counted one at a time, so two runs that arrive together cannot both step over a milestone.
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evidence-card-runs:${run.originCardId}`]);
        const card = (await client.query("SELECT user_id FROM evimed_frontier.evidence_cards WHERE id=$1", [run.originCardId])).rows[0];
        if (!card) return null;
        const inserted = await client.query(
          `INSERT INTO evimed_frontier.evidence_card_runs(user_id,project_id,run_id,card_id) VALUES($1,$2,$3,$4)
            ON CONFLICT(user_id,project_id,run_id) DO NOTHING RETURNING run_id`,
          [project.userId, project.id, run.id, run.originCardId],
        );
        if (!inserted.rowCount) return null;
        const by = card.user_id === project.userId ? "author" : "others";
        const count = by === "others"
          ? Number((await client.query("SELECT count(*)::integer AS n FROM evimed_frontier.evidence_card_runs WHERE card_id=$1 AND user_id<>$2",
            [run.originCardId, card.user_id])).rows[0].n)
          : 0;
        return { by, authorId: String(card.user_id), count };
      });
      if (!outcome) return;
      recordCardRun(outcome.by);
      if (outcome.by === "others" && this.cited && EVIDENCE_CITATION_MILESTONES.includes(outcome.count)) {
        await this.cited({ cardId: run.originCardId, authorId: outcome.authorId, count: outcome.count }).catch(() => {});
      }
    } catch {
      this.report?.("evidence_card_run_unrecorded");
    }
  }
}
