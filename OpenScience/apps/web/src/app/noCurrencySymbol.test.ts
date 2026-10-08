// @vitest-environment node
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shellSources, sourceStrings as strings, walk } from "@/test/sourceStrings";

/**
 * Every amount on screen is in 灵豆 (one 灵豆 is one CNY; design reference §15.1,
 * E-7), so no string the app can render carries a currency sign. A price list in
 * ¥ next to an allowance in 灵豆 is two units for one thing, which is the
 * mistake this ends: the tool cards' “约 4～8 灵豆”, the allowance, the
 * simulated wallet, the usage page and the run's cost all draw
 * `formatLingdou` / `allowanceText`, and the domain's refusal sentence says
 * 灵豆 as well.
 *
 * Only strings are read (string and template literals, JSX text) — a comment
 * explaining the old sign or a regular expression that tolerates it in what a
 * person types cannot trip it. The web app's sources and the domain's sentences
 * that reach the screen are in scope.
 *
 * `PENDING` is the files whose amounts belong to another R13 work package (the
 * task page's budgets, 循证 GEO's budget and market money) and are converted
 * there; empty it when they are. A path that no longer exists is reported.
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));
const DOMAIN_SRC = fileURLToPath(new URL("../../../../packages/domain/src", import.meta.url));

/** Amounts owned by other packages; remove each once that package has moved to 灵豆. */
const PENDING = new Set<string>([]);

const SIGN = /[¥￥]/;
/** The shape this replaced; the scan must see it in a string (below), which is how it is known to read strings. */
const OLD_SHAPE = "约 ¥4～8 额度";

const webSources = shellSources(SRC);
const domainSources = walk(DOMAIN_SRC).filter((path) => path.endsWith(".mjs"));

function offenders(): { id: string; line: number; text: string }[] {
  return [
    ...webSources.map((path) => ({ path, id: `web:${relative(SRC, path)}` })),
    ...domainSources.map((path) => ({ path, id: `domain:${relative(DOMAIN_SRC, path)}` })),
  ].flatMap(({ path, id }) => strings(path).filter(({ text }) => SIGN.test(text)).map(({ line, text }) => ({ id, line, text: text.trim().slice(0, 60) })));
}

describe("no amount is drawn with a currency sign", () => {
  it("walked the web app and the domain, and would see a sign in a string", () => {
    expect(webSources.length).toBeGreaterThan(150);
    expect(domainSources.length).toBeGreaterThan(50);
    expect(webSources.map((path) => relative(SRC, path))).toEqual(expect.arrayContaining(["lib/format.ts", "components/settings/SimulatedAllowance.tsx", "app/routes/CapabilitiesPage.tsx"]));
    const probe = join(SRC, "app/noCurrencySymbol.test.ts");
    expect(strings(probe).some(({ text }) => text === OLD_SHAPE && SIGN.test(text))).toBe(true);
  });

  it("holds in every string, except in the files another work package still owns", () => {
    const found = offenders().filter(({ id }) => !PENDING.has(id)).map(({ id, line, text }) => `${id}:${line}  ${text}`);
    expect(found).toEqual([]);
  });

  it("names only files that still exist", () => {
    const present = new Set([
      ...webSources.map((path) => `web:${relative(SRC, path)}`),
      ...domainSources.map((path) => `domain:${relative(DOMAIN_SRC, path)}`),
    ]);
    expect([...PENDING].filter((id) => !present.has(id))).toEqual([]);
  });
});
