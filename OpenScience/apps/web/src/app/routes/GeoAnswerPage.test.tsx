import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { answerFilled, evidenceFilled, geoProject } from "@/components/geo/__fixtures__/geoTabs";
import { GeoFrameHarness } from "@/components/geo/__fixtures__/geoFrameHarness";
import { actionFixture, actionsFilled, clustersFilled, clusterViewFixture, G_BRAND, questionSetFixture } from "@/components/geo/__fixtures__/geoSpine";
import { GeoAnswerPage } from "./GeoAnswerPage";

const client = vi.hoisted(() => ({
  getGeoAnswer: vi.fn(),
  getGeoEvidence: vi.fn(),
  getGeoProject: vi.fn(),
  getGeoActions: vi.fn(),
  getGeoQuestions: vi.fn(),
  getGeoClusters: vi.fn(),
  getGeoCluster: vi.fn(),
  getGeoArticles: vi.fn(),
}));
const conversation = vi.hoisted(() => ({ open: vi.fn(async () => true) }));
vi.mock("@/components/geo/useOpenGeoConversation", () => ({ useOpenGeoConversation: () => conversation.open }));
vi.mock("@/lib/geoClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geoClient")>()),
  ...client,
}));

function Probe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

/** The answer in the place the layout gives it: the band's toolbar above it, the project's cache under it. */
function renderAnswer(snapshotId = "snap_deepseek", search = "") {
  return render(
    <MemoryRouter initialEntries={[`/app/geo/geo_1/answers/${snapshotId}${search}`]}>
      <Routes>
        <Route path="/app/geo/:geoId/answers/:snapshotId" element={<><GeoFrameHarness project={geoProject()} tab="questions"><GeoAnswerPage /></GeoFrameHarness><Probe /></>} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  client.getGeoAnswer.mockReset().mockResolvedValue(answerFilled);
  client.getGeoEvidence.mockReset().mockResolvedValue(evidenceFilled);
  client.getGeoProject.mockReset().mockResolvedValue(geoProject());
  client.getGeoActions.mockReset().mockResolvedValue({ ...actionsFilled, actions: [] });
  client.getGeoQuestions.mockReset().mockResolvedValue(questionSetFixture());
  client.getGeoClusters.mockReset().mockResolvedValue(clustersFilled);
  client.getGeoCluster.mockReset().mockImplementation(async (_geoId: string, id: string) => clusterViewFixture(id));
  client.getGeoArticles.mockReset().mockResolvedValue({ articles: [] });
  conversation.open.mockClear();
});

describe("one answer", () => {
  it("heads the page with the way back, the question and its one action; the date switcher and the screenshot are the band's toolbar", async () => {
    renderAnswer();
    expect(await screen.findByRole("heading", { level: 2, name: "打了减重针一直恶心，要不要停药？" })).toBeInTheDocument();
    // Opened from a link, there is no list to go back to: the way back is the tab that holds the finding.
    expect(screen.getByRole("link", { name: "返回准确与安全" })).toHaveAttribute("href", "/app/geo/geo_1/accuracy");
    expect(screen.getByRole("link", { name: /截图/ })).toHaveAttribute("href", expect.stringContaining(`/geo/projects/geo_1/screenshots/${"a".repeat(64)}`));
    // The header's controls are the primitives' sizes: the way back is the
    // 36 px icon button, 截图 the 28 px text button beside the 28 px chip.
    expect(screen.getByRole("link", { name: "返回准确与安全" })).toHaveClass("h-control", "w-9");
    expect(screen.getByRole("link", { name: /截图/ })).toHaveClass("h-sm");
    // the controls above what they control: both are in the toolbar, not in the page's body
    const toolbar = document.querySelector("[data-toolbar]") as HTMLElement;
    expect(toolbar).toContainElement(screen.getByRole("link", { name: /截图/ }));
    expect(toolbar).toContainElement(screen.getByRole("button", { name: /测量日期/ }));
    // the page has one primary action: with a wrong sentence in the answer it is the correction
    expect(screen.getAllByRole("button").filter((button) => button.hasAttribute("data-geo-answer-primary"))).toHaveLength(1);
    expect(screen.getByRole("button", { name: "写纠错稿" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /测量日期/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "9月22日" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/geo/geo_1/answers/snap_deepseek_old");
  });

  it("goes back to the list as the reader left it when they came from inside the app, even after switching engine or day", async () => {
    render(
      <MemoryRouter initialEntries={["/app/geo/geo_1/accuracy?show=open"]}>
        <Routes>
          <Route path="/app/geo/geo_1/accuracy" element={<><Link to="/app/geo/geo_1/answers/snap_deepseek">看回答</Link><Probe /></>} />
          <Route path="/app/geo/:geoId/answers/:snapshotId" element={<><GeoAnswerPage /><Probe /></>} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("link", { name: "看回答" }));
    await screen.findByRole("heading", { level: 2, name: "打了减重针一直恶心，要不要停药？" });
    // Another engine's answer replaces this one in the history instead of piling on it.
    await userEvent.click(within(screen.getByRole("navigation", { name: "AI 引擎" })).getByRole("link", { name: /元宝/ }));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/geo/geo_1/answers/snap_yuanbao");
    await userEvent.click(await screen.findByRole("button", { name: "返回" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/geo/geo_1/accuracy?show=open");
  });

  it("with no finding to read, the way back is the questions", async () => {
    client.getGeoAnswer.mockResolvedValue({ ...answerFilled, errors: [], facts: { ...answerFilled.facts!, statements: [] } });
    renderAnswer();
    expect(await screen.findByRole("link", { name: "返回问题与回答" })).toHaveAttribute("href", "/app/geo/geo_1/questions");
  });

  // The answer is read inside the project's band: the browser tab's name and the page's one `h1` are the layout's
  // (`GeoProjectPage.test.tsx` holds them), so this page draws no title of its own.
  it("draws no title of the document and no page-level heading: the layout's band is above it", async () => {
    renderAnswer();
    await screen.findByRole("heading", { level: 2, name: "打了减重针一直恶心，要不要停药？" });
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(document.title).not.toContain("AI 回答监测");
  });

  it("reads the judge's findings against the card claims in their order, as lines of text and never a stop", async () => {
    client.getGeoAnswer.mockResolvedValue({
      ...answerFilled,
      facts: {
        ...answerFilled.facts,
        specifiedInfo: { correct: 3, wrong: 1, decided: 4, rate: 0.75, byTopic: { dosage: { correct: 1, wrong: 1 }, indication: { correct: 2, wrong: 0 }, contraindication: { correct: 0, wrong: 0 }, adverse_reaction: { correct: 0, wrong: 0 } } },
        checks: {
          offLabel: ["也可以用于青少年减重"],
          omittedSafety: [{ claimId: "gcl_1", claimKey: "contra", cardId: "ec_1", cardClaimId: "contra", cardRevision: 3 }],
          citations: [
            { link: "L1", url: "https://example.org/a", statement: "每周一次", exists: true, supports: "no", evidence: "每日一次" },
            { link: "L2", url: "https://example.org/gone", statement: "每周一次", exists: false, supports: null, evidence: null },
            { link: "L3", url: "https://example.org/unchecked", statement: "每周一次", exists: null, supports: null, evidence: null },
          ],
        },
      },
    });
    renderAnswer();
    const section = await screen.findByRole("region", { name: "对照卡片结论的核对" });
    expect(within(section).getByText(/指定信息：判定 4 句，讲对 3 句，讲错 1 句；适应证 对 2 错 0；用法用量 对 1 错 1/)).toBeInTheDocument();
    expect(within(section).getByText("超出说明书的说法：“也可以用于青少年减重”")).toBeInTheDocument();
    expect(within(section).getByText("漏掉了 1 条说明书上的安全信息")).toBeInTheDocument();
    expect(within(section).getByText(/页面里说的不一样/)).toBeInTheDocument();
    expect(within(section).getByText(/打不开或已不存在/)).toBeInTheDocument();
    expect(within(section).queryByText(/unchecked/)).not.toBeInTheDocument();
  });

  it("draws nothing for an answer the judge has no findings about", async () => {
    renderAnswer();
    await screen.findByRole("heading", { level: 2, name: "打了减重针一直恶心，要不要停药？" });
    expect(screen.queryByRole("region", { name: "对照卡片结论的核对" })).not.toBeInTheDocument();
  });

  it("lists the engines asked the same question, with what each answer did", async () => {
    renderAnswer();
    const nav = await screen.findByRole("navigation", { name: "AI 引擎" });
    const deepseek = within(nav).getByText("DeepSeek").closest("[data-geo-sibling]") as HTMLElement;
    expect(within(deepseek).getByText("讲错 1 处")).toHaveClass("text-danger");
    expect(within(nav).getByRole("link", { name: /元宝.*提及 · 引用你/ })).toHaveAttribute("href", "/app/geo/geo_1/answers/snap_yuanbao");
    expect(within(nav).getByText("未提及")).toBeInTheDocument();
    expect(within(nav).getByText("未测")).toBeInTheDocument();
  });

  it("marks the wrong sentence with a wavy red line and says beneath it, in one line, what is right and where the handling stands", async () => {
    renderAnswer();
    const wrong = await waitFor(() => {
      const found = document.querySelector("[data-geo-wrong]");
      if (!found) throw new Error("not yet");
      return found as HTMLElement;
    });
    expect(wrong).toHaveTextContent("它需要每天注射一次");
    expect(wrong).toHaveClass("decoration-wavy", "decoration-danger");
    expect(screen.getAllByText("玛仕度肽", { selector: "strong" }).length).toBeGreaterThan(0);

    const correction = document.querySelector("[data-geo-correction]") as HTMLElement;
    // The correction sits right under the paragraph that says it.
    expect(wrong.closest("p")?.nextElementSibling).toBe(correction);
    await waitFor(() => expect(correction).toHaveTextContent("讲错我方：对的是每周一次皮下注射，从低剂量起始，按说明书逐步增加剂量。"));
    expect(correction).toHaveTextContent("处置中");
    // The detail is the claim's record, not a block of the answer's text
    expect(correction).not.toHaveTextContent("依据：");
    expect(correction).not.toHaveTextContent("出处：");
  });

  it("opens the claim's record from that line, with the label, the basis, each engine's words, where this one took it from and the handling", async () => {
    renderAnswer();
    const open = await screen.findByRole("button", { name: /对的是每周一次/ });
    await userEvent.click(open);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("?error="));
    const drawer = await screen.findByRole("dialog");
    const record = drawer.querySelector("[data-geo-error-drawer]") as HTMLElement;
    expect(record).toHaveTextContent("它需要每天注射一次");
    expect(record.querySelector("[data-geo-error-basis]")).toHaveTextContent("依据：玛仕度肽注射液说明书（国家药监局 2025）");
    expect(record.querySelector("[data-geo-error-source='baike.baidu.com']")).not.toBeNull();
    expect(record).toHaveTextContent("修改百科词条");
    // the engines' words are the way to the answers; the one on this page leads back here
    expect(within(record).getByRole("link", { name: /它需要每天注射一次/ })).toHaveAttribute("href", "/app/geo/geo_1/answers/snap_deepseek");
  });

  it("names a claim's source in the reader's words, never by its internal address (G14)", async () => {
    client.getGeoEvidence.mockResolvedValue({
      ...evidenceFilled,
      claims: evidenceFilled.claims.map((claim) => (claim.id === "clm_1" ? { ...claim, sourceRef: "web-page:e1edc04a1ac28750", sourceLabel: null } : claim)),
    });
    renderAnswer("snap_deepseek", "?error=err_1");
    const drawer = await screen.findByRole("dialog");
    await waitFor(() => expect(drawer.querySelector("[data-geo-error-drawer]")).not.toBeNull());
    expect(drawer).not.toHaveTextContent("web-page:");
    expect(drawer.querySelector("[data-geo-error-basis]")).toBeNull();
  });

  it("offers the correction as the page's action, with the brief in the conversation unsent", async () => {
    renderAnswer();
    await userEvent.click(await screen.findByRole("button", { name: "写纠错稿" }));
    await waitFor(() => expect(conversation.open).toHaveBeenCalledTimes(1));
    const [target, brief] = conversation.open.mock.calls[0] as unknown as [{ projectId: string; sessionId: string | null }, string];
    expect(target).toEqual({ projectId: "prj_geo_1", sessionId: null });
    expect(brief).toContain("它需要每天注射一次");
  });

  it("with nothing wrong in the answer, the one action is to talk it over", async () => {
    client.getGeoAnswer.mockResolvedValue({ ...answerFilled, errors: [], facts: { ...answerFilled.facts!, statements: [] } });
    renderAnswer();
    await userEvent.click(await screen.findByRole("button", { name: "在对话中处理" }));
    await waitFor(() => expect(conversation.open).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "写纠错稿" })).not.toBeInTheDocument();
  });

  it("names the question's group as a link that opens the group's record in place", async () => {
    // the answer's question is one the question set holds under the brand group
    client.getGeoAnswer.mockResolvedValue({ ...answerFilled, question: { ...answerFilled.question, id: "q_brand_1" } });
    renderAnswer();
    const link = await screen.findByRole("link", { name: "品牌身份、规格与厂家" });
    expect(link).toHaveAttribute("data-geo-cluster-link", G_BRAND);
    await userEvent.click(link);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`group=${G_BRAND}`));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("the actions that name the claim's rows are its correction in the record", async () => {
    client.getGeoActions.mockResolvedValue({
      ...actionsFilled,
      actions: [actionFixture({ key: "correct_error:g:a", kind: "correct_error", need: { ...actionFixture({ key: "k", kind: "maintain" }).need, errorIds: ["err_1"] }, status: "writing" })],
    });
    renderAnswer("snap_deepseek", "?error=err_1");
    const drawer = await screen.findByRole("dialog");
    await waitFor(() => expect(drawer.querySelector("[data-geo-error-action]")).not.toBeNull());
  });

  it("lists a citation that came back without a link, and says it has none (G8)", async () => {
    client.getGeoAnswer.mockResolvedValue({
      ...answerFilled,
      snapshot: { ...answerFilled.snapshot, citations: [...answerFilled.snapshot.citations, { url: null, domain: null, title: "减重针的常见副作用", inBody: true }] },
    });
    renderAnswer();
    const cited = await screen.findByRole("region", { name: "引用的信源" });
    const row = within(cited).getByText("减重针的常见副作用").closest("li") as HTMLElement;
    expect(within(row).getByText("没有链接")).toBeInTheDocument();
    expect(within(row).queryByRole("link")).not.toBeInTheDocument();
  });

  it("lists the cited sources, with those not used in the body said so", async () => {
    renderAnswer();
    const cited = await screen.findByRole("region", { name: "引用的信源" });
    expect(within(cited).getAllByRole("listitem")).toHaveLength(3);
    expect(within(cited).getByText("只列在参考资料")).toBeInTheDocument();
    expect(within(cited).getByRole("link", { name: "打开玛仕度肽" })).toHaveAttribute("href", "https://baike.baidu.com/item/x");
    expect(within(cited).getByRole("link", { name: "打开玛仕度肽" })).toHaveClass("h-sm", "w-7");
  });

  it("says a 百度 answer is mention-only", async () => {
    client.getGeoAnswer.mockResolvedValue({
      ...answerFilled,
      snapshot: { ...answerFilled.snapshot, engine: "baidu", answerText: null, surface: { mode: "inclusion" }, screenshot: false, citations: [] },
      errors: [],
      facts: { brands: [{ name: "玛仕度肽", ours: true, competitor: false, position: null, inRecommendation: false, count: 1 }], statements: [] },
    });
    renderAnswer();
    expect(await screen.findByText("只测提及：回答里提到了我们的产品。")).toBeInTheDocument();
  });

  it("opens on the sentence it is about: says whose answer it is, brings the wrong one to the top of the page, and can do it again", async () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    scroll.mockClear();
    renderAnswer();
    expect(await screen.findByText("DeepSeek 的原回答，标红处与说明书不一致。")).toBeInTheDocument();
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
    // outside a layout there is no page ground to move: the browser's own scroll is the fallback (`scrollBlockToTop`)
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    expect(scroll.mock.contexts[0]).toBe(document.querySelector("[data-geo-wrong]"));
    await userEvent.click(screen.getByRole("button", { name: "看第 1 处" }));
    expect(scroll).toHaveBeenCalledTimes(2);
    scroll.mockRestore();
  });

  it("says nothing about a mark when the answer has no wrong sentence", async () => {
    client.getGeoAnswer.mockResolvedValue({ ...answerFilled, errors: [], facts: { ...answerFilled.facts!, statements: [] } });
    renderAnswer();
    await screen.findByRole("heading", { level: 2, name: "打了减重针一直恶心，要不要停药？" });
    expect(screen.queryByText(/标红处与说明书不一致/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "看第 1 处" })).not.toBeInTheDocument();
  });

  it("marks the platform's finding as its own, apart from the engine's words", async () => {
    renderAnswer();
    const correction = await waitFor(() => {
      const found = document.querySelector("[data-geo-correction]") as HTMLElement | null;
      if (!found) throw new Error("not yet");
      return found;
    });
    expect(within(correction).getByText("核查")).toBeInTheDocument();
  });

  it("never prints in the answer a sentence the answer does not hold: the live case (an older quote of the same claim)", async () => {
    // Kimi's answer ends 「…帮家人了解？」. The error row's quote is the first sentence this claim was seen as, in an older answer.
    const stale = {
      ...answerFilled.errors[0], id: "err_stale", statement: "禁忌/慎用：个人或家族有甲状腺髓样癌", claimId: "clm_1",
      firstSnapshotId: "snap_old", snapshotId: "snap_deepseek", createdAt: "2026-09-25T00:00:00Z",
    };
    client.getGeoAnswer.mockResolvedValue({ ...answerFilled, errors: [stale] });
    renderAnswer();
    await screen.findByRole("heading", { level: 2, name: "打了减重针一直恶心，要不要停药？" });
    const article = document.querySelector("[data-geo-answer]") as HTMLElement;
    // The answer's own wrong sentence is marked; the row about the same claim speaks for it and adds no second block or sentence.
    await waitFor(() => expect(article.querySelectorAll("[data-geo-wrong]")).toHaveLength(1));
    expect(article.querySelectorAll("[data-geo-correction]")).toHaveLength(1);
    expect(within(article.querySelector("[data-geo-answer-note]")!.parentElement!).queryByText(/甲状腺髓样癌/)).not.toBeInTheDocument();
    expect(screen.queryByText(/更早的回答里也出现过/)).not.toBeInTheDocument();
  });

  it("lists a row about another claim, from an earlier answer, apart from the text — with the day and where it was said", async () => {
    const earlier = {
      ...answerFilled.errors[0], id: "err_old", statement: "孕妇可以放心使用", claimId: "clm_9", firstSnapshotId: "snap_old", snapshotId: "snap_old",
      createdAt: "2026-09-25T00:00:00Z", status: "closed" as const,
    };
    client.getGeoAnswer.mockResolvedValue({ ...answerFilled, errors: [...answerFilled.errors, earlier] });
    renderAnswer();
    const summary = await screen.findByText("更早的回答里也出现过（1 条）");
    const folded = summary.closest("details") as HTMLElement;
    expect(folded).not.toHaveAttribute("open");
    expect(folded).toHaveTextContent("“孕妇可以放心使用”");
    expect(folded).toHaveTextContent("9月25日");
    expect(within(folded).getByRole("link", { name: "看那次回答" })).toHaveAttribute("href", "/app/geo/geo_1/answers/snap_old");
    // Not in the answer: it neither underlines nor corrects anything there.
    const article = document.querySelector("[data-geo-answer]") as HTMLElement;
    expect(article.querySelectorAll("[data-geo-wrong]")).toHaveLength(1);
    expect(article.querySelectorAll("[data-geo-correction]")).toHaveLength(1);
  });

  it("is one correction for a claim two sources contradicted", async () => {
    const second = { ...answerFilled.errors[0], id: "err_b", citedSource: { url: null, domain: "zhihu.com", attribute: "farm" as const } };
    client.getGeoAnswer.mockResolvedValue({ ...answerFilled, errors: [...answerFilled.errors, second] });
    renderAnswer();
    await waitFor(() => expect(document.querySelectorAll("[data-geo-correction]")).toHaveLength(1));
    expect(document.querySelectorAll("[data-geo-wrong]")).toHaveLength(1);
    expect(screen.queryByText(/更早的回答里也出现过/)).not.toBeInTheDocument();
  });

  it("says an answer that is not there", async () => {
    client.getGeoAnswer.mockRejectedValue(new WebApiError("not found", { status: 404, code: "not_found" }));
    renderAnswer();
    expect(await screen.findByText("这条回答不存在或已删除。")).toBeInTheDocument();
  });
});
