/**
 * The wire split's invariants, as one implementation.
 *
 * Why this file exists at all: the same assertion used to live twice, once in
 * `packages/harness-port/test/port.test.mjs` and once in this package's
 * contract test, and both copies asserted a hand-maintained total — "the
 * harness publishes 52 unary methods; the split must account for all of them".
 * 0.1.2 deleted the ApiProxy interface outright, so that number lost its
 * subject: there is no single published surface to be complete against, because
 * what a kernel exposes now follows the composition it was started with. The
 * port's copy was rewritten on 2026-09-01; this one was not, and stayed red
 * restating a count of a surface that no longer exists.
 *
 * What the count was really protecting also changed shape. It guarded against a
 * method existing that we neither allow nor deny, back when a browser could
 * reach the kernel through a pass-through proxy. That route is retired;
 * `isAllowedWireMethod` governs only the control plane's own calls, so an
 * unlisted method is not a hole — it is unreachable. Restating the number as
 * 50 would read as coverage while measuring nothing.
 *
 * So the invariants below are the ones that still have a subject on the 0.1.2
 * wire, and they live in one file so a third copy cannot drift a third time.
 * The port's test can adopt them with a relative import; no package.json edit
 * is needed for that, only the import.
 *
 * @module @evimed/contracts/dsh/wireSplit
 */

/** A 0.1.2 endpoint name: exactly two slash-separated segments. */
const ENDPOINT_NAME = /^[a-zA-Z][a-zA-Z0-9]*\/[a-zA-Z][a-zA-Z0-9]*$/;

/**
 * Namespaces the control plane may never call into, whatever the method.
 *
 * These are namespace bans, not whole-surface bans: `session/`, `subagents/`
 * and `agentPresets/` are split down the middle (`session/list` is allowed,
 * `session/rename` is denied), so they are checked method by method by the
 * allow-list itself rather than by prefix.
 *
 * The previous version of this list was written against 0.1.1's dotted names
 * (`/^(settings|credentials|workspace|goal|llm)\./`) and was never updated when
 * 0.1.2 renamed every method to a slash. It therefore matched nothing at all
 * for the whole life of the pin — a check that passes because it can never
 * fire. `bannedNamespacesAreReal` below exists so that cannot happen silently
 * again: every namespace named here must actually appear in `wire.denied`.
 */
const CONTROL_PLANE_BANNED_NAMESPACES = Object.freeze([
  "settings",
  "credentials",
  "workspace",
  "goals",
  "llm",
  "agentTeams",
  "directoryPicker",
  "messageFeedback",
  "sessionReferenceResolver",
]);

/** @param {string} method @returns {string} */
function namespaceOf(method) {
  return String(method).split("/")[0];
}

/**
 * Every way the split can be wrong, as a list of issue strings. Empty means the
 * split is well-formed. A list rather than a throw so a caller can report all
 * of them at once — an upgrade PR should start from the full set of moved
 * seams, not from the first one.
 *
 * @param {any} seams the seam manifest (`SEAMS` from `@evimed/harness-port`)
 * @returns {string[]}
 */
export function wireSplitIssues(seams) {
  /** @type {string[]} */
  const issues = [];
  const unary = Array.isArray(seams?.wire?.unary) ? seams.wire.unary : [];
  const denied = Array.isArray(seams?.wire?.denied) ? seams.wire.denied : [];
  const all = [...unary, ...denied];

  // A method is allowed and denied at once, or listed twice in one half.
  const seen = new Set();
  for (const method of all) {
    if (seen.has(method)) issues.push(`${method} is listed twice across the split`);
    seen.add(method);
  }

  // Neither half may be empty: an empty allow-list would refuse every call the
  // control plane makes, and an empty deny-list is what a lost manifest looks
  // like.
  if (unary.length === 0) issues.push("the allowed half of the split is empty");
  if (denied.length === 0) issues.push("the denied half of the split is empty");

  for (const method of seen) {
    if (!ENDPOINT_NAME.test(String(method))) issues.push(`${method} is not a 0.1.2 endpoint name`);
    if (String(method).includes(".")) issues.push(`${method} is 0.1.1's dotted name; 0.1.2 renamed every method to a slash`);
  }

  const deniedNamespaces = new Set(denied.map(namespaceOf));
  for (const banned of CONTROL_PLANE_BANNED_NAMESPACES) {
    // Non-vacuity. Without this, a rename makes the ban below stop matching and
    // the check keeps passing while guarding nothing.
    if (!deniedNamespaces.has(banned)) {
      issues.push(`the ${banned}/ namespace is named as banned but no denied method is in it — the ban no longer matches anything`);
    }
  }
  for (const method of unary) {
    if (CONTROL_PLANE_BANNED_NAMESPACES.includes(namespaceOf(method))) {
      issues.push(`${method} must not be reachable from the control plane`);
    }
  }

  // The two seams that decide whether a run can rewrite its own deployment.
  for (const method of ["settings/update", "credentials/set"]) {
    if (!denied.includes(method)) issues.push(`${method} fell out of the denied half`);
  }

  // Every allowed method declares the argument names its descriptor carries.
  // 0.1.2 moved arguments into a named descriptor, so a call with the right
  // method and the wrong argument name is refused at the gateway boundary; the
  // manifest is where that name is written down.
  const declared = Object.keys(seams?.wire?.unaryArgs ?? {});
  for (const method of unary) {
    if (!declared.includes(method)) issues.push(`${method} is allowed but declares no unaryArgs entry`);
  }
  for (const method of declared) {
    if (!unary.includes(method)) issues.push(`unaryArgs declares ${method}, which is not in the allowed half`);
  }

  return issues;
}

export { CONTROL_PLANE_BANNED_NAMESPACES };
