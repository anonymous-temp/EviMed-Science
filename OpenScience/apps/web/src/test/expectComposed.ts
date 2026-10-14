import { expect } from "vitest";
import { compositionFacts, precedes, type CompositionFacts } from "./compositionFixtures";

/**
 * The assertions every page of the framework answers to, in one call — what a page package states for its real page, after
 * rendering it: `expectComposed(container)`.
 *
 *  - it has a header and a body, and the header comes first;
 *  - **the page-level toolbar comes before the body** and is not in it, and no toolbar stands under the content it controls;
 *  - it has at most one row of views (`tablists`: pass the exact number for a page that must have one);
 *  - its header holds at most one primary action;
 *  - **a step rail, where there is one, is in the sticky band**;
 *  - no tag is a control or sits in one.
 *
 * A module's rail on every tab is stated by rendering each tab: `for (const tab of tabs) expectComposed(…, { stepRail: true })`
 * and comparing the rails' steps (see `pageComposition.test.tsx`). Returns the facts for any assertion of the page's own.
 */
export function expectComposed(
  root: ParentNode,
  expected: {
    tablists?: number;
    stepRail?: boolean;
    toolbar?: boolean;
    /** How many tags a page is **known** to wear as controls — a baseline that may only fall, never a licence; absent means none. */
    clickableTags?: number;
  } = {},
): CompositionFacts {
  const facts = compositionFacts(root);
  expect(facts.header, "the page has a header").not.toBeNull();
  expect(facts.body, "the page has a body").not.toBeNull();
  expect(precedes(facts.header!, facts.body!), "the header comes before the body").toBe(true);
  for (const toolbar of facts.toolbars) {
    if (facts.body!.contains(toolbar)) continue;
    expect(precedes(toolbar, facts.body!), "a page-level toolbar comes before the body").toBe(true);
  }
  expect(facts.controlsBelowContent, "no toolbar stands under the content it controls").toEqual([]);
  if (expected.toolbar !== undefined) expect(facts.toolbars.some((toolbar) => !facts.body!.contains(toolbar)), "a page-level toolbar").toBe(expected.toolbar);
  if (expected.tablists === undefined) expect(facts.tablists.length, "at most one row of views").toBeLessThanOrEqual(1);
  else expect(facts.tablists, "the rows of views").toHaveLength(expected.tablists);
  expect(facts.headerPrimaryActions.length, "at most one primary action in the header").toBeLessThanOrEqual(1);
  if (expected.stepRail !== undefined) expect(facts.stepRails.length > 0, "a step rail").toBe(expected.stepRail);
  for (const rail of facts.stepRails) expect(facts.chrome?.contains(rail), "the step rail is in the sticky band").toBe(true);
  if (expected.clickableTags === undefined) expect(facts.clickableTags, "no tag is a control").toEqual([]);
  else expect(facts.clickableTags.length, "no more tags are controls than the baseline says").toBeLessThanOrEqual(expected.clickableTags);
  return facts;
}
