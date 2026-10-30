import { describe, expect, it } from "vitest";
import { allInstalledExtensions, extensionAvailability, nextDisabled, skillActivationText, platformSkillReadOnly, skillAdapted, skillPublisher, skillRepositoryUrl } from "./catalogueModel";
import type { ExtensionInstallation, ExtensionSelection } from "@/lib/extensionsClient";
import type { PlatformSkill } from "@/lib/skillLibraryClient";

const installed = { phase: "waiting", effective: false } as ExtensionInstallation;

describe("extension activation belongs to the selected project", () => {
  it("uses a project's effective state instead of the account installation placeholder", () => {
    expect(extensionAvailability(installed, { enabled: true, effective: true, phase: "effective" } as ExtensionSelection)).toBe("已启用");
  });
  it("separates added, disabled, pending and a failed activation that retained the previous runtime", () => {
    expect(extensionAvailability(installed)).toBe("未在当前项目启用");
    expect(extensionAvailability(installed, { enabled: false, effective: false, phase: "effective" } as ExtensionSelection)).toBe("已关闭");
    expect(extensionAvailability(installed, { enabled: false, effective: true, phase: "waiting" } as ExtensionSelection)).toBe("等待当前任务结束后生效");
    expect(extensionAvailability(installed, { enabled: false, effective: true, phase: "failed" } as ExtensionSelection)).toBe("更改未生效，原设置仍在使用");
    expect(extensionAvailability(installed, { enabled: false, phase: "unknown" } as ExtensionSelection)).toBe("生效状态待确认");
  });
  it("does not call a connected package ready merely because it was added", () => {
    expect(extensionAvailability(installed, { enabled: true, effective: false, phase: "connection-needed" } as ExtensionSelection)).toBe("需要连接账户");
  });
});

it("a required, long-task or module-pack skill is listed without a control; the rest can be switched", () => {
  const rows = [
    { id: "curated:plot", group: "数据与图表" },
    { id: "core:guard", requirement: { required: true, reason: "system" } },
    { id: "office:docx", requirement: { required: true, reason: "workflow" } },
    { id: "geo-private:method", group: "循证 GEO" },
    { id: "loopx:loopx", group: "长任务" },
  ] as PlatformSkill[];
  expect(rows.filter(row => !platformSkillReadOnly(row)).map(row => row.id)).toEqual(["curated:plot"]);
});

it("keeps publisher and adaptation identity instead of relabeling every package as built-in", () => {
  expect(skillPublisher({ source: "platform", provenance: { kind: "adapted", publisher: "K-Dense", repository: "K-Dense-AI/scientific-agent-skills", version: "v2.72.0", license: "MIT" } } as PlatformSkill)).toBe("K-Dense");
  expect(skillPublisher({ source: "platform", provenance: { kind: "first-party", publisher: "EviMed", repository: null, version: null, license: "MIT" } } as PlatformSkill)).toBe("EviMed Science");
  expect(skillPublisher({ source: "platform", provenance: { kind: "first-party-derived", publisher: "EviMed", upstreamPublisher: "K-Dense-AI", repository: "https://github.com/K-Dense-AI/scientific-agent-skills", version: null, license: "MIT" } } as PlatformSkill)).toBe("EviMed Science");
});

it("does not present saved personal or platform choices as effective", () => {
  expect(skillActivationText(true, { phase: "waiting", savedRevision: 2, effectiveRevision: 1, error: null })).toBe("等待当前任务结束后生效");
  expect(skillActivationText(false, { phase: "effective", savedRevision: 2, effectiveRevision: 2, error: null })).toBe("已关闭");
  expect(skillActivationText(true, undefined)).toBe("生效状态待确认");
  expect(skillActivationText(true, { phase: "saved", savedRevision: 0, effectiveRevision: null, error: null })).toBe("生效状态待确认");
});

it("accepts recorded HTTPS repository links and rejects executable or credentialed URLs", () => {
  expect(skillRepositoryUrl("https://github.com/K-Dense-AI/scientific-agent-skills")).toBe("https://github.com/K-Dense-AI/scientific-agent-skills");
  expect(skillRepositoryUrl("K-Dense-AI/scientific-agent-skills")).toBe("https://github.com/K-Dense-AI/scientific-agent-skills");
  expect(skillRepositoryUrl("javascript:alert(1)")).toBeNull();
  expect(skillRepositoryUrl("https://secret@github.com/owner/repo")).toBeNull();
});

it("loads installed pages completely and rejects a looping cursor without pretending unobserved packages are uninstalled", async () => {
  const first = { ...installed, id: "one" }, second = { ...installed, id: "two" };
  const calls: Array<string | null | undefined> = [];
  const result = await allInstalledExtensions(async cursor => {
    calls.push(cursor);
    return cursor ? { items: [first, second], nextCursor: null } : { items: [first], nextCursor: "next" };
  });
  expect(result.items.map(item => item.id)).toEqual(["one", "two"]);
  expect(calls).toEqual([undefined, "next"]);
  await expect(allInstalledExtensions(async () => ({ items: [], nextCursor: "loop" }))).rejects.toThrow();
});

it("a switch never re-sends a disabled id the page has no row for", () => {
  const policy = { payload: { disabled: ["community:gone", "office:docx"] }, items: [{ id: "office:docx" }, { id: "office:xlsx" }] };
  expect(nextDisabled(policy, "office:xlsx", false)).toEqual(["office:docx", "office:xlsx"]);
  expect(nextDisabled(policy, "office:docx", true)).toEqual([]);
});

it("an idle project's activation says when the saved choice takes effect, in plain words", () => {
  expect(skillActivationText(false, { phase: "ready", savedRevision: 2, effectiveRevision: 2, error: null, live: false })).toBe("已关闭");
  expect(skillActivationText(true, { phase: "ready", savedRevision: 0, effectiveRevision: null, error: null, live: false })).toBe("已启用");
  expect(skillActivationText(true, { phase: "pending", savedRevision: 3, effectiveRevision: null, error: null, live: false })).toBe("下次对话生效");
  expect(skillActivationText(false, { phase: "deferred", savedRevision: 3, effectiveRevision: null, error: "runtime_composition_unavailable", live: true })).toBe("暂未生效，稍后会自动再试");
});

it("an upstream skill the platform edited is told apart from one it ships unedited", () => {
  expect(skillAdapted({ provenance: { kind: "upstream-adapted" } } as PlatformSkill)).toBe(true);
  expect(skillAdapted({ provenance: { kind: "upstream" } } as PlatformSkill)).toBe(false);
  expect(skillAdapted({} as PlatformSkill)).toBe(false);
});

it("prefers real Chinese display metadata and preserves unknown author-supplied names", async () => {
  const { skillDisplayName } = await import("./catalogueModel");
  expect(skillDisplayName({ id: "community:paper-search", title: "文献检索" })).toBe("文献检索");
  expect(skillDisplayName({ id: "community:paper-search", title: "community:paper-search" })).toBe("community:paper-search");
});

it("localizes every reviewed GEO task while preserving Chinese overrides and unrelated third-party titles", async () => {
  const { skillDisplayName } = await import("./catalogueModel");
  const { GEO_SKILL_TITLES } = await import("@evimed/domain/skill-display");
  for (const [name, title] of Object.entries(GEO_SKILL_TITLES)) {
    expect(skillDisplayName({ id: `geo-private:${name}`, title: name })).toBe(title);
    expect(title).toMatch(/[㐀-鿿]/u);
  }
  expect(skillDisplayName({ id: "geo-private:geo-care-nodes", title: "已有的中文任务名" })).toBe("已有的中文任务名");
  expect(skillDisplayName({ id: "community:research-paper", title: "Research Paper Toolkit" })).toBe("Research Paper Toolkit");
  expect(skillDisplayName({ id: "personal:geo-care-nodes", title: "My Care Workflow" })).toBe("My Care Workflow");
  expect(skillDisplayName({ id: "geo-private:unreviewed", title: "Future Method" })).toBe("Future Method");
});
