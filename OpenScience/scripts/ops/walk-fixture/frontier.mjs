/**
 * 前沿动态 for the walk's fixture: the feed a reader sees after a few days of the knowledge-source plugin, and the evidence zones beside it.
 *
 *  - eight invented sources and thirty-six published items (a story is two or three reports of one trial, named by one registry number, so
 *    the platform's own clusterer joins them), spread over the last three days so that the hot list, 精选 and today's daily all have
 *    something in them — the daily's window is the one the module computes for the day, and its issue is written by the module's own
 *    composer (`composer.tick()`: cluster, hot list, daily), not by hand;
 *  - one official zone (the platform's, written by its own account) with a long card — thirty-nine sources the platform has read, eighteen
 *    claims with their ✓ and ⚠ — and two shorter ones; one zone of the fixture account's own with a card in it, which is the author page;
 *  - the topic zones of 证据专区 (2026-10-29): one platform zone of two keywords over the newest items, with a cited 最新进展, and the
 *    account's own private zone.
 *
 * Every title, journal, trial number and sentence is invented.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps", "server");
const load = (/** @type {string[]} */ ...parts) => import(pathToFileURL(path.join(server, ...parts)).href);

const sha = (/** @type {string} */ text) => createHash("sha256").update(text).digest("hex");

/** [id, name, lane, type, authority] */
const SOURCES = [
  ["example-journal-medicine", "示例医学杂志", "evidence", "journal", 5],
  ["example-journal-cardiology", "示例心血管杂志", "evidence", "journal", 4],
  ["example-journal-oncology", "示例肿瘤学杂志", "evidence", "journal", 4],
  ["example-drug-regulator", "示例药品监管机构", "regulatory", "regulator", 5],
  ["example-evidence-body", "示例循证医学协会", "guideline", "evidence-body", 4],
  ["example-health-news", "示例健康新闻网", "evidence", "media", 3],
  ["example-pharma-news", "示例医药产业报", "pipeline", "media", 3],
  ["example-ai-medicine", "示例医学 AI 周刊", "ai", "media", 3],
];

/**
 * The items: [source, hours ago it became visible, lane, evidence type, specialties, selected, safety, registry number or null, Chinese title,
 * Chinese summary]. The first of a story is its primary report; the later ones are reports of it.
 */
const ITEMS = [
  ["example-journal-medicine", 20, "evidence", "rct", ["endocrinology"], true, false, "NCT90000001", "每周一次的降糖药在 2 型糖尿病 52 周试验中降低糖化血红蛋白 1.8 个百分点", "随机、双盲、对照试验纳入 1,264 名成人，52 周时试验组糖化血红蛋白下降 1.8 个百分点，对照组下降 0.9 个百分点；胃肠道不良反应多在加量时出现。"],
  ["example-health-news", 19, "evidence", "rct", ["endocrinology"], false, false, "NCT90000001", "周制剂降糖药试验结果发布：降糖幅度约为对照的两倍", "报道援引试验论文，降糖幅度约为对照的两倍，体重下降 6.2 公斤。"],
  ["example-pharma-news", 18, "pipeline", "press-release", ["endocrinology"], false, false, "NCT90000001", "研发企业称将在年内提交周制剂降糖药的上市申请", "企业新闻稿说明将基于该试验提交上市申请。"],
  ["example-journal-cardiology", 27, "evidence", "rct", ["cardiology"], true, false, "NCT90000002", "钠-葡萄糖协同转运蛋白 2 抑制剂降低射血分数保留心衰的住院风险", "试验随访 26 个月，心衰住院或心血管死亡的复合结局风险比 0.79。"],
  ["example-health-news", 25, "evidence", "rct", ["cardiology"], false, false, "NCT90000002", "射血分数保留的心衰有了新选择：一项大型试验的要点", "要点梳理：风险比 0.79，获益主要来自住院减少。"],
  ["example-health-news", 22, "evidence", "rct", ["cardiology"], false, false, "NCT90000002", "心衰新药试验：哪些患者获益更大", "亚组分析提示合并糖尿病的患者获益更明显。"],
  // A preview two days before the paper and a follow-up after it: the story's reports span Beijing days whatever the hour the fixture is made
  // at (48 hours between them are always two calendar days at the least), so the event page's 报道时间线 draws more than one day.
  ["example-health-news", 50, "evidence", "rct", ["cardiology"], false, false, "NCT90000002", "射血分数保留心衰的大型试验即将公布结果：业内关注什么", "业内预计试验将回答住院风险是否下降。"],
  ["example-health-news", 2, "evidence", "rct", ["cardiology"], false, false, "NCT90000002", "心衰门诊开始讨论新药的处方路径", "多家医院的心衰门诊开始讨论新药的处方路径与随访安排。"],
  ["example-journal-oncology", 31, "evidence", "rct", ["oncology"], true, false, "NCT90000003", "免疫联合化疗一线治疗晚期肺癌：总生存延长 4.1 个月", "中位总生存 19.6 个月对 15.5 个月，三级以上不良事件发生率相近。"],
  ["example-health-news", 29, "evidence", "rct", ["oncology"], false, false, "NCT90000003", "晚期肺癌一线联合方案的最新生存数据", "报道称联合组中位总生存延长 4.1 个月。"],
  ["example-journal-medicine", 36, "evidence", "rct", ["neurology"], true, false, "NCT90000004", "早期阿尔茨海默病抗体治疗 18 个月：认知下降减缓 27%", "试验纳入 1,800 名早期患者，认知量表评分下降幅度减少 27%，影像异常的发生率增加。"],
  ["example-health-news", 33, "evidence", "rct", ["neurology"], false, false, "NCT90000004", "阿尔茨海默病抗体药：获益与影像异常需要一起看", "解读强调需要监测影像学异常。"],
  ["example-journal-cardiology", 40, "evidence", "rct", ["cardiology"], true, false, "NCT90000005", "整群随机试验：社区房颤筛查使卒中发生率降低 14%", "整群随机试验覆盖 7.2 万人，筛查组卒中发生率降低 14%。"],
  ["example-health-news", 38, "evidence", "rct", ["cardiology"], false, false, "NCT90000005", "社区筛查房颤值得做吗：新试验给出答案", "筛查可以发现更多无症状房颤，抗凝治疗比例上升。"],
  ["example-evidence-body", 17, "guideline", "guideline", ["endocrinology"], true, false, null, "2 型糖尿病诊疗指南更新：强调体重管理与心肾保护", "更新版推荐把体重管理与心肾保护写入起始治疗目标。"],
  ["example-evidence-body", 43, "guideline", "guideline", ["cardiology"], false, false, null, "高血压管理专家共识：家庭血压监测的位置", "共识建议以家庭血压监测作为诊断与随访的补充。"],
  ["example-drug-regulator", 24, "regulatory", "regulatory-decision", ["endocrinology"], true, false, "NCT90000006", "药监机构批准周制剂降糖药用于成人 2 型糖尿病", "批准基于两项 III 期试验，适应证为成人 2 型糖尿病的血糖控制。"],
  ["example-pharma-news", 23, "regulatory", "regulatory-decision", ["endocrinology"], false, false, "NCT90000006", "周制剂降糖药获批上市：企业称已准备首批供货", "企业表示首批供货将在本季度到位。"],
  ["example-drug-regulator", 30, "regulatory", "regulatory-decision", ["oncology"], true, false, null, "某靶向药新增一线适应证", "新增适应证基于总生存获益。"],
  ["example-drug-regulator", 21, "safety", "safety-notice", ["pharmacy"], false, true, null, "某降脂药说明书增加肝损伤警示", "说明书修订增加肝损伤的警示与监测要求。"],
  ["example-drug-regulator", 34, "safety", "safety-notice", ["pharmacy"], false, true, null, "某批次注射剂因包装问题召回", "涉及单一批次，原因为包装密封不良。"],
  ["example-pharma-news", 26, "pipeline", "press-release", ["oncology"], false, false, "NCT90000007", "创新肿瘤药进入 III 期：企业披露首例入组", "企业披露 III 期试验首例入组。"],
  ["example-pharma-news", 28, "pipeline", "press-release", ["oncology"], false, false, "NCT90000007", "III 期肿瘤试验启动：行业观察", "行业观察认为该靶点竞争激烈。"],
  ["example-ai-medicine", 19, "ai", "review-opinion", ["radiology"], true, false, "NCT90000008", "大模型辅助读片的前瞻性评估：漏诊率下降，用时缩短", "前瞻性评估纳入 3 家医院，漏诊率下降 18%，平均阅片用时缩短 22%。"],
  ["example-ai-medicine", 18, "ai", "review-opinion", ["radiology"], false, false, "NCT90000008", "AI 辅助读片进入医院：评估结果怎么看", "评论提示评估人群来自三甲医院，外推需要谨慎。"],
  ["example-ai-medicine", 32, "ai", "review-opinion", ["anesthesiology"], false, false, null, "手术室里的预测模型：术中低血压预警", "回顾性研究提示预警模型可提前 5 分钟发现低血压。"],
  ["example-health-news", 45, "public-health", "review-opinion", ["infectious-disease"], false, false, null, "季节性流感疫苗接种率回升", "接种率较上一季度回升 3 个百分点。"],
  ["example-evidence-body", 50, "research", "review-opinion", ["pharmacy"], false, false, null, "本年度临床研究基金申报指南发布", "指南强调真实世界证据与方法学质量。"],
  ["example-journal-medicine", 52, "evidence", "systematic-review", ["nephrology"], false, false, null, "慢性肾脏病降压目标的网状 Meta 分析", "纳入 31 项试验，更低的收缩压目标与心血管事件减少相关。"],
  ["example-journal-oncology", 55, "evidence", "observational", ["oncology"], false, false, null, "癌症幸存者的心血管风险：一项全国队列研究", "队列包含 12 万名幸存者，心血管风险在治疗后十年内持续升高。"],
  ["example-journal-cardiology", 57, "evidence", "real-world", ["cardiology"], false, false, null, "真实世界中新型抗凝药的出血风险", "真实世界数据显示大出血风险与试验结果一致。"],
  ["example-health-news", 60, "evidence", "review-opinion", ["pediatrics"], false, false, null, "儿童哮喘吸入治疗的依从性问题", "依从性差是哮喘控制不佳的主要原因。"],
  ["example-pharma-news", 6, "pipeline", "press-release", ["endocrinology"], false, false, null, "企业公布口服周制剂降糖药的 II 期数据", "II 期数据显示糖化血红蛋白下降 1.4 个百分点。"],
  ["example-health-news", 4, "evidence", "review-opinion", ["endocrinology"], false, false, null, "糖尿病患者冬季血糖管理要点", "冬季应增加血糖监测频率。"],
  ["example-ai-medicine", 3, "ai", "review-opinion", ["pharmacy"], false, false, null, "药物相互作用提示系统的临床评估", "评估显示提示依从性是效果的关键。"],
  ["example-journal-medicine", 8, "evidence", "rct", ["gastroenterology"], false, false, null, "质子泵抑制剂减量试验：症状复发率相近", "减量组与维持组的症状复发率相近。"],
  ["example-journal-cardiology", 12, "evidence", "rct", ["cardiology"], false, false, null, "他汀联合依折麦布的早期强化降脂试验", "早期强化降脂使低密度脂蛋白胆固醇更快达标。"],
  // Five more stories of two reports each, so the hot list has its ten (the owner's list is full) — two of them first reported within twelve
  // hours, which the list marks 「新」.
  ["example-journal-medicine", 5, "evidence", "rct", ["gastroenterology"], false, false, "NCT90000009", "围手术期加速康复方案缩短结直肠手术住院时间", "多中心试验显示住院时间中位缩短 1.5 天，并发症发生率相近。"],
  ["example-health-news", 4, "evidence", "rct", ["gastroenterology"], false, false, "NCT90000009", "结直肠手术的加速康复：试验要点", "报道援引试验，住院时间缩短 1.5 天。"],
  ["example-journal-oncology", 9, "evidence", "rct", ["oncology"], false, false, "NCT90000010", "辅助免疫治疗用于高危黑色素瘤：三年无复发生存提高", "三年无复发生存率 68% 对 54%。"],
  ["example-pharma-news", 8, "pipeline", "press-release", ["oncology"], false, false, "NCT90000010", "辅助免疫治疗的黑色素瘤试验：企业解读", "企业解读强调三年无复发生存获益。"],
  ["example-journal-cardiology", 15, "evidence", "rct", ["cardiology"], false, false, "NCT90000011", "经导管瓣膜置换在中危患者中的五年结局", "五年死亡或致残性卒中的复合结局与外科手术相近。"],
  ["example-health-news", 14, "evidence", "rct", ["cardiology"], false, false, "NCT90000011", "瓣膜置换五年随访：微创与开胸差别不大", "五年结局相近，微创恢复更快。"],
  ["example-journal-medicine", 21, "evidence", "rct", ["nephrology"], false, false, "NCT90000012", "钠-葡萄糖协同转运蛋白 2 抑制剂延缓非糖尿病肾病进展", "肾功能下降速度减缓 0.9 毫升每分钟每年。"],
  ["example-health-news", 20, "evidence", "rct", ["nephrology"], false, false, "NCT90000012", "非糖尿病肾病也能用降糖药吗：新试验", "试验纳入非糖尿病的慢性肾脏病患者。"],
  ["example-journal-oncology", 36, "evidence", "rct", ["oncology"], false, false, "NCT90000013", "乳腺癌新辅助治疗：病理完全缓解率比较", "病理完全缓解率 45% 对 32%。"],
  ["example-health-news", 35, "evidence", "rct", ["oncology"], false, false, "NCT90000013", "乳腺癌新辅助新方案的病理缓解数据", "报道援引试验，病理完全缓解率提高 13 个百分点。"],
];

/** The items the fixture publishes, for the test that holds what the walk draws from them. */
export const FIXTURE_ITEMS = ITEMS;

/**
 * The days the fixture's archive holds besides the ones the composer writes, for a Beijing `today` (`YYYY-MM-DD`): a few from this month
 * and last month's last days, the middle of last month and one from the month before, so the archive column of 日报 is drawn with
 * months and not as one list. Every day is before `today`, unique and newest first. A day that would fall in the future of the calendar
 * of the month it is named for (the 30th of a 28-day month) is not made.
 * @param {string} today
 * @returns {string[]}
 */
export function fixtureArchiveDays(today) {
  const [year, month, day] = today.split("-").map(Number);
  const dayOf = (/** @type {number} */ y, /** @type {number} */ m, /** @type {number} */ d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
  // Day 0 of a month is the last day of the one before.
  const lastOfPrevious = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();
  const offsets = [3, 4, 6, 9].map((back) => dayOf(year, month, day - back));
  const previous = [0, 2, 7, 14].map((back) => dayOf(year, month - 1, lastOfPrevious - back));
  const older = [dayOf(year, month - 2, 20)];
  return [...new Set([...offsets, ...previous, ...older])].filter((candidate) => candidate < today).sort().reverse();
}

/**
 * 日报's archive: the issues of the days before the one the composer wrote, so the archive by month, the stamp of an issue and 「先看三件事」
 * are drawn on more than today's. The days the fixture's items cover are composed by the module itself (its window, its ranking); the
 * days before them are that newest issue again, with fewer rows in each lane so the numbers differ, written as the job writes an issue
 * (07:31 in Beijing on its day) and never over a day that has one.
 * @param {any} database @param {any} daily the composer's daily @param {(line: string) => void} log
 */
export async function furnishArchive(database, daily, log) {
  const { frontierDayIn } = await import("@evimed/domain");
  const today = frontierDayIn(new Date());
  const shift = (/** @type {string} */ day, /** @type {number} */ days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const generated = (/** @type {string} */ day) => new Date(Date.parse(`${day}T07:31:00+08:00`));
  const insert = (/** @type {string} */ day, /** @type {any} */ issue) => database.query(`INSERT INTO evimed_frontier.dailies (day, window_start, window_end, lead, sections, safety,
      ai_minute, markdown, item_ids, model, cost_cny, generated_at, finalized_at)
    VALUES ($1::date, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9::bigint[], $10, NULL, $11, $11) ON CONFLICT (day) DO NOTHING`,
  [day, issue.window.start, issue.window.end, JSON.stringify(issue.lead), JSON.stringify(issue.sections), JSON.stringify(issue.safety), issue.aiMinute,
    issue.markdown, issue.itemIds, issue.model, generated(day)]);
  let composed = 0;
  for (const back of [1, 2, 3]) {
    const day = shift(today, -back);
    const issue = await daily.compose(day).catch((/** @type {any} */ error) => { log(`frontier: archive ${day} — ${String(error?.code ?? error?.message ?? error).slice(0, 120)}`); return null; });
    if (issue) { await insert(day, issue); composed += 1; }
  }
  const template = (await database.query(`SELECT window_start, window_end, lead, sections, safety, ai_minute, markdown, item_ids, model
    FROM evimed_frontier.dailies ORDER BY day DESC LIMIT 1`)).rows[0];
  if (!template) { log(`frontier: archive — ${composed} composed, no issue to copy from`); return; }
  let copied = 0;
  for (const [at, day] of fixtureArchiveDays(today).entries()) {
    const sections = (Array.isArray(template.sections) ? template.sections : []).map((/** @type {any} */ section) => ({ ...section, itemIds: (section.itemIds ?? []).slice(0, 1 + ((at + 1) % 4)) }));
    // The archive counts an issue by the items it holds: the copy holds as many as its rows.
    const held = (template.lead ? 1 : 0) + (template.safety?.length ?? 0) + sections.reduce((sum, /** @type {any} */ section) => sum + section.itemIds.length, 0);
    await insert(day, { window: { start: template.window_start, end: template.window_end }, lead: template.lead, sections, safety: template.safety, aiMinute: template.ai_minute,
      markdown: template.markdown, itemIds: (template.item_ids ?? []).slice(0, held), model: template.model });
    copied += 1;
  }
  log(`frontier: archive — ${composed} composed, ${copied} copied (${fixtureArchiveDays(today).join(", ")})`);
}

/**
 * 追踪 (c3-track): the regulator's approvals and the evidence body's guidelines carry the records the track step extracts (written as
 * it writes them), and the congress on now — or, between meetings, the one that ended last — has three reports naming it inside its
 * window and a recap of its first day, so the walk reads the three segments and a hub with something in it. The congress is read
 * from the calendar on the day the fixture is made, so the fixture keeps one whatever the date.
 * @param {any} database @param {Function} insertComposedItem @param {{ hoursAgo: (hours: number) => string, log: (line: string) => void }} context
 */
async function furnishTrack(database, insertComposedItem, { hoursAgo, log }) {
  const { FRONTIER_CONGRESSES, frontierCongressCode, frontierCongressItemWindow, frontierCongressStatus, frontierDayIn } = await import("@evimed/domain");
  const { FRONTIER_TRACK_FACTS_VERSION } = await load("src", "frontierTrackFacts.mjs");
  const facts = (/** @type {Record<string, unknown>} */ record) => JSON.stringify({ version: FRONTIER_TRACK_FACTS_VERSION, basis: "walk-fixture", ...record });
  const approvals = (await database.query(`SELECT id, title_zh FROM evimed_frontier.items WHERE primary_source_id = 'example-drug-regulator'
    AND evidence_type = 'regulatory-decision' ORDER BY visible_at DESC`)).rows;
  const records = [
    { kind: "approval", approval: "new-drug", agency: { key: "nmpa", label: "国家药监局", from: "source" }, drug: { text: "周制剂降糖药", quote: "周制剂降糖药" },
      indication: { text: "成人 2 型糖尿病", quote: "成人 2 型糖尿病" }, date: null },
    { kind: "approval", approval: "new-indication", agency: { key: "nmpa", label: "国家药监局", from: "source" }, drug: { text: "某靶向药", quote: "某靶向药" },
      indication: { text: "一线治疗", quote: "一线适应证" }, date: null },
  ];
  for (const [index, row] of approvals.entries()) {
    await database.query("UPDATE evimed_frontier.items SET genre = 'approval', genre_basis = 'code', track_facts = $2::jsonb, track_facts_version = $3 WHERE id = $1",
      [row.id, facts(records[index % records.length]), FRONTIER_TRACK_FACTS_VERSION]);
  }
  const guidelines = (await database.query(`SELECT id FROM evimed_frontier.items WHERE primary_source_id = 'example-evidence-body' AND evidence_type = 'guideline'
    ORDER BY visible_at DESC`)).rows;
  for (const row of guidelines) {
    await database.query("UPDATE evimed_frontier.items SET genre = 'guideline', genre_basis = 'code', track_facts = $2::jsonb, track_facts_version = $3 WHERE id = $1",
      [row.id, facts({ kind: "guideline", body: { text: "示例循证医学协会", quote: "示例循证医学协会" }, scope: { text: "2 型糖尿病诊疗", quote: "诊疗指南" },
        recommendations: [{ text: "把体重管理写入起始治疗目标", grade: "strong", quote: "体重管理" }, { text: "起始治疗即考虑心肾保护", grade: null, quote: "心肾保护" }] }),
      FRONTIER_TRACK_FACTS_VERSION]);
    // The reader opens its 「AI 要点」 panel with every kind of field and the source's own words at its end (2026-10-27): a
    // production guideline drew the panel's dividers and its quote, which the fixture's items had none of, and the walk counted
    // their border kinds only on production.
    await database.query("UPDATE evimed_frontier.items SET brief = $2::jsonb WHERE id = $1", [row.id, JSON.stringify({
      genre: "guideline",
      points: [
        { key: "issuer", text: "示例循证医学协会，2026 年版" },
        { key: "population", text: "成人 2 型糖尿病的诊疗，含合并肥胖与慢性肾病者" },
        { key: "changes", items: ["把体重管理写入起始治疗目标（强推荐，中等质量证据）", "起始治疗即考虑心肾保护（弱推荐）"] },
        { key: "basis", text: "多项随机对照试验与系统评价" },
      ],
      quote: { text: "Weight management should be a primary treatment goal.", zh: "体重管理应成为首要治疗目标。" },
    })]);
  }
  const today = frontierDayIn(new Date());
  const congress = FRONTIER_CONGRESSES.find((entry) => frontierCongressStatus(entry, today) === "ongoing")
    ?? FRONTIER_CONGRESSES.filter((entry) => frontierCongressStatus(entry, today) === "recent").sort((a, b) => b.end.localeCompare(a.end))[0] ?? null;
  if (!congress) { log(`frontier: ${approvals.length} approvals and ${guidelines.length} guidelines tracked; no congress on or just ended on ${today}`); return; }
  const code = frontierCongressCode(congress);
  const window = frontierCongressItemWindow(congress);
  // The reports sit on the meeting's first day (or the window's first day still to come is today), never after now.
  const firstDay = congress.start <= today ? congress.start : window.from;
  const hours = Math.max(1, Math.round((Date.now() - new Date(`${firstDay}T10:00:00+08:00`).getTime()) / 3_600_000));
  const reports = [
    ["example-journal-oncology", "evidence", "rct", ["oncology"], true, `${code}：一项三期随机试验在大会上报告主要终点达到`, "三期随机试验在大会口头报告，主要终点的风险比 0.71。"],
    ["example-health-news", "evidence", "rct", ["oncology"], false, `${code} 现场：口头报告的新数据怎么看`, "报道援引大会口头报告，试验组的主要终点优于对照。"],
    ["example-journal-cardiology", "evidence", "observational", ["cardiology"], false, `${code} 壁报：一项真实世界队列研究`, "队列研究提示不良事件多在治疗前三个月出现。"],
  ];
  const ids = [];
  for (const [index, [sourceId, lane, evidenceType, specialties, selected, titleZh, summaryZh]] of reports.entries()) {
    const at = hoursAgo(hours - index);
    const row = await insertComposedItem(database, {
      sourceId, title: `${code} report ${index + 1}`, titleZh, summaryZh, reasonZh: selected ? "大会口头报告的三期结果，直接影响治疗选择。" : null, lane,
      sourceType: SOURCES.find((entry) => entry[0] === sourceId)?.[3] ?? "media", evidenceType, evidenceBasis: "pubmed-types", specialties, selected,
      selectedRule: selected ? "score" : null, safetyAlert: false, verification: "passed", publishedAt: at, timelineAt: at, visibleAt: at,
      scores: { authority: 24, impact: selected ? 20 : 10, novelty: 10, relevance: null }, scoreTotal: selected ? 78 : 58,
      entityKeys: specialties.map((specialty) => `specialty:${specialty}`), registryIds: [], identityKey: `walk:${sha(`congress:${index}:${titleZh}`).slice(0, 24)}`,
      abstract: summaryZh, mentions: [],
    });
    ids.push(row);
  }
  const publicIds = (await database.query("SELECT id, public_id FROM evimed_frontier.items WHERE id = ANY($1::bigint[]) ORDER BY id", [ids.map((row) => row.id)])).rows;
  if (congress.start <= today) {
    await database.query(`INSERT INTO evimed_frontier.congress_recaps (congress_id, day, recap_zh, refs, item_ids, model, generated_at)
      VALUES ($1, $2::date, $3, $4::jsonb, $5::bigint[], 'walk-fixture', now()) ON CONFLICT (congress_id, day) DO NOTHING`,
    [congress.id, congress.start, `首日的口头报告里，一项三期随机试验达到主要终点，风险比 0.71 [1]；现场报道强调试验组优于对照 [2]。一项真实世界队列提示不良事件多在治疗前三个月出现，属于观察性研究，不能说明因果 [3]。`,
      JSON.stringify(publicIds.map((row, index) => ({ n: index + 1, itemId: String(row.public_id) }))), publicIds.map((row) => row.id)]);
  }
  log(`frontier: ${approvals.length} approvals and ${guidelines.length} guidelines tracked; congress ${congress.id} (${frontierCongressStatus(congress, today)}) with ${ids.length} reports`);
}

/** Furnish one wholly synthetic outside-event topic through the current topic pipeline and its validators. */
export async function furnishTopic(database, log) {
  const { FrontierTopics, FRONTIER_TOPIC_WRITE_INSTRUCTIONS } = await load("src", "frontierTopics.mjs");
  const { migrateFrontierLeads } = await load("src", "frontierLeads.mjs");
  await migrateFrontierLeads(database);
  const title = "示例城市跑步活动后的运动风险讨论";
  const snapshots = [20, 5].map(minutes => ({ board: "weibo", fetchedAt: new Date(Date.now() - minutes * 60000).toISOString(),
    entries: [{ title, rank: 1, heat: 999, desc: "示例城市举办跑步活动，参与者讨论运动前健康评估。全部内容为界面测试合成。", url: "https://synthetic-topic.example.org/running" }] }));
  const topic = { title: "跑步前需要做哪些健康评估？", question: "健康成年人参加跑步活动前，需要关注哪些风险因素，什么情况下应先咨询医生？", peg: "", peg_entry: null,
    entities: { diseases: [], drugs: [] }, queries: { zh_reports: ["跑步 运动前健康评估"], zh_evidence: ["运动前健康评估 指南"], en_evidence: ["preparticipation screening exercise guideline"], stats: [] } };
  const topics = new FrontierTopics({ database, plugin: { configured: true, hotLists: async () => ({ boards: snapshots }) },
    editor: { callJson: async () => ({ groups: [{ members: [1], medical_members: [1], domain: "society", medical: true, needs_private_health: false, subject_names: [], question: topic.question, same_as: null, confidence: 1 }] }),
      writeJson: async (instructions, _input, _max, { verify }) => {
        const checked = verify(instructions === FRONTIER_TOPIC_WRITE_INSTRUCTIONS ? topic : { overview_zh: "" });
        return { verification: checked.issues.length ? "dropped" : "passed", output: checked.output, issues: checked.issues };
      } }, config: { frontierOutsideEventEnabled: true } });
  const result = await topics.tick();
  log(`frontier: synthetic outside-event topic ${JSON.stringify(result)}`);
  if (!result.accepted) throw new Error("The synthetic outside-event fixture topic did not pass the current pipeline.");
}

/** Deterministic stand-in for the current grouping wire: only identical synthetic registry IDs may join. */
export function fixtureGroupAnswer(messages) {
  const input = String(messages.at(-1)?.content ?? "");
  const registries = text => new Set(text.match(/NCT9\d{7}/gu) ?? []);
  const same = (left, right) => [...registries(left)].some(id => registries(right).has(id));
  if (input.includes("【报道 A】")) {
    const [left, right = ""] = input.split("【报道 B】");
    return { relation: same(left, right) ? "SAME_OCCURRENCE" : "UNRELATED", confidence: 1, difference: "Synthetic fixture registry identity" };
  }
  const [report, ...candidates] = input.split(/【候选 C\d+】/u);
  return { query: "Synthetic fixture registry identity", decisions: candidates.map((candidate, index) => ({ id: `C${index + 1}`,
    relation: same(report, candidate.split("【已入选】")[0]) ? "SAME_OCCURRENCE" : "UNRELATED", confidence: 1, note: "Synthetic fixture registry identity" })),
    selection: { addsValue: true, reason: "Synthetic companion report" } };
}

/**
 * @param {any} app @param {any} user the fixture account
 * @param {{ log: (line: string) => void }} context
 */
export async function furnishFrontier(app, user, { log }) {
  const { insertSource } = await load("test", "helpers", "frontierFixtures.mjs");
  const { insertComposedItem } = await load("test", "helpers", "frontierComposeFixtures.mjs");
  const database = app.store.database;
  const composer = app.frontier?.composer;
  /** @type {{ events: any, daily: any } | null} */
  let editors = null;
  // The stand-in is in place before the items are: the feed's own worker ticks on its own cadence and would otherwise cluster the
  // first items with no editor to ask, one event each, before the rounds below (seen 2026-10-25).
  if (composer) {
    // The model is absent here (no key, and nothing to bill it to): an editor that says what the editor would — these reports are one event,
    // here is the digest — stands in while the loops run, and the real one is put back after. Everything else is the module's own code.
    editors = { events: composer.events.editor, daily: composer.daily.editor };
    // The account the feed's jobs run under: the worker finds it on its own at its next start; the fixture does not wait for that.
    const { ensureFrontierProject } = await load("src", "frontierWorker.mjs");
    app.frontier.editor.owner = await ensureFrontierProject({ store: app.store, config: app.config });
    composer.events.editor = {
      available: true, model: "walk-fixture",
      callJson: async (messages) => fixtureGroupAnswer(messages),
      writeJson: async (_instructions, input, _max, { verify }) => {
        const summary = input.match(/^导读：(.+)$/mu)?.[1] ?? "同一合成事件的报道与原始资料供界面测试读取。";
        const title = input.match(/^中文标题：(.+)$/mu)?.[1] ?? "合成测试事件的报道与原始资料";
        const checked = verify({ title, digest: `${summary}以上均为界面测试的合成资料，不代表真实研究或真实事件。` });
        return { verification: checked.issues.length ? "dropped" : "passed", output: checked.output, issues: checked.issues };
      },
    };
    composer.daily.editor = { available: true, model: "walk-fixture", writeDaily: async () => ({ verification: "passed", aiMinuteZh: "今天与临床相关的 AI 进展有 3 条，其中一条是前瞻性评估。", error: null }) };
  }
  for (const [id, name, lane, sourceType, authority] of SOURCES) {
    await insertSource(database, id, { name, lane, source_type: sourceType, authority, owner_entity: `${id}-owner`, safety_feed: lane === "safety" || lane === "regulatory" });
  }
  const now = Date.now();
  const hoursAgo = (/** @type {number} */ hours) => new Date(now - hours * 3_600_000).toISOString();
  // Tags of the tree (frontierTags.mjs) by the item's specialty, so the walk sees cards and readers with 标签 as production has them.
  const { FrontierTagStore } = await load("src", "frontierTags.mjs");
  const tagStore = new FrontierTagStore({ database });
  /** @type {Record<string, string[]>} */
  const TAGS = { endocrinology: ["2型糖尿病"], cardiology: ["心力衰竭", "SGLT2 抑制剂"], oncology: ["非小细胞肺癌", "免疫检查点抑制剂"],
    neurology: ["阿尔茨海默病"], anesthesiology: ["低血压", "人工智能"], "infectious-disease": ["流感", "疫苗"] };
  for (const [index, [sourceId, hours, lane, evidenceType, specialties, selected, safety, registry, titleZh, summaryZh]] of ITEMS.entries()) {
    const row = await insertComposedItem(database, {
      sourceId, title: `Report ${index + 1}: ${registry ?? "no registry number"}`, titleZh, summaryZh,
      reasonZh: selected ? "一手证据，样本量大，对临床决策有直接影响。" : null, lane, sourceType: SOURCES.find((entry) => entry[0] === sourceId)?.[3] ?? "media",
      evidenceType, evidenceBasis: "pubmed-types", specialties, selected, selectedRule: selected ? "score" : null, safetyAlert: safety,
      verification: "passed", publishedAt: hoursAgo(hours + 2), timelineAt: hoursAgo(hours), visibleAt: hoursAgo(hours),
      scores: { authority: 24, impact: selected ? 18 : 8, novelty: 8, relevance: null }, scoreTotal: selected ? 84 - index : 52 - index,
      entityKeys: specialties.map((specialty) => `specialty:${specialty}`), registryIds: registry ? [registry] : [], identityKey: `walk:${sha(`${index}:${titleZh}`).slice(0, 24)}`,
      abstract: summaryZh, mentions: [],
    });
    const names = specialties.flatMap((/** @type {string} */ key) => TAGS[key] ?? []);
    if (names.length) await database.transaction((/** @type {any} */ client) => tagStore.link(client, row.id, names, { origin: "edit", specialties }));
  }
  // 就此提问 (c3-ask): the questions a reader of a selected item would ask next, as the pipeline's ask step stores them, so the reader
  // the walk opens carries its 「就此提问」 block.
  await database.query("UPDATE evimed_frontier.items SET ask_zh = $1::jsonb WHERE selected",
    [JSON.stringify(["这个结果适用于中国患者吗", "和现有标准治疗相比差在哪", "安全性数据有哪些"])]);
  log(`frontier: ${SOURCES.length} sources, ${ITEMS.length} items`);

  // The composer's own loops, once: items into events, the hot list, today's issue.
  if (composer && editors) {
    for (let round = 0; round < 3; round += 1) {
      // The loops keep their own cadence (a hot list every ten minutes); the worker has already ticked them once, before there was anything
      // to cluster. Each is made due again, and the order the composer keeps (clustering, the hot list, the digests) does the rest.
      for (const loop of Object.values(composer.loops)) /** @type {any} */ (loop).lastStarted = 0;
      const ticked = await composer.tick().catch((/** @type {any} */ error) => ({ failed: String(error?.code ?? error?.message ?? error).slice(0, 200) }));
      log(`frontier: composer tick ${round + 1} — ${JSON.stringify(ticked).slice(0, 400)}`);
    }
    log(`frontier: daily ${JSON.stringify(await composer.daily.runDue().catch((/** @type {any} */ error) => ({ failed: String(error?.code ?? error?.message ?? error) })))} ${JSON.stringify(composer.daily.status?.() ?? null).slice(0, 400)}`);
    await furnishArchive(database, composer.daily, log).catch((/** @type {any} */ error) => log(`frontier: archive — ${String(error?.message ?? error).slice(0, 200)}`));
    composer.events.editor = editors.events;
    composer.daily.editor = editors.daily;
    await furnishHotHistory(database, log);
    log(`frontier: composer ${JSON.stringify(Object.fromEntries(Object.entries(composer.status().loops).map(([name, state]) => [name, [state.runs, state.lastError]])))}`);
    const events = (await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.events")).rows[0]?.n ?? 0;
    const hot = (await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.hot_snapshots")).rows[0]?.n ?? 0;
    const dailies = (await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.dailies")).rows[0]?.n ?? 0;
    log(`frontier: ${events} events, ${hot} hot snapshot(s), ${dailies} daily issue(s)`);
  } else log("frontier: no composer — the events, the hot list and the daily were not made");
  await furnishTrack(database, insertComposedItem, { hoursAgo, log });
  await furnishTopic(database, log);

  return furnishZones(app, user, { log });
}

/**
 * What the hot list looked like in the day before it: seven earlier lists, four hours apart (the trend's points) and the one six hours
 * back that 「升温」 is read against. Without them the page has no sparkline and no 「升温」, and the owner's list has both — a fixture whose hot
 * list had a heat and no history drew none of the shapes the walk measures in a row of it (a tag beside the title, a trend at the end).
 * The rankings are the latest list's, a little lower for the events that are rising and without two of the others, so the module's own
 * reading (`frontierHotReading`) finds what it finds on a live list.
 * @param {any} database @param {(line: string) => void} log
 */
async function furnishHotHistory(database, log) {
  const latest = (await database.query("SELECT taken_at, ranking, heats FROM evimed_frontier.hot_snapshots ORDER BY taken_at DESC LIMIT 1")).rows?.[0];
  const entries = Array.isArray(latest?.ranking) ? latest.ranking : [];
  if (entries.length < 6) { log(`frontier: the hot list holds ${entries.length} events: no history was written`); return; }
  const at = new Date(latest.taken_at).getTime();
  const heats = /** @type {Record<string, number>} */ (latest.heats ?? {});
  const rising = new Set(entries.slice(3, 7).map((entry) => entry.eventId));
  let written = 0;
  for (const hoursBack of [24, 20, 16, 12, 8, 6, 4]) {
    // Eight hours back and nearer the list was as it is now with three events missing (ranks 5 to 7) and two swapped: the events that moved up are 「升温」.
    const ranking = hoursBack > 8
      ? entries.map((entry) => ({ ...entry }))
      : [...entries.slice(0, 2), entries[3], entries[2], ...entries.slice(7)].filter(Boolean).map((entry) => ({ ...entry }));
    const earlier = Object.fromEntries(Object.entries(heats).map(([id, value]) => {
      const ramp = 0.55 + 0.45 * (1 - hoursBack / 24);
      return [id, Math.round(value * (rising.has(id) ? ramp * 0.55 : ramp) * 10_000) / 10_000];
    }));
    const result = await database.query(
      "INSERT INTO evimed_frontier.hot_snapshots (taken_at, ranking, heats) VALUES ($1, $2::jsonb, $3::jsonb) ON CONFLICT (taken_at) DO NOTHING",
      [new Date(at - hoursBack * 3_600_000).toISOString(), JSON.stringify(ranking.map((entry, index) => ({ ...entry, rank: index + 1, delta: 0 }))), JSON.stringify(earlier)]);
    written += result.rowCount ?? 0;
  }
  log(`frontier: ${written} earlier hot lists written (the trend's points and the one 「升温」 is read against)`);
}

/**
 * The official zone and the fixture account's own, with their cards.
 * @param {any} app @param {any} user @param {{ log: (line: string) => void }} context
 */
async function furnishZones(app, user, { log }) {
  const zones = app.frontier?.evidenceZones;
  if (!zones) { log("frontier: no evidence zone service"); return null; }
  const { PLATFORM_PUBLISHER_USER_ID } = await import("@evimed/domain");
  const publisher = { id: PLATFORM_PUBLISHER_USER_ID };
  const own = { id: user.id };
  if (!(await app.store.userById(publisher.id).catch(() => null))) log(`frontier: the platform publisher account ${publisher.id} does not exist; the official zone cannot be written`);
  const official = (await zones.saveEditorial(publisher, { title: "糖尿病与代谢证据专区", description: "平台整理的糖尿病与代谢领域的证据，每条结论都对着它的原文。", background: "覆盖降糖药、体重管理与心肾保护。", kind: "official" }, null, null, false, "programme")).zone;
  const published = (await zones.saveEditorial(publisher, { expectedRevision: official.revision, state: "published" }, official.id, null, false, "programme")).zone;

  const sources = Array.from({ length: 39 }, (_unused, index) => {
    const n = 300 + ((index * 137) % 1_400);
    const treated = Math.round(n * (0.06 + ((index * 7) % 5) / 100));
    const control = Math.round(n * (0.1 + ((index * 3) % 6) / 100));
    return {
      title: `示例研究 ${index + 1}：${index % 3 === 0 ? "随机对照试验" : index % 3 === 1 ? "队列研究" : "系统评价"}`,
      url: `https://literature.example.org/studies/${index + 1}`,
      excerpt: `示例研究 ${index + 1} 纳入 ${n} 名成人。主要结局在干预组发生 ${treated} 例，在对照组发生 ${control} 例。`,
      fetchedSha256: sha(`source-${index + 1}`),
    };
  });
  const claims = Array.from({ length: 18 }, (_unused, index) => ({
    claimId: `CLM-${String(index + 1).padStart(3, "0")}`, claimType: "direct", claim: `第 ${index * 2 + 1} 项研究的主要结局在干预组更少。`,
    sourceIndexes: [index * 2 + 1], supportQuote: index === 4 || index === 11
      ? "主要结局在干预组发生 1 例，在对照组发生 99 例" // not in the source: a ⚠
      : sources[index * 2].excerpt.slice(sources[index * 2].excerpt.indexOf("主要结局"), sources[index * 2].excerpt.indexOf("例。") + 1),
  }));
  const card = {
    title: "周制剂降糖药与每日制剂相比，降糖和体重的差别有多大？", subtype: "academic",
    summary: "39 项研究汇总：周制剂的降糖幅度略大，体重下降更明显，胃肠道反应多在加量期出现。",
    body: "多数试验为开放标签设计，随访 26 至 104 周。降糖幅度的差别在不同基线糖化血红蛋白水平上一致；体重下降的差别随基线体重增加而增大。",
    sources, limitations: "多数试验为开放标签设计；不同研究的对照药物不同，合并时按药物类别分层。", provenance: "平台整理",
    content: { question: "周制剂降糖药与每日制剂相比，降糖和体重的差别有多大？", answer: "降糖略大，体重下降更明显。", population: "成人 2 型糖尿病",
      comparisons: [
        { title: "糖化血红蛋白 ≤ 7%", outcome: "达标率", timeframe: "52 周", denominator: 100, control: { label: "每日制剂", events: 52 }, intervention: { label: "周制剂", events: 63 },
          relativeEffect: "RR 1.21", certainty: "moderate", participants: 8400, studies: 12, outcomeRole: "benefit", sourceIndexes: [1] },
        { title: "恶心", outcome: "恶心", timeframe: "52 周", denominator: 100, control: { label: "每日制剂", events: 11 }, intervention: { label: "周制剂", events: 17 }, outcomeRole: "harm", sourceIndexes: [3] },
      ] },
    claims, state: "published",
  };
  // The short card first: the newest card leads a zone, and the walk reads the first, so the long one is written last.
  await zones.saveEditorial(publisher, { ...card, title: "减重效果相同时，哪类降糖药的胃肠道反应更少？", summary: "按药物类别比较胃肠道不良反应。", sources: sources.slice(0, 6),
    claims: claims.slice(0, 3), content: { ...card.content, comparisons: card.content.comparisons.slice(1) } }, published.id, null, true, "programme").catch((/** @type {any} */ error) => log(`frontier: second card — ${String(error?.message ?? error).slice(0, 200)}`));
  const long = (await zones.saveEditorial(publisher, card, published.id, null, true, "programme")).evidence;

  // What the account follows: a specialty, a drug, a topic and a source (the 关注 view), and the official zone (its first group).
  for (const [kind, key, label] of [["specialty", "endocrinology", "内分泌代谢"], ["drug", "weekly-agent", "每周一次降糖药"], ["topic", "heart-failure", "射血分数保留心衰"], ["source", "example-journal-medicine", "示例医学杂志"]]) {
    await app.store.database.query("INSERT INTO evimed_frontier.user_follows (user_id, kind, key, label) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [user.id, kind, key, label]);
  }
  // A typed follow (c3-watch), made the way the 「我的关注」 input makes it — the reading falls back to the typed words where no model is
  // reachable, and the last week's matches are found at once — then read as seen a day ago, so the column shows a count of what is new.
  const typed = await app.frontier?.service?.createFollow(user, { kind: "query", label: "周制剂降糖药" }).catch((/** @type {any} */ error) => ({ failed: String(error?.code ?? error?.message ?? error) }));
  const typedId = typed?.follow?.id;
  if (typedId) await app.store.database.query("UPDATE evimed_frontier.user_follows SET seen_at = now() - interval '1 day' WHERE user_id = $1 AND kind = 'query'", [user.id]);
  log(`frontier: typed follow ${typedId ? `made, ${(await app.store.database.query("SELECT count(*)::int AS n FROM evimed_frontier.follow_matches m JOIN evimed_frontier.user_follows f ON f.id = m.follow_id WHERE f.user_id = $1", [user.id])).rows[0].n} matches` : `not made: ${JSON.stringify(typed).slice(0, 200)}`}`);
  // The row `act(…, "follow")` writes; written directly because the zone's revision moved with every card saved above.
  await app.store.database.query("INSERT INTO evimed_frontier.evidence_zone_follows (user_id, zone_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [user.id, published.id]);

  // The fixture account's own zone and a card in it: the author's page.
  const mine = (await zones.save(own, { title: "我的心血管文献笔记", description: "自己读到的心血管证据", background: "读书笔记" })).zone;
  const mineLive = (await zones.save(own, { expectedRevision: mine.revision, state: "published" }, mine.id)).zone;
  await zones.save(own, { title: "房颤筛查值得做吗？", subtype: "academic", summary: "两项整群随机试验的要点。", body: "筛查发现更多无症状房颤。",
    sources: [{ title: "示例筛查试验", url: "https://literature.example.org/screening", excerpt: "筛查组卒中发生率降低 14%。" }],
    limitations: "只有两项试验。", provenance: "自己整理", content: { question: "房颤筛查值得做吗？", answer: "可能值得。", population: "65 岁以上社区人群" },
    claims: [{ claimId: "CLM-001", claimType: "direct", claim: "筛查组卒中发生率更低。", sourceIndexes: [1], supportQuote: "筛查组卒中发生率降低 14%" }], state: "published" }, mineLive.id, null, true)
    .catch((/** @type {any} */ error) => log(`frontier: own card — ${String(error?.message ?? error).slice(0, 200)}`));
  await furnishTopicZones(app, user, publisher, { log });
  log(`frontier: zones written, the long card is ${long?.id}`);
  return { officialZoneId: published.id, cardId: long?.id ?? null };
}

/**
 * The topic zones of 证据专区 (2026-10-29) as the planner and the data plane leave them, over the fixture's own items: one platform
 * zone of two keywords (its definition, its judged items — eight core, the rest related —, a cited 最新进展 and its counts) and the
 * account's own private zone. Written directly: the planner and the judge are model calls the fixture does not make.
 * @param {any} app @param {any} user @param {{ id: string }} publisher @param {{ log: (line: string) => void }} context
 */
async function furnishTopicZones(app, user, publisher, { log }) {
  const db = app.store.database;
  const { evidenceZoneRole } = await import("@evimed/domain");
  const items = (await db.query(`SELECT i.id, i.public_id, i.genre, i.safety_alert, i.source_type, i.evidence_type, i.flags, i.lane, i.platform, i.channel
    FROM evimed_frontier.items i WHERE i.state = 'published' ORDER BY i.visible_at DESC, i.id DESC LIMIT 14`)).rows;
  if (!items.length) { log("frontier: no published items for the topic zones"); return; }
  const definition = (/** @type {string} */ group) => ({ version: 1, type: "drug-indication",
    keywords: [{ label: "每周一次降糖药", terms: ["每周一次降糖药", "周制剂"], tagIds: [], entityKeys: [] }, { label: "体重管理", terms: ["体重管理", "减重", "肥胖"], tagIds: [], entityKeys: [] }],
    perspective: null, scope: "每周一次的降糖药用于体重管理的疗效、安全性与可及性；单纯降糖的研究不在此列", include: "以体重为主要结局的研究、指南、审批与安全信号。",
    exclude: "只讲降糖、体重是次要结局的研究。", excludeTerms: [], specialties: ["endocrinology"], group, seeds: { positive: [], negative: [] } });
  const zones = [
    ["ez_walk_topic", publisher.id, "official", "published", "internet", "walk-weekly-weight", "每周一次降糖药与体重管理", "肥胖"],
    ["ez_walk_mine", user.id, "user", "draft", "platform", null, "我关注的周制剂心血管结局", "心血管"],
  ];
  for (const [id, owner, kind, state, visibility, slug, title, group] of zones) {
    const value = definition(String(group));
    await db.query(`INSERT INTO evimed_frontier.evidence_zones (id, user_id, title, description, state, kind, visibility, slug, zone_type, specialties, group_label,
        scope_zh, definition, definition_version, backfilled_version, lifecycle)
      VALUES ($1,$2,$3,'',$4,$5,$6,$7,'drug-indication','{endocrinology}',$8,$9,$10::jsonb,1,1,'active') ON CONFLICT (id) DO NOTHING`,
      [id, owner, title, state, kind, visibility, slug, group, value.scope, JSON.stringify(value)]);
    for (const [index, item] of items.entries()) {
      await db.query(`INSERT INTO evimed_frontier.zone_items (zone_id, item_id, state, relevance, via, role, score, decided_by, definition_version, judged_at)
        VALUES ($1,$2,'in',$3,'tag',$4,1,'model:fixture',1,now()) ON CONFLICT DO NOTHING`,
        [id, item.id, index < 8 ? "core" : "related", evidenceZoneRole({ ...item, safetyAlert: item.safety_alert })]);
    }
  }
  const refs = items.slice(0, 2).map((item, index) => ({ n: index + 1, itemId: item.public_id }));
  await db.query(`UPDATE evimed_frontier.evidence_zones SET overview = $2::jsonb, overview_at = now() WHERE id = $1`, ["ez_walk_topic", JSON.stringify({
    text: "示例医学杂志发表了一项每周一次降糖药的减重试验，干预组 52 周体重下降 12%[1]。示例药品监管机构批准了一种周制剂用于体重管理的新适应症[2]。",
    refs, basis: "fixture", model: "fixture", version: "zone-progress-1" })]);
  const membership = app.frontier?.zoneMembership;
  for (const [id] of zones) await membership?.refreshStats?.(id).catch((/** @type {any} */ error) => log(`frontier: topic zone stats — ${String(error?.message ?? error).slice(0, 200)}`));
  log(`frontier: topic zones written over ${items.length} items`);
}
