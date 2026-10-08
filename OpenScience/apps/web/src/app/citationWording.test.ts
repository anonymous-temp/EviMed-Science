// @vitest-environment node
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shellSources, sourceStrings } from "@/test/sourceStrings";

/**
 * A quotation found in its preserved source is “引文已核对”, a quotation that was
 * not is “未核对上” (design reference appendix B, E-12): one word for one check,
 * on the evidence card's header, the ✓ and ⚠ a screen reader names, the
 * publishing dialog, the matrix and the popover. 「核验」 was the delivery
 * gate's word for another check and had spread over this one, so a reader met
 * two words for the same ✓. This holds the shell to the one word.
 *
 * The exception is the card nature “复算核验” (a recalculation: the numbers were
 * computed again, which is not a quotation check), which the domain writes and
 * the shell only shows. The task page's template prompt and stage names are
 * converted by the package that owns that page.
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Files another work package still owns; empty this when it has converted its words. */
const PENDING = new Set(["components/autopilot/taskPresentation.ts"]);

const sources = shellSources(SRC);
const OLD = /核验/;
const NATURE = "复算核验";

describe("one word for the citation check", () => {
  it("walked the shell, and would see 核验 in a string but not a card's nature", () => {
    expect(sources.length).toBeGreaterThan(150);
    const own = sourceStrings(join(SRC, "app/citationWording.test.ts")).map(({ text }) => text);
    expect(own).toContain(NATURE);
  });

  it("says 核对, not 核验, in everything the shell can render — except a recalculation's name", () => {
    const found = sources
      .filter((path) => !PENDING.has(relative(SRC, path)))
      .flatMap((path) => sourceStrings(path)
        .filter(({ text }) => OLD.test(text.split(NATURE).join("")))
        .map(({ line, text }) => `${relative(SRC, path)}:${line}  ${text.trim().slice(0, 60)}`));
    expect(found).toEqual([]);
  });

  it("names only files that still exist", () => {
    const present = new Set(sources.map((path) => relative(SRC, path)));
    expect([...PENDING].filter((path) => !present.has(path))).toEqual([]);
  });
});
