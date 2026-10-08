import { describe, expect, it } from "vitest";
import { sourceDraft } from "./geoTabText";

describe("the draft 「在对话中处理」 hands over for a source", () => {
  const base = { product: "信尔美", name: "百度百科", domain: "baike.baidu.com", cited: 69, wrong: 14, mentions: 35 };

  it("names the site by its domain and states the count as co-occurrence, with the wrong sentences", () => {
    const draft = sourceDraft({ ...base, sentences: [{ text: "每天注射一次", fromThisSite: false }, { text: "只能用三个月", fromThisSite: true }] });
    expect(draft).toContain("百度百科（baike.baidu.com）");
    expect(draft).toContain("引用它的 69 个回答里，有 14 个讲错了信尔美");
    // The sentence the engine's own marker puts on this site leads.
    expect(draft.indexOf("只能用三个月")).toBeLessThan(draft.indexOf("每天注射一次"));
    expect(draft).toMatch(/这个站该怎么处理？$/);
    // It does not say the site said it.
    expect(draft).not.toMatch(/这个站(说|讲)/);
  });

  it("carries at most five sentences, each once", () => {
    const sentences = Array.from({ length: 8 }, (_, index) => ({ text: `第 ${index % 7} 句`, fromThisSite: false }));
    const draft = sourceDraft({ ...base, sentences });
    expect(draft.match(/“第 \d 句”/g)).toHaveLength(5);
  });

  it("asks about placement, not correction, for a site nothing misstated, and uses the bare domain when it has no name", () => {
    const draft = sourceDraft({ ...base, name: null, domain: "dxy.com", wrong: 0, sentences: [] });
    expect(draft).toContain("看看信源 dxy.com");
    expect(draft).toContain("其中 35 个提到了信尔美");
    expect(draft).not.toContain("讲错");
  });
});
