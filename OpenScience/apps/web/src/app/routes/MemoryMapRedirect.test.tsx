import { describe, expect, it } from "vitest";
import { overviewAddressFromMap } from "./MemoryMapRedirect";

describe("where an address of the retired 记忆地图 lands", () => {
  it("is the overview, plain, when the address carried nothing it can use", () => {
    expect(overviewAddressFromMap("")).toBe("/app/memory/overview");
    expect(overviewAddressFromMap("?view=dims")).toBe("/app/memory/overview");
    expect(overviewAddressFromMap("?view=time&dimension=aspect%3Adecision&focus=memory%3Aa&depth=2&chain=1&part=you&kind=decision")).toBe("/app/memory/overview");
    expect(overviewAddressFromMap("?view=activity&range=1y")).toBe("/app/memory/overview");
  });

  it("carries the relation graph and the topics as the panel the overview opens on", () => {
    expect(overviewAddressFromMap("?view=graph")).toBe("/app/memory/overview?explore=graph");
    expect(overviewAddressFromMap("?view=topics")).toBe("/app/memory/overview?explore=topics");
  });

  it("carries the project, the search, the open drawer, what needs a look, a topic and a 30- or 90-day range as they were", () => {
    expect(overviewAddressFromMap("?view=topics&project=prj_1&q=%E7%96%B3&open=entry%3Ae4&look=1&topic=t1&range=30d"))
      .toBe("/app/memory/overview?explore=topics&project=prj_1&q=%E7%96%B3&open=entry%3Ae4&look=1&topic=t1&range=30d");
  });
});
