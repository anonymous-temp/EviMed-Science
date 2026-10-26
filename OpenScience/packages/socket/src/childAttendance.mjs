/**
 * Which child sessions run with nobody attending, inherited from the trusted turn that started them, even if their parent
 * later moves on to an attended turn (run-policy's ask-user and task-tool guard).
 *
 * A child is recorded when it starts and released when it settles — the kernel's `subagent/end`, which every child of either
 * tool passes exactly once — or when its delegation is collected or abandoned. Before 2026-10-25 nothing released it, so a warm
 * runtime (twelve hours, up to thirty children a run) kept one entry per child it ever ran, and a child whose parent id was
 * empty made a session state for the id '' (review F9).
 */
export class ChildAttendance {
  constructor() {
    /** @type {Map<string, boolean>} */
    this.children = new Map()
  }

  /** A child a delegation of a run started: it takes that run's attendance. @param {string} childId @param {boolean} unattended */
  bind(childId, unattended) {
    if (childId) this.children.set(childId, unattended === true)
  }

  /**
   * A child the kernel's own `subagent` started: it takes its parent's — an inherited mark first, then the parent's own state,
   * read and never created. A child with no parent id records nothing.
   * @param {string} childId @param {string} parentId @param {(parentId: string) => boolean} parentUnattended
   */
  inherit(childId, parentId, parentUnattended) {
    if (!childId || !parentId) return
    this.children.set(childId, this.children.get(parentId) ?? parentUnattended(parentId) === true)
  }

  /** @param {string} childId @returns {boolean | undefined} */
  get(childId) {
    return this.children.get(childId)
  }

  /** @param {string} childId */
  release(childId) {
    this.children.delete(childId)
  }

  get size() {
    return this.children.size
  }
}
