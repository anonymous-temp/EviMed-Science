/**
 * 「虚拟临研」's study members and their roles (build plan 2026-09-28 §11.1
 * conclusion 4, §11.2 layer 2).
 *
 * Hidden knowledge:
 *
 * - **This is a study-level membership list, not an organization model.** The
 *   platform has accounts and nothing above them; the partner's coordinator,
 *   the sponsor's statistician and the site need to see one study together,
 *   and that is the whole requirement. Introducing organizations to serve it
 *   would put a tenancy model in front of every other module, and the plan
 *   explicitly declines that.
 * - **The owner is a `lead` without a row.** The study's `user_id` is the
 *   owner; `members` holds everyone else. A service that read only `members`
 *   would lock the owner out of their own study the moment they invited
 *   anyone, and adding an owner row instead would mean two places to keep in
 *   step (`vcrAccess.mjs` resolves it once, and this file asks it).
 * - **One person, several roles.** The key is `(study, user, role)` because
 *   the single physician at a small site is the coordinator and the clinical
 *   reviewer, and collapsing that into one strongest role silently grants the
 *   other's abilities. `abilitiesOf` is the union of what the held roles
 *   allow, from `roleAllows` in the domain — never a second table here.
 * - **Managing members is itself an ability.** Only `manage_members` (today:
 *   `lead`) may add or remove, and the judge decides that, not this file. A
 *   clinical reviewer who could add a data manager would be a way around every
 *   field-level grant in the module.
 * - **A study never ends up with nobody who can manage it, and that is an
 *   invariant rather than a check.** An earlier draft here refused to remove
 *   "the last holder of `manage_members`". That branch could not run: the
 *   owner is a `lead` by being the owner, so the set of managers always
 *   contains them, and the guard was dead code with a test that could only be
 *   written by faking a study with no owner. The lockout it was written
 *   against is prevented one line up instead — the owner's own roles are not
 *   in `members` and cannot be removed from it (`ownerFixed`).
 *
 * @module vcrMembers
 */

import { VCR_MEMBER_ROLES, VCR_MEMBER_ROLE_LABELS_ZH, VCR_ROLE_ABILITIES, roleAllows } from "@evimed/domain";

import { VcrAccess, VCR_ACCESS_CODES } from "./vcrAccess.mjs";
import { HttpError } from "./security.mjs";

/** Refusals this service adds to the judge's. */
export const VCR_MEMBER_CODES = Object.freeze({
  roleUnknown: "vcr_member_role_unknown",
  selfRequired: "vcr_member_user_required",
  ownerFixed: "vcr_member_owner_fixed",
});

export const VCR_MEMBER_REASONS_ZH = Object.freeze({
  [VCR_MEMBER_CODES.roleUnknown]: "角色不在可选范围内。",
  [VCR_MEMBER_CODES.selfRequired]: "请指定成员账号。",
  [VCR_MEMBER_CODES.ownerFixed]: "研究负责人由研究所有者担任，不能在成员列表中改动。",
});

/** @param {string} code */
function refuse(status, code) {
  return new HttpError(status, code, /** @type {any} */ (VCR_MEMBER_REASONS_ZH)[code] ?? code);
}

/** The ability that lets an account change the member list. */
const MANAGE = "manage_members";

/** Roles that carry `manage_members`, derived from the domain rather than listed again. */
export const VCR_MANAGING_ROLES = Object.freeze(VCR_MEMBER_ROLES.filter((role) => roleAllows(role, MANAGE)));

export class VcrMembers {
  /**
   * @param {{ store: import("./vcrDataStore.mjs").VcrDataStore, access?: VcrAccess, now?: () => Date }} options
   */
  constructor({ store, access = null, now = () => new Date() }) {
    if (!store) throw new TypeError("The VCR member service needs its store.");
    this.store = store;
    this.access = access ?? new VcrAccess({ store, now });
    this.now = now;
  }

  /**
   * Everyone on the study, the owner first and marked as such.
   * @param {{ actor: string, studyId: string }} request
   */
  async list(request) {
    await this.access.require({ actor: request.actor, studyId: request.studyId, ability: "read" });
    const study = await this.store.studyForAccess(request.studyId);
    if (!study) throw refuse(404, VCR_ACCESS_CODES.studyNotFound);
    const rows = await this.store.listMembers(request.studyId);
    /** @type {Map<string, { userId: string, owner: boolean, roles: string[], invitedBy: string | null, createdAt: string | null }>} */
    const people = new Map();
    people.set(study.userId, { userId: study.userId, owner: true, roles: ["lead"], invitedBy: null, createdAt: null });
    for (const row of rows) {
      const entry = people.get(row.userId)
        ?? { userId: row.userId, owner: false, roles: [], invitedBy: row.invitedBy, createdAt: row.createdAt };
      if (!entry.roles.includes(row.role)) entry.roles.push(row.role);
      people.set(row.userId, entry);
    }
    return [...people.values()].map((entry) => ({
      ...entry,
      roles: [...entry.roles].sort(),
      roleLabels: [...entry.roles].sort().map((role) => /** @type {any} */ (VCR_MEMBER_ROLE_LABELS_ZH)[role] ?? role),
      abilities: abilitiesOfRoles(entry.roles),
    }));
  }

  /**
   * Add a role to somebody. Idempotent: adding a role they already hold
   * changes only the note that came with it.
   * @param {{ actor: string, studyId: string, userId: string, role: string,
   *   detail?: Record<string, unknown> }} request
   */
  async add(request) {
    await this.access.require({ actor: request.actor, studyId: request.studyId, ability: MANAGE });
    const userId = String(request.userId ?? "").trim();
    if (!userId) throw refuse(400, VCR_MEMBER_CODES.selfRequired);
    if (!VCR_MEMBER_ROLES.includes(String(request.role))) throw refuse(400, VCR_MEMBER_CODES.roleUnknown);
    const study = await this.store.studyForAccess(request.studyId);
    if (!study) throw refuse(404, VCR_ACCESS_CODES.studyNotFound);
    // The owner's `lead` is the study row, not a member row. Writing one would
    // create a second place that has to agree with the first.
    if (userId === study.userId) throw refuse(409, VCR_MEMBER_CODES.ownerFixed);
    const member = await this.store.addMember({
      studyId: request.studyId, userId, role: String(request.role),
      invitedBy: request.actor, detail: request.detail ?? {}, actor: request.actor,
    });
    return { ...member, roleLabel: /** @type {any} */ (VCR_MEMBER_ROLE_LABELS_ZH)[member.role] ?? member.role };
  }

  /**
   * Take one role away. Only that role: a person who is both the site and the
   * clinical reviewer keeps the other one.
   * @param {{ actor: string, studyId: string, userId: string, role: string }} request
   */
  async remove(request) {
    await this.access.require({ actor: request.actor, studyId: request.studyId, ability: MANAGE });
    const userId = String(request.userId ?? "").trim();
    if (!userId) throw refuse(400, VCR_MEMBER_CODES.selfRequired);
    if (!VCR_MEMBER_ROLES.includes(String(request.role))) throw refuse(400, VCR_MEMBER_CODES.roleUnknown);
    const study = await this.store.studyForAccess(request.studyId);
    if (!study) throw refuse(404, VCR_ACCESS_CODES.studyNotFound);
    // The owner has no member row, so there is nothing here to remove — and
    // refusing by name is what keeps the study from losing its only manager.
    if (userId === study.userId) throw refuse(409, VCR_MEMBER_CODES.ownerFixed);
    return this.store.removeMember({
      studyId: request.studyId, userId, role: String(request.role), actor: request.actor,
    });
  }

  /**
   * What this account may do in this study, whether it is a member or the
   * owner. An account with nothing to do here gets an empty list, never an
   * error — the caller decides what a zero-ability answer means.
   * @param {{ studyId: string, userId: string }} request
   */
  async abilitiesOf(request) {
    const study = await this.store.studyForAccess(request.studyId);
    if (!study) return { roles: [], abilities: [] };
    const memberRoles = await this.store.rolesOf(request.studyId, request.userId);
    const roles = study.userId === request.userId ? [...new Set(["lead", ...memberRoles])].sort() : memberRoles;
    return { roles, abilities: abilitiesOfRoles(roles) };
  }
}

/** The union of what a set of roles allows, sorted. @param {string[]} roles */
export function abilitiesOfRoles(roles) {
  const abilities = new Set();
  for (const role of roles ?? []) {
    for (const ability of /** @type {any} */ (VCR_ROLE_ABILITIES)[role] ?? []) abilities.add(ability);
  }
  return [...abilities].sort();
}
