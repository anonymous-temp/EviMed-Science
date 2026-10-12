import { describe, expect, it } from "vitest";
import { TEST_PALETTE } from "./map/palette";
import { CLOUD_WORDS, wordCloudOption, wordColour, wordTooltip } from "./wordCloudOption";

const topic = (id: string, weight: number, trend = 0, label = `主题 ${id}`) => ({ id, label, weight, trend });

describe("the topic cloud", () => {
  it("sizes a word by the number the ranking prints, and colours it by its trend and nothing else", () => {
    const option: any = wordCloudOption([topic("a", 14, 3), topic("b", 9, 0), topic("c", 5, -2)], { selected: null, palette: TEST_PALETTE, fontFamily: "sans" });
    const series = option.series[0];
    expect(series.type).toBe("wordCloud");
    expect(series.data.map((word: any) => [word.name, word.value, word.textStyle.color])).toEqual([["主题 a", 14, "#blue"], ["主题 b", 9, "#text"], ["主题 c", 5, "#faint"]]);
    expect(series.rotationRange).toEqual([0, 0]);
    expect(series.layoutAnimation).toBe(false);
  });
  it("makes the chosen topic the blue, heavy word", () => {
    const series: any = (wordCloudOption([topic("a", 4), topic("b", 9)], { selected: "a", palette: TEST_PALETTE, fontFamily: "sans" }) as any).series[0];
    const chosen = series.data.find((word: any) => word.id === "a");
    expect([chosen.textStyle.color, chosen.textStyle.fontWeight]).toEqual(["#blue", 800]);
    expect(series.data.find((word: any) => word.id === "b").textStyle.fontWeight).toBe(500);
    expect(wordColour(topic("x", 1, 0), true, TEST_PALETTE)).toBe("#blue");
  });
  it("draws at most forty words, the largest", () => {
    const many = Array.from({ length: 60 }, (_, index) => topic(`t${index}`, index + 1));
    const words = (wordCloudOption(many, { selected: null, palette: TEST_PALETTE, fontFamily: "sans" }) as any).series[0].data;
    expect(words).toHaveLength(CLOUD_WORDS);
    expect(words[0].value).toBe(60);
  });
  it("escapes a topic's name in the tooltip, and says the number and the trend", () => {
    const html = wordTooltip(topic("a", 12, 3, "<img src=x onerror=alert(1)>"));
    expect(html).not.toContain("<img");
    expect(html).toContain("12 条记忆 · 近 30 天 +3");
    expect(wordTooltip(topic("b", 4, -1))).toContain("近 30 天 -1");
    const formatter = (wordCloudOption([topic("a", 1, 0, "<b>")], { selected: null, palette: TEST_PALETTE, fontFamily: "sans" }) as any).tooltip.formatter;
    expect(formatter({ name: "<b>" })).toContain("&lt;b&gt;");
    expect(formatter({ name: "nobody" })).toBe("");
  });
});
