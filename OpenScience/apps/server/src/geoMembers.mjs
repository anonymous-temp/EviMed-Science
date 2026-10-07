/**
 * 「循证 GEO」's project members and their roles (flywheel F29, 2026-10-06): the way an enterprise brings colleagues and an outside
 * agency into one project, and the people a product card names as its author and its reviewing doctor.
 *
 * Hidden knowledge:
 *
 * - **A membership list, not an organization model** — the same decision as 虚拟临床研究's study members (`vcrMembers.mjs`). The
 *   platform has accounts and nothing above them; the brand team, the medical affairs reviewer and the agency need to see one
 *   project together, and that is the whole requirement. The owner is the project's account and holds every ability without a row,
 *   so adding a colleague can never lock the owner out of their own project, and the owner's roles cannot be taken away
 *   (`geo_member_owner_fixed`).
 * - **One person, several roles.** The key is project, account and role: the single physician of a small company is its editor and
 *   its reviewing doctor, and collapsing that into the strongest role would grant what neither said. What a person may do is the
 *   union of the roles they hold (`geoAbilitiesOf`, from the domain — no second table here).
 * - **Another account without a membership reads the project as one that does not exist** (`geo_project_not_found`, from the
 *   service's lookup); a member without the ability for an operation is told so, by the ability's name, because they know the
 *   project is there.
 * - **Real named people on every card.** A product-zone card discloses its authors and its reviewers (the card contract refuses it
 *   otherwise). `peopleOf` gives them from the members: the owner and the editors are the authors, the medical reviewers the
 *   reviewers, each named as their account is and, where the member gave it, by hospital, department and specialty. A doctor
 *   project's doctor is the author and the reviewer.
 * - **Nothing else is judged here.** Who may manage members is the caller's lookup (`manage_members`, the owner); this file adds,
 *   removes and lists.
 *
 * @module geoMembers
 */

import { GEO_MEMBER_ROLES, GEO_MEMBER_ROLE_LABELS_ZH, geoAbilitiesOf, geoDisclosurePerson } from "@evimed/domain";
import { HttpError } from "./security.mjs";

/** The refusals this module adds to the service's. */
export const GEO_MEMBER_CODES = Object.freeze({
  roleInvalid: "geo_member_role_invalid",
  userRequired: "geo_member_user_required",
  ownerFixed: "geo_member_owner_fixed",
  detailInvalid: "geo_member_detail_invalid",
});

/** The keys a member's detail may hold: how the person is named on a card, and a note (an agency names itself here). */
const DETAIL_KEYS = Object.freeze(["hospital", "department", "specialty", "title", "organization", "note"]);
const DETAIL_MAX = 120;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * A member's detail, trimmed and bounded; refuses a key it does not know.
 * @param {unknown} value @returns {Record<string, string>}
 */
export function memberDetail(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, GEO_MEMBER_CODES.detailInvalid, "detail is an object.");
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!DETAIL_KEYS.includes(key) || typeof entry !== "string" || [...entry.trim()].length > DETAIL_MAX) {
      throw new HttpError(400, GEO_MEMBER_CODES.detailInvalid, `detail takes only ${DETAIL_KEYS.join(", ")}, each text of at most ${DETAIL_MAX} characters.`);
    }
    if (entry.trim()) out[key] = entry.trim();
  }
  return out;
}

export class GeoMembers {
  /**
   * @param {{ store: import("./geoStore.mjs").GeoStore }} options
   */
  constructor({ store }) {
    if (!store) throw new TypeError("The GEO member service needs its store.");
    this.store = store;
    this.counters = { added: 0, removed: 0 };
  }

  /**
   * Everyone on the project, the owner first and marked as such, each with the roles and what the roles allow.
   * @param {{ id: string, userId: string }} project
   */
  async list(project) {
    const rows = await this.store.memberRows(project.id);
    /** @type {Map<string, { userId: string, owner: boolean, roles: string[], detail: Record<string, any>, invitedBy: string | null, createdAt: string | null }>} */
    const people = new Map();
    people.set(project.userId, { userId: project.userId, owner: true, roles: ["owner"], detail: {}, invitedBy: null, createdAt: null });
    for (const row of rows) {
      const entry = people.get(row.userId) ?? { userId: row.userId, owner: false, roles: [], detail: {}, invitedBy: row.invitedBy, createdAt: row.createdAt };
      if (!entry.roles.includes(row.role)) entry.roles.push(row.role);
      entry.detail = { ...entry.detail, ...row.detail };
      people.set(row.userId, entry);
    }
    const names = await this.store.personNames([...people.keys()]);
    return [...people.values()].map((entry) => ({
      ...entry,
      name: names.get(entry.userId) ?? null,
      roles: [...entry.roles].sort(),
      roleLabels: [...entry.roles].sort().map((role) => /** @type {Record<string, string>} */ (GEO_MEMBER_ROLE_LABELS_ZH)[role] ?? role),
      abilities: geoAbilitiesOf(entry.roles),
    }));
  }

  /**
   * Give an account a role. Idempotent: the same role again changes only the detail that came with it.
   * @param {{ project: { id: string, userId: string }, actorId: string, userId: unknown, role: unknown, detail?: unknown }} request
   */
  async add({ project, actorId, userId, role, detail }) {
    if (typeof userId !== "string" || !ACCOUNT_ID.test(userId)) throw new HttpError(400, GEO_MEMBER_CODES.userRequired, "userId is the member's account.");
    if (typeof role !== "string" || !GEO_MEMBER_ROLES.includes(/** @type {any} */ (role))) {
      throw new HttpError(400, GEO_MEMBER_CODES.roleInvalid, `role is one of: ${GEO_MEMBER_ROLES.join(", ")}.`);
    }
    // The owner's abilities are the project row, not a member row: a second place that has to agree with the first.
    if (userId === project.userId) throw new HttpError(409, GEO_MEMBER_CODES.ownerFixed, "The owner's roles are not a member's and cannot be changed.");
    const member = await this.store.addMember({ geoId: project.id, userId, role, invitedBy: actorId, detail: memberDetail(detail) });
    this.counters.added += 1;
    return { ...member, roleLabel: /** @type {Record<string, string>} */ (GEO_MEMBER_ROLE_LABELS_ZH)[member.role] ?? member.role };
  }

  /**
   * Take roles away from an account: the one named, or every role it holds.
   * @param {{ project: { id: string, userId: string }, userId: string, role?: string | null }} request
   */
  async remove({ project, userId, role = null }) {
    if (!ACCOUNT_ID.test(String(userId))) throw new HttpError(400, GEO_MEMBER_CODES.userRequired, "userId is the member's account.");
    if (userId === project.userId) throw new HttpError(409, GEO_MEMBER_CODES.ownerFixed, "The owner's roles are not a member's and cannot be changed.");
    if (role != null && !GEO_MEMBER_ROLES.includes(/** @type {any} */ (role))) throw new HttpError(400, GEO_MEMBER_CODES.roleInvalid, `role is one of: ${GEO_MEMBER_ROLES.join(", ")}.`);
    const held = (await this.store.memberRows(project.id)).filter((row) => row.userId === userId && (role == null || row.role === role)).map((row) => row.role);
    let removed = 0;
    for (const each of held) if (await this.store.removeMember({ geoId: project.id, userId, role: each })) removed += 1;
    this.counters.removed += removed;
    return { removed };
  }

  /**
   * The people a card of this project discloses: authors and reviewers, named as their accounts are and by the detail the member gave.
   * The owner is an author; the editors too; the medical reviewers are the reviewers. A doctor project's doctor, named by the
   * project's producer settings, is the author and a reviewer.
   * @param {{ id: string, userId: string, producer?: Record<string, any> | null }} project
   * @param {{ ownerName?: string | null }} [options]
   * @returns {Promise<{ authors: { name: string, affiliation?: string, title?: string }[], reviewers: { name: string, affiliation?: string, title?: string }[] }>}
   */
  async peopleOf(project, { ownerName = null } = {}) {
    const rows = await this.store.memberRows(project.id);
    const names = await this.store.personNames([...new Set([project.userId, ...rows.map((row) => row.userId)])]);
    const person = (/** @type {string} */ userId, /** @type {Record<string, any>} */ detail) => {
      const name = (userId === project.userId ? ownerName : null) ?? names.get(userId) ?? null;
      return name ? geoDisclosurePerson({ name, ...detail }) : null;
    };
    const doctor = project.producer?.kind === "doctor" && project.producer?.name ? geoDisclosurePerson({ ...project.producer, name: String(project.producer.name) }) : null;
    /** @type {{ name: string, affiliation?: string, title?: string }[]} */
    const authors = [];
    /** @type {{ name: string, affiliation?: string, title?: string }[]} */
    const reviewers = [];
    const push = (/** @type {typeof authors} */ list, /** @type {{ name: string } | null} */ entry) => { if (entry && !list.some((known) => known.name === entry.name)) list.push(entry); };
    push(authors, doctor ?? person(project.userId, {}));
    if (doctor) push(reviewers, doctor);
    for (const row of rows) {
      if (row.role === "editor") push(authors, person(row.userId, row.detail));
      if (row.role === "medical_reviewer") push(reviewers, person(row.userId, row.detail));
    }
    return { authors, reviewers };
  }

  metrics() {
    return { ...this.counters };
  }
}
