/**
 * Capsules a test needs that production never makes with a single call.
 *
 * Production makes a person's own capsule one way: `CapsuleService.ownCapsule(userId, { create: true })`, one fixed id per account,
 * in force at once. A test that needs the person's own capsule makes it that way. These two are for the capsules that one never
 * is: a hand-made source capsule that a case fills with entries of its own (several to an account, which the one fixed capsule
 * cannot give), and a received pack as an import leaves it, without the archive it came in.
 */
import { randomUUID } from "node:crypto";

/**
 * A capsule of the account's own that is not the account's one capsule: its own id, its own entries, never put in force.
 * @param {{ documents: any }} service @param {string} userId @param {{ title?: string, description?: string }} [input]
 */
export function makeCapsule(service, userId, { title = "Test capsule", description = "" } = {}) {
  return service.documents.put(userId, "capsule", randomUUID(), { title, description, activationMode: "own", imported: false }, { expectedRevision: 0 });
}

/**
 * A pack someone else shared, as an import leaves it. Not in force: enabling it is what the case is about.
 * @param {{ documents: any }} service @param {string} userId @param {Record<string, any>} [payload]
 */
export function makePack(service, userId, { id = `pack-${randomUUID()}`, title = "Colleague's pack", ...payload } = {}) {
  return service.documents.put(userId, "capsule", id, { title, description: "", activationMode: "guest", imported: true, ...payload }, { expectedRevision: 0 });
}
