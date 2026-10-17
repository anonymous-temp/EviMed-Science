/**
 * What an account that has been used for a few weeks holds besides the modules' own data, for the walk's fixture: the things remembered
 * about the person and the project (the memory page and its map), three scheduled tasks, and an inbox of forty-odd notices from two
 * sources. Written through the platform's own stores (`researchMemory.upsertRecord`, `autopilotService.create`,
 * `notificationService.create`); every sentence is invented.
 */

const DAY = 86_400_000;

/** [scope, kind, key, value, origin, importance, days ago it began to hold] */
const MEMORIES = [
  ["user", "profile", "profile.role", "三甲医院内分泌科主治医师，主要做 2 型糖尿病的药物治疗研究。", "explicit", 0.9, 41],
  ["user", "profile", "profile.setting", "在门诊和病房之间轮转，每周有一个半天的科研时间。", "explicit", 0.6, 40],
  ["user", "profile", "profile.language", "中文交流为主，文献检索与引用保留英文原题。", "inferred", 0.5, 39],
  ["user", "preference", "preference.answer_order", "回答先给结论，再列依据；引用文献时给出 PMID。", "explicit", 0.8, 38],
  ["user", "preference", "preference.drug_comparison_format", "比较不同药物时偏好用表格，列出剂量、疗效、安全性三列。", "inferred", 0.6, 30],
  ["user", "preference", "preference.units", "剂量统一写成 mg 与每周一次这样的写法，不用缩写。", "explicit", 0.5, 29],
  ["user", "preference", "preference.report_length", "报告类文档控制在三页以内，附表放在最后。", "inferred", 0.4, 22],
  ["user", "behavior", "behavior.checks_numbers", "引用数字时总会回到原文核对，不接受转述的数字。", "inferred", 0.5, 20],
  ["user", "behavior", "behavior.weekly_review", "每周五下午整理当周的文献与笔记。", "inferred", 0.4, 15],
  ["user", "correction", "correction.hba1c_target", "老年患者的糖化血红蛋白目标不是 7%，要看合并症与预期寿命（用户纠正过一次）。", "explicit", 0.8, 27],
  ["user", "correction", "correction.sglt2_wording", "SGLT2 抑制剂的心衰获益写“降低住院风险”，不写“降低死亡率”（用户纠正过一次）。", "explicit", 0.7, 12],
  ["project", "project_fact", "project_fact.research_question", "研究问题：成人 2 型糖尿病使用每周一次与每日一次降糖针的疗效与体重差别。", "explicit", 0.9, 36],
  ["project", "project_fact", "project_fact.population", "纳入标准：年龄 ≥ 18 岁，糖化血红蛋白 7.5%–10.5%，BMI ≥ 25。", "explicit", 0.8, 36],
  ["project", "project_fact", "project_fact.outcomes", "主要结局为 52 周糖化血红蛋白较基线变化；次要结局为体重与达标率。", "explicit", 0.8, 35],
  ["project", "project_fact", "project_fact.exclusions", "排除一型糖尿病、胰腺炎病史与重度肾功能不全。", "explicit", 0.6, 35],
  ["project", "project_fact", "project_fact.data_source", "数据来自三家医院的门诊随访记录，2019–2025 年。", "explicit", 0.6, 33],
  ["project", "decision", "decision.statistics", "2026-09-12 决定：主分析用混合效应模型，缺失按随机缺失处理并做敏感性分析。", "explicit", 0.9, 34],
  ["project", "decision", "decision.registry", "2026-09-20 决定：研究方案先在注册平台登记，再开始数据整理。", "explicit", 0.7, 27],
  ["project", "analysis", "analysis.previous_meta", "上一次的 Meta 分析用随机效应模型（REML），糖化血红蛋白的异质性 I² = 62%，纳入 9 项研究。", "explicit", 0.6, 31],
  ["project", "analysis", "analysis.sample_size", "样本量估算：双侧 α = 0.05，把握度 90%，每组 133 人，脱落率 15%。", "explicit", 0.6, 28],
  ["project", "follow_up", "follow_up.registry_number", "拿到注册号后补进方案与论文的方法部分。", "inferred", 0.5, 18],
  ["project", "follow_up", "follow_up.safety_table", "安全性表格还缺注射部位反应的数据，向数据组要。", "inferred", 0.5, 9],
  ["project", "run_summary", "run_summary.literature_scan", "9 月 28 日的文献扫描：检出 41 篇，纳入 12 篇，三篇需要补全文。", "system", 0.3, 19],
];

/** The three scheduled tasks: [title, instruction, hour, task types]. */
const TASKS = [
  ["每日行业要闻", "每天早上整理前一天与糖尿病药物治疗有关的新闻、监管动态和重要论文，按重要程度排序，每条一句话。", 7, ["routine"]],
  ["每周工作汇总", "每周五下午汇总本周的对话、文件与待办，写成一页纸的周报，并列出下周要做的三件事。", 16, ["routine"]],
  ["心衰证据追踪", "追踪射血分数保留心衰的新随机试验与指南更新，有新的证据时对照现有结论并说明差别。", 8, ["literature-sentinel", "evidence-update"]],
];

/**
 * @param {any} app @param {any} user @param {{ geoProjectId: string, studies: { finished: string, mixed: string, empty: string }, projects: { geo: string, finished: string, mixed: string } }} ids
 * @param {{ log: (line: string) => void }} context
 */
export async function furnishAccount(app, user, ids, { log }) {
  const now = Date.now();
  // The account's own project exists from its first request; here nobody has made one yet.
  await app.store.defaultProject(user);

  // ---- memory
  for (const [scope, kind, key, value, origin, importance, daysAgo] of MEMORIES) {
    await app.researchMemory.upsertRecord(user.id, {
      scope, ...(scope === "project" ? { scopeId: "default" } : {}), kind, key, value, origin, status: "active", confidence: origin === "explicit" ? 0.95 : 0.7, importance,
      validFrom: new Date(now - daysAgo * DAY).toISOString(),
    }, null, { by: "user", reason: "walk fixture" });
  }
  log(`account: ${MEMORIES.length} memory records`);

  // ---- scheduled tasks (made, not started: nothing here can run one)
  for (const [title, prompt, scheduleHour, taskTypes] of TASKS) {
    await app.autopilotService.create(user.id, { projectId: "default", title, prompt, topics: [title], taskTypes, dailyBudgetCny: 3, weeklyBudgetCny: 15, maxEpisodeCny: 2,
      scheduleHour, timeZone: "Asia/Shanghai" });
  }
  log(`account: ${TASKS.length} scheduled tasks`);

  // ---- the inbox: twenty-four notices about the GEO project and twenty about the studies
  const at = (/** @type {number} */ hoursAgo) => new Date(now - hoursAgo * 3_600_000);
  const geo = ids.geoProjectId;
  /** @type {Array<[string, string, string, string]>} title, body, tab, group key */
  const geoNotices = [
    ["第 5 周复测完成", "三个引擎共 144 个回答已核对，综合可见度指数 48，比上周低 2。", "", "geo:round"],
    ["第 4 周复测完成", "综合可见度指数 49，比上周高 4；品类对比群的提及率上升。", "", "geo:round"],
    ["第 3 周复测完成", "综合可见度指数 45，与上周持平。", "", "geo:round"],
    ["发现讲错我方", "豆包把“每周一次”讲成了“每天一次”，涉及问句“康舒宁一周打几次”。", "accuracy", "geo:wrong"],
    ["发现讲错我方", "千问称康舒宁可用于一型糖尿病患者，与说明书不符。", "accuracy", "geo:wrong"],
    ["发现讲错我方", "DeepSeek 称起始剂量为 5 mg，说明书是 2 mg。", "accuracy", "geo:wrong"],
    ["讲错已确认", "“每天注射一次”在 10 次追问中出现 8 次，已列入待处理。", "accuracy", "geo:confirm"],
    ["讲错已确认", "“可用于一型糖尿病”在 10 次追问中出现 6 次。", "accuracy", "geo:confirm"],
    ["有 3 条行动等你写", "策略给出的行动里，3 条需要稿件：更正说明、疗效对比、价格问答。", "actions", "geo:actions"],
    ["稿件已写好", "“康舒宁用法更正说明”通过检查，可以发布。", "actions", "geo:articles"],
    ["稿件已写好", "“周制剂降糖针的疗效与胃肠反应”通过检查，可以发布。", "actions", "geo:articles"],
    ["稿件需要修改", "“康舒宁的价格与报销问答”里有一处价格没有来源。", "actions", "geo:articles"],
    ["发现新的引用来源", "千问开始引用一家新的医学科普网站，已加入信源表。", "sources", "geo:sources"],
    ["自有页面被引用", "官网的“说明书更新公告”被豆包引用 3 次。", "sources", "geo:sources"],
    ["信源三条件待核对", "两家信源的三条件检查日期已超过 30 天。", "sources", "geo:sources"],
    ["问句集已锁定", "48 个问句、12 个问句群已锁定为第 1 版。", "questions", "geo:questions"],
    ["策略已更新", "新增 7 条缺口，其中 2 条与讲错有关。", "plan", "geo:strategy"],
    ["策略已更新", "主战场调整为“品类对比：疗效”与“价格与报销”。", "plan", "geo:strategy"],
    ["周报已生成", "第 4 周周报已生成，可以下载。", "", "geo:report"],
    ["周报已生成", "第 3 周周报已生成，可以下载。", "", "geo:report"],
    ["对照组出现波动", "对照群“不良反应”本周提及率下降 12 个百分点。", "visibility", "geo:control"],
    ["引擎暂时未测", "千问第 2 周有 3 个问句没有拿到回答，已计入未测。", "visibility", "geo:engine"],
    ["证据卡已更新", "说明书要点卡已按 2026 版说明书更新。", "evidence", "geo:evidence"],
    ["证据卡已发布", "“康舒宁说明书要点卡”已发布到产品专区。", "evidence", "geo:evidence"],
  ];
  /** @type {Array<[string, string, string, string]>} */
  const vcrNotices = [
    ["EV-201：定义已整理", "研究定义 v1：二线 NSCLC，主要终点为无进展生存期。", "overview", "vcr:definition"],
    ["EV-201：证据已汇总", "4 张假设卡已生成，对照组中位 PFS 4.1 个月（预测区间 3.0–5.6）。", "data", "vcr:evidence"],
    ["EV-201：人群已构建", "候选人群 3,412 名，其中 57 名符合全部入排条件。", "population", "vcr:population"],
    ["EV-201：虚拟患者已生成", "2,000 名虚拟患者，两组各 1,000 名；中位 PFS 与设定一致。", "patients", "vcr:patients"],
    ["EV-201：对照已设计", "真实外部对照无法估计，缺 3 项数据；文献对照有限制地估计。", "comparator", "vcr:comparator"],
    ["EV-201：试验方案已模拟", "4 个方案，成功把握 58%–74%；方案 B 样本量 180。", "trial", "vcr:trial"],
    ["EV-201：匹配已完成", "6 人已评估，1 人符合全部条件，2 人证据不足。", "matching", "vcr:matching"],
    ["EV-201：有人等你确认联系", "P-0192 的转诊记录等待协调员确认后联系。", "matching", "vcr:contact"],
    ["EV-201：有人等你确认联系", "P-0233 缺少体能评分，需要先请求补证。", "matching", "vcr:contact"],
    ["EV-201：研究包已生成", "研究包 v1 已生成，可以下载。", "overview", "vcr:package"],
    ["EV-202：患者这一步没有做完", "已算出的部分保留；可以接着做。", "patients", "vcr:patients"],
    ["EV-202：有计算等你确认预算", "1 项计算需要 2.5 小时 CPU 时间，等你确认。", "overview", "vcr:budget"],
    ["EV-202：试验方案已模拟", "3 个方案，成功把握 58%–74%。", "trial", "vcr:trial"],
    ["EV-202：入排条件已变更", "1 个结果已过期：入排条件已变更，可以重新算。", "population", "vcr:stale"],
    ["EV-202：证据已汇总", "4 张假设卡已生成。", "data", "vcr:evidence"],
    ["EV-202：定义已整理", "研究定义 v1 已保存。", "overview", "vcr:definition"],
    ["GLP-1 周制剂：研究已创建", "还没有开始：先写下研究要回答的问题。", "overview", "vcr:created"],
    ["EV-201：预测已登记", "累计入组预测已登记，6 个月后与实际对照。", "trial", "vcr:prediction"],
    ["EV-201：新增先例", "有 3 个新的试验先例可用于入组速度的估计。", "data", "vcr:precedent"],
    ["EV-201：监管沟通已记录", "与监管机构的沟通记录已添加。", "trial", "vcr:regulatory"],
  ];
  const studyOf = (/** @type {string} */ title) => (title.startsWith("EV-202") ? ids.studies.mixed : title.startsWith("GLP-1") ? ids.studies.empty : ids.studies.finished);
  const projectOf = (/** @type {string} */ title) => (title.startsWith("EV-202") ? ids.projects.mixed : title.startsWith("GLP-1") ? "vcr-glp1" : ids.projects.finished);
  let n = 0;
  for (const [title, body, tab, groupKey] of geoNotices) {
    n += 1;
    await app.notificationService.create(user.id, { noticeType: "notify", severity: title.startsWith("发现讲错") ? "attention" : "info", title, body, projectId: ids.projects.geo,
      source: { type: "geo", id: tab ? `${geo}/${tab}` : geo }, groupKey: `${groupKey}:${n}` }, { now: at(3 + n * 9) });
  }
  for (const [title, body, tab, groupKey] of vcrNotices) {
    n += 1;
    await app.notificationService.create(user.id, { noticeType: "notify", severity: title.includes("等你") ? "attention" : "info", title, body, projectId: projectOf(title),
      source: { type: "vcr", id: `${studyOf(title)}/${tab}` }, groupKey: `${groupKey}:${n}` }, { now: at(5 + n * 8) });
  }
  log(`account: ${geoNotices.length + vcrNotices.length} inbox notices`);
}
