import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { compositionFacts, PAGES } from "@/test/compositionFixtures";

/**
 * The page table the release walk reads (`scripts/ops/page-templates.json`, R19) and the samples of the framework's six templates agree.
 *
 * The walk holds every real page to what its template allows — a module page has its step rail and a band, a settings page has neither a tab
 * list nor a toolbar, a reading page has contents from six windows — and `pageComposition.test.tsx` draws one sample of each template. If
 * the table said one thing and the sample did another, the walk would fail pages for a rule the framework itself does not keep. The router's
 * coverage of the table (every route has a template, every template-bearing route exists) is `apps/server/test/uiWalkBaseline.test.mjs`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const table = JSON.parse(readFileSync(join(here, "../../../../scripts/ops/page-templates.json"), "utf8")) as {
  templates: Record<string, { name: string; tablist: string; toolbar: string; stepRail: string; outline: string; longViewports: number }>;
  views: Array<{ view: string; template: string; module?: string; band?: string }>;
};

describe("the page table's templates", () => {
  it("are the six the framework has a sample page for, with the states of a screen and the kernel's own frame beside them", () => {
    expect(PAGES.map((sample) => sample.id)).toEqual(["T1", "T2", "T3", "T4", "T5", "T6"]);
    expect(Object.keys(table.templates).filter((id) => /^T\d$/.test(id))).toEqual(PAGES.map((sample) => sample.id));
    expect(Object.keys(table.templates).filter((id) => !/^T\d$/.test(id))).toEqual(["screen", "kernel"]);
  });

  it.each(PAGES)("$id: the sample page keeps the slots the table gives its template", (sample) => {
    const rule = table.templates[sample.id];
    const { container } = render(sample.element());
    const facts = compositionFacts(container);
    // `none` is none, `allowed` is at most one, `every-tab` is one: a page has one row of each.
    const count = { tablist: facts.tablists.length, toolbar: facts.toolbars.length, stepRail: facts.stepRails.length };
    for (const slot of ["tablist", "toolbar", "stepRail"] as const) {
      const wanted = rule[slot];
      if (wanted === "none") expect(count[slot], `${sample.id} ${slot}`).toBe(0);
      else if (wanted === "every-tab") expect(count[slot], `${sample.id} ${slot}`).toBe(1);
      else expect(count[slot], `${sample.id} ${slot}`).toBeLessThanOrEqual(1);
    }
  });

  it("give a module page the template that has a step rail on every tab, and nothing else", () => {
    const withRail = Object.entries(table.templates).filter(([, rule]) => rule.stepRail === "every-tab").map(([id]) => id);
    expect(withRail).toEqual(["T3"]);
    // A module's tabs, and a record read inside the module's band (`band`: one 循证 GEO answer, under 问题与回答).
    for (const view of table.views.filter((entry) => entry.module || entry.band)) expect(view.template, view.view).toBe("T3");
    for (const view of table.views.filter((entry) => !entry.module && !entry.band)) expect(view.template, view.view).not.toBe("T3");
  });

  it("let a reading page be read from the top in six windows and anything else in twelve", () => {
    expect(Object.fromEntries(Object.entries(table.templates).map(([id, rule]) => [id, rule.longViewports]))).toEqual({
      T1: 12, T2: 12, T3: 12, T4: 12, T5: 6, T6: 12, screen: 12, kernel: 12,
    });
  });
});
