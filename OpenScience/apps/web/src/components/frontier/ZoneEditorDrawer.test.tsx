import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import type { ZoneDetail, ZoneDraftResult } from "@/lib/evidenceTopicClient";
import { topicDefinition, topicPreview, topicZone } from "./__fixtures__/zoneDirectory";
import { ZoneEditorDrawer, type ZoneEditorDrawerProps } from "./ZoneEditorDrawer";

const client = vi.hoisted(() => ({ draftZone: vi.fn(), previewZone: vi.fn(), createZone: vi.fn(), updateZone: vi.fn() }));
vi.mock("@/lib/evidenceTopicClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceTopicClient")>()), ...client }));

const draftResult = (over: Partial<ZoneDraftResult> = {}): ZoneDraftResult => ({
  draft: { title: "GLP-1 受体激动剂减重 · 心血管结局", definition: topicDefinition },
  readings: [], suggestions: { narrower: [], broader: [] }, preview: topicPreview(), similar: [], ...over,
});
const detail = (over: Partial<ZoneDetail> = {}): ZoneDetail => ({
  ...topicZone({ id: "zone_mine", title: "我的 GLP-1 专区", kind: "user", published: false }),
  revision: 3, definition: topicDefinition, canEdit: true, canDelete: true, band: "normal", overviewAt: null, related: [], successors: [], lastItemAt: null, ...over,
});

function mount(props: Partial<ZoneEditorDrawerProps> = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<MemoryRouter><ZoneEditorDrawer mode="create" onClose={onClose} onSaved={onSaved} {...props} /></MemoryRouter>);
  return { onClose, onSaved };
}
const generate = async (sentence = "GLP-1 减重药的心血管结局") => {
  await userEvent.type(screen.getByRole("textbox", { name: "想持续看什么？" }), sentence);
  await userEvent.click(screen.getByRole("button", { name: "生成" }));
};

beforeEach(() => {
  vi.clearAllMocks();
  client.draftZone.mockResolvedValue(draftResult());
  client.previewZone.mockResolvedValue(topicPreview({ count30: 12, perWeek: 3 }));
  client.createZone.mockResolvedValue(detail());
  client.updateZone.mockResolvedValue(detail());
});

describe("creating 我的专区", () => {
  it("starts with one question and three examples that fill it, and drafts nothing until asked", async () => {
    mount();
    const dialog = screen.getByRole("dialog", { name: "新建专区" });
    expect(within(dialog).getByRole("textbox", { name: "想持续看什么？" })).toHaveAttribute("maxlength", "200");
    expect(within(dialog).queryByRole("button", { name: "建立" })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "ADC 治疗 HER2 低表达乳腺癌" }));
    expect(within(dialog).getByRole("textbox", { name: "想持续看什么？" })).toHaveValue("ADC 治疗 HER2 低表达乳腺癌");
    expect(client.draftZone).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "生成" })).toBeEnabled();
  });

  it("drafts a sentence into a name, keywords and a scope, with what the zone would have gathered in 30 days", async () => {
    mount();
    await generate();
    expect(client.draftZone).toHaveBeenCalledWith({ text: "GLP-1 减重药的心血管结局", baseZoneId: null, fromItemId: null });
    expect(await screen.findByRole("textbox", { name: "名称" })).toHaveValue("GLP-1 受体激动剂减重 · 心血管结局");
    const keywords = screen.getByRole("list", { name: "关键词" });
    expect(within(keywords).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["GLP-1 受体激动剂", "心血管结局"]);
    expect(screen.getByRole("textbox", { name: "范围" })).toHaveValue(topicDefinition.scope);
    expect(screen.getByText("近 30 天 41 条 · 约每周 10 条")).toBeInTheDocument();
    const recent = screen.getByRole("list", { name: "最近的几条" });
    expect(within(recent).getAllByRole("listitem")).toHaveLength(2);
    // The draft came with its preview: no second read for the same keywords.
    expect(client.previewZone).not.toHaveBeenCalled();
  });

  it("marks the borderline items 算 or 不算 and creates the zone with them as seeds, one request id, unpublished", async () => {
    const { onSaved } = mount();
    await generate();
    const list = await screen.findByRole("list", { name: "边界样例" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    const yes = screen.getByRole("button", { name: "算：减重手术与药物的比较" });
    const no = screen.getByRole("button", { name: "不算：胰高血糖素样肽的基础研究" });
    expect(yes).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(yes);
    await userEvent.click(no);
    expect(yes).toHaveAttribute("aria-pressed", "true");
    expect(no).toHaveAttribute("aria-pressed", "true");
    // The same press again lets go of it.
    await userEvent.click(no);
    expect(no).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(no);
    await userEvent.click(screen.getByRole("button", { name: "建立" }));
    await waitFor(() => expect(client.createZone).toHaveBeenCalledTimes(1));
    expect(client.createZone.mock.calls[0]![0]).toEqual({
      title: "GLP-1 受体激动剂减重 · 心血管结局",
      definition: topicDefinition,
      seeds: { positive: ["b1"], negative: ["b2"] },
      published: false,
      requestId: expect.stringMatching(/\S{8,}/),
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "zone_mine" })));
    // No approval and no confirmation step: nothing but the drawer was asked of the reader.
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("publishes to the platform only when the switch is turned on, and says what that means", async () => {
    mount();
    await generate();
    const publish = await screen.findByRole("switch", { name: "公开到平台" });
    expect(publish).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("公开后，平台里的其他人也能看到和关注")).toBeInTheDocument();
    await userEvent.click(publish);
    await userEvent.click(screen.getByRole("button", { name: "建立" }));
    await waitFor(() => expect(client.createZone).toHaveBeenCalledWith(expect.objectContaining({ published: true })));
  });

  it("reads the preview again, a moment after a keyword is removed or added, and sends the edited definition", async () => {
    mount();
    await generate();
    await screen.findByRole("textbox", { name: "名称" });
    await userEvent.click(screen.getByRole("button", { name: "移除关键词“心血管结局”" }));
    await waitFor(() => expect(client.previewZone).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(client.previewZone.mock.calls[0]![0].keywords.map((keyword: { label: string }) => keyword.label)).toEqual(["GLP-1 受体激动剂"]);
    expect(await screen.findByText("近 30 天 12 条 · 约每周 3 条")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "添加关键词" }), "替尔泊肽{Enter}");
    await waitFor(() => expect(client.previewZone).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(client.previewZone.mock.calls[1]![0].keywords.map((keyword: { label: string }) => keyword.label)).toEqual(["GLP-1 受体激动剂", "替尔泊肽"]);
    await userEvent.click(screen.getByRole("button", { name: "建立" }));
    await waitFor(() => expect(client.createZone).toHaveBeenCalledTimes(1));
    expect(client.createZone.mock.calls[0]![0].definition.keywords).toEqual([
      { label: "GLP-1 受体激动剂", terms: ["GLP-1 受体激动剂", "司美格鲁肽"] },
      { label: "替尔泊肽", terms: ["替尔泊肽"] },
    ]);
  });

  it("takes at most four keywords, the number the server keeps", async () => {
    mount();
    await generate();
    const input = await screen.findByRole("textbox", { name: "添加关键词" });
    await userEvent.type(input, "甲{Enter}");
    await userEvent.type(screen.getByRole("textbox", { name: "添加关键词" }), "乙{Enter}");
    expect(within(screen.getByRole("list", { name: "关键词" })).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.queryByRole("textbox", { name: "添加关键词" })).not.toBeInTheDocument();
  });

  it("offers the other readings of an ambiguous sentence, and choosing one replaces the draft and previews it", async () => {
    client.draftZone.mockResolvedValue(draftResult({
      draft: { title: "抗体偶联药物", definition: { ...topicDefinition, keywords: [{ label: "抗体偶联药物", terms: ["ADC"] }] } },
      readings: [
        { label: "抗体偶联药物", draft: { title: "抗体偶联药物", definition: { ...topicDefinition, keywords: [{ label: "抗体偶联药物", terms: ["ADC"] }] } } },
        { label: "表观扩散系数", draft: { title: "表观扩散系数", definition: { ...topicDefinition, keywords: [{ label: "表观扩散系数", terms: ["ADC"] }] } } },
      ],
    }));
    mount();
    await generate("ADC");
    const readings = await screen.findByRole("group", { name: "你指的是" });
    expect(within(readings).getAllByRole("button").map((button) => button.textContent)).toEqual(["抗体偶联药物", "表观扩散系数"]);
    await userEvent.click(within(readings).getByRole("button", { name: "表观扩散系数" }));
    expect(screen.getByRole("textbox", { name: "名称" })).toHaveValue("表观扩散系数");
    await waitFor(() => expect(client.previewZone).toHaveBeenCalledTimes(1), { timeout: 3000 });
    // The readings were for the sentence; once one is chosen they go.
    expect(screen.queryByRole("group", { name: "你指的是" })).not.toBeInTheDocument();
  });

  it("hints, never blocks, when the zone is too wide: the narrower candidates with their own weekly counts", async () => {
    const narrower = { label: "加限定：心血管结局", draft: { title: "GLP-1 减重 · 心血管", definition: topicDefinition }, perWeek: 9 };
    client.draftZone.mockResolvedValue(draftResult({
      preview: topicPreview({ perWeek: 80, count30: 340, band: "broad" }),
      suggestions: { narrower: [narrower, { ...narrower, label: "加限定：安全性", perWeek: 14 }], broader: [{ ...narrower, label: "不该出现的放宽", perWeek: 99 }] },
    }));
    mount();
    await generate();
    await screen.findByText("近 30 天 340 条 · 约每周 80 条");
    expect(screen.getByText("范围偏宽，加一个限定会更聚焦：")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "加限定：心血管结局 · 约每周 9 条" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "加限定：安全性 · 约每周 14 条" })).toBeInTheDocument();
    expect(screen.queryByText(/不该出现的放宽/)).not.toBeInTheDocument();
    // Not a block: the zone can be made as written.
    expect(screen.getByRole("button", { name: "建立" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "加限定：心血管结局 · 约每周 9 条" }));
    expect(screen.getByRole("textbox", { name: "名称" })).toHaveValue("GLP-1 减重 · 心血管");
    expect(screen.queryByText("范围偏宽，加一个限定会更聚焦：")).not.toBeInTheDocument();
  });

  it("offers a wider candidate when the zone is too narrow, and nothing when the count is fine", async () => {
    client.draftZone.mockResolvedValue(draftResult({
      preview: topicPreview({ perWeek: 1, count30: 4, band: "narrow" }),
      suggestions: { narrower: [], broader: [{ label: "放宽到心血管结局", draft: { title: "放宽", definition: topicDefinition }, perWeek: 12 }] },
    }));
    mount();
    await generate();
    expect(await screen.findByText("范围偏窄，放宽一点会多一些：")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "放宽到心血管结局 · 约每周 12 条" })).toBeInTheDocument();
  });

  it("points to a zone that already says nearly the same", async () => {
    client.draftZone.mockResolvedValue(draftResult({ similar: [topicZone({ id: "z_same", title: "GLP-1 心血管结局" })] }));
    mount();
    await generate();
    expect(await screen.findByText("已有相近的专区：")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "GLP-1 心血管结局" })).toHaveAttribute("href", "/app/frontier/zones/z_same");
  });

  it("says the limit in the reader's words when they already have thirty, and keeps the draft", async () => {
    client.createZone.mockRejectedValue(new WebApiError("limit", { status: 409, code: "evidence_user_zone_limit" }));
    mount();
    await generate();
    await userEvent.click(await screen.findByRole("button", { name: "建立" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("最多可以建 30 个专区，先删掉不用的再建");
    expect(screen.getByRole("textbox", { name: "名称" })).toHaveValue("GLP-1 受体激动剂减重 · 心血管结局");
    expect(screen.getByRole("button", { name: "建立" })).toBeEnabled();
  });

  it("says a failed draft and lets the reader ask again", async () => {
    client.draftZone.mockRejectedValueOnce(new WebApiError("down", { status: 502 }));
    mount();
    await generate();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "名称" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "生成" }));
    expect(await screen.findByRole("textbox", { name: "名称" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a lost answer's second press to one creation: the same request id for the same content", async () => {
    client.createZone.mockRejectedValueOnce(new WebApiError("down", { status: 502 })).mockResolvedValueOnce(detail());
    mount();
    await generate();
    await userEvent.click(await screen.findByRole("button", { name: "建立" }));
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "建立" }));
    await waitFor(() => expect(client.createZone).toHaveBeenCalledTimes(2));
    expect(client.createZone.mock.calls[1]![0].requestId).toBe(client.createZone.mock.calls[0]![0].requestId);
  });

  it("drafts at once from an item or a zone to copy", async () => {
    mount({ seed: { fromItemId: "item-9" } });
    await screen.findByRole("textbox", { name: "名称" });
    expect(client.draftZone).toHaveBeenCalledWith({ text: "", baseZoneId: null, fromItemId: "item-9" });
  });

  it("fills a searched group's name in without drafting it", async () => {
    mount({ seed: { text: "乳腺癌" } });
    expect(screen.getByRole("textbox", { name: "想持续看什么？" })).toHaveValue("乳腺癌");
    expect(client.draftZone).not.toHaveBeenCalled();
  });

  it("drafts the words of a search at once when the seed says to", async () => {
    mount({ seed: { text: "司美格鲁肽", generate: true } });
    await screen.findByRole("textbox", { name: "名称" });
    expect(client.draftZone).toHaveBeenCalledWith({ text: "司美格鲁肽", baseZoneId: null, fromItemId: null });
  });
});

describe("editing 我的专区", () => {
  it("starts from the zone's own definition, drafts nothing, and previews it without marks", async () => {
    mount({ mode: "edit", zone: detail() });
    expect(screen.getByRole("dialog", { name: "编辑专区" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "名称" })).toHaveValue("我的 GLP-1 专区");
    expect(screen.getByRole("textbox", { name: "想怎么调整？" })).toHaveValue("");
    expect(client.draftZone).not.toHaveBeenCalled();
    await waitFor(() => expect(client.previewZone).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("近 30 天 12 条 · 约每周 3 条")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "边界样例" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^算：/ })).not.toBeInTheDocument();
  });

  it("saves only what changed, with the zone's revision, and asks nothing", async () => {
    const zone = detail();
    const { onSaved } = mount({ mode: "edit", zone });
    const name = screen.getByRole("textbox", { name: "名称" });
    await userEvent.clear(name);
    await userEvent.type(name, "GLP-1 与心血管");
    await userEvent.click(screen.getByRole("switch", { name: "公开到平台" }));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.updateZone).toHaveBeenCalledTimes(1));
    expect(client.updateZone).toHaveBeenCalledWith(zone, { title: "GLP-1 与心血管", published: true });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(client.createZone).not.toHaveBeenCalled();
  });

  it("sends the definition when a keyword was removed", async () => {
    const zone = detail();
    mount({ mode: "edit", zone });
    await userEvent.click(screen.getByRole("button", { name: "移除关键词“心血管结局”" }));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.updateZone).toHaveBeenCalledTimes(1));
    const change = client.updateZone.mock.calls[0]![1];
    expect(change.title).toBeUndefined();
    expect(change.definition.keywords.map((keyword: { label: string }) => keyword.label)).toEqual(["GLP-1 受体激动剂"]);
  });

  it("drafts again from a new sentence, copying from the zone being edited", async () => {
    mount({ mode: "edit", zone: detail() });
    await userEvent.type(screen.getByRole("textbox", { name: "想怎么调整？" }), "加上替尔泊肽");
    await userEvent.click(screen.getByRole("button", { name: "生成" }));
    await waitFor(() => expect(client.draftZone).toHaveBeenCalledWith({ text: "加上替尔泊肽", baseZoneId: "zone_mine", fromItemId: null }));
    expect(await screen.findByRole("textbox", { name: "名称" })).toHaveValue("GLP-1 受体激动剂减重 · 心血管结局");
  });
});
