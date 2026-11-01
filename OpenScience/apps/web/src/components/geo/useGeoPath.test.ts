import { describe, expect, it } from "vitest";
import { geoPathWithContext } from "./useGeoPath";
describe("GEO record navigation keeps the selected observations", () => {
  const from = { pathname: "/app/geo/g/sources", search: "?from=2026-10-01&engines=kimi&engines=deepseek&clientTags=病程,长期&session=s1&source=site" };
  it("carries repeated scope and session fields without leaving an unrelated drawer open", () => {
    const next = new URL(geoPathWithContext("/app/geo/g/answers/snap", from), "https://example.test");
    expect(next.searchParams.getAll("engines")).toEqual(["deepseek", "kimi"]);
    expect(next.searchParams.get("from")).toBe("2026-10-01");
    expect(next.searchParams.getAll("clientTags")).toEqual(["病程,长期"]);
    expect(next.searchParams.get("session")).toBe("s1");
    expect(next.searchParams.has("source")).toBe(false);
  });
  it("lets a destination narrow a dimension and never carries one product's scope into another", () => {
    const next = new URL(geoPathWithContext("/app/geo/g/questions?engine=doubao#detail", from), "https://example.test");
    expect(next.searchParams.get("engine")).toBe("doubao"); expect(next.searchParams.has("engines")).toBe(false);
    expect(next.hash).toBe("#detail");
    expect(geoPathWithContext("/app/geo/other", from)).toBe("/app/geo/other");
  });
});

it("carries the actual addressed native session through source and plan navigation",()=>{
  const path=geoPathWithContext("/app/geo/g/sources",{pathname:"/app/geo/g/chat/current-session",search:"?session=older-default&groupIds=g1"});
  const url=new URL(path,"https://example.test");
  // The addressed conversation stays the page's: it is in the path, and the stale query copy of another session is gone.
  expect(url.pathname).toBe("/app/geo/g/chat/current-session");
  expect(url.searchParams.has("session")).toBe(false);
  expect(url.searchParams.getAll("groupIds")).toEqual(["g1"]);
});

describe("a link in the results while the conversation is open", () => {
  const open={pathname:"/app/geo/g/chat/ses1",search:"?result=questions&engines=kimi"};

  it("stays on the chat path and names the result beside it, whichever tab it leads to", () => {
    for(const [tab,expected] of [["sources","sources"],["accuracy","accuracy"],["plan","plan"]]){
      const url=new URL(geoPathWithContext(`/app/geo/g/${tab}`,open),"https://example.test");
      expect(url.pathname).toBe("/app/geo/g/chat/ses1");
      expect(url.searchParams.get("result")).toBe(expected);
      // The scope travels with the press, as it does between two results.
      expect(url.searchParams.getAll("engines")).toEqual(["kimi"]);
    }
  });

  it("keeps the destination's own view, step and block, and a project's own address means its overview", () => {
    const url=new URL(geoPathWithContext("/app/geo/g/questions?view=journey&step=journey#geo-journey",open),"https://example.test");
    expect(url.pathname).toBe("/app/geo/g/chat/ses1");
    expect(url.searchParams.get("result")).toBe("questions");
    expect(url.searchParams.get("view")).toBe("journey");
    expect(url.searchParams.get("step")).toBe("journey");
    expect(url.hash).toBe("#geo-journey");
    const bare=new URL(geoPathWithContext("/app/geo/g",open),"https://example.test");
    expect(bare.pathname).toBe("/app/geo/g/chat/ses1");
    expect(bare.searchParams.get("result")).toBe("overview");
  });

  it("leaves the conversation for an address that is not a result, and for another project", () => {
    expect(geoPathWithContext("/app/geo/g/answers/snap",open)).toMatch(/^\/app\/geo\/g\/answers\/snap/);
    expect(geoPathWithContext("/app/geo/other/sources",open)).toBe("/app/geo/other/sources");
  });

  it("does not turn a press on the plain results into a conversation", () => {
    const url=new URL(geoPathWithContext("/app/geo/g/sources",{pathname:"/app/geo/g/questions",search:"?session=ses1"}),"https://example.test");
    expect(url.pathname).toBe("/app/geo/g/sources");
    expect(url.searchParams.get("session")).toBe("ses1");
  });
});

 it('a destination saved selection replaces all inherited filters but preserves the active conversation',()=>{
  const result=geoPathWithContext('/app/geo/g/accuracy?selectionRef=gsel_exact&error=rare',{pathname:'/app/geo/g/visibility',search:'?round=latest&from=2026-10-01&engines=kimi&groupIds=unrelated&session=ses1'});
  const query=new URL(result,'https://local.example').searchParams;
  expect([...query.entries()].sort()).toEqual([['error','rare'],['selectionRef','gsel_exact'],['session','ses1']]);
 });
