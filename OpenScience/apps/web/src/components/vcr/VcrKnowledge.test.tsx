import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readVcrKnowledge, readVcrStudy } from "@/lib/vcrClient";
import { ComparisonCard, VcrDefinitionsPanel, VcrDefinitionsSection, VcrKnowledgeSection } from "./VcrKnowledge";
import { fixture, installVcrServer, STUDY_ID } from "./__fixtures__/serverFixtures";

// Only the network is doubled; the readers, the client's route functions and the components are real.
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

const draw = (node: React.ReactElement) => render(<MemoryRouter>{node}</MemoryRouter>);

/** The knowledge block the server sends, as the reader makes it. */
function knowledgeOf(patch: Record<string, unknown> = {}) {
  return readVcrKnowledge({
    pack: {
      origin: "stored", id: "pkg_1", diseaseKey: "rare_thing", name: "Rare thing", nameZh: "某罕见病", version: 2, status: "ai-draft",
      counts: { terms: 3, phenotypes: 0, endpoints: 2, criteria: 4, mappings: 0, background: 0 },
      sources: [{ id: "paper", title: "A review", url: "https://example.org/review", licence: "link-only", licenceName: "Rights reserved by the publisher: cited by link, facts restated in own words", use: "link-only", accessed: "2026-10-04" }],
      canPromote: true,
    },
    definitions: [{ definitionId: "dfn_1", version: 2, populationId: "pop_1", name: "成人 ECOG 0–1", text: "年龄不小于 18 岁、ECOG 0 或 1。", versions: 3, uses: 2, usedAt: null,
      packRefs: [{ section: "mappings", id: "m_age", concept: "age" }] }],
    comparisons: [],
    savable: [{ populationId: "pop_1", label: "人群 v2", name: "成人 ECOG 0–1" }],
    ...patch,
  })!;
}

const LIBRARY = {
  definitions: [
    { id: "dfn_1", name: "成人 ECOG 0–1", versions: 3, uses: 2, updatedAt: null, latest: { version: 3, text: "年龄不小于 18 岁、ECOG 0 或 1。", rules: [{ name: "adult", rule: {} }, { name: "fit", rule: {} }], packRefs: [], createdAt: null } },
    { id: "dfn_2", name: "EGFR 阳性", versions: 1, uses: 1, updatedAt: null, latest: { version: 1, text: "EGFR 敏感突变。", rules: [], packRefs: [], createdAt: null } },
  ],
};

beforeEach(() => {
  installVcrServer(network.productRequest, { "GET /vcr/definitions": LIBRARY });
  toasts.success.mockReset();
  toasts.error.mockReset();
});

const posted = (method: string, path: string) => network.productRequest.mock.calls.filter((call) => call[0] === path && call[1] === method);

describe("病种定义包 on 定义与证据", () => {
  it("marks a draft 「AI 草拟」, lists each source with its link and licence, and lets the lead promote it", async () => {
    const changed = vi.fn();
    draw(<VcrKnowledgeSection studyId={STUDY_ID} knowledge={knowledgeOf()} canWrite onChanged={changed} />);
    const pack = document.querySelector("[data-vcr-pack]") as HTMLElement;
    expect(pack).toHaveAttribute("data-vcr-pack", "ai-draft");
    expect(within(pack).getByText("某罕见病")).toBeInTheDocument();
    expect(within(pack).getByText("AI 草拟")).toBeInTheDocument();
    // The pack's own version number is the platform's, not a reader's.
    expect(within(pack).queryByText("v2")).toBeNull();
    expect(pack).toHaveTextContent("术语 3 · 表型 0 · 终点 2 · 入排条件 4");
    await userEvent.click(within(pack).getByText("来源 1"));
    const link = within(pack).getByRole("link", { name: /A review/ });
    expect(link).toHaveAttribute("href", "https://example.org/review");
    expect(pack).toHaveTextContent("仅链接");
    await userEvent.click(within(pack).getByRole("button", { name: "复核后标为已整理" }));
    await waitFor(() => expect(posted("POST", `/vcr/studies/${STUDY_ID}/pack/promote`)).toHaveLength(1));
    expect(toasts.success).toHaveBeenCalled();
    expect(changed).toHaveBeenCalled();
  });

  it("shows a curated pack as 「已整理」 with nothing to promote", () => {
    const curated = knowledgeOf({ pack: { origin: "shipped", id: "nsclc", diseaseKey: "nsclc", name: "NSCLC", nameZh: "非小细胞肺癌", version: 1, status: "curated", counts: { terms: 42 }, sources: [], canPromote: false } });
    draw(<VcrKnowledgeSection studyId={STUDY_ID} knowledge={curated} canWrite onChanged={() => undefined} />);
    expect(screen.getByText("已整理")).toBeInTheDocument();
    expect(screen.queryByText("AI 草拟")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "复核后标为已整理" })).not.toBeInTheDocument();
  });

  it("names the library definitions the study used, with their versions and uses and the pack entries they rest on", () => {
    draw(<VcrKnowledgeSection studyId={STUDY_ID} knowledge={knowledgeOf()} canWrite={false} onChanged={() => undefined} />);
    const used = document.querySelector("[data-vcr-used-definition]") as HTMLElement;
    expect(used).toHaveTextContent("成人 ECOG 0–1 v2");
    expect(used).toHaveTextContent("定义库");
    expect(used).toHaveTextContent("共 3 个版本 · 用于 2 个研究");
    expect(used).toHaveTextContent("年龄不小于 18 岁、ECOG 0 或 1。");
    expect(within(used).getByText("age")).toBeInTheDocument();
  });

  it("offers the catalogue to a writer when the study has no pack, and binds the one chosen", async () => {
    installVcrServer(network.productRequest, {
      "GET /vcr/packs": { packs: [
        { origin: "shipped", id: "nsclc", diseaseKey: "nsclc", name: "NSCLC", nameZh: "非小细胞肺癌", version: 1, status: "curated", counts: {}, sources: [] },
        { origin: "stored", id: "pkg_9", diseaseKey: "rare", name: null, nameZh: "某罕见病", version: 1, status: "ai-draft", counts: {}, sources: [] },
      ] },
    });
    const changed = vi.fn();
    draw(<VcrKnowledgeSection studyId={STUDY_ID} knowledge={knowledgeOf({ pack: null, definitions: [] })} canWrite onChanged={changed} />);
    const select = await screen.findByLabelText("选用病种定义包");
    expect(within(select).getByRole("option", { name: "某罕见病（AI 草拟）" })).toBeInTheDocument();
    await userEvent.selectOptions(select, "nsclc");
    await userEvent.click(screen.getByRole("button", { name: "绑定" }));
    await waitFor(() => expect(posted("POST", `/vcr/studies/${STUDY_ID}/pack`)).toHaveLength(1));
    expect(posted("POST", `/vcr/studies/${STUDY_ID}/pack`)[0][2]).toEqual({ use: "nsclc" });
    expect(changed).toHaveBeenCalled();
  });

  it("shows nothing at all to a reader who cannot write when there is no pack and no definition", () => {
    const { container } = draw(<VcrKnowledgeSection studyId={STUDY_ID} knowledge={knowledgeOf({ pack: null, definitions: [] })} canWrite={false} onChanged={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("申请成为平台病种定义包 (flywheel F26)", () => {
  const curated = (platformRequest: Record<string, unknown>) => knowledgeOf({
    pack: { origin: "stored", id: "pkg_1", diseaseKey: "rare_thing", name: "Rare thing", nameZh: "某罕见病", version: 2, status: "curated", counts: { terms: 3 }, sources: [], canPromote: false, platformRequest },
  });

  it("offers the request to the lead of a curated pack and sends nothing but the act; a pass says so", async () => {
    installVcrServer(network.productRequest, { [`POST /vcr/studies/${STUDY_ID}/pack/platform`]: { state: "passed", existing: false, failing: [] } });
    const changed = vi.fn();
    draw(<VcrKnowledgeSection studyId={STUDY_ID} knowledge={curated({ canRequest: true, requested: false, recheck: null })} canWrite onChanged={changed} />);
    await userEvent.click(screen.getByRole("button", { name: "申请成为平台病种定义包" }));
    await waitFor(() => expect(posted("POST", `/vcr/studies/${STUDY_ID}/pack/platform`)).toHaveLength(1));
    expect(posted("POST", `/vcr/studies/${STUDY_ID}/pack/platform`)[0][2]).toEqual({});
    expect(toasts.success).toHaveBeenCalled();
    expect(changed).toHaveBeenCalled();
  });

  it("names what failed the re-check, keeps the pack the account's and offers the request again", async () => {
    installVcrServer(network.productRequest, {
      [`POST /vcr/studies/${STUDY_ID}/pack/platform`]: { state: "failed", existing: false, failing: [{ section: "terms", id: "t1", code: "source_changed", detail: "A review（doi:10.1000/x）已有「retraction」记录" }] },
    });
    draw(<VcrKnowledgeSection studyId={STUDY_ID} knowledge={curated({ canRequest: true, requested: false, recheck: null })} canWrite onChanged={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "申请成为平台病种定义包" }));
    const failing = await screen.findByText(/复核没有通过/);
    expect(failing.closest("[data-vcr-platform-failing]")).toHaveTextContent("terms · t1：A review（doi:10.1000/x）已有「retraction」记录");
    expect(screen.getByRole("button", { name: "申请成为平台病种定义包" })).toBeInTheDocument();
  });

  it("shows the last re-check that failed from the study's own payload, and says a platform pack is one already", () => {
    const { unmount } = draw(<VcrKnowledgeSection studyId={STUDY_ID} knowledge={curated({ canRequest: true, requested: false,
      recheck: { state: "failed", failing: [{ section: "endpoints", id: "e1", code: "source_changed", detail: "来源有记录" }], checked: {}, at: null } })} canWrite onChanged={() => undefined} />);
    expect(document.querySelector("[data-vcr-platform-failing]")).toHaveTextContent("endpoints · e1");
    unmount();
    draw(<VcrKnowledgeSection studyId={STUDY_ID} knowledge={curated({ canRequest: false, requested: true, recheck: null })} canWrite onChanged={() => undefined} />);
    expect(screen.getByText("这份病种定义包已经是平台病种定义包。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "申请成为平台病种定义包" })).not.toBeInTheDocument();
  });

  it("names a platform pack's author by the name they allow, and labels a changed source without offering a request", () => {
    const platform = knowledgeOf({
      pack: { origin: "stored", id: "pkg_9", diseaseKey: "rare_thing", name: "Rare thing", nameZh: "某罕见病", version: 1, status: "curated", counts: {}, sources: [],
        platform: { version: 1, author: { name: "张主任", at: null, sourceVersion: 2 }, zoneId: null, state: "live", sourceChanged: { at: "2026-10-06T00:00:00Z", sources: [] } } },
    });
    draw(<VcrKnowledgeSection studyId={STUDY_ID} knowledge={platform} canWrite onChanged={() => undefined} />);
    const mark = document.querySelector("[data-vcr-platform-pack]") as HTMLElement;
    expect(mark).toHaveTextContent("平台病种定义包");
    expect(mark).toHaveTextContent("张主任 整理 · 取自其 v2");
    expect(mark).toHaveTextContent("来源有变更");
    expect(screen.queryByRole("button", { name: "申请成为平台病种定义包" })).not.toBeInTheDocument();
  });
});

describe("定义库 on the population tab", () => {
  it("saves a population's definition as a new entry, with the name and the plain-language text", async () => {
    const changed = vi.fn();
    draw(<VcrDefinitionsSection studyId={STUDY_ID} knowledge={knowledgeOf()} canWrite canRun onChanged={changed} />);
    await userEvent.click(screen.getByRole("button", { name: "存入定义库" }));
    const drawer = await screen.findByRole("dialog", { name: "存入定义库" });
    expect(within(drawer).getByLabelText("名称")).toHaveValue("成人 ECOG 0–1");
    const submit = within(drawer).getByRole("button", { name: "存入" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(drawer).getByLabelText("哪些人在里面"), "年龄不小于 18 岁、ECOG 0 或 1。");
    await userEvent.click(submit);
    await waitFor(() => expect(posted("POST", `/vcr/studies/${STUDY_ID}/definitions`)).toHaveLength(1));
    expect(posted("POST", `/vcr/studies/${STUDY_ID}/definitions`)[0][2]).toEqual({ populationId: "pop_1", name: "成人 ECOG 0–1", text: "年龄不小于 18 岁、ECOG 0 或 1。" });
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });

  it("saves as the next version of an existing entry, carrying its id and not a name", async () => {
    draw(<VcrDefinitionsSection studyId={STUDY_ID} knowledge={knowledgeOf()} canWrite canRun onChanged={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "存入定义库" }));
    const drawer = await screen.findByRole("dialog", { name: "存入定义库" });
    await userEvent.selectOptions(await within(drawer).findByLabelText("存为"), "dfn_2");
    expect(within(drawer).queryByLabelText("名称")).not.toBeInTheDocument();
    await userEvent.type(within(drawer).getByLabelText("哪些人在里面"), "加上 ECOG 限制。");
    await userEvent.click(within(drawer).getByRole("button", { name: "存入" }));
    await waitFor(() => expect(posted("POST", `/vcr/studies/${STUDY_ID}/definitions`)).toHaveLength(1));
    expect(posted("POST", `/vcr/studies/${STUDY_ID}/definitions`)[0][2]).toEqual({ populationId: "pop_1", text: "加上 ECOG 限制。", definitionId: "dfn_2" });
  });

  it("uses a library definition in the study and says which columns were renamed and which were left", async () => {
    installVcrServer(network.productRequest, {
      "GET /vcr/definitions": LIBRARY,
      [`POST /vcr/studies/${STUDY_ID}/definitions/dfn_1/use`]: { populationId: "pop_9", version: 3, renamed: [{ from: "AGE", to: "age_years" }], unmatched: ["HOSPITAL"] },
    });
    draw(<VcrDefinitionsSection studyId={STUDY_ID} knowledge={knowledgeOf({ savable: [] })} canWrite canRun={false} onChanged={() => undefined} />);
    const select = await screen.findByLabelText("用定义库里的定义");
    await userEvent.selectOptions(select, "dfn_1");
    await userEvent.selectOptions(await screen.findByLabelText("版本"), "2");
    await userEvent.click(screen.getByRole("button", { name: "用于本研究" }));
    await waitFor(() => expect(posted("POST", `/vcr/studies/${STUDY_ID}/definitions/dfn_1/use`)).toHaveLength(1));
    expect(posted("POST", `/vcr/studies/${STUDY_ID}/definitions/dfn_1/use`)[0][2]).toEqual({ version: 2 });
    expect(toasts.success.mock.calls[0][0]).toContain("已按字段对应改了 1 列");
    expect(toasts.success.mock.calls[0][0]).toContain("HOSPITAL");
  });

  it("asks the engine to compare two different versions of a definition used here, and only offers it to someone who may run", async () => {
    const { rerender } = draw(<VcrDefinitionsSection studyId={STUDY_ID} knowledge={knowledgeOf()} canWrite canRun={false} onChanged={() => undefined} />);
    expect(screen.queryByRole("button", { name: "比较版本" })).not.toBeInTheDocument();
    rerender(<MemoryRouter><VcrDefinitionsSection studyId={STUDY_ID} knowledge={knowledgeOf()} canWrite canRun onChanged={() => undefined} /></MemoryRouter>);
    const compare = screen.getByRole("button", { name: "比较版本" });
    expect(compare).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("比较"), "1");
    await userEvent.selectOptions(screen.getByLabelText("与"), "1");
    expect(compare).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("与"), "3");
    await userEvent.click(compare);
    await waitFor(() => expect(posted("POST", `/vcr/studies/${STUDY_ID}/definitions/dfn_1/compare`)).toHaveLength(1));
    expect(posted("POST", `/vcr/studies/${STUDY_ID}/definitions/dfn_1/compare`)[0][2]).toEqual({ versionA: 1, versionB: 3 });
  });

  it("shows the engine's comparison: both sizes, the overlap, and the covariates ordered by the size of their standardized difference with the large ones flagged", () => {
    const knowledge = knowledgeOf({ comparisons: [{
      id: "res_1", definitionId: "dfn_1", versionA: 1, versionB: 2, snapshotId: "snp_1", cohortSizeA: 417, cohortSizeB: 324, overlap: { both: 324, onlyA: 93, onlyB: 0 }, floor: 0.1,
      covariates: [
        { covariate: "male", kind: "binary", meanA: 0.55, meanB: 0.56, standardizedDifference: 0.018 },
        { covariate: "age", kind: "continuous", meanA: 59.4, meanB: 63.9, standardizedDifference: 0.321 },
        { covariate: "site", skipped: "not_numeric" },
      ],
    }] });
    draw(<VcrDefinitionsSection studyId={STUDY_ID} knowledge={knowledge} canWrite={false} canRun={false} onChanged={() => undefined} />);
    const card = document.querySelector("[data-vcr-comparison='res_1']") as HTMLElement;
    expect(card).toHaveTextContent("v1 保留 417 人");
    expect(card).toHaveTextContent("v2 保留 324 人");
    expect(card).toHaveTextContent("两版都在 324 · 只在 v1 93 · 只在 v2 0");
    const rows = [...card.querySelectorAll("[data-vcr-comparison-row]")].map((row) => row.getAttribute("data-vcr-comparison-row"));
    expect(rows).toEqual(["age", "male", "site"]);
    expect(card.querySelector("[data-vcr-comparison-row='age']")).toHaveTextContent("0.32");
    expect(card.querySelector("[data-vcr-comparison-row='age']")?.className).toContain("bg-warn-soft");
    expect(card.querySelector("[data-vcr-comparison-row='male']")?.className).not.toContain("bg-warn-soft");
    expect(card.querySelector("[data-vcr-comparison-row='site']")).toHaveTextContent("未比较");
  });

  it("renders a comparison card on its own with the definition's name in the title", () => {
    const [comparison] = knowledgeOf({ comparisons: [{ id: "res_2", definitionId: "dfn_1", versionA: 2, versionB: 3, snapshotId: null, cohortSizeA: 10, cohortSizeB: 8, overlap: {}, covariates: [], floor: null }] }).comparisons;
    draw(<ComparisonCard comparison={comparison} name="成人 ECOG 0–1" />);
    expect(screen.getByText("成人 ECOG 0–1：v2 与 v3")).toBeInTheDocument();
  });
});

describe("人群定义库 on the module home", () => {
  it("lists the account's definitions with their versions and uses, and opens one to its versions and the studies that used it", async () => {
    installVcrServer(network.productRequest, {
      "GET /vcr/definitions": LIBRARY,
      "GET /vcr/definitions/dfn_1": { id: "dfn_1", name: "成人 ECOG 0–1", uses: 2,
        versions: [{ version: 3, text: "55 岁及以上。", rules: [{ name: "older" }], packRefs: [{ section: "mappings", id: "m_age", concept: "age" }] }, { version: 1, text: "年龄不小于 18 岁。", rules: [{ name: "adult" }], packRefs: [] }],
        studies: [{ version: 1, studyId: "std_a", studyName: "研究甲", at: null }, { version: 3, studyId: "std_b", studyName: "研究乙", at: null }] },
    });
    draw(<VcrDefinitionsPanel />);
    const entry = await screen.findByText("成人 ECOG 0–1");
    expect(screen.getByText("3 个版本 · 用于 2 个研究")).toBeInTheDocument();
    expect(screen.getByText("EGFR 阳性")).toBeInTheDocument();
    await userEvent.click(entry);
    const versions = await screen.findAllByText(/^v[13]$/);
    expect(versions).toHaveLength(2);
    expect(screen.getByText("55 岁及以上。")).toBeInTheDocument();
    expect(screen.getByText("用过的研究：研究甲、研究乙")).toBeInTheDocument();
    expect(screen.getByText("age")).toBeInTheDocument();
  });

  it("says so when the library is empty, and says the module is off rather than empty when it is", async () => {
    installVcrServer(network.productRequest, { "GET /vcr/definitions": { definitions: [] } });
    const { unmount } = draw(<VcrDefinitionsPanel />);
    expect(await screen.findByText("定义库里还没有定义")).toBeInTheDocument();
    unmount();
    installVcrServer(network.productRequest, { "GET /vcr/definitions": () => { throw Object.assign(new Error("off"), { status: 404, code: "vcr_not_enabled" }); } });
    draw(<VcrDefinitionsPanel />);
    expect(await screen.findByText(/还没有在这个工作空间开放|暂时无法读取/)).toBeInTheDocument();
  });
});

describe("what the study payload carries", () => {
  it("is read into the study and never required: a study without the package reads as no knowledge", () => {
    const base = fixture<Record<string, unknown>>("ev201/study.json");
    const study = readVcrStudy({ ...base, knowledge: undefined });
    expect(study.knowledge).toBeNull();
    const withIt = readVcrStudy({ ...base, knowledge: { pack: { id: "nsclc", status: "curated", counts: {}, sources: [] }, definitions: [], comparisons: [], savable: [] } });
    expect(withIt.knowledge?.pack?.status).toBe("curated");
    // a status the vocabulary does not have is not shown as curated
    expect(readVcrKnowledge({ pack: { id: "x", status: "unknown" } })?.pack?.status).toBe("ai-draft");
  });
});
