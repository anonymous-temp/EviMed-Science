import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { readVcrStudy } from "@/lib/vcrClient";
import { fixture } from "./__fixtures__/serverFixtures";
import { WebApiError } from "@/lib/apiClient";
import { studyBriefKey, readStudyBrief } from "@/lib/vcrStudyBrief";
import { VcrStudyBrief } from "./VcrStudyBrief";
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
const me = vi.hoisted(() => ({ fetchWebMe: vi.fn() }));
const files = vi.hoisted(() => ({ pickFiles: vi.fn(), uploadFilesToWorkspace: vi.fn() }));
vi.mock("@/lib/productClient", () => network);
vi.mock("@/lib/backend", () => files);
vi.mock("@/lib/apiClient", async original => ({ ...(await original<typeof import("@/lib/apiClient")>()), fetchWebMe: me.fetchWebMe }));
const started = vi.fn();
const accepted = { studyId: "s1", sessionId: "canonical", runId: "r1", status: "running", dispatchStatus: "sent", errorCode: null, state: "accepted" };
beforeEach(() => {
  window.localStorage.clear(); vi.clearAllMocks();
  me.fetchWebMe.mockResolvedValue({ user: { id: "u1", tenantId: "t1" } });
  network.productRequest.mockImplementation(async (path, method) => path === "/vcr/studies" && method === "POST" ? { id: "s1", projectId: "p1" } : path.endsWith("/start") ? accepted : {});
});
function draw() { return render(<MemoryRouter><VcrStudyBrief onStarted={started} /></MemoryRouter>); }
it("keeps a short editable brief on navigation and isolates other accounts and tenants", async () => {
  const page = draw();
  await userEvent.type(await screen.findByRole("textbox", { name: "研究问题" }), "我的研究问题");
  page.unmount();
  const resumed = draw();
  expect(await screen.findByRole("textbox", { name: "研究问题" })).toHaveValue("我的研究问题");
  resumed.unmount();
  me.fetchWebMe.mockResolvedValue({ user: { id: "u2", tenantId: "t1" } });
  draw();
  expect(await screen.findByRole("textbox", { name: "研究问题" })).toHaveValue("");
});
it("examples populate meaningful editable optional information, and never allocate on selection", async () => {
  draw();
  await userEvent.click(await screen.findByRole("button", { name: "设计一项研究" }));
  expect((screen.getByRole("textbox", { name: "研究问题" }) as HTMLTextAreaElement).value).toContain("GLP-1");
  await userEvent.click(screen.getByText("补充人群、终点和已有材料（可选）"));
  expect((screen.getByRole("textbox", { name: "目标人群" }) as HTMLInputElement).value).toContain("HbA1c");
  expect(network.productRequest).not.toHaveBeenCalled();
});
it("persists an explicit draft and submits its exact brief once to canonical Start", async () => {
  draw();
  await userEvent.type(await screen.findByRole("textbox", { name: "研究问题" }), "  问题原文\n尚无材料  ");
  await userEvent.click(screen.getByRole("button", { name: "开始研究" }));
  await waitFor(() => expect(started).toHaveBeenCalledWith({ id: "s1", projectId: "p1" }, accepted, expect.any(Function)));
  expect(network.productRequest).toHaveBeenNthCalledWith(1, "/vcr/studies", "POST", { draft: true, name: "问题原文", question: "  问题原文\n尚无材料  " });
  const body = network.productRequest.mock.calls.find(call => call[0] === "/vcr/studies/s1/start")?.[2];
  expect(body).toEqual({ brief: "  问题原文\n尚无材料  ", name: "问题原文", action: "definition", requestId: expect.any(String) });
  expect(network.productRequest.mock.calls.filter(call => call[0].endsWith("/start"))).toHaveLength(1);
});
it("retries an uncertain receipt with the same immutable bytes and key after reload", async () => {
  let attempts = 0;
  network.productRequest.mockImplementation(async path => path === "/vcr/studies" ? { id: "s1", projectId: "p1" } : path.endsWith("/start") ? (++attempts === 1 ? { ...accepted, state: "confirming" } : accepted) : {});
  const page = draw();
  await userEvent.type(await screen.findByRole("textbox", { name: "研究问题" }), "原始简述");
  await userEvent.click(screen.getByRole("button", { name: "开始研究" }));
  await screen.findByText(/正在核实是否已提交/);
  page.unmount(); draw();
  await userEvent.click(await screen.findByRole("button", { name: "核实提交" }));
  await waitFor(() => expect(started).toHaveBeenCalled());
  const calls = network.productRequest.mock.calls.filter(call => call[0].endsWith("/start"));
  expect(calls).toHaveLength(2); expect(calls[0][2]).toEqual(calls[1][2]);
});
it("keeps the remotely saved brief when adding materials fails", async () => {
  files.pickFiles.mockResolvedValue([{ name: "paper.pdf" }]);
  files.uploadFilesToWorkspace.mockRejectedValue(new Error("offline"));
  draw();
  await userEvent.type(await screen.findByRole("textbox", { name: "研究问题" }), "有资料的研究");
  await userEvent.click(screen.getByRole("button", { name: "添加参考材料" }));
  await screen.findByRole("status");
  expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies", "POST", expect.objectContaining({ draft: true, question: expect.stringContaining("有资料的研究") }));
  expect(readStudyBrief(studyBriefKey("u1", "t1"))?.remote).toEqual({ id: "s1", projectId: "p1" });
  expect(started).not.toHaveBeenCalled();
});
it("retains the brief and allows revision after an explicit busy refusal", async () => {
  network.productRequest.mockImplementation(async path => { if (path.endsWith("/start")) throw new WebApiError("busy", { status: 409, code: "vcr_conversation_busy" }); return path === "/vcr/studies" ? { id: "s1", projectId: "p1" } : {}; });
  draw();
  const question = await screen.findByRole("textbox", { name: "研究问题" });
  await userEvent.type(question, "等空闲再开始");
  await userEvent.click(screen.getByRole("button", { name: "开始研究" }));
  await screen.findByRole("status");
  expect(question).toHaveValue("等空闲再开始"); expect(question).not.toBeDisabled(); expect(started).not.toHaveBeenCalled();
});
it("lets materials come first but cancellation allocates nothing", async () => {
  files.pickFiles.mockResolvedValue([]);
  draw();
  await userEvent.click(await screen.findByRole("button", { name: "添加参考材料" }));
  expect(files.pickFiles).toHaveBeenCalledOnce(); expect(network.productRequest).not.toHaveBeenCalled();
});
it("keeps material-only drafts truthful and asks for a question before Start", async () => {
  files.pickFiles.mockResolvedValue([new File(["data"], "reference.pdf")]); files.uploadFilesToWorkspace.mockResolvedValue(["knowledge-base/reference.pdf"]);
  draw();
  await userEvent.click(await screen.findByRole("button", { name: "添加参考材料" }));
  await screen.findByText("材料已加入草稿。请补充想研究什么，再开始研究。");
  expect(screen.getByRole("textbox", { name: "研究问题" })).toHaveValue("");
  expect(screen.getByRole("button", { name: "开始研究" })).toBeDisabled();
  expect(screen.getByRole("list", { name: "研究材料" })).toHaveTextContent("reference.pdf · 已上传");
  expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies", "POST", expect.objectContaining({ draft: true, question: expect.stringContaining("reference.pdf（待上传）") }));
  expect(network.productRequest.mock.calls.some(call => call[0].endsWith("/start"))).toBe(false);
});
it("does not resubmit an accepted Start when opening the conversation fails", async () => {
  started.mockRejectedValueOnce(new Error("navigation failed"));
  draw();
  await userEvent.type(await screen.findByRole("textbox", { name: "研究问题" }), "只提交一次");
  await userEvent.click(screen.getByRole("button", { name: "开始研究" }));
  const reopen = await screen.findByRole("button", { name: "打开研究对话" });
  await userEvent.click(reopen);
  await waitFor(() => expect(started).toHaveBeenCalledTimes(2));
  expect(network.productRequest.mock.calls.filter(call => call[0].endsWith("/start"))).toHaveLength(1);
});
it("retains explicit programme choice with an unsent brief", async () => {
  const page = draw();
  await userEvent.type(await screen.findByRole("textbox", { name: "研究问题" }), "完整研究流程");
  await userEvent.selectOptions(screen.getByLabelText("本次开始"), "auto"); page.unmount(); draw();
  expect(await screen.findByLabelText("本次开始")).toHaveValue("auto");
});

it.each([{ attachments: { length: 1 } }, { attachments: [null] }, { remote: { id: 23, projectId: [] } }, { remote: ["bad"] }, { priorSubmission: { request: { state: "accepted" } } }, { request: {} }, { request: { state: "confirming" } }, { request: { state: "accepted", payload: {} } }])("recovers legitimate text from malformed nested persistence: %j", async extra => {
  window.localStorage.setItem(studyBriefKey("u1", "t1"), JSON.stringify({ fields: { question: "保留问题", population: "", intervention: "", endpoint: "", materials: "", output: "", name: "" }, ...extra }));
  draw();
  expect(await screen.findByRole("textbox", { name: "研究问题" })).toHaveValue("保留问题");
  if ("request" in extra) {
    expect(screen.getByRole("button", { name: "开始研究" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "研究问题" })).not.toBeDisabled();
    expect(screen.getByText(/本地提交记录不完整/)).toBeInTheDocument();
  }
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
it("does not allocate after a picker resolves outside its originating page", async () => {
  const picker = deferred<File[]>(); files.pickFiles.mockReturnValue(picker.promise);
  const page = draw(); await userEvent.click(await screen.findByRole("button", { name: "添加参考材料" }));
  page.unmount(); picker.resolve([new File(["data"], "reference.pdf")]);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(network.productRequest).not.toHaveBeenCalled();
});
it("retains a late created draft but never submits or navigates after leaving", async () => {
  const created = deferred<{ id: string; projectId: string }>(); network.productRequest.mockReturnValue(created.promise);
  const page = draw(); await userEvent.type(await screen.findByRole("textbox", { name: "研究问题" }), "留下创建中的问题");
  await userEvent.click(screen.getByRole("button", { name: "开始研究" }));
  await waitFor(() => expect(network.productRequest).toHaveBeenCalledOnce());
  page.unmount(); created.resolve({ id: "late_study", projectId: "late_project" });
  await waitFor(() => expect(readStudyBrief(studyBriefKey("u1", "t1"))?.remote?.id).toBe("late_study"));
  expect(network.productRequest).toHaveBeenCalledOnce(); expect(started).not.toHaveBeenCalled();
});
it("persists a late accepted receipt only in its original account scope and suppresses handoff", async () => {
  const receipt = deferred<typeof accepted>();
  network.productRequest.mockImplementation(async path => path.endsWith("/start") ? receipt.promise : { id: "s1", projectId: "p1" });
  const page = draw(); await userEvent.type(await screen.findByRole("textbox", { name: "研究问题" }), "账户一的提交");
  await userEvent.click(screen.getByRole("button", { name: "开始研究" }));
  await waitFor(() => expect(network.productRequest.mock.calls.some(call => call[0].endsWith("/start"))).toBe(true));
  page.unmount(); me.fetchWebMe.mockResolvedValue({ user: { id: "u2", tenantId: "t2" } }); draw();
  await userEvent.type(await screen.findByRole("textbox", { name: "研究问题" }), "账户二未提交的问题");
  receipt.resolve(accepted);
  await waitFor(() => expect(readStudyBrief(studyBriefKey("u1", "t1"))?.request?.state).toBe("accepted"));
  expect(started).not.toHaveBeenCalled();
  expect(readStudyBrief(studyBriefKey("u2", "t2"))?.fields.question).toBe("账户二未提交的问题");
  expect(readStudyBrief(studyBriefKey("u2", "t2"))?.request).toBeUndefined();
});
it("does not continue a late upload with cross-scope requests", async () => {
  const uploaded = deferred<string[]>(); files.pickFiles.mockResolvedValue([new File(["data"], "reference.pdf")]); files.uploadFilesToWorkspace.mockReturnValue(uploaded.promise);
  const page = draw(); await userEvent.click(await screen.findByRole("button", { name: "添加参考材料" }));
  await waitFor(() => expect(files.uploadFilesToWorkspace).toHaveBeenCalledOnce());
  page.unmount(); uploaded.resolve(["knowledge-base/reference.pdf"]);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(network.productRequest.mock.calls.some(call => call[1] === "PATCH")).toBe(false);
  expect(started).not.toHaveBeenCalled();
});
it("offers explicit recovery from a deleted remote without replaying Start or claiming files migrated", async () => {
  window.localStorage.setItem(studyBriefKey("u1", "t1"), JSON.stringify({ fields: { question: "原始问题仍在", population: "", intervention: "", endpoint: "", materials: "", output: "", name: "Saved study" }, remote: { id: "deleted", projectId: "old_project" }, attachments: [{ name: "old.csv", state: "uploaded" }] }));
  network.productRequest.mockImplementation(async (path, method) => { if (path.includes("/deleted") && method === "PATCH") throw new WebApiError("gone", { status: 404, code: "vcr_study_not_found" }); return { id: "replacement", projectId: "new_project" }; });
  draw(); await userEvent.click(await screen.findByRole("button", { name: "保存草稿" }));
  await userEvent.click(await screen.findByRole("button", { name: "另存为新草稿" }));
  await waitFor(() => expect(readStudyBrief(studyBriefKey("u1", "t1"))?.remote?.id).toBe("replacement"));
  expect(screen.getByRole("textbox", { name: "研究问题" })).toHaveValue("原始问题仍在");
  expect(screen.getByRole("list", { name: "研究材料" })).not.toHaveTextContent("已上传");
  expect(network.productRequest.mock.calls.some(call => call[0].endsWith("/start"))).toBe(false);
});

it("saves a data-first draft and hands off to protected intake without a question, generic upload or Start", async () => {
  const data = vi.fn();
  render(<MemoryRouter><VcrStudyBrief onStarted={started} onDataRequested={data} /></MemoryRouter>);
  await userEvent.click(await screen.findByRole("button", { name: "保存草稿并接入研究数据" }));
  await waitFor(() => expect(data).toHaveBeenCalledWith({ id: "s1", projectId: "p1" }, expect.any(Function)));
  expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies", "POST", { draft: true, name: "新研究", question: "" });
  expect(files.pickFiles).not.toHaveBeenCalled(); expect(files.uploadFilesToWorkspace).not.toHaveBeenCalled();
  expect(network.productRequest.mock.calls.some(call => call[0].endsWith("/start"))).toBe(false);
  expect(readStudyBrief(studyBriefKey("u1", "t1", "s1"))?.fields.question).toBe("");
});
it("routes the existing-data example to protected intake and preserves its structured brief in the study scope", async () => {
  const data = vi.fn();
  render(<MemoryRouter><VcrStudyBrief onStarted={started} onDataRequested={data} /></MemoryRouter>);
  await userEvent.click(await screen.findByRole("button", { name: "分析已有数据" }));
  const question = (screen.getByRole("textbox", { name: "研究问题" }) as HTMLTextAreaElement).value;
  expect(screen.getByRole("button", { name: "添加参考材料" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "保存草稿并接入研究数据" }));
  await waitFor(() => expect(data).toHaveBeenCalledOnce());
  expect(files.uploadFilesToWorkspace).not.toHaveBeenCalled(); expect(started).not.toHaveBeenCalled();
  const saved = readStudyBrief(studyBriefKey("u1", "t1", "s1"));
  expect(saved?.fields.question).toBe(question); expect(saved?.fields.materials).toContain("研究数据接入");
});
it("does not send selected research tables through the public-reference uploader", async () => {
  files.pickFiles.mockResolvedValue([new File(["patient,followup"], "followup.csv")]);
  const data = vi.fn();
  render(<MemoryRouter><VcrStudyBrief onStarted={started} onDataRequested={data} /></MemoryRouter>);
  await userEvent.click(await screen.findByRole("button", { name: "添加参考材料" }));
  await screen.findByText(/所选研究数据尚未上传/);
  expect(files.uploadFilesToWorkspace).not.toHaveBeenCalled(); expect(network.productRequest).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "保存草稿并接入研究数据" }));
  await waitFor(() => expect(data).toHaveBeenCalledOnce());
  expect(files.uploadFilesToWorkspace).not.toHaveBeenCalled();
});
it("starts for an ordinary collaborator without sending a rename that requires study management", async () => {
  const study = readVcrStudy({ ...fixture<Record<string, unknown>>("empty/study.json"), id: "s1", projectId: "p1", question: "团队研究问题", name: "Team study", abilities: ["read", "write", "run"] });
  render(<MemoryRouter><VcrStudyBrief study={study} onStarted={started} /></MemoryRouter>);
  await userEvent.click(await screen.findByRole("button", { name: "开始研究" }));
  await waitFor(() => expect(started).toHaveBeenCalled());
  expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/s1", "PATCH", { question: "团队研究问题" });
  const payload = network.productRequest.mock.calls.find(call => call[0].endsWith("/start"))?.[2];
  expect(payload).not.toHaveProperty("name"); expect(payload).toHaveProperty("brief", "团队研究问题");
});

it("normalizes bounded attachment records and never carries uploaded claims without a remote binding", async () => {
  window.localStorage.setItem(studyBriefKey("u1", "t1"), JSON.stringify({ fields: { question: "保留资料说明" }, attachments: [null, { name: "reference.pdf", state: "uploaded" }, { name: 3 }, { name: "x".repeat(513), state: "selected" }] }));
  draw();
  expect(await screen.findByRole("textbox", { name: "研究问题" })).toHaveValue("保留资料说明");
  const materials = screen.getByRole("list", { name: "研究材料" });
  expect(materials.children).toHaveLength(1); expect(materials).toHaveTextContent("reference.pdf · 待上传");
});
it("restores structured question and fields on return to the saved study instead of the serialized material status", async () => {
  files.pickFiles.mockResolvedValue([new File(["reference"], "paper.pdf")]); files.uploadFilesToWorkspace.mockResolvedValue(["knowledge-base/paper.pdf"]);
  const data = vi.fn();
  const page = render(<MemoryRouter><VcrStudyBrief onStarted={started} onDataRequested={data} /></MemoryRouter>);
  await userEvent.type(await screen.findByRole("textbox", { name: "研究问题" }), "保持原始研究问题");
  await userEvent.click(screen.getByRole("button", { name: "添加参考材料" }));
  await screen.findByText("材料已加入研究，尚未开始。");
  await userEvent.click(screen.getByRole("button", { name: "保存草稿并接入研究数据" }));
  await waitFor(() => expect(data).toHaveBeenCalledOnce()); page.unmount();
  const study = readVcrStudy({ ...fixture<Record<string, unknown>>("empty/study.json"), id: "s1", projectId: "p1", name: "Saved study", question: "保持原始研究问题\n\n材料文件：paper.pdf（已上传）", abilities: ["read", "write", "run", "manage_study"] });
  render(<MemoryRouter><VcrStudyBrief study={study} onStarted={started} onDataRequested={data} /></MemoryRouter>);
  expect(await screen.findByRole("textbox", { name: "研究问题" })).toHaveValue("保持原始研究问题");
  expect(screen.getByRole("list", { name: "研究材料" })).toHaveTextContent("paper.pdf · 已上传");
});

it.each(["confirming", "accepted"])("retains corrupted %s submission identity through examples, text and action edits", async state => {
  const key = studyBriefKey("u1", "t1");
  window.localStorage.setItem(key, JSON.stringify({ fields: { question: "原始问题" }, remote: { id: "original", projectId: "original_project" }, request: { state }, missingRemote: true, priorSubmission: { studyId: "prior", recovery: { state: "unknown", studyId: "prior" } } }));
  const before = readStudyBrief(key);
  draw();
  await userEvent.click(await screen.findByRole("button", { name: "设计一项研究" }));
  expect(screen.getByRole("button", { name: "开始研究" })).toBeDisabled();
  const question = screen.getByRole("textbox", { name: "研究问题" });
  await userEvent.clear(question); await userEvent.type(question, "只修改内容，不重置提交");
  await userEvent.selectOptions(screen.getByLabelText("本次开始"), "auto");
  const after = readStudyBrief(key);
  expect(after?.fields.question).toBe("只修改内容，不重置提交"); expect(after?.action).toBe("auto");
  expect(after?.recovery).toEqual(before?.recovery); expect(after?.missingRemote).toBe(true);
  expect(after?.priorSubmission).toEqual(before?.priorSubmission); expect(after?.remote).toEqual(before?.remote);
  expect(screen.getByRole("button", { name: "开始研究" })).toBeDisabled(); expect(network.productRequest).not.toHaveBeenCalled();
});
