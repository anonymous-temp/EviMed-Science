/**
 * 「虚拟临床研究」's per-operation access judgment: study × role × source × field ×
 * window × purpose, decided in code, recorded every time (build plan
 * 2026-09-28 §8.1, §11.2 layer 2; platform principle 14; AC-06, AC-17, AC-22).
 *
 * Hidden knowledge:
 *
 * - **Default deny, and the deny is named.** Every refusal carries a code from
 *   `VCR_ACCESS_CODES` and a sentence the page can show. A silent `false` is
 *   the failure mode this replaces: the data manager who cannot see a column
 *   and cannot find out why exports the column again under another name, and
 *   the control is gone.
 * - **Another account's study reads exactly like one that never existed.**
 *   Both answer `vcr_study_not_found`, and the judge never reveals that the
 *   study is real but forbidden — that difference is an enumeration oracle
 *   (AC-17, GEO's rule). The same holds for a source outside the caller's
 *   studies. Inside a study the caller can already see, a missing grant is
 *   told plainly (`vcr_no_grant`): hiding it there buys nothing and costs the
 *   coordinator an afternoon.
 * - **A member holds roles, plural, and the owner is a `lead` by being the
 *   owner.** The study row's `user_id` never appears in `members`, so a judge
 *   that read only `members` would lock the owner out of their own study on
 *   the first call.
 * - **Sealed beats everything.** A sealed field is refused to the study lead,
 *   to the engine, and to the run, with no inference and no imputation
 *   offered in its place (AC-06, AC-22, AC-32). "Restricted during the trial"
 *   is not a missing value to fill; it is a value that does not exist for us.
 * - **A direct identifier is never released into a study.** Names, contact
 *   details and record numbers stay with the partner or in an identity table;
 *   a study works on a per-study pseudonym (plan §8.1). So a field the
 *   snapshot's field map marks `identifier` is refused even under a grant that
 *   names it — the grant is about which clinical columns may be read, not
 *   about who the people are.
 * - **Access is judged at `now`. `asOf` only selects rows.** A replay dated in
 *   the past is judged against the grant, the window and the seal as they are
 *   today: a revoked grant does not become live again by asking about last
 *   month, and a seal that stood then is not a seal that stands now. Judging on
 *   the caller's date was the hole (review CS-39) — an `asOf` before a grant's
 *   window closed opened a read the window forbids, and an `asOf` before the plan
 *   froze read sealed outcomes. What a past date does change is which rows are
 *   visible (`rowsVisibleAsOf` in `vcrDataPlane.mjs`), the other half of AC-15;
 *   the decision echoes it as `asOf` so the ledger says what was asked about.
 * - **A source is the study's or it does not exist.** A source of another
 *   account, of another study, or attached to no study answers 404 whatever the
 *   caller holds in this study (CS-49): telling a member "you have no grant" on
 *   somebody else's source tells them the source exists.
 * - **The seal is judged from the study, not only from the snapshot.** A snapshot
 *   frozen while the study was exploratory carries no seal; when the study's use
 *   is raised to a confirmatory one its outcome columns are sealed at once, by
 *   `vcrEffectiveSeal`, with no one having to remember to seal them.
 * - **One audit row per judgment, allowed or refused.** The question a
 *   sponsor's computerized-system validation asks is 「当时谁读了什么」, and a
 *   ledger that records only the refusals answers a different question.
 *
 * @module vcrAccess
 */

import { VCR_MEMBER_ROLES, VCR_ROLE_ABILITIES, roleAllows } from "@evimed/domain";

import { HttpError } from "./security.mjs";
import { vcrEffectiveSeal, vcrOutcomeColumns } from "./vcrSeal.mjs";

/** Every refusal this judge can return, by name. */
export const VCR_ACCESS_CODES = Object.freeze({
  ok: "ok",
  noActor: "vcr_access_no_actor",
  studyNotFound: "vcr_study_not_found",
  roleForbids: "vcr_role_forbids",
  sourceNotFound: "vcr_source_not_found",
  sourceWithdrawn: "vcr_source_withdrawn",
  noGrant: "vcr_no_grant",
  purposeNotGranted: "vcr_purpose_not_granted",
  outsideWindow: "vcr_outside_window",
  fieldNotGranted: "vcr_field_not_granted",
  fieldSealed: "vcr_field_sealed",
  fieldIdentifying: "vcr_field_identifying",
  snapshotNotFound: "vcr_snapshot_not_found",
});

/** The refusals that must read as 「不存在」 — a 404 that tells the caller nothing else. */
export const VCR_NOT_FOUND_CODES = /** @type {readonly string[]} */ (Object.freeze([
  VCR_ACCESS_CODES.studyNotFound, VCR_ACCESS_CODES.sourceNotFound, VCR_ACCESS_CODES.snapshotNotFound,
]));

/** What each refusal says on the page. Baseline language is Simplified Chinese. */
export const VCR_ACCESS_REASONS_ZH = Object.freeze({
  [VCR_ACCESS_CODES.ok]: "允许",
  [VCR_ACCESS_CODES.noActor]: "未登录。",
  [VCR_ACCESS_CODES.studyNotFound]: "研究不存在。",
  [VCR_ACCESS_CODES.roleForbids]: "当前角色没有这项操作的权限。",
  [VCR_ACCESS_CODES.sourceNotFound]: "数据源不存在。",
  [VCR_ACCESS_CODES.sourceWithdrawn]: "数据源已撤回，不能再读取。",
  [VCR_ACCESS_CODES.noGrant]: "这个数据源没有对你的授权。",
  [VCR_ACCESS_CODES.purposeNotGranted]: "这次用途不在数据源允许的用途内。",
  [VCR_ACCESS_CODES.outsideWindow]: "请求时间不在授权的可见时间窗内。",
  [VCR_ACCESS_CODES.fieldNotGranted]: "这个字段不在授权范围内。",
  [VCR_ACCESS_CODES.fieldSealed]: "这个字段处于封存状态，不可读取，也不做推断或填补。",
  [VCR_ACCESS_CODES.fieldIdentifying]: "这是直接标识字段，研究中只使用按研究派生的假名编号。",
  [VCR_ACCESS_CODES.snapshotNotFound]: "数据快照不存在。",
});

/** Every ability any role has. A request naming something outside this is a programming error. */
export const VCR_ABILITIES = Object.freeze([...new Set(Object.values(VCR_ROLE_ABILITIES).flat())].sort());

/**
 * How a grant names who it is for. A user id, or one of these two forms, so a
 * partner can授权 "every coordinator on this study" without listing people who
 * have not joined yet.
 */
export const VCR_GRANTEE_PREFIXES = Object.freeze(["role:", "study:"]);

/** @param {unknown} value */
const stamp = (value) => {
  if (value == null) return null;
  const parsed = Date.parse(typeof value === "string" ? value : new Date(/** @type {any} */ (value)).toISOString());
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * @typedef {{
 *   allowed: boolean, code: string, reason: string, ability: string, roles: string[],
 *   studyId: string | null, sourceId: string | null, snapshotId: string | null,
 *   asOf: string, purpose: string | null, grantId: string | null,
 *   fields: { allowed: string[], denied: { field: string, code: string, reason: string }[] },
 * }} VcrAccessDecision
 */

export class VcrAccess {
  /**
   * @param {{ store: import("./vcrDataStore.mjs").VcrDataStore, now?: () => Date,
   *   audit?: boolean }} options
   */
  constructor({ store, now = () => new Date(), audit = true }) {
    if (!store) throw new TypeError("The VCR access judge needs its store.");
    this.store = store;
    this.now = now;
    this.auditEnabled = audit !== false;
  }

  /**
   * Judge one operation. Never throws for a refusal — a refusal is the return
   * value, carrying what would have to change (principle 3).
   *
   * @param {{ actor: string, studyId: string, ability: string, sourceId?: string | null,
   *   snapshotId?: string | null, fields?: string[], asOf?: string | Date | null,
   *   purpose?: string | null, note?: string }} request
   * @returns {Promise<VcrAccessDecision>}
   */
  async judge(request) {
    const ability = String(request?.ability ?? "").trim();
    if (!VCR_ABILITIES.includes(ability)) {
      throw new TypeError(`A VCR ability is one of ${VCR_ABILITIES.join(", ")}, got ${JSON.stringify(request?.ability)}`);
    }
    // Judged at `now`; the caller's `asOf` is echoed and selects rows elsewhere.
    const judgedAt = this.now().getTime();
    const asked = request?.asOf ? stamp(request.asOf) : null;
    const asOf = new Date(asked ?? judgedAt).toISOString();
    const fields = [...new Set((request?.fields ?? []).map((field) => String(field)))].sort();
    /** @type {VcrAccessDecision} */
    const base = {
      allowed: false, code: VCR_ACCESS_CODES.studyNotFound, reason: "", ability, roles: [],
      studyId: request?.studyId ?? null, sourceId: request?.sourceId ?? null, snapshotId: request?.snapshotId ?? null,
      asOf, purpose: request?.purpose ?? null, grantId: null,
      fields: { allowed: [], denied: [] },
    };
    /** @param {Partial<VcrAccessDecision>} patch */
    const decide = (patch) => {
      const decision = { ...base, ...patch };
      decision.reason = decision.reason || /** @type {any} */ (VCR_ACCESS_REASONS_ZH)[decision.code] || "";
      return decision;
    };

    const actor = String(request?.actor ?? "").trim();
    if (!actor) return this.#record(decide({ code: VCR_ACCESS_CODES.noActor }), request);

    // 1. The study, and whether this account is in it at all.
    const study = request?.studyId ? await this.store.studyForAccess(String(request.studyId)) : null;
    if (!study) return this.#record(decide({ code: VCR_ACCESS_CODES.studyNotFound }), request);
    const memberRoles = await this.store.rolesOf(study.id, actor);
    const roles = study.userId === actor ? [...new Set(["lead", ...memberRoles])].sort() : memberRoles;
    if (!roles.length) return this.#record(decide({ code: VCR_ACCESS_CODES.studyNotFound }), request);

    // 2. The ability, from the roles actually held.
    if (!roles.some((role) => roleAllows(role, ability))) {
      return this.#record(decide({ code: VCR_ACCESS_CODES.roleForbids, roles }), request);
    }
    if (!request?.sourceId && !request?.snapshotId) {
      return this.#record(decide({ allowed: true, code: VCR_ACCESS_CODES.ok, roles }), request);
    }

    // 3. Resolve the snapshot first when one was named: the seal lives there.
    let snapshot = null;
    let sourceId = request?.sourceId ? String(request.sourceId) : null;
    if (request?.snapshotId) {
      snapshot = await this.store.getSnapshot(String(request.snapshotId));
      if (!snapshot) return this.#record(decide({ code: VCR_ACCESS_CODES.snapshotNotFound, roles }), request);
      if (sourceId && snapshot.sourceId !== sourceId) {
        return this.#record(decide({ code: VCR_ACCESS_CODES.snapshotNotFound, roles }), request);
      }
      sourceId = snapshot.sourceId;
      // A snapshot attached to another study is that study's; from here it
      // does not exist, the same way the study itself would not. So is one
      // attached to none: every snapshot the routes make belongs to a study.
      if (snapshot.studyId !== study.id) {
        return this.#record(decide({ code: VCR_ACCESS_CODES.snapshotNotFound, roles }), request);
      }
    }

    // 4. The source.
    const source = sourceId ? await this.store.sourceFor(sourceId) : null;
    if (!source) return this.#record(decide({ code: VCR_ACCESS_CODES.sourceNotFound, roles, sourceId }), request);
    const ownsSource = source.userId === actor;
    // The study's own source, or a source of the caller's own that is attached
    // to no study. Anything else — another account's, or another study's — does
    // not exist from here, whatever role the caller holds (CS-49).
    const inThisStudy = source.studyId === study.id || (!source.studyId && ownsSource);
    if (!inThisStudy) {
      return this.#record(decide({ code: VCR_ACCESS_CODES.sourceNotFound, roles, sourceId }), request);
    }
    if (source.status === "withdrawn") {
      return this.#record(decide({ code: VCR_ACCESS_CODES.sourceWithdrawn, roles, sourceId }), request);
    }

    // 5. The grant. The source's own account needs none; everybody else does,
    //    and "no grant" is the default answer (principle 14).
    /** @type {any} */
    let grant = null;
    if (!ownsSource) {
      const live = await this.store.liveGrants({ sourceId: source.id, studyId: study.id });
      const candidates = live.filter((/** @type {any} */ entry) => granteeMatches(entry.grantee, actor, study.id, roles));
      if (!candidates.length) {
        return this.#record(decide({ code: VCR_ACCESS_CODES.noGrant, roles, sourceId }), request);
      }
      // A grant naming a role only counts when the ability comes from that role.
      const usable = candidates.filter((/** @type {any} */ entry) => !entry.role || roleAllows(entry.role, ability));
      if (!usable.length) {
        return this.#record(decide({ code: VCR_ACCESS_CODES.roleForbids, roles, sourceId }), request);
      }
      // Widest window first, so a study with an old narrow grant and a new
      // wide one is judged on the one that actually authorises the read.
      grant = usable.sort((a, b) => windowWidth(b) - windowWidth(a))[0];
    }

    // 6. Purpose. The source's declared uses bind everyone including its owner
    //    — that is the registration the partner signed, not an access control.
    const purpose = request?.purpose ? String(request.purpose) : null;
    if (purpose) {
      if (source.allowedUses.length && !source.allowedUses.includes(purpose)) {
        return this.#record(decide({ code: VCR_ACCESS_CODES.purposeNotGranted, roles, sourceId, grantId: grant?.id ?? null }), request);
      }
      if (grant?.purposes?.length && !grant.purposes.includes(purpose)) {
        return this.#record(decide({ code: VCR_ACCESS_CODES.purposeNotGranted, roles, sourceId, grantId: grant.id }), request);
      }
    }

    // 7. The window: the grant's, then the source's registered visible window.
    const windows = [
      { start: stamp(grant?.windowStart), end: stamp(grant?.windowEnd) },
      { start: stamp(source.visibleWindow?.start), end: stamp(source.visibleWindow?.end) },
    ];
    for (const window of windows) {
      if (window.start != null && judgedAt < window.start) {
        return this.#record(decide({ code: VCR_ACCESS_CODES.outsideWindow, roles, sourceId, grantId: grant?.id ?? null }), request);
      }
      if (window.end != null && judgedAt > window.end) {
        return this.#record(decide({ code: VCR_ACCESS_CODES.outsideWindow, roles, sourceId, grantId: grant?.id ?? null }), request);
      }
    }

    // 8. The fields, one at a time. A refused field never refuses the others:
    //    one failed operation does not stop the conversation (principle 14).
    /** @type {{ field: string, code: string, reason: string }[]} */
    const denied = [];
    const allowedFields = [];
    if (fields.length) {
      // The seal, from the study as it stands and the snapshot's outcome columns.
      const fieldMaps = snapshot ? await this.store.listFieldMaps(snapshot.id) : [];
      const { sealed } = vcrEffectiveSeal({ study, snapshot, outcomeColumns: vcrOutcomeColumns(fieldMaps), now: judgedAt });
      const sealActive = sealed.size > 0;
      const identifiers = new Set(
        fieldMaps.filter((/** @type {any} */ map) => map.identifier === true).map((/** @type {any} */ map) => map.columnName));
      for (const field of fields) {
        if (sealActive && sealed.has(field)) {
          denied.push({ field, code: VCR_ACCESS_CODES.fieldSealed, reason: VCR_ACCESS_REASONS_ZH[VCR_ACCESS_CODES.fieldSealed] });
          continue;
        }
        if (identifiers.has(field)) {
          denied.push({ field, code: VCR_ACCESS_CODES.fieldIdentifying, reason: VCR_ACCESS_REASONS_ZH[VCR_ACCESS_CODES.fieldIdentifying] });
          continue;
        }
        if (grant && !grantAllowsField(grant, field)) {
          denied.push({ field, code: VCR_ACCESS_CODES.fieldNotGranted, reason: VCR_ACCESS_REASONS_ZH[VCR_ACCESS_CODES.fieldNotGranted] });
          continue;
        }
        allowedFields.push(field);
      }
    }
    // Asking for fields and being refused every one of them is a refusal, not
    // an empty success: a caller that reads `allowed` alone must not proceed.
    if (fields.length && !allowedFields.length) {
      return this.#record(decide({
        code: denied[0]?.code ?? VCR_ACCESS_CODES.fieldNotGranted, roles, sourceId,
        grantId: grant?.id ?? null, fields: { allowed: [], denied },
      }), request);
    }

    return this.#record(decide({
      allowed: true, code: VCR_ACCESS_CODES.ok, roles, sourceId,
      grantId: grant?.id ?? null, fields: { allowed: allowedFields, denied },
    }), request);
  }

  /**
   * Judge, and throw the HTTP refusal when the answer is no. `404` for
   * anything that must read as 「不存在」, `403` for everything else.
   * @param {Parameters<VcrAccess["judge"]>[0]} request
   */
  async require(request) {
    const decision = await this.judge(request);
    if (!decision.allowed) throw vcrAccessError(decision);
    return decision;
  }

  /**
   * Record the judgment. Allowed reads are recorded too: the ledger has to
   * answer 「当时谁读了什么」, not only 「谁被拦下过」.
   * @param {VcrAccessDecision} decision
   * @param {any} request
   */
  async #record(decision, request) {
    if (!this.auditEnabled) return decision;
    try {
      await this.store.audit({
        studyId: decision.studyId, userId: request?.actor ?? null, actor: request?.actor ?? "",
        action: `access.${decision.ability}`,
        object: decision.snapshotId ?? decision.sourceId ?? decision.studyId ?? "",
        outcome: decision.allowed ? "ok" : "denied",
        reason: decision.allowed ? "" : decision.code,
        detail: {
          roles: decision.roles, purpose: decision.purpose, asOf: decision.asOf, grantId: decision.grantId,
          fields: decision.fields.allowed, denied: decision.fields.denied,
          ...(request?.note ? { note: String(request.note) } : {}),
        },
      });
    } catch {
      // The judgment stands whether or not the ledger could be written; an
      // audit failure that silently turned a read into a refusal would be a
      // worse failure than the one it reported (principle 19).
    }
    return decision;
  }
}

/** @param {VcrAccessDecision} decision */
export function vcrAccessError(decision) {
  const status = VCR_NOT_FOUND_CODES.includes(decision.code) ? 404 : 403;
  const error = new HttpError(status, decision.code, decision.reason || decision.code);
  /** @type {any} */ (error).vcrDetail = {
    ability: decision.ability, roles: decision.roles, fields: decision.fields,
    ...(decision.grantId ? { grantId: decision.grantId } : {}),
  };
  return error;
}

/**
 * Does this grant name this caller? A user id, `role:<role>` for anyone
 * holding that role in the study, or `study:<id>` for any member of it.
 * @param {string} grantee @param {string} actor @param {string} studyId @param {string[]} roles
 */
export function granteeMatches(grantee, actor, studyId, roles) {
  const name = String(grantee ?? "").trim();
  if (!name) return false;
  if (name === actor) return true;
  if (name.startsWith("role:")) {
    const role = name.slice("role:".length);
    return VCR_MEMBER_ROLES.includes(role) && roles.includes(role);
  }
  if (name.startsWith("study:")) return name.slice("study:".length) === studyId;
  return false;
}

/**
 * An `allow` grant with no field list is source-wide — that is what a grant
 * written without one means, and the DDL's default is the empty list. Sealed
 * and identifying fields are refused before this is ever asked.
 * @param {{ fields: string[], fieldMode: string }} grant @param {string} field
 */
export function grantAllowsField(grant, field) {
  const list = grant?.fields ?? [];
  if (grant?.fieldMode === "deny") return !list.includes(field);
  return list.length === 0 || list.includes(field);
}

/** How wide a grant's window is, for picking the one that authorises a read. @param {any} grant */
function windowWidth(grant) {
  const start = stamp(grant?.windowStart) ?? Number.NEGATIVE_INFINITY;
  const end = stamp(grant?.windowEnd) ?? Number.POSITIVE_INFINITY;
  const width = end - start;
  return Number.isFinite(width) ? width : Number.MAX_SAFE_INTEGER;
}
