/**
 * The knowledge base for the walk's fixture: eight documents of a study project (two of them PDFs, so that an original can be opened), and
 * the pages and the graph the engine compiles from them.
 *
 * The documents are uploaded through the platform's own route and read by its own worker (a PDF through the parser — here a stand-in that
 * answers with the text this file holds for it, as the page contract's tests do); the engine is OpenViking's stand-in
 * (`test/helpers/openVikingResourcesStub.mjs`), which holds the files in memory and writes what the script below says a compile wrote;
 * everything after that — the push of the documents, the round, the mirror of the pages and of the graph into the ledger, the ✓ and ⚠ of
 * each quotation — is the module's own code, the way `knowledgePages.integration.test.mjs` drives it.
 *
 * Every document, page and entity is invented.
 */

/** [file name, content]; a `.pdf` has its parsed text, a page at a time, in `PARSED`. */
const DOCUMENTS = [
  ["项目方案-周制剂降糖药真实世界研究-v3.md", "# 周制剂降糖药真实世界研究：项目方案 v3\n\n## 研究问题\n\n成人 2 型糖尿病患者使用每周一次与每日一次降糖针的疗效与体重差别。\n\n## 入选与排除\n\n纳入年龄不小于 18 岁、糖化血红蛋白在 7.5% 到 10.5% 之间、体重指数不低于 25 的患者。排除一型糖尿病、胰腺炎病史与重度肾功能不全。\n\n## 结局\n\n主要结局为 52 周糖化血红蛋白较基线的变化；次要结局为体重变化与糖化血红蛋白达标率。\n\n## 数据来源\n\n数据来自三家医院的门诊随访记录，时间范围为 2019 年至 2025 年。\n"],
  ["统计分析计划.md", "# 统计分析计划\n\n主分析使用混合效应模型，固定效应包括治疗组、访视、基线糖化血红蛋白和治疗组与访视的交互项，随机效应为受试者。\n\n缺失数据按随机缺失处理，并以多重插补和最坏情形做敏感性分析。\n\n样本量估算：双侧显著性水平 0.05，把握度 90%，每组需要 133 人，按 15% 的脱落率调整。\n"],
  ["会议纪要-0928.md", "# 项目周会纪要（9 月 28 日）\n\n1. 数据组确认三家医院的随访记录已经完成脱敏，下周一交付。\n2. 统计组提出主分析改用混合效应模型，原因是访视时间点不完全一致。\n3. 方案先在注册平台登记，拿到注册号再开始数据整理。\n4. 安全性表格还缺注射部位反应的数据，向数据组索取。\n"],
  ["文献检索记录.txt", "检索日期：2026 年 9 月 28 日\n检索式：周制剂 AND 2 型糖尿病 AND 随机对照试验\n检出：41 篇；纳入：12 篇；需要补全文：3 篇。\n纳入研究的随访时间为 26 至 104 周，多数为开放标签设计。\n"],
  ["随访数据说明.md", "# 随访数据说明\n\n每名患者的记录包含基线、第 12、26、39 和 52 周的访视。\n\n字段：糖化血红蛋白（%）、体重（公斤）、空腹血糖（毫摩尔每升）、不良反应（恶心、腹泻、注射部位反应）。\n\n三家医院的数据口径一致，体重在晨起空腹时测量。\n"],
  ["不良反应处理要点.md", "# 不良反应处理要点\n\n胃肠道反应多出现在加量期，常见的是恶心、腹泻和呕吐，多数在数周内缓解。\n\n如出现持续剧烈腹痛，应立即停药并就医，警惕胰腺炎。\n\n注射部位反应以轮换注射部位和冷藏后回温后注射来减轻。\n"],
  ["2型糖尿病诊疗指南-2026更新.pdf", ""],
  ["周制剂降糖药52周试验.pdf", ""],
];

/** What the parser answers for each PDF: the title and the text a page at a time. */
const PARSED = {
  "2型糖尿病诊疗指南-2026更新.pdf": { title: "2 型糖尿病诊疗指南（2026 更新）", pages: [
    "# 2 型糖尿病诊疗指南（2026 更新）\n\n本次更新强调体重管理与心肾保护，并把它们写入起始治疗的目标。\n",
    "## 血糖控制目标\n\n多数成年患者的糖化血红蛋白目标为小于 7%；老年患者与合并症多的患者应放宽目标。\n",
    "## 药物选择\n\n合并心衰或慢性肾脏病的患者，优先选择有心肾获益证据的药物。每周一次的制剂可以提高依从性。\n",
  ] },
  "周制剂降糖药52周试验.pdf": { title: "每周一次降糖药与每日一次对照的 52 周随机对照试验", pages: [
    "# 52 周随机对照试验\n\n随机、双盲、对照试验纳入 1,264 名成人 2 型糖尿病患者。\n",
    "## 主要结果\n\n52 周时试验组糖化血红蛋白下降 1.8 个百分点，对照组下降 0.9 个百分点。\n",
    "## 体重\n\n试验组体重下降 6.2 公斤，对照组下降 1.1 公斤。\n",
    "## 安全性\n\n胃肠道不良反应在试验组更常见，多数为轻中度，并在加量后出现。\n",
  ] },
};

/**
 * A valid PDF: one line of text a page, in the standard Helvetica (so ASCII only), with its cross-reference table.
 * @param {string[]} lines the text of each page
 */
export function minimalPdf(lines) {
  /** @type {string[]} */ const objects = [];
  const font = 3;
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const firstPage = 4;
  const kids = lines.map((_text, index) => `${firstPage + index * 2} 0 R`).join(" ");
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${lines.length} >>`;
  objects[font] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  lines.forEach((text, index) => {
    const page = firstPage + index * 2;
    const stream = `BT /F1 20 Tf 72 700 Td (${text.replace(/[()\\]/g, " ")}) Tj ET`;
    objects[page] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${page + 1} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`;
    objects[page + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/**
 * The parser stand-in: `fetch` as the in-house parsing API is called, answering the text held here for the file named.
 * @param {any} _url @param {any} init
 */
export async function parserStandIn(_url, init) {
  const name = String(init.body.get("filename"));
  const parsed = /** @type {Record<string, { title: string, pages: string[] }>} */ (PARSED)[name];
  if (!parsed) return new Response(JSON.stringify({ code: 404, message: "unknown file" }), { status: 404 });
  let content = "";
  const pages = parsed.pages.map((page, index) => {
    const start = content.length;
    content += page;
    return { index: index + 1, start, end: content.length, status: "ok" };
  });
  return new Response(JSON.stringify({ code: 200, message: "success", uuid: "U", timestamp: 1, elapsed_ms: 1, data: { title: parsed.title, content, pages } }), { status: 200 });
}

/**
 * @param {any} app @param {any} user @param {string} password
 * @param {{ engine: any, setCompile: (script: (request: any, stub: any) => void) => void, base: string, log: (line: string) => void }} context
 */
export async function furnishKnowledge(app, user, password, { engine, setCompile, base, log }) {
  const project = await app.store.defaultProject(await app.store.userById(user.id));
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: user.id, password }) });
  const auth = await login.json();
  const headers = { "content-type": "application/json", cookie: String(login.headers.get("set-cookie")).split(";")[0], "x-open-science-csrf": auth.data.csrfToken,
    "x-open-science-project": project.id, "accept-language": "zh-CN,zh;q=0.9" };
  const api = async (/** @type {string} */ route, /** @type {RequestInit} */ init = {}) => {
    const response = await fetch(`${base}${route}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  /** @type {Record<string, string>} */
  const ids = {};
  for (const [name, text] of DOCUMENTS) {
    const pdf = name.endsWith(".pdf");
    const body = pdf
      ? { root: "base", path: `knowledge-base/${name}`, data: minimalPdf(/** @type {any} */ (PARSED)[name].pages.map((_page, index) => `${name.includes("52") ? "Randomised trial" : "Diabetes guideline"} - page ${index + 1}`)).toString("base64"), encoding: "base64" }
      : { root: "base", path: `knowledge-base/${name}`, data: text, encoding: "utf8" };
    const sent = await api("/api/files/upload", { method: "POST", body: JSON.stringify(body) });
    if (sent.status !== 200) throw new Error(`upload of ${name} answered ${sent.status}: ${JSON.stringify(sent.body).slice(0, 200)}`);
    const source = await app.sourceService.get(user.id, sent.body.data.source.id);
    // Text only: an understanding of each document is a model's, and none is here.
    if (source.payload.depth !== "index_only") {
      await app.sourceService.override(user.id, source.id, { expectedRevision: source.revision, docType: source.payload.docType, depth: "index_only", reason: "Walk fixture: text only." });
    }
    ids[name] = source.id;
  }
  await settle(app, user, "ingest", () => app.sourceWorker.tick());
  const states = await Promise.all(Object.entries(ids).map(async ([name, id]) => [name, (await app.sourceService.get(user.id, id)).payload.status]));
  log(`knowledge: ${DOCUMENTS.length} documents, ${states.filter(([, status]) => status === "complete").length} read (${states.filter(([, status]) => status !== "complete").map(([name, status]) => `${name}: ${status}`).join(", ") || "all"})`);

  // The documents reach the engine, then one compile round writes the pages and the graph, which the module mirrors.
  await settle(app, user, "ov-resource-sync", () => app.sourceSyncWorker.tick());
  const roots = app.openVikingResources.roots(user.id, project.id);
  const source = (/** @type {string} */ name) => `${roots.sources}/${ids[name]}.md`;
  setCompile((request, stub) => {
    if (request.skill.endsWith("/llm-wiki")) for (const [rel, text] of Object.entries(wikiPages(source))) stub.put(`${request.to}/${rel}`, text);
    else {
      for (const [rel, text] of Object.entries(graphFiles(source))) stub.put(`${request.to}/${rel}`, text);
    }
  });
  await api("/api/knowledge-pages/compile", { method: "POST", body: JSON.stringify({ projectId: project.id }) });
  const round = await settle(app, user, "wiki-compile", () => app.knowledgePagesWorker.tick());
  await settle(app, user, "ingest", () => app.sourceWorker.tick());
  const tree = await api(`/api/knowledge-pages/tree?projectId=${project.id}`);
  log(`knowledge: the round ${JSON.stringify(round ?? null).slice(0, 160)}; ${tree.body?.data?.pages?.length ?? 0} pages and graph files mirrored`);
  return { ids };
}

/**
 * Tick a worker until the user's jobs of a kind are all done.
 * @param {any} app @param {any} user @param {string} kind @param {() => Promise<any>} tick
 */
async function settle(app, user, kind, tick) {
  let last = null;
  for (let round = 0; round < 400; round += 1) {
    await app.store.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp() WHERE user_id=$1 AND kind=$2 AND status='queued'", [user.id, kind]);
    const outcome = await tick();
    if (outcome && typeof outcome === "object" && "result" in outcome) last = outcome.result;
    const open = await app.store.database.query("SELECT 1 FROM evimed_product.jobs WHERE user_id=$1 AND kind=$2 AND status IN ('queued','running')", [user.id, kind]);
    if (!open.rowCount) { await new Promise((resolve) => setTimeout(resolve, 150)); const again = await app.store.database.query("SELECT 1 FROM evimed_product.jobs WHERE user_id=$1 AND kind=$2 AND status IN ('queued','running')", [user.id, kind]); if (!again.rowCount) return last; }
  }
  throw new Error(`the ${kind} jobs did not end`);
}

/** The pages a compile of the wiki writes: [path] → markdown, each quotation a phrase of a document (one of them is not). @param {(name: string) => string} src */
function wikiPages(src) {
  const plan = src("项目方案-周制剂降糖药真实世界研究-v3.md");
  const sap = src("统计分析计划.md");
  const minutes = src("会议纪要-0928.md");
  const search = src("文献检索记录.txt");
  const data = src("随访数据说明.md");
  const safety = src("不良反应处理要点.md");
  const guideline = src("2型糖尿病诊疗指南-2026更新.pdf");
  const trial = src("周制剂降糖药52周试验.pdf");
  const page = (/** @type {string} */ type, /** @type {string} */ title, /** @type {string} */ description, /** @type {string} */ body) => `---\ntype: ${type}\ntitle: ${title}\ndescription: ${description}\n---\n\n# ${title}\n\n${body}\n`;
  return {
    "index.md": page("index", "知识页目录", "本项目的知识页", "- [周制剂降糖药](concept/周制剂降糖药.md)\n- [糖化血红蛋白目标](concept/糖化血红蛋白目标.md)\n- [胃肠道不良反应](concept/胃肠道不良反应.md)\n- [统计分析计划](concept/统计分析计划.md)\n- [样本量估算](concept/样本量估算.md)\n- [研究方案](entity/研究方案.md)\n- [随访数据](entity/随访数据.md)\n- [文献检索](entity/文献检索.md)"),
    "concept/周制剂降糖药.md": page("concept", "周制剂降糖药", "每周注射一次的降糖药", `## 定义\n\n每周注射一次的降糖药，52 周时糖化血红蛋白下降幅度约为对照的两倍 [试验](${trial} "52 周时试验组糖化血红蛋白下降 1.8 个百分点，对照组下降 0.9 个百分点")。\n\n## 体重\n\n试验组体重下降 6.2 公斤 [试验](${trial} "试验组体重下降 6.2 公斤，对照组下降 1.1 公斤")。\n\n## 指南\n\n每周一次的制剂可以提高依从性 [指南](${guideline} "每周一次的制剂可以提高依从性")。\n\n## 相关\n\n- [胃肠道不良反应](胃肠道不良反应.md)\n- [糖化血红蛋白目标](糖化血红蛋白目标.md)\n\n## 来源\n\n- [试验](${trial})\n- [指南](${guideline})`),
    "concept/糖化血红蛋白目标.md": page("concept", "糖化血红蛋白目标", "不同人群的目标值", `多数成年患者的目标小于 7% [指南](${guideline} "多数成年患者的糖化血红蛋白目标为小于 7%")；老年患者应放宽 [指南](${guideline} "老年患者与合并症多的患者应放宽目标")。\n\n本研究的入选范围是 7.5% 到 10.5% [方案](${plan} "糖化血红蛋白在 7.5% 到 10.5% 之间")。\n\n参见 [周制剂降糖药](周制剂降糖药.md)。`),
    "concept/胃肠道不良反应.md": page("concept", "胃肠道不良反应", "恶心、腹泻、呕吐", `胃肠道反应多出现在加量期 [处理要点](${safety} "胃肠道反应多出现在加量期，常见的是恶心、腹泻和呕吐")，多数在数周内缓解 [处理要点](${safety} "多数在数周内缓解")。\n\n出现持续剧烈腹痛应立即停药 [处理要点](${safety} "应立即停药并就医，警惕胰腺炎")；试验中试验组更常见 [试验](${trial} "胃肠道不良反应在试验组更常见")。\n\n另有一条说明书上没有的说法 [处理要点](${safety} "所有患者在第一周内都会出现严重呕吐")。`),
    "concept/统计分析计划.md": page("concept", "统计分析计划", "主分析与敏感性分析", `主分析使用混合效应模型 [统计分析计划](${sap} "主分析使用混合效应模型")，原因是访视时间点不完全一致 [纪要](${minutes} "原因是访视时间点不完全一致")。\n\n缺失数据按随机缺失处理 [统计分析计划](${sap} "缺失数据按随机缺失处理")。\n\n参见 [样本量估算](样本量估算.md)。`),
    "concept/样本量估算.md": page("concept", "样本量估算", "把握度与脱落率", `双侧显著性水平 0.05，把握度 90%，每组需要 133 人 [统计分析计划](${sap} "每组需要 133 人，按 15% 的脱落率调整")。`),
    "entity/研究方案.md": page("entity", "研究方案", "项目方案 v3", `研究问题：成人 2 型糖尿病患者使用每周一次与每日一次降糖针的疗效与体重差别 [方案](${plan} "成人 2 型糖尿病患者使用每周一次与每日一次降糖针的疗效与体重差别")。\n\n主要结局为 52 周糖化血红蛋白较基线的变化 [方案](${plan} "主要结局为 52 周糖化血红蛋白较基线的变化")。\n\n方案先在注册平台登记 [纪要](${minutes} "方案先在注册平台登记，拿到注册号再开始数据整理")。\n\n参见 [随访数据](随访数据.md)。`),
    "entity/随访数据.md": page("entity", "随访数据", "三家医院的门诊随访记录", `数据来自三家医院的门诊随访记录 [方案](${plan} "数据来自三家医院的门诊随访记录")；每名患者有基线与四次随访 [数据说明](${data} "基线、第 12、26、39 和 52 周的访视")。`),
    "entity/文献检索.md": page("entity", "文献检索", "9 月 28 日的检索", `检出 41 篇，纳入 12 篇 [检索记录](${search} "检出：41 篇；纳入：12 篇")；多数为开放标签设计 [检索记录](${search} "多数为开放标签设计")。`),
  };
}

/** The files a compile of the graph writes: the entities and the relations between them. @param {(name: string) => string} src */
function graphFiles(src) {
  const files = /** @type {Record<string, string>} */ ({});
  const entity = (/** @type {string} */ id, /** @type {string} */ title, /** @type {string} */ type, /** @type {string} */ description, /** @type {string[]} */ sources) => {
    files[`entities/${id}.md`] = `---\ntype: entity\nid: ${id}\ntitle: ${title}\nentity_type: ${type}\ndescription: ${description}\nsources:\n${sources.map((uri) => `  - ${uri}`).join("\n")}\n---\n\n${description}\n`;
  };
  const plan = src("项目方案-周制剂降糖药真实世界研究-v3.md");
  const sap = src("统计分析计划.md");
  const minutes = src("会议纪要-0928.md");
  const search = src("文献检索记录.txt");
  const data = src("随访数据说明.md");
  const safety = src("不良反应处理要点.md");
  const guideline = src("2型糖尿病诊疗指南-2026更新.pdf");
  const trial = src("周制剂降糖药52周试验.pdf");
  entity("weekly-agent", "每周一次的降糖药", "drug", "每周注射一次的降糖药。", [trial, guideline]);
  entity("daily-agent", "每日一次的降糖药", "drug", "每日注射一次的对照药。", [trial]);
  entity("hba1c", "糖化血红蛋白", "outcome", "主要结局：52 周较基线的变化。", [plan, trial]);
  entity("weight", "体重", "outcome", "次要结局：体重变化。", [plan, trial]);
  entity("nausea", "恶心与胃肠道反应", "adverse_event", "多出现在加量期。", [safety, trial]);
  entity("pancreatitis", "胰腺炎", "adverse_event", "持续剧烈腹痛时需要排除。", [safety]);
  entity("followup-data", "随访数据", "dataset", "三家医院的门诊随访记录。", [plan, data]);
  entity("protocol", "项目方案 v3", "document", "研究问题、入选排除与结局。", [plan, minutes]);
  entity("sap", "统计分析计划", "document", "混合效应模型与敏感性分析。", [sap]);
  entity("mixed-model", "混合效应模型", "method", "主分析方法。", [sap, minutes]);
  entity("sample-size", "样本量估算", "method", "每组 133 人。", [sap]);
  entity("trial-52w", "52 周随机对照试验", "study", "周制剂与每日制剂的对照试验。", [trial]);
  entity("literature-search", "文献检索", "method", "9 月 28 日的检索。", [search]);
  entity("guideline", "诊疗指南 2026 更新", "document", "强调体重管理与心肾保护。", [guideline]);
  entity("hospital-a", "医院甲", "site", "随访记录来源之一。", [data]);
  entity("hospital-b", "医院乙", "site", "随访记录来源之二。", [data]);
  entity("hospital-c", "医院丙", "site", "随访记录来源之三。", [data]);
  const relation = (/** @type {string} */ from, /** @type {string} */ name, /** @type {string} */ label, /** @type {string} */ to, /** @type {string[]} */ evidence) => JSON.stringify({ from, relation: name, label, to, evidence });
  files["relations.jsonl"] = `${[
    relation("weekly-agent", "compared_with", "对照", "daily-agent", [trial]),
    relation("weekly-agent", "lowers", "降低", "hba1c", [trial]),
    relation("weekly-agent", "lowers", "降低", "weight", [trial]),
    relation("weekly-agent", "causes", "可引起", "nausea", [safety, trial]),
    relation("nausea", "warns_of", "需警惕", "pancreatitis", [safety]),
    relation("trial-52w", "studies", "研究", "weekly-agent", [trial]),
    relation("guideline", "recommends", "推荐", "weekly-agent", [guideline]),
    relation("protocol", "specifies", "规定", "mixed-model", [plan, minutes]),
    relation("sap", "specifies", "规定", "mixed-model", [sap]),
    relation("sap", "specifies", "规定", "sample-size", [sap]),
    relation("protocol", "uses", "使用", "followup-data", [plan]),
    relation("protocol", "measures", "主要结局", "hba1c", [plan]),
    relation("protocol", "measures", "次要结局", "weight", [plan]),
    relation("followup-data", "collected_at", "采集于", "hospital-a", [data]),
    relation("followup-data", "collected_at", "采集于", "hospital-b", [data]),
    relation("followup-data", "collected_at", "采集于", "hospital-c", [data]),
    relation("literature-search", "informs", "支持", "protocol", [search]),
    relation("mixed-model", "analyses", "分析", "followup-data", [sap]),
  ].join("\n")}\n`;
  return files;
}
