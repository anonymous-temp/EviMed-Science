/**
 * 前沿动态 for the walk's fixture: the feed a reader sees after a few days of the knowledge-source plugin, and the evidence zones beside it.
 *
 *  - eight invented sources and thirty-six published items (a story is two or three reports of one trial, named by one registry number, so
 *    the platform's own clusterer joins them), spread over the last three days so that the hot list, 精选 and today's daily all have
 *    something in them — the daily's window is the one the module computes for the day, and its issue is written by the module's own
 *    composer (`composer.tick()`: cluster, hot list, daily), not by hand;
 *  - one official zone (the platform's, written by its own account) with a long card — thirty-nine sources the platform has read, eighteen
 *    claims with their ✓ and ⚠ — and two shorter ones; one zone of the fixture account's own with a card in it, which is the author page.
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
  ["example-journal-oncology", 31, "evidence", "rct", ["oncology"], true, false, "NCT90000003", "免疫联合化疗一线治疗晚期肺癌：总生存延长 4.1 个月", "中位总生存 19.6 个月对 15.5 个月，三级以上不良事件发生率相近。"],
  ["example-health-news", 29, "evidence", "rct", ["oncology"], false, false, "NCT90000003", "晚期肺癌一线联合方案的最新生存数据", "报道称联合组中位总生存延长 4.1 个月。"],
  ["example-journal-medicine", 36, "evidence", "rct", ["neurology", "geriatrics"], true, false, "NCT90000004", "早期阿尔茨海默病抗体治疗 18 个月：认知下降减缓 27%", "试验纳入 1,800 名早期患者，认知量表评分下降幅度减少 27%，影像异常的发生率增加。"],
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
  ["example-ai-medicine", 32, "ai", "review-opinion", ["surgery-anesthesia"], false, false, null, "手术室里的预测模型：术中低血压预警", "回顾性研究提示预警模型可提前 5 分钟发现低血压。"],
  ["example-health-news", 45, "public-health", "review-opinion", ["public-health"], false, false, null, "季节性流感疫苗接种率回升", "接种率较上一季度回升 3 个百分点。"],
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

/**
 * @param {any} app @param {any} user the fixture account
 * @param {{ log: (line: string) => void }} context
 */
export async function furnishFrontier(app, user, { log }) {
  const { insertSource } = await load("test", "helpers", "frontierFixtures.mjs");
  const { insertComposedItem } = await load("test", "helpers", "frontierComposeFixtures.mjs");
  const database = app.store.database;
  for (const [id, name, lane, sourceType, authority] of SOURCES) {
    await insertSource(database, id, { name, lane, source_type: sourceType, authority, owner_entity: `${id}-owner`, safety_feed: lane === "safety" || lane === "regulatory" });
  }
  const now = Date.now();
  const hoursAgo = (/** @type {number} */ hours) => new Date(now - hours * 3_600_000).toISOString();
  for (const [index, [sourceId, hours, lane, evidenceType, specialties, selected, safety, registry, titleZh, summaryZh]] of ITEMS.entries()) {
    await insertComposedItem(database, {
      sourceId, title: `Report ${index + 1}: ${registry ?? "no registry number"}`, titleZh, summaryZh,
      reasonZh: selected ? "一手证据，样本量大，对临床决策有直接影响。" : null, lane, sourceType: SOURCES.find((entry) => entry[0] === sourceId)?.[3] ?? "media",
      evidenceType, evidenceBasis: "pubmed-types", specialties, selected, selectedRule: selected ? "score" : null, safetyAlert: safety,
      verification: "passed", publishedAt: hoursAgo(hours + 2), timelineAt: hoursAgo(hours), visibleAt: hoursAgo(hours),
      scores: { authority: 24, impact: selected ? 18 : 8, novelty: 8, relevance: null }, scoreTotal: selected ? 84 - index : 52 - index,
      entityKeys: specialties.map((specialty) => `specialty:${specialty}`), registryIds: registry ? [registry] : [], identityKey: `walk:${sha(`${index}:${titleZh}`).slice(0, 24)}`,
      abstract: summaryZh, mentions: [],
    });
  }
  log(`frontier: ${SOURCES.length} sources, ${ITEMS.length} items`);

  // The composer's own loops, once: items into events, the hot list, today's issue.
  const composer = app.frontier?.composer;
  if (composer) {
    // The model is absent here (no key, and nothing to bill it to): an editor that says what the editor would — these reports are one event,
    // here is the digest — stands in while the loops run, and the real one is put back after. Everything else is the module's own code.
    const editors = { events: composer.events.editor, daily: composer.daily.editor };
    // The account the feed's jobs run under: the worker finds it on its own at its next start; the fixture does not wait for that.
    const { ensureFrontierProject } = await load("src", "frontierWorker.mjs");
    app.frontier.editor.owner = await ensureFrontierProject({ store: app.store, config: app.config });
    composer.events.editor = {
      available: true, model: "walk-fixture",
      judgeSameEvent: async (/** @type {{ candidates: unknown[] }} */ input) => ({ verdicts: input.candidates.map(() => "yes"), error: null, attempts: 1 }),
      writeEventDigest: async (/** @type {{ reports: any[] }} */ input) => {
        const first = input.reports[0] ?? {};
        const title = String(first.titleZh ?? first.title_zh ?? first.title ?? "这件事");
        return { verification: "passed", digestZh: `${title}。共有 ${input.reports.length} 家机构报道，一手材料与转述报道各自的要点见下。`, latestZh: String(input.reports.at(-1)?.titleZh ?? title), error: null };
      },
    };
    composer.daily.editor = { available: true, model: "walk-fixture", writeDaily: async () => ({ verification: "passed", aiMinuteZh: "今天与临床相关的 AI 进展有 3 条，其中一条是前瞻性评估。", error: null }) };
    for (let round = 0; round < 3; round += 1) {
      // The loops keep their own cadence (a hot list every ten minutes); the worker has already ticked them once, before there was anything
      // to cluster. Each is made due again, and the order the composer keeps (clustering, the hot list, the digests) does the rest.
      for (const loop of Object.values(composer.loops)) /** @type {any} */ (loop).lastStarted = 0;
      const ticked = await composer.tick().catch((/** @type {any} */ error) => ({ failed: String(error?.code ?? error?.message ?? error).slice(0, 200) }));
      log(`frontier: composer tick ${round + 1} — ${JSON.stringify(ticked).slice(0, 400)}`);
    }
    log(`frontier: daily ${JSON.stringify(await composer.daily.runDue().catch((/** @type {any} */ error) => ({ failed: String(error?.code ?? error?.message ?? error) })))} ${JSON.stringify(composer.daily.status?.() ?? null).slice(0, 400)}`);
    composer.events.editor = editors.events;
    composer.daily.editor = editors.daily;
    await furnishHotHistory(database, log);
    log(`frontier: composer ${JSON.stringify(Object.fromEntries(Object.entries(composer.status().loops).map(([name, state]) => [name, [state.runs, state.lastError]])))}`);
    const events = (await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.events")).rows[0]?.n ?? 0;
    const hot = (await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.hot_snapshots")).rows[0]?.n ?? 0;
    const dailies = (await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.dailies")).rows[0]?.n ?? 0;
    log(`frontier: ${events} events, ${hot} hot snapshot(s), ${dailies} daily issue(s)`);
  } else log("frontier: no composer — the events, the hot list and the daily were not made");

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
  log(`frontier: zones written, the long card is ${long?.id}`);
  return { officialZoneId: published.id, cardId: long?.id ?? null };
}
