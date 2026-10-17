/**
 * 循证 GEO for the walk's fixture: one invented product followed through five weekly measurements on three engines, furnished the way
 * the module furnishes itself.
 *
 *  - the product, its claims, twelve question groups of four questions (three of them controls), the journey — written by the module's own
 *    writers (`geoRuntimeWrite`, what a run's `geo_write` calls), the question set locked;
 *  - the measured side — five rounds of answers (a baseline and four weekly), 144 answers each, with their judged facts: whether the
 *    product was named, first, recommended, which sites were cited, which statements were wrong. The probe host and the judge model are
 *    absent here, so the answers are written into the tables the measurement writes (`GeoMeasureStore`), and **the numbers are the
 *    platform's own** — `tickMetrics` computes every rate, the index and the sources' citation counts from them;
 *  - the strategy a run would write — gaps, the battlefield, the engines' promises, the layout, the sources by layer — its actions, the
 *    articles written for them and the page the brand published itself.
 *
 * Nothing is real: the product, its maker, the competitors, the sites (`*.example.*`) and the answers are invented.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps", "server", "src");
const load = (/** @type {string} */ file) => import(pathToFileURL(path.join(server, file)).href);

const ENGINES = ["doubao", "qianwen", "deepseek"];
const BRAND = "康舒宁";
const COMPETITORS = ["诺康泰", "瑞信平"];
const OWNED = "kangshuning.example.com";

/** The twelve groups: four pools of three, the second of each four a control. A question is a thing a person asks an assistant. */
const GROUPS = [
  { pool: "P1", name: "已用药：用法与剂量", typical: "康舒宁一周打几次？", stage: "用药中", questions: ["康舒宁一周打几次", "康舒宁起始剂量是多少", "康舒宁打错了时间怎么办", "康舒宁要在饭前还是饭后打"] },
  { pool: "P1", name: "已用药：不良反应", typical: "康舒宁恶心怎么办？", stage: "用药中", control: true, questions: ["康舒宁打了以后恶心怎么办", "康舒宁会不会引起低血糖", "康舒宁胃胀要停药吗", "康舒宁注射部位红肿正常吗"] },
  { pool: "P1", name: "已用药：漏用与停药", typical: "康舒宁漏打了怎么补？", stage: "用药中", questions: ["康舒宁漏打了一次怎么补", "康舒宁可以自己停药吗", "康舒宁出差怎么保存", "康舒宁和别的降糖药能一起用吗"] },
  { pool: "P2", name: "品类对比：疗效", typical: "每周一次的降糖针哪个降糖效果好？", stage: "选药", questions: ["每周一次的降糖针哪个降糖效果好", "康舒宁和诺康泰哪个降糖更多", "周制剂降糖针一般能降多少糖化血红蛋白", "康舒宁降体重的效果怎么样"] },
  { pool: "P2", name: "品类对比：安全性", typical: "降糖针哪个胃肠反应小？", stage: "选药", control: true, questions: ["降糖针哪个胃肠反应小", "康舒宁和瑞信平的副作用比较", "周制剂降糖针有哪些禁忌", "康舒宁安全性怎么样"] },
  { pool: "P2", name: "品类对比：价格与报销", typical: "康舒宁多少钱一支？", stage: "选药", questions: ["康舒宁多少钱一支", "康舒宁能报销吗", "降糖针每个月大概花多少钱", "康舒宁和诺康泰哪个更便宜"] },
  { pool: "P3", name: "症状求助：血糖波动", typical: "血糖忽高忽低吃什么药？", stage: "确诊后", questions: ["血糖忽高忽低吃什么药", "餐后血糖高怎么控制", "空腹血糖偏高要不要打针", "二甲双胍控制不好下一步怎么办"] },
  { pool: "P3", name: "症状求助：体重管理", typical: "糖尿病怎么减重？", stage: "确诊后", control: true, questions: ["糖尿病怎么减重", "超重的糖尿病患者用什么药", "吃降糖药胖了怎么办", "有减重效果的降糖药有哪些"] },
  { pool: "P3", name: "症状求助：胃肠不适", typical: "打针后胃不舒服怎么办？", stage: "用药中", questions: ["打针后胃不舒服怎么办", "降糖针引起腹泻怎么处理", "恶心呕吐要不要去医院", "饮食怎么调整能减轻胃肠反应"] },
  { pool: "P4", name: "品牌身份：谁生产", typical: "康舒宁是哪家公司的？", stage: "选药", questions: ["康舒宁是哪家公司的", "康舒宁是进口药还是国产药", "康舒宁什么时候上市的", "康舒宁的通用名是什么"] },
  { pool: "P4", name: "品牌身份：真假辨别", typical: "怎么辨别康舒宁的真假？", stage: "购药", control: true, questions: ["怎么辨别康舒宁的真假", "康舒宁包装上有什么防伪标识", "网上买的康舒宁可靠吗", "康舒宁的批号在哪里查"] },
  { pool: "P4", name: "品牌身份：购买渠道", typical: "康舒宁在哪里买？", stage: "购药", questions: ["康舒宁在哪里买", "康舒宁需要处方吗", "康舒宁医院能开吗", "康舒宁可以网上买吗"] },
];

/** Third-party sites the engines cite, with what kind of site each is. Every name is invented. */
const SITES = {
  news: ["health-daily.example.com", "med-times.example.cn", "life-news.example.com"],
  vertical: ["doctor-answers.example.com", "pharma-know.example.com", "diabetes-hub.example.org", "drug-guide.example.org", "health-library.example.com"],
  social: ["ask-and-answer.example.com", "note-share.example.com", "short-video.example.com", "health-circle.example.cn"],
  wiki: ["med-encyclopedia.example.com", "knowledge-base.example.org"],
  regulator: ["drug-registry.example.org"],
};
const CITED_BY = { doubao: [...SITES.social, ...SITES.news, ...SITES.vertical.slice(0, 2)], qianwen: [...SITES.vertical, ...SITES.wiki, ...SITES.news.slice(0, 1)], deepseek: [...SITES.regulator, ...SITES.wiki, ...SITES.vertical.slice(0, 3)] };

/** A deterministic number in [0, 1) for a label: the same fixture every time. @param {string} label */
function unit(label) {
  return createHash("sha256").update(label).digest().readUInt32BE(0) / 2 ** 32;
}

/** The wrong sentences the answers carry about the product, each a claim contradicted: [statement, claim key, type, severity, evidence]. */
const WRONGS = [
  [`${BRAND}每天注射一次`, "dosing", "number", "S3", "本品每周一次皮下注射给药"],
  [`${BRAND}可以用于一型糖尿病患者`, "indication", "label_conflict", "S4", "用于成人2型糖尿病患者的血糖控制"],
  [`${BRAND}没有明显的胃肠道不良反应`, "adverse", "dropped_condition", "S2", "常见不良反应为胃肠道反应（恶心、腹泻、呕吐）"],
  [`${BRAND}起始剂量为5 mg`, "dosing", "number", "S3", "起始剂量为2 mg，每4周可增加一次"],
];

/**
 * @param {any} app @param {any} user the fixture account
 * @param {{ log: (line: string) => void }} context
 * @returns {Promise<{ projectId: string, controlProjectId: string }>}
 */
export async function furnishGeo(app, user, { log }) {
  const { geoRuntimeWrite } = await load("geoWrites.mjs");
  const { GeoMeasureStore } = await load("geoMeasureStore.mjs");
  const { tickMetrics } = await load("geoMetricsJob.mjs");
  const geoStore = app.geo.store;
  const controlProject = await app.store.createProject(user, "geo-kangshuning", BRAND);
  const project = await geoStore.createProject({ userId: user.id, projectId: controlProject.id, engines: ENGINES, coverageDays: 90, product: { brandName: BRAND } });
  const write = async (/** @type {string} */ what, /** @type {any} */ body, extra = {}) => {
    // The project is read again for every write: a product write merges into the product the project holds.
    const result = await geoRuntimeWrite({ store: geoStore, project: await geoStore.getProject(user.id, project.id), what, body, articleGate: async () => "passed", ...extra });
    const problems = (result.issues ?? []).filter((/** @type {any} */ issue) => issue.code !== "notice");
    if (problems.length || result.ok === false) throw new Error(`geo_write ${what}: ${JSON.stringify(result.issues ?? [])}`);
    return result;
  };

  // ---- the product, its claims, the questions, the journey
  await write("product", { data: { brandName: BRAND, genericName: "示例周制剂注射液", aliases: ["康舒宁注射液"], rx: "rx", singleSource: true,
    indication: "成人2型糖尿病患者的血糖控制", competitors: COMPETITORS.map((name) => ({ brandName: name, genericName: "示例周制剂（对照）" })) } });
  const claims = await write("claims", { items: [
    { claimKey: "dosing", statement: "每周皮下注射一次，起始剂量 2 mg", quote: "本品每周一次皮下注射给药，起始剂量为2 mg，每4周可增加一次。", sourceRef: "说明书 2026 版", sourceKind: "label", inLabel: true },
    { claimKey: "indication", statement: "用于成人2型糖尿病的血糖控制", quote: "用于成人2型糖尿病患者的血糖控制。", sourceRef: "说明书 2026 版", sourceKind: "label", inLabel: true },
    { claimKey: "adverse", statement: "常见不良反应为胃肠道反应", quote: "常见不良反应为胃肠道反应（恶心、腹泻、呕吐），多在剂量增加时出现。", sourceRef: "说明书 2026 版", sourceKind: "label", inLabel: true },
  ] });
  const questions = await write("questions", { data: { groups: GROUPS.map((group) => ({
    pool: group.pool, name: group.name, typicalQuestion: group.typical, journeyStage: group.stage, isControl: Boolean(group.control),
    questions: group.questions.map((text) => ({ text: `${text}？`, kind: "real", platform: "xhs", isMeasured: true })),
  })) } });
  await write("lock_questions", { data: {} });
  await write("journey", { data: {
    subtypes: [{ name: "新确诊", size: "300000" }, { name: "口服药控制不佳", size: "900000" }],
    personas: [{ name: "刚确诊的上班族", age: "38 岁", situation: "刚确诊，白天上班", voice: "最好少打针、不影响工作" }],
    stages: [{ stage: "确诊后", emotion: "焦虑", questions: ["糖尿病怎么减重"], infoSources: ["知识社区"] }, { stage: "用药中", emotion: "担心", questions: ["康舒宁恶心怎么办"], infoSources: ["医生"] }],
    careNodes: [{ node: "起始用药", redFlags: ["持续剧烈腹痛应立即就医"] }],
  } }).catch((error) => log(`geo: the journey was not written (${String(error.message).slice(0, 200)})`));

  // ---- the measured side
  const measure = new GeoMeasureStore(geoStore.database ?? app.store.database);
  await measure.ready();
  const groupIds = questions.ids;
  const map = await geoStore.questionMap(project.id, 1);
  const claimIds = Object.fromEntries((claims.claims ?? []).map((/** @type {any} */ claim) => [claim.claimKey ?? claim.key, claim.id]));
  if (!claimIds.dosing) throw new Error(`the claims were written without their keys: ${JSON.stringify(claims.claims)}`);
  const today = new Date();
  const dayOffsets = [28, 21, 14, 7, 0];
  /** @type {Array<{ snapshot: any, wrong: any[] }>} */
  const wrongOnes = [];
  for (const [roundIndex, daysAgo] of dayOffsets.entries()) {
    const askedAt = new Date(today.getTime() - daysAgo * 86_400_000 - 3_600_000);
    const roundId = `gr_walk_${roundIndex}`;
    await measure.query(`INSERT INTO evimed_geo.rounds (id, user_id, geo_project_id, kind, set_version, engines, status, planned, done, failed, sample_date, created_at, started_at, finished_at)
      VALUES ($1, $2, $3, $4, 1, $5::text[], 'done', 144, 144, 0, $6::date, $7, $7, $7)`,
    [roundId, user.id, project.id, roundIndex === 0 ? "baseline" : "weekly", ENGINES, askedAt.toISOString().slice(0, 10), askedAt.toISOString()]);
    for (const group of map) {
      const spec = GROUPS.find((entry) => entry.name === group.name) ?? GROUPS[0];
      for (const question of group.questions) {
        for (const engine of ENGINES) {
          const answer = answerOf({ roundIndex, group: spec, question: { id: `${spec.name}:${question.text}`, text: question.text }, engine, claimIds });
          const snapshot = { id: `gs_walk_${roundIndex}_${question.id}_${engine}`, userId: user.id, geoProjectId: project.id, roundId, questionId: question.id, engine,
            askedAt, status: "valid", answerText: answer.text, answerSha256: createHash("sha256").update(answer.text).digest("hex"), citations: answer.citations,
            screenshotSha256: null, surface: { mode: "web", deep: false, newChat: true, city: null }, latencyMs: 4_000 + Math.round(unit(`lat${question.id}${engine}`) * 5_000),
            warnings: [], probeJobId: null };
          await measure.insertSnapshot(snapshot);
          await measure.writeFacts(snapshot, { ...answer.facts, judgedAt: askedAt.toISOString() }, { at: askedAt });
          if (answer.wrong.length) wrongOnes.push({ snapshot: { ...snapshot, questionText: question.text }, wrong: answer.wrong });
        }
      }
    }
  }
  const deps = { store: measure, now: () => new Date(), config: {} };
  for (let guard = 0; guard < 10; guard += 1) if ((await tickMetrics(deps)).rounds === 0) break;
  log(`geo: ${dayOffsets.length} rounds measured, ${wrongOnes.length} answers carry a wrong sentence`);

  // ---- the errors the wrong sentences make (the platform's own record of one, with the confirmation it would have asked for done)
  /** @type {Map<string, string>} */
  const firstSeen = new Map();
  for (const { snapshot, wrong } of wrongOnes) {
    for (const entry of wrong) {
      const fingerprint = `${entry.key}:${entry.text}`;
      const { error, created } = await measure.upsertError({
        id: `ge_walk_${firstSeen.size + 1}`, userId: user.id, geoProjectId: project.id, fingerprint, engine: snapshot.engine, questionId: snapshot.questionId,
        snapshotId: snapshot.id, statement: entry.text, errorType: entry.errorType, severity: entry.severity, claimId: claimIds[entry.key] ?? null, evidenceQuote: entry.evidence,
        confirm: { status: "done", asked: 10, valid: 10, seen: 8, stability: "stable" },
        citedSource: { attribute: unit(entry.text) < 0.4 ? "owned" : "third_party", domain: unit(entry.text) < 0.4 ? OWNED : SITES.social[0] },
        action: unit(entry.text) < 0.4 ? "own_edit" : "correction_letter", responsible: unit(entry.text) < 0.4 ? "client" : "platform",
        now: snapshot.askedAt, askedAt: snapshot.askedAt,
      });
      if (created) firstSeen.set(error.id, error.id);
    }
    await measure.errorsRecorded(snapshot.id);
  }
  // Their states: the oldest are closed, one is being acted on, one waits for a remeasure, the rest are open.
  const ids = [...firstSeen.keys()];
  const stateOf = (/** @type {number} */ index) => (index < 2 ? "closed" : index === 2 ? "acting" : index === 3 ? "awaiting_remeasure" : "open");
  for (const [index, id] of ids.entries()) await measure.updateError(id, { status: stateOf(index) });
  log(`geo: ${ids.length} errors`);

  // ---- the strategy a run writes: gaps, the battlefield, the engines' promises, the layout, the sources by layer
  const groupName = (/** @type {number} */ index) => GROUPS[index].name;
  await write("strategy", { data: {
    summary: "先把剂量和适应证讲对，再进入品类对比的回答。",
    battlefield: { groups: [groupName(3), groupName(5)], reason: "这两群被问得最多，三个引擎都还没有稳定提到康舒宁" },
    expectations: [
      { engine: "doubao", promise: "可以承诺提高被提及，先把剂量讲对", layers: ["coverage", "owned"] },
      { engine: "qianwen", promise: "可以承诺讲对剂量与适应证", layers: ["anchor", "coverage"] },
      { engine: "deepseek", promise: "保持现状，补齐说明书信源", layers: ["anchor"] },
    ],
    gaps: [
      { gapId: "G1", class: "wrong", groupId: groupIds[0], judgment: "三个引擎都有把每周一次讲成每天一次的回答" },
      { gapId: "G2", class: "benefit_only", groupId: groupIds[3], judgment: "只讲降糖和减重的获益，没有提胃肠道反应" },
      { gapId: "G3", class: "missing_evidence", groupId: groupIds[4], judgment: "安全性的回答没有引用说明书" },
      { gapId: "G4", class: "weak_source", groupId: groupIds[5], judgment: "价格与报销的回答引用的是过期的网页" },
      { gapId: "G5", class: "dropped_condition", groupId: groupIds[6], judgment: "把适应证讲成了所有糖尿病患者" },
      { gapId: "G6", class: "outdated", groupId: groupIds[9], judgment: "还在引用旧的包装与批号信息" },
      { gapId: "G7", class: "audience_mismatch", groupId: groupIds[8], judgment: "胃肠不适的建议写得太专业，患者看不懂" },
    ],
    layout: { layers: { anchor: [SITES.regulator[0], SITES.wiki[0]], coverage: [SITES.vertical[0], SITES.news[0]], owned: [OWNED] },
      byEngine: [{ provider: "doubao", coverage: [SITES.social[0]], owned: [OWNED] }], constraints: ["处方药只进专业渠道"], clientActions: ["开通官方账号并认证"] },
    sources: [
      { domain: OWNED, layer: "owned", kind: "brand" },
      { domain: SITES.regulator[0], layer: "anchor", kind: "government", threeConditions: { icp_owner_match: true, news_indexed: true, medical_vertical: true, checked_on: "2026-10-01" } },
      { domain: SITES.wiki[0], layer: "anchor", kind: "encyclopedia", threeConditions: { icp_owner_match: true, news_indexed: true, medical_vertical: true, checked_on: "2026-10-01" } },
      { domain: SITES.vertical[0], layer: "coverage", kind: "vertical" },
      { domain: SITES.vertical[1], layer: "coverage", kind: "vertical" },
      { domain: SITES.news[0], layer: "coverage", kind: "news" },
    ],
  } });
  const actions = [
    { gapId: "G1", groupId: groupIds[0], gapClass: "wrong", kind: "correct_error", errorIds: ids.slice(0, 2), what: { layer: "correction", title: "康舒宁用法更正说明", channel: "brand_site" },
      engines: ["doubao", "qianwen"], sources: [{ domain: OWNED, why: "官网是三个引擎引用最多的自有页面" }], promise: "accuracy_to_target", basis: "三个引擎共 14 条回答把每周一次讲成每天一次", metricId: "M-06" },
    { gapId: "G2", groupId: groupIds[3], gapClass: "benefit_only", kind: "fill_gap", what: { layer: "deep", title: "周制剂降糖针的疗效与胃肠反应", channel: "baijiahao" },
      engines: ["doubao"], sources: [{ domain: SITES.vertical[0], why: "豆包引用最多的科普平台" }], promise: "raise_mention", basis: "品类对比群的提及率低于其他群", metricId: "M-01" },
    { gapId: "G3", groupId: groupIds[4], gapClass: "missing_evidence", kind: "fill_gap", what: { layer: "card", title: "康舒宁说明书要点卡", channel: "brand_site" },
      engines: ["qianwen", "deepseek"], sources: [{ domain: SITES.regulator[0], why: "引用最稳定的信源" }], promise: "coverage_complete", basis: "安全性回答缺少说明书信源", metricId: "M-08" },
    { gapId: "G4", groupId: groupIds[5], gapClass: "weak_source", kind: "fill_gap", what: { layer: "qa", title: "康舒宁的价格与报销问答", channel: "zhihu" },
      engines: ["qianwen"], sources: [{ domain: SITES.social[0], why: "千问常引用问答社区" }], promise: "raise_mention", basis: "价格问题引用的页面已经过期", metricId: "M-01" },
    { gapId: "G5", groupId: groupIds[6], kind: "win_cluster", what: { layer: "popular", title: "血糖忽高忽低怎么办", channel: "wechat_mp" },
      engines: ["doubao", "deepseek"], promise: "enter_mention", basis: "泛增量群几乎不被提到", metricId: "M-01S" },
    { gapId: "G6", groupId: groupIds[9], gapClass: "outdated", kind: "maintain", what: { layer: "card", title: "康舒宁包装与批号查询", channel: "brand_site" },
      engines: ["deepseek"], promise: "hold", basis: "品牌身份群已经稳定，保持更新" },
  ];
  await write("actions", { items: actions });

  // ---- the articles written for them, and the page the brand published itself
  const articles = [
    { path: "deliverables/geo-content-1/articles/correction-dosing.md", layer: "correction", title: "康舒宁用法更正说明", groupId: groupIds[0], claimIds: [claimIds.dosing], safety: "clear", errorIds: ids.slice(0, 2) },
    { path: "deliverables/geo-content-1/articles/deep-compare.md", layer: "deep", title: "周制剂降糖针的疗效与胃肠反应", groupId: groupIds[3], claimIds: [claimIds.dosing, claimIds.adverse], safety: "clear" },
    { path: "deliverables/geo-content-1/articles/card-label.md", layer: "card", title: "康舒宁说明书要点卡", groupId: groupIds[4], claimIds: [claimIds.indication], safety: "clear" },
    { path: "deliverables/geo-content-1/articles/qa-price.md", layer: "qa", title: "康舒宁的价格与报销问答", groupId: groupIds[5], claimIds: [], safety: "open" },
  ].map((article) => ({ ...article, contentSha256: createHash("sha256").update(article.path).digest("hex") }));
  const written = await write("articles", { items: articles }, { articleExists: null }).catch((error) => { log(`geo: articles — ${String(error.message).slice(0, 300)}`); return null; });
  await write("owned_links", { items: [
    { url: `https://${OWNED}/news/label-update`, platform: "brand_site", title: "说明书更新公告", publishedAt: new Date(today.getTime() - 20 * 86_400_000).toISOString().slice(0, 10), groupId: groupIds[0] },
    { url: "https://zhuanlan.example.com/p/20261001", platform: "zhihu", title: "每周一次的降糖针怎么选", publishedAt: new Date(today.getTime() - 9 * 86_400_000).toISOString().slice(0, 10), groupId: groupIds[3] },
  ] }).catch((error) => log(`geo: owned links — ${String(error.message).slice(0, 300)}`));
  log(`geo: strategy, ${actions.length} actions, ${written?.ids?.length ?? 0} articles, owned links written`);
  return { projectId: project.id, controlProjectId: controlProject.id };
}

/**
 * The answer one engine gives one question in one week, and what the judge made of it: a function of the labels alone, so that the
 * fixture is the same on every run. The product is named more often as the weeks go (except in the control groups, which no work
 * touches), more often by some engines than by others, and a few answers carry a wrong sentence.
 * @param {{ roundIndex: number, group: any, question: any, engine: string, claimIds: Record<string, string> }} input
 */
function answerOf({ roundIndex, group, question, engine, claimIds }) {
  const seed = `${roundIndex}:${question.id}:${engine}`;
  const base = { P1: 0.7, P2: 0.3, P3: 0.12, P4: 0.5 }[/** @type {"P1"} */ (group.pool)] ?? 0.3;
  const engineFactor = { doubao: 1, qianwen: 0.8, deepseek: 0.9 }[/** @type {"doubao"} */ (engine)] ?? 1;
  const lift = group.control ? 0 : roundIndex * 0.045;
  const named = unit(`mention:${seed}`) < Math.min(0.95, (base + lift) * engineFactor);
  const first = named && unit(`first:${seed}`) < 0.35;
  const recommended = named && unit(`rec:${seed}`) < 0.5;
  const position = named ? 1 + Math.floor(unit(`pos:${seed}`) * 3) : null;
  const cited = CITED_BY[/** @type {"doubao"} */ (engine)];
  const count = Math.floor(unit(`cites:${seed}`) * 4);
  /** @type {Array<{ title: string, url: string }>} */
  const citations = [];
  for (let index = 0; index < count; index += 1) {
    const domain = cited[Math.floor(unit(`site:${seed}:${index}`) * cited.length)];
    citations.push({ title: `${group.name}的参考资料 ${index + 1}`, url: `https://${domain}/a/${Math.floor(unit(`page:${seed}:${index}`) * 900) + 100}` });
  }
  const citesOurs = named && unit(`ours:${seed}`) < 0.3;
  if (citesOurs) citations.push({ title: "说明书更新公告", url: `https://${OWNED}/news/label-update` });
  const wrong = named && roundIndex >= 1 && unit(`wrong:${seed}`) < (group.pool === "P1" || group.pool === "P2" ? 0.09 : 0.02);
  const pick = Math.floor(unit(`which:${seed}`) * WRONGS.length);
  const [sentence, key, errorType, severity, evidence] = WRONGS[pick];
  const rivals = COMPETITORS.filter((_, index) => unit(`rival:${seed}:${index}`) < 0.55);
  const brands = [
    ...rivals.map((name, index) => ({ name, ours: false, competitor: true, position: index + (named && position === 1 ? 2 : 1), inRecommendation: unit(`rr:${seed}${name}`) < 0.6, count: 1 })),
    ...(named ? [{ name: BRAND, ours: true, competitor: false, position, inRecommendation: recommended, count: 1 + Math.floor(unit(`n:${seed}`) * 2) }] : []),
  ];
  const text = named
    ? `${wrong ? `${sentence}，` : ""}关于“${question.text}”：${rivals.length ? `${rivals.join("、")}和` : ""}${BRAND}都是常见的选择。${BRAND}是每周皮下注射的降糖药，用于成人2型糖尿病的血糖控制，具体请遵医嘱，并定期复查血糖。`
    : `关于“${question.text}”：建议先到内分泌科就诊，由医生根据血糖、体重和并发症情况选择药物${rivals.length ? `，常见的有${rivals.join("、")}` : ""}，不要自行购药。`;
  const statements = [
    ...(named ? [{ text: `${BRAND}是每周皮下注射的降糖药`, verdict: "correct", claimId: claimIds.dosing, claimKey: "dosing", evidence: "本品每周一次皮下注射给药" }] : []),
    ...(wrong ? [{ text: sentence, verdict: "wrong", claimId: claimIds[key], claimKey: key, evidence, errorType, severity }] : []),
  ];
  return {
    text, citations,
    wrong: wrong ? [{ text: sentence, key, errorType, severity, evidence }] : [],
    facts: {
      brands, mentionsOurs: named, firstOurs: first, recommendedOurs: recommended, positionOurs: position, brandsMentioned: brands.length,
      retrievalTriggered: citations.length > 0, citesOurs, citesOursInBody: citesOurs && unit(`body:${seed}`) < 0.5, careHint: unit(`care:${seed}`) < 0.7,
      statements, failureMode: wrong ? "wrong_ours" : named ? "correct" : "omitted", parserVersion: "walk-fixture", judgedAt: null,
      redFlagExpected: [], redFlagHits: [], safetyTermsHit: [],
    },
  };
}
