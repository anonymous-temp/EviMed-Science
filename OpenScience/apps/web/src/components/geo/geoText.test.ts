import { describe, expect, it } from "vitest";
import { absentWord, coverageText, GEO_ERROR_STATUS_WORDS, groupName, platformName, zh } from "./geoText";

describe("a sentence assembled from values (spec §5.5)", () => {
  it("puts a half-width space where Chinese meets a Latin name or a digit, and only there", () => {
    const engine = (name: string) => zh`${name}讲错最多，${3} 条`;
    expect(engine("DeepSeek")).toBe("DeepSeek 讲错最多，3 条");
    expect(engine("豆包")).toBe("豆包讲错最多，3 条");
    expect(zh`本轮只有${"Kimi"}测到读数`).toBe("本轮只有 Kimi 测到读数");
    // Punctuation needs no space, and a value's own text is never touched.
    expect(zh`${"Kimi"}：${"它需要每天注射一次"}`).toBe("Kimi：它需要每天注射一次");
    expect(zh`下次 ${"10月20日"}复测`).toBe("下次 10月20日复测");
    expect(zh`${null}本轮未测`).toBe("本轮未测");
  });
});

describe("the reader's words for the platform's codes", () => {
  it("names a platform, keeps one already in Chinese, and never prints an unknown code", () => {
    expect(platformName("xhs")).toBe("小红书");
    expect(platformName("douyin")).toBe("抖音");
    expect(platformName("知乎")).toBe("知乎");
    expect(platformName("wechat_channels")).toBe("微信视频号");
    expect(platformName("some_new_site")).toBeNull();
    expect(platformName(null)).toBeNull();
  });

  it("strips a question group's internal number and keeps the rest (F-G10)", () => {
    expect(groupName("P1-01 品牌身份")).toBe("品牌身份");
    expect(groupName("P3_12：泛症状咨询")).toBe("泛症状咨询");
    expect(groupName("恶心呕吐与胃肠反应")).toBe("恶心呕吐与胃肠反应");
    expect(groupName("P2-03")).toBe("P2-03");
  });

  it("says why an engine was not measured, and nothing for a code it does not know", () => {
    expect(absentWord("login")).toBe("探测账号需要重新登录");
    expect(absentWord("paused")).toBe("探测暂停，没有拿到有效回答");
    expect(absentWord("unavailable")).toBe("这个部署还没有接入");
    expect(absentWord("no_answer")).toBe("没有拿到有效回答");
    expect(absentWord("session_invalid")).toBeNull();
  });

  it("groups a wrong statement's handling the way the accuracy page does", () => {
    expect(Object.values(GEO_ERROR_STATUS_WORDS)).toEqual(["待处理", "处置中", "待复测", "已关闭"]);
  });

  it("writes a coverage window as a range with ～ and no spaces", () => {
    expect(coverageText(92, "2026-10-01")).toBe("10月1日～12月31日");
    expect(coverageText(90, null)).toBe("覆盖 90 天");
  });
});
