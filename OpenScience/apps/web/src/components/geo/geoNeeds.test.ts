import { describe, expect, it } from "vitest";
import type { GeoNeedsYou } from "@/lib/geoClient";
import { geoNeeds } from "./geoNeeds";

/**
 * The bar over every view lists only what the reader can do: 「等你」 about money a reader cannot move, or a release they cannot give,
 * is a sentence with nothing behind it. The server judges every operation all the same; the page only does not ask for what would be refused.
 */
const need = (kind: string, extra: Partial<GeoNeedsYou> = {}): GeoNeedsYou => ({
  kind, key: `k:${kind}`, verb: "do", object: { type: "project" }, target: { tab: "overview" }, ...extra,
});
const abilities = (...held: string[]) => (ability: string) => held.includes(ability);

describe("geoNeeds: what the work waits for from this reader", () => {
  it("kinds each need by what it asks: money and release to confirm, an error and a failed step to resolve, the client's own act offline", () => {
    const all = abilities("manage_money", "review", "edit", "run");
    const project = { needsYou: [
      need("set_budget"),
      need("release_articles", { count: 3 }),
      need("correct_severe_error"),
      need("client_action", { text: "在官网放上说明书链接" }),
      need("credits_waiting", { object: { type: "step", id: "diagnosis" } }),
      need("step_failed", { object: { type: "step", id: "content" } }),
    ] };
    expect(geoNeeds(project, all).map(({ kind, text }) => [kind, text])).toEqual([
      ["confirm", "设置投放预算"],
      ["confirm", "放行 3 篇稿件"],
      ["resolve", "有严重讲错待纠正"],
      ["offline", "在官网放上说明书链接"],
      ["resolve", "诊断等你补额度"],
      ["resolve", "内容未完成，已算出的部分保留"],
    ]);
  });

  it("asks for the budget only of someone who may move money, and for a release only of a reviewer", () => {
    const project = { needsYou: [need("set_budget"), need("release_articles", { count: 2 })] };
    expect(geoNeeds(project, abilities("edit", "run")).map((item) => item.text)).toEqual([]);
    expect(geoNeeds(project, abilities("manage_money")).map((item) => item.text)).toEqual(["设置投放预算"]);
    expect(geoNeeds(project, abilities("review")).map((item) => item.text)).toEqual(["放行 2 篇稿件"]);
  });

  it("asks for a correction of an editor, and for a retry or an allowance of someone who may run", () => {
    const project = { needsYou: [
      need("correct_severe_error"),
      need("credits_waiting", { object: { type: "step", id: "diagnosis" } }),
      need("step_failed", { object: { type: "step", id: "content" } }),
    ] };
    expect(geoNeeds(project, abilities("edit")).map((item) => item.text)).toEqual(["有严重讲错待纠正"]);
    expect(geoNeeds(project, abilities("run")).map((item) => item.text)).toEqual(["诊断等你补额度", "内容未完成，已算出的部分保留"]);
    expect(geoNeeds(project, abilities("read"))).toEqual([]);
  });

  it("says nothing of a step it cannot name, and nothing of a kind it does not know", () => {
    const all = abilities("run", "edit", "review", "manage_money");
    const project = { needsYou: [need("step_failed"), need("credits_waiting", { object: { type: "step", id: "no-such-step" } }), need("something_new")] };
    expect(geoNeeds(project, all).map((item) => item.text)).toEqual([]);
  });

  it("is empty for a project the server told nothing about", () => {
    expect(geoNeeds({ needsYou: undefined as unknown as GeoNeedsYou[] }, abilities("run"))).toEqual([]);
  });
});
