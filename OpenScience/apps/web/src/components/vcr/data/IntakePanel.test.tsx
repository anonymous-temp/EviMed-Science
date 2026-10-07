import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { readVcrStudy, type VcrStudy } from "@/lib/vcrClient";
import { fixture, installVcrServer, STUDY_ID } from "../__fixtures__/serverFixtures";
import { DataTab } from "../tabs/DataTab";

// Only the network is doubled: `productRequest` for the JSON routes and
// `fetchWithWebAuth` for the upload. The readers, the route functions and the
// components are the real ones, and every page is the server's own fixture —
// `vcrIntakeView.integration.test.mjs` walks a study through the real intake
// and fails if the service sends a byte that is not in these files.
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);

const upload = vi.hoisted(() => ({ fetchWithWebAuth: vi.fn() }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/apiClient")>()), fetchWithWebAuth: upload.fetchWithWebAuth }));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

vi.mock("@/lib/projects", () => ({
  useProjectStore: { getState: () => ({ projects: [{ id: "prj_ev201" }], select: vi.fn(), load: vi.fn() }) },
}));

const DATA = `/vcr/studies/${STUDY_ID}/data`;

// A tier that takes real data: the intake is the tab's first section, under its own heading. (At T0 it is one folded line, `DataTab.test.tsx`.)
function study(change?: (raw: any) => void): VcrStudy {
  const raw = fixture("ev201/study.json");
  raw.tier = "T2";
  change?.(raw);
  return readVcrStudy(raw);
}

function drawTab(change?: (raw: any) => void) {
  return render(
    <MemoryRouter initialEntries={[`/app/virtual-research/${STUDY_ID}/data`]}>
      <Routes>
        <Route path="/app/virtual-research/:studyId/:tab?" element={<DataTab studyId={STUDY_ID} study={study(change)} />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The page the server sends now: a function, so a test can change what the next read answers. */
let page: any;
let server: ReturnType<typeof installVcrServer>;
const load = (name: string, change?: (raw: any) => void) => {
  page = fixture(`intake/${name}`);
  change?.(page);
};

beforeEach(() => {
  load("data-sealed.json");
  server = installVcrServer(network.productRequest, { [`GET ${DATA}`]: () => structuredClone(page) });
  upload.fetchWithWebAuth.mockReset();
  toasts.success.mockReset();
  toasts.error.mockReset();
});

const writes = () => server.calls.filter((call) => call.method !== "GET");
const source = (name: string) => screen.getByText(name, { selector: "h2" }).closest("[data-vcr-source]") as HTMLElement;

describe("数据接入 — what the page shows", () => {
  it("shows each source with its files, its map's state, its snapshot and the seal standing, and nothing of a patient", async () => {
    drawTab();
    expect(await screen.findByRole("heading", { name: "数据接入" })).toBeInTheDocument();
    const seal = document.querySelector("[data-vcr-seal]") as HTMLElement;
    expect(within(seal).getByText("封存中")).toBeInTheDocument();
    expect(within(seal).getAllByText("尚未冻结").length).toBe(1);
    expect(within(seal).getByText("尚未读取")).toBeInTheDocument();
    expect(within(seal).getByText("分析计划尚未冻结：结局字段仍处于封存状态。")).toBeInTheDocument();

    expect(source("合作方基线")).toBeTruthy();
    expect(screen.getAllByText("cohort.csv").length).toBeGreaterThan(0);
    expect(screen.getAllByText("visits.csv").length).toBeGreaterThan(0);
    expect(screen.getAllByText("已确认").length).toBeGreaterThan(0);
    expect(screen.getByText("快照 v1")).toBeInTheDocument();
    expect(screen.getByText("结局封存中")).toBeInTheDocument();
    expect(screen.getByText(/封存的列：OS_DEAD、OS_MONTHS/)).toBeInTheDocument();
    expect(screen.getByText(/事件表 \d+ 行 · 含结局/)).toBeInTheDocument();
    expect(screen.getByText("一致性 10 项")).toBeInTheDocument();
    // A second source still being mapped, with the server's own list of what is wrong with its map.
    expect(screen.getByText("医院随访表")).toBeInTheDocument();
    expect(screen.getByText("followup.csv 要派生分析表，需要标出哪一列是受试者编号。")).toBeInTheDocument();
    // The revoked grant is kept and said so.
    expect(screen.getByText(/已于 .* 撤销/)).toBeInTheDocument();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("HZ-30001");
    expect(text).not.toMatch(/\/tmp|vcr-intake-view/);
  });

  it("shows both timestamps and the lifted seal once the plan is frozen and an outcome has been read", async () => {
    load("data-lifted.json");
    drawTab();
    await screen.findByText("结局封存");
    const seal = document.querySelector("[data-vcr-seal]") as HTMLElement;
    expect(within(seal).getByText("已解除")).toBeInTheDocument();
    expect(within(seal).getByText("昨天 16:00")).toBeInTheDocument();
    expect(within(seal).getByText("昨天 17:30")).toBeInTheDocument();
    expect(within(seal).getByText(/已读取的结局列：OS_DEAD、OS_MONTHS/)).toBeInTheDocument();
    expect(within(seal).queryByText("结局先于计划冻结被读取")).not.toBeInTheDocument();
    expect(screen.getByText("封存已解除")).toBeInTheDocument();
    // An outcome read before the plan froze is said in so many words.
    load("data-lifted.json", (raw) => { raw.intake.seal.ordered = false; });
    drawTab();
    expect(await screen.findAllByText("结局先于计划冻结被读取")).not.toHaveLength(0);
  });

  it("a member with no grant sees a source's name and state, and neither its columns nor a control", async () => {
    load("data-viewer.json");
    drawTab();
    await screen.findByRole("heading", { name: "数据接入" });
    expect(screen.getByText("合作方基线")).toBeInTheDocument();
    expect(screen.getAllByText(/你还没有读取这个数据源的授权/).length).toBe(2);
    expect(screen.queryByLabelText("选择要上传的文件")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "冻结快照" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "登记" })).not.toBeInTheDocument();
    expect(screen.queryByText("PATIENT_NO")).not.toBeInTheDocument();
  });

  it("a study with the plane composed and nothing uploaded offers 登记数据源; one with no plane says why, in the plane's own words", async () => {
    load("data-none.json");
    const { unmount } = drawTab();
    expect(await screen.findByText(/还没有数据源。登记一个/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登记" })).toBeDisabled();
    unmount();
    load("data-sealed.json", (raw) => { raw.intake = { available: false, message: "本部署未接入数据平面，暂不能接入患者级数据。", sources: [], snapshots: [] }; });
    drawTab((raw) => { raw.tier = "T2"; });
    expect(await screen.findByText("本部署未接入数据平面，暂不能接入患者级数据。")).toBeInTheDocument();
  });

  it("a payload with no intake block at all is a tab, not a crash", async () => {
    load("data-sealed.json", (raw) => { delete raw.intake; });
    drawTab();
    expect(await screen.findByRole("button", { name: /让 AI 做|开始/ }).catch(() => null)).toBeDefined();
    expect(screen.queryByRole("heading", { name: "数据接入" })).not.toBeInTheDocument();
  });
});

describe("数据接入 — what the page sends", () => {
  /** A file dialog filters by extension; a dropped file or an "all files" choice does not, so the page checks for itself. */
  const person = () => userEvent.setup({ applyAccept: false });

  it("registers a source with exactly the route's body", async () => {
    load("data-none.json");
    drawTab();
    await userEvent.type(await screen.findByLabelText("名称"), "合作方基线");
    await userEvent.type(screen.getByLabelText("数据方"), "合作方医院");
    await userEvent.click(screen.getByRole("button", { name: "登记" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      method: "POST", path: `${DATA}/sources`,
      body: { name: "合作方基线", ownerParty: "合作方医院", allowedUses: ["vcr"], valueSource: "observed" },
    });
    expect(Object.keys(writes()[0].body as object).sort()).toEqual(["allowedUses", "name", "ownerParty", "valueSource"]);
  });

  it("refuses on the page an upload the plane would refuse, and streams one it would not", async () => {
    drawTab();
    const chooser = (await screen.findAllByLabelText("选择要上传的文件"))[0] as HTMLInputElement;
    await person().upload(chooser, new File(["x"], "cohort.parquet"));
    expect(await screen.findByText(/Parquet 文件目前不能直接接入/)).toBeInTheDocument();
    await person().upload(chooser, new File(["a,b\n1,2\n"], "noextension"));
    expect(await screen.findByText("文件名需要带扩展名，例如 cohort.csv。")).toBeInTheDocument();
    const big = new File(["x"], "big.csv");
    Object.defineProperty(big, "size", { value: 60 * 1024 * 1024 });
    await person().upload(chooser, big);
    expect(await screen.findByText(/文件超过 50 MB 的上限/)).toBeInTheDocument();
    expect(upload.fetchWithWebAuth).not.toHaveBeenCalled();

    upload.fetchWithWebAuth.mockResolvedValue(new Response(JSON.stringify({ data: { file: { id: "sfl_9", name: "extra.csv" }, created: true } }), { status: 201 }));
    const file = new File(["a,b\n1,2\n"], "extra 队列.csv", { type: "text/csv" });
    await person().upload(chooser, file);
    await waitFor(() => expect(upload.fetchWithWebAuth).toHaveBeenCalledTimes(1));
    const [url, init] = upload.fetchWithWebAuth.mock.calls[0];
    expect(String(url)).toContain(`/vcr/studies/${STUDY_ID}/data/sources/src_1/files?name=`);
    expect(new URL(String(url), "http://x").searchParams.get("name")).toBe("extra 队列.csv");
    expect(new URL(String(url), "http://x").searchParams.has("role")).toBe(false);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(file);
    expect(init.headers["Content-Type"]).toBe("application/octet-stream");
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已上传 extra 队列.csv。"));
    // The dictionary role is sent as a query word, not a body field.
    upload.fetchWithWebAuth.mockClear();
    await userEvent.selectOptions(screen.getAllByLabelText("文件类型")[0], "dictionary");
    await person().upload(chooser, new File(["变量名,说明\nAGE,年龄\n"], "dictionary.csv"));
    await waitFor(() => expect(upload.fetchWithWebAuth).toHaveBeenCalledTimes(1));
    expect(new URL(String(upload.fetchWithWebAuth.mock.calls[0][0]), "http://x").searchParams.get("role")).toBe("dictionary");
  });

  it("uploads a patient document with the subject it belongs to and the date it became visible, and will not without the subject", async () => {
    drawTab();
    const chooser = (await screen.findAllByLabelText("选择要上传的文件"))[0];
    await person().selectOptions(screen.getAllByLabelText("文件类型")[0], "document");
    await person().upload(chooser, new File(["主诉：咳嗽三周。"], "note.txt"));
    expect(await screen.findByText("患者文档要写明它属于哪位受试者（源数据里的编号）。")).toBeInTheDocument();
    expect(upload.fetchWithWebAuth).not.toHaveBeenCalled();
    upload.fetchWithWebAuth.mockResolvedValue(new Response(JSON.stringify({ data: { file: { id: "sfl_9", name: "note.txt" }, created: true } }), { status: 201 }));
    await person().type(screen.getAllByLabelText("文档所属受试者编号")[0], "HZ-30001");
    await person().type(screen.getAllByLabelText("文档对平台可见的日期")[0], "2026-03-01");
    await person().upload(chooser, new File(["主诉：咳嗽三周。"], "note.txt"));
    await waitFor(() => expect(upload.fetchWithWebAuth).toHaveBeenCalledTimes(1));
    const query = new URL(String(upload.fetchWithWebAuth.mock.calls[0][0]), "http://x").searchParams;
    expect(query.get("role")).toBe("document");
    expect(query.get("subject")).toBe("HZ-30001");
    expect(query.get("visibleAt")).toBe("2026-03-01");
  });

  it("takes a PDF or Word record where the deployment converts them, and says what a scan needs", async () => {
    // The page offers only what the deployment would take: text alone until a converter is composed.
    drawTab();
    const withoutConverter = (await screen.findAllByLabelText("选择要上传的文件"))[0] as HTMLInputElement;
    await person().selectOptions(screen.getAllByLabelText("文件类型")[0], "document");
    expect(withoutConverter.accept).toBe(".txt,.md");
    expect(document.body.textContent).not.toContain("PDF 和 Word 在平台内转成文字");
    cleanup();

    load("data-sealed.json", (raw) => {
      raw.intake.sources[0].upload.documents = { formats: ["txt", "md", "pdf", "docx"], maxBytes: 25 * 1024 * 1024, maxText: "25 MB", converter: true };
    });
    drawTab();
    const chooser = (await screen.findAllByLabelText("选择要上传的文件"))[0] as HTMLInputElement;
    await person().selectOptions(screen.getAllByLabelText("文件类型")[0], "document");
    expect(chooser.accept).toBe(".txt,.md,.pdf,.docx");
    expect(document.body.textContent).toContain("PDF 和 Word 在平台内转成文字，不会发给外部服务");
    await person().type(screen.getAllByLabelText("文档所属受试者编号")[0], "HZ-30001");

    // A picture is refused on the page, with the plane's own sentence, and never sent.
    await person().upload(chooser, new File(["x"], "chest-xray.png"));
    expect(await screen.findByText(/请提供文字版：可复制文字的 PDF、Word（.docx）或 .txt/)).toBeInTheDocument();
    await person().upload(chooser, new File(["x"], "old-record.doc"));
    expect(await screen.findByText(/请另存为 \.docx/)).toBeInTheDocument();
    expect(upload.fetchWithWebAuth).not.toHaveBeenCalled();

    // A PDF is sent as a document of its subject.
    upload.fetchWithWebAuth.mockResolvedValue(new Response(JSON.stringify({ data: { file: { id: "sfl_9", name: "document-ab12cd34.txt" }, created: true } }), { status: 201 }));
    await person().upload(chooser, new File(["%PDF-1.4"], "discharge.pdf"));
    await waitFor(() => expect(upload.fetchWithWebAuth).toHaveBeenCalledTimes(1));
    const query = new URL(String(upload.fetchWithWebAuth.mock.calls[0][0]), "http://x").searchParams;
    expect(query.get("role")).toBe("document");
    expect(query.get("name")).toBe("discharge.pdf");
    expect(query.get("subject")).toBe("HZ-30001");

    // A scan the plane refuses is shown with the reason and what to bring instead.
    upload.fetchWithWebAuth.mockResolvedValue(new Response(JSON.stringify({ error: "x", code: "vcr_document_needs_text" }), { status: 422 }));
    await person().upload(chooser, new File(["%PDF-1.4 scan"], "scan.pdf"));
    expect(await screen.findAllByText(/没有可提取的文字（多半是扫描件或图片）。请提供文字版/)).not.toHaveLength(0);
    expect(toasts.error).toHaveBeenCalled();
  });

  it("offers a FHIR, OMOP or ADaM import only where the deployment converts them, and sends the file with its standard", async () => {
    drawTab();
    await screen.findAllByLabelText("选择要上传的文件");
    expect(Array.from((screen.getAllByLabelText("文件类型")[0] as HTMLSelectElement).options).map((option) => option.value)).not.toContain("import");
    cleanup();

    const imports = {
      available: true, maxBytes: 25 * 1024 * 1024, maxText: "25 MB",
      formats: [{ value: "fhir", extensions: ["ndjson", "json", "zip"] }, { value: "omop", extensions: ["zip"] }, { value: "adam", extensions: ["xpt", "zip"] }],
    };
    load("data-sealed.json", (raw) => { raw.intake.sources[0].upload.imports = imports; });
    drawTab();
    const chooser = (await screen.findAllByLabelText("选择要上传的文件"))[0] as HTMLInputElement;
    await person().selectOptions(screen.getAllByLabelText("文件类型")[0], "import");
    const standard = screen.getAllByLabelText("标准格式")[0] as HTMLSelectElement;
    expect(Array.from(standard.options).map((option) => option.textContent)).toEqual(["FHIR", "OMOP CDM", "CDISC ADaM"]);
    expect(chooser.accept).toBe(".ndjson,.json,.zip");
    await person().selectOptions(standard, "omop");
    expect(chooser.accept).toBe(".zip");
    expect(document.body.textContent).toContain("在平台内转成数据表，不会发给外部服务");

    // A file the standard is not uploaded as is refused on the page, and never sent.
    await person().upload(chooser, new File(["x"], "person.csv"));
    expect(await screen.findByText("这一种格式支持：zip。")).toBeInTheDocument();
    expect(upload.fetchWithWebAuth).not.toHaveBeenCalled();

    // The upload is sent as the standard it is declared to be; the answer is read, imported and left, in sentences.
    upload.fetchWithWebAuth.mockResolvedValue(new Response(JSON.stringify({ data: {
      format: "omop", standard: { name: "OMOP CDM" },
      tables: [{ name: "omop_person", file: "omop_person.csv", rows: 28, columns: 11, stored: true }, { name: "omop_measurement", file: "omop_measurement.csv", rows: 10040, columns: 9, stored: false, reason: "table_too_large" }],
      fieldMap: { hash: "a".repeat(64), entries: 40, trimmed: 0, columnSourcesDeclared: true },
      coverage: {
        inputs: [{ kind: "procedure_occurrence", records: 1649, imported: 0, status: "skipped", reason: "unsupported_table", skipped: {} }, { kind: "person", records: 28, imported: 28, status: "imported", reason: null, skipped: {} }],
        skippedTables: [], notices: [{ code: "zero_follow_up", count: 2 }],
      },
    } }), { status: 201 }));
    await person().upload(chooser, new File(["PK"], "Synthea27Nj_5.4.zip"));
    await waitFor(() => expect(upload.fetchWithWebAuth).toHaveBeenCalledTimes(1));
    const [url, init] = upload.fetchWithWebAuth.mock.calls[0];
    expect(String(url)).toContain("/data/sources/src_1/imports?");
    const query = new URL(String(url), "http://x").searchParams;
    expect([query.get("name"), query.get("format"), query.get("role")]).toEqual(["Synthea27Nj_5.4.zip", "omop", null]);
    expect(init.method).toBe("POST");
    const report = await screen.findByText(/已按 OMOP CDM 导入 1 张表，并提出了字段映射。/);
    const text = report.closest("[data-vcr-import-report]")?.textContent ?? "";
    expect(text).toContain("omop_person：28 行，11 列");
    expect(text).toContain("omop_measurement：没有保存（超过文件大小上限）");
    expect(text).toContain("procedure_occurrence：读到 1649 条，导入 0 条（本版本不读这张表）");
    expect(text).toContain("2 位患者的随访时间为 0 天");
    expect(text).toContain("每一列都标明了值的来源");
    expect(toasts.success).toHaveBeenCalled();

    // A file that is not the standard it was declared as is refused with the registry's own words.
    upload.fetchWithWebAuth.mockResolvedValue(new Response(JSON.stringify({ error: "x", code: "vcr_import_not_this_format" }), { status: 422 }));
    await person().upload(chooser, new File(["PK"], "other.zip"));
    expect(await screen.findAllByText(/这个文件不是你选的那种标准格式/)).not.toHaveLength(0);
    expect(toasts.error).toHaveBeenCalled();
  });

  it("shows which standard an imported table came from", async () => {
    load("data-sealed.json", (raw) => {
      raw.intake.sources[0].files[0].importFormat = "fhir";
    });
    drawTab();
    const rows = await screen.findAllByText("cohort.csv");
    expect(rows.some((row) => row.closest("li")?.textContent?.includes("来自 FHIR 导入"))).toBe(true);
  });

  it("shows a converted record's origin and how many of its pages had no text", async () => {
    load("data-sealed.json", (raw) => {
      raw.intake.sources[0].files.push({
        id: "sfl_conv", name: "document-9f8e7d6c.txt", role: "document", roleLabel: "患者文档", format: "txt", size: "12.3 KB", rows: null, columnCount: null,
        at: "刚刚", latest: null, columns: [], entries: null, sheets: [], sheetUsed: null, subjectKey: "P0123456789abcdef", visibleAt: null,
        sourceFormat: "pdf", pages: 12, blankPages: 1,
      });
    });
    drawTab();
    const row = await screen.findByText("document-9f8e7d6c.txt");
    expect(row.closest("li")?.textContent).toContain("来自 PDF，12 页，其中 1 页没有文字");
  });

  it("names the plane's refusal of an upload in words a data manager can act on", async () => {
    drawTab();
    const chooser = (await screen.findAllByLabelText("选择要上传的文件"))[0];
    upload.fetchWithWebAuth.mockResolvedValue(new Response(JSON.stringify({ error: "x", code: "vcr_data_file_unreadable" }), { status: 422 }));
    await person().upload(chooser, new File(["a,a\n1,2\n"], "dup.csv"));
    expect(await screen.findByText("这个文件读不出来：请确认它是带表头的表格，列名没有重复。")).toBeInTheDocument();
    expect(toasts.error).toHaveBeenCalled();
  });

  it("saves the field map as the entries the person said, and only those, and confirms the hash it was shown", async () => {
    load("data-sealed.json", (raw) => {
      // The second source, unmapped: two columns of one file.
      const second = raw.intake.sources[1];
      second.fieldMap = { ...second.fieldMap, state: "none", stateLabel: "尚未提出", hash: null, columns: [], issues: [] };
      second.files[0].columns = [
        { name: "PATIENT_NO", type: "text", filled: 1, distinct: 24, identifying: false },
        { name: "ARM", type: "text", filled: 1, distinct: 2, identifying: false },
        { name: "DEAD", type: "integer", filled: 1, distinct: 2, identifying: false },
        { name: "PHONE", type: "text", filled: 1, distinct: 24, identifying: true },
      ];
    });
    drawTab();
    await screen.findByRole("heading", { name: "数据接入" });
    const editor = document.querySelector('[data-vcr-fieldmap="src_2"]') as HTMLElement;
    expect(editor).toBeTruthy();
    // The column that looks like the person's key is suggested; a suspected identifier is marked and left out of the analysis.
    expect(within(editor).getByLabelText("PATIENT_NO 的作用")).toHaveValue("subject_key");
    expect(within(editor).getByLabelText("PHONE 的作用")).toHaveValue("other");
    expect(within(editor).getAllByText("疑似标识")).toHaveLength(1);
    await userEvent.selectOptions(within(editor).getByLabelText("ARM 的作用"), "arm");
    await userEvent.type(within(editor).getByLabelText("ARM 中的试验组取值"), "TRT");
    await userEvent.type(within(editor).getByLabelText("ARM 中的对照组取值"), "CTL");
    await userEvent.selectOptions(within(editor).getByLabelText("DEAD 的作用"), "outcome_event");
    // An outcome without a parameter code cannot be saved, and the field says why.
    expect(within(editor).getByRole("button", { name: "保存并检查" })).toBeDisabled();
    await userEvent.type(within(editor).getByLabelText("DEAD 的参数代码"), "OS");
    await userEvent.type(within(editor).getByLabelText("ARM 在分析表里的列名"), "arm");
    server.calls.length = 0;
    network.productRequest.mockImplementation(async (path: string, method = "GET", body?: unknown) => {
      server.calls.push({ method, path, body });
      if (method === "GET") return structuredClone(page);
      if (path.endsWith("/fieldmap")) return { hash: "d".repeat(64), entryIssues: [], mapIssues: [] };
      return {};
    });
    await userEvent.click(within(editor).getByRole("button", { name: "保存并检查" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].path).toBe(`${DATA}/sources/src_2/fieldmap`);
    // In the file's own column order; the identifier is sent as one, so it is never derived.
    expect(writes()[0].body).toEqual({ columns: [
      { table: "followup.csv", column: "PATIENT_NO", role: "subject_key" },
      { table: "followup.csv", column: "ARM", role: "arm", alias: "arm", codes: { treated: ["TRT"], control: ["CTL"] } },
      { table: "followup.csv", column: "DEAD", role: "outcome_event", parameter: "OS" },
      { table: "followup.csv", column: "PHONE", role: "other", identifier: true },
    ] });
  });

  it("confirms the map by the hash the server showed, and only when the server's list of problems is empty; freezes only a confirmed one", async () => {
    load("data-sealed.json", (raw) => {
      const first = raw.intake.sources[0];
      first.fieldMap = { ...first.fieldMap, state: "proposed", stateLabel: "待确认", confirmedBy: null, confirmedAt: null, issues: [] };
      first.status = "profiled";
    });
    drawTab();
    const confirm = (await screen.findAllByRole("button", { name: "确认字段映射" }))[0];
    expect(confirm).toBeEnabled();
    // The confirmed source may be frozen; a proposed one may not.
    const freezes = screen.getAllByRole("button", { name: /冻结/ });
    expect(freezes.every((button) => button.hasAttribute("disabled"))).toBe(true);
    await userEvent.click(confirm);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: "POST", path: `${DATA}/sources/src_1/fieldmap/confirm` });
    expect(writes()[0].body).toEqual({ hash: page.intake.sources[0].fieldMap.hash });
  });

  it("freezes a confirmed source with an empty body, and says which tables were refused", async () => {
    drawTab();
    const freeze = await screen.findByRole("button", { name: "冻结新版本" });
    expect(freeze).toBeEnabled();
    network.productRequest.mockImplementation(async (path: string, method = "GET", body?: unknown) => {
      server.calls.push({ method, path, body });
      if (method === "GET") return structuredClone(page);
      return { snapshot: { id: "snp_2", version: 2 }, tables: { registered: [], skipped: [], refused: [{ shape: "subject", issues: [{ issue: "duplicate-subject-id", blocking: true, message: "受试者级表每人一行，这些编号出现了不止一次。" }] }] } };
    });
    await userEvent.click(freeze);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: "POST", path: `${DATA}/sources/src_1/snapshots`, body: {} });
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("受试者级表每人一行，这些编号出现了不止一次。"));
  });

  it("grants and revokes: the body is the route's, only the source's own account is offered the form", async () => {
    // The fixture's first source is another account's (the data manager's): the study's owner sees no form there, and the second source is the owner's own.
    drawTab();
    const own = (await screen.findAllByText("授权给")).length;
    expect(own).toBe(1);
    expect(screen.getByText("只有登记这个数据源的账号可以授权别人读取它。")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("授权给"), "account");
    await userEvent.type(screen.getByLabelText("成员账号 ID"), "view-manager");
    await userEvent.type(screen.getByLabelText("限定的列（留空为所有列）"), "AGE、ARM");
    await userEvent.click(screen.getByRole("button", { name: "授权" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      method: "POST", path: `${DATA}/sources/src_2/grants`,
      body: { grantee: "view-manager", fields: ["AGE", "ARM"], purposes: ["vcr"] },
    });
    expect(Object.keys(writes()[0].body as object).sort()).toEqual(["fields", "grantee", "purposes"]);
  });

  it("names a refusal with the plane's own code as a sentence, not as a status", async () => {
    drawTab();
    const freeze = await screen.findByRole("button", { name: "冻结新版本" });
    network.productRequest.mockImplementation(async (_path: string, method = "GET") => {
      if (method === "GET") return structuredClone(page);
      throw new WebApiError("Confirm the field map first.", { status: 409, code: "vcr_field_map_unconfirmed" });
    });
    await userEvent.click(freeze);
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("请先确认字段映射，再冻结快照。"));
  });
});
