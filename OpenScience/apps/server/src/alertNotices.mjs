/**
 * What an operator's inbox says about each monitoring alert: a Chinese title
 * and one sentence, in place of the rule's own name (「告警：GeoUrgentFindingsOpen」,
 * 2026-10-07 review — the inbox showed program identifiers).
 *
 * Data, not language handling: one row per alert in
 * `deploy/web/monitoring/open-science.rules.json`, looked up by `alertname`.
 * `test/alertReceiver.test.mjs` fails when a rule has no row here and when a
 * row names no rule, so a new alert cannot ship with an English identifier
 * for a title and a deleted one cannot leave a row behind. An alert this table
 * does not know — one raised outside that file — is still delivered, as
 * 「系统告警」 with the rule's own summary (`alertNoticeText`).
 *
 * A sentence may name one of the alert's own labels as `{label}`; it is
 * replaced by the label's value, or by 「某个」 when the alert did not carry it.
 *
 * @module alertNotices
 */

/** @typedef {{ title: string, sentence: string }} AlertNotice */

/** @type {Readonly<Record<string, AlertNotice>>} */
export const ALERT_NOTICES = Object.freeze({
  // The deployment itself.
  OpenScienceApiMetricsUnavailable: { title: "监控读不到平台指标", sentence: "平台的指标接口两分钟没有回应，监控暂时看不到系统的运行情况。" },
  OpenScienceHealthProbeFailed: { title: "平台没有响应", sentence: "监控网络两分钟连不上平台，用户此刻可能打不开页面。" },
  OpenScienceReadinessProbeFailed: { title: "平台没有准备好", sentence: "平台的就绪检查连续五分钟未通过，部分功能可能不可用。" },
  OpenScienceReadinessCheckFailed: { title: "一项就绪检查未通过", sentence: "平台的某一项自检持续失败，对应的功能可能受影响。" },
  OpenScienceApiServerErrors: { title: "接口持续出错", sentence: "平台接口十分钟里持续返回服务器错误。" },
  OpenScienceApiHighErrorRatio: { title: "接口出错比例偏高", sentence: "平台接口超过两成的回答是错误，已持续十五分钟。" },
  OpenScienceRateLimitPressure: { title: "请求被频繁限流", sentence: "十分钟内有大量请求因限流或并发上限被拒绝。" },
  OpenScienceTaskQueueNearCapacity: { title: "任务队列快满了", sentence: "全局任务队列持续超过上限的八成，新任务可能要排队。" },
  OpenScienceRuntimeCapacityNearLimit: { title: "运行环境快用满了", sentence: "同时运行的研究环境持续超过上限的八成，新对话可能要等待。" },
  OpenScienceRuntimeQuotaMonitorGap: { title: "有运行环境没有被额度监控覆盖", sentence: "至少一个正在运行的研究环境不在项目空间额度的定时检查之内。" },
  OpenScienceMemoryIndexRefusingWrites: { title: "记忆索引不再收新内容", sentence: "记忆索引的最近一次写入连续十五分钟失败，多半是向量模型或它的密钥出了问题。" },
  OpenScienceMemoryRecallDegraded: { title: "记忆召回已降级", sentence: "十五分钟里每次召回都没能用上索引，只能退回关键词匹配；记忆没有丢，但排序变差了。" },
  OpenScienceCertificateExpiringSoon: { title: "网站证书三天内到期", sentence: "公开网站的 TLS 证书不到三天就过期，自动续期可能已经停了。" },
  OpenScienceHostDiskLow: { title: "服务器磁盘空间偏低", sentence: "生产服务器的剩余空间低于 20 GB，下一次发布可能装不下。" },
  OpenScienceHostDiskCritical: { title: "服务器磁盘空间告急", sentence: "生产服务器的剩余空间低于 8 GB，数据库和研究工作区有被写满的风险，请立刻清理。" },
  OpenScienceHostMemoryLow: { title: "服务器内存偏低", sentence: "生产服务器可用内存低于 2 GB，同机的构建任务可能把平台挤掉。" },
  OpenScienceHostMemoryCritical: { title: "服务器内存告急", sentence: "生产服务器可用内存低于 1 GB，系统随时可能强制结束进程，请立刻停掉正在构建的任务。" },
  OpenScienceRunFailureRatioHigh: { title: "研究运行大量失败", sentence: "最近一小时完成的研究运行里超过一半失败了。" },

  // 前沿动态 and the knowledge-source plugin it reads.
  FrontierNoSuccessfulCollection: { title: "前沿动态一小时没有读到新内容", sentence: "知识源插件一小时里没有从任何信源读到内容。" },
  FrontierTierOneHealthLow: { title: "核心信源健康度偏低", sentence: "第一梯队信源的健康率低于 95%，已持续两小时。" },
  FrontierHostRateLimited: { title: "有信源在限制抓取", sentence: "某个站点一小时里拒绝了十次以上，抓取间隔可能过紧。" },
  FrontierPluginModelCallsHigh: { title: "知识源插件的模型调用偏多", sentence: "知识源插件一天调用模型超过 50 次，可能是很多页面改版了，或者陷入了反复尝试。" },
  FrontierBacklogOld: { title: "前沿动态有任务积压", sentence: "有条目等待处理超过六小时，新内容会晚出现。" },
  FrontierIngestBelowBaseline: { title: "今天收到的内容偏少", sentence: "最近一天新进的条目不到上周同一天的一半。" },
  FrontierFirstPassLow: { title: "前沿动态编辑的一次通过率偏低", sentence: "超过一成半的编辑结果带有信源里没有的数字，被退回重写。" },
  FrontierTitleOnlyHigh: { title: "只发出标题的条目偏多", sentence: "今天超过 5% 的条目因数字核对两次没通过，只发布了原标题。" },
  FrontierBudgetNearLimit: { title: "前沿动态今日预算快用完", sentence: "模块今天的模型预算已用掉八成，超过之后新条目只收集、不再编辑。" },
  FrontierFewSelectedByNoon: { title: "今天入选的动态偏少", sentence: "北京时间中午已过，今天入选的条目还不到五条。" },
  FrontierEdgeRelayDown: { title: "东京中转节点不通", sentence: "经东京节点的请求三十分钟全部失败，依赖它的信源读不到内容。" },
  FrontierEdgeProxyCertificateExpiring: { title: "东京代理的证书快到期", sentence: "东京代理的证书不到一天就过期，自动续期可能已经停了。" },
  FrontierPluginPullStale: { title: "前沿动态三十分钟没有拉到新内容", sentence: "平台已经三十分钟没能从知识源插件拉取内容。" },
  FrontierPluginLagHigh: { title: "前沿动态落后知识源插件", sentence: "平台落后知识源插件超过 2000 条，新内容会晚很多才出现。" },
  FrontierDailyMissing: { title: "今天的前沿日报还没有生成", sentence: "07:45 已过，今天的前沿日报仍然缺失。" },
  FrontierApiSlow: { title: "前沿动态页面变慢", sentence: "前沿动态的接口响应偏慢，用户翻页和打开页面会感到卡顿。" },

  // Model providers and public sources.
  ModelProviderBalanceExhausted: { title: "模型服务商余额已用尽", sentence: "{provider} 以余额不足拒绝了调用，直到充值为止对它的每次调用都会失败。" },
  PublicSourceCredentialUnusable: { title: "数据源的密钥读不到", sentence: "数据源 {source} 的密钥已经配置却读取失败，请求会悄悄改用别的来源，请检查密钥文件的权限和路径。" },
  EvimedEvidenceRefused: { title: "EviMed 证据接口被拒绝", sentence: "EviMed 自有证据接口在过去一小时被拒绝多次，检索会退回公共数据源，报告质量可能下降。" },

  // Review, Jev and memory.
  ReviewEditorFailing: { title: "审阅编辑频繁失败", sentence: "过去一小时审阅编辑的失败超过一半，成果照常交付，但没有编辑意见。" },
  ReviewReplyChecksFailing: { title: "回答核查频繁失败", sentence: "回答的引用核查失败多于完成，带引用的回答暂时没有核查结果。" },
  JevFailing: { title: "判定服务在反复回退", sentence: "有一个判定站点反复失败并退回到原来的做法。" },
  ReviewMedicineClaimContradicted: { title: "有回答的用药结论与它引用的来源相反", sentence: "有一条回答的用药结论被它自己引用的来源推翻，研究者已在收件箱收到提醒。" },
  JevCalibrationDrift: { title: "判定服务的一致率持续偏低", sentence: "有一个判定站点的一致率连续七天低于校准基线，请先核对模型和提示再动阈值。" },
  MemoryRerankFailing: { title: "记忆重排序失败偏多", sentence: "召回结果的重排序失败多于成功，记忆仍可用，但排序退回到向量顺序。" },

  // 循证 GEO.
  GeoUrgentFindingsOpen: { title: "循证 GEO 有严重的回答偏差未处理", sentence: "有 AI 引擎把客户药品讲错，严重度为 S3 或 S4，可能影响用药安全，请尽快处理或关闭。" },
  GeoProbeLoopStalled: { title: "循证 GEO 的探测停了", sentence: "探测循环超过三十分钟没有成功跑完一轮，可见度和准确度的数据停在了上一轮。" },
  GeoProbeEnginesPaused: { title: "有 AI 引擎被暂停探测", sentence: "探测主机上有引擎被暂停超过一小时，多半是被登出了，请到探测主机重新登录。" },
});

/** The title an alert this table does not know is delivered under. */
export const UNKNOWN_ALERT_TITLE = "系统告警";

/**
 * The title and the one sentence for an alert.
 *
 * A known alert reads from its row. One this table does not know is
 * 「系统告警」 with the rule's summary, then its description, and only when it
 * carries neither the rule's name, so the notice is never empty.
 *
 * @param {{ alertname: string, summary: string, description: string, labels: Record<string, string> }} alert
 * @returns {{ title: string, sentence: string }}
 */
export function alertNoticeText(alert) {
  const known = Object.hasOwn(ALERT_NOTICES, alert.alertname) ? ALERT_NOTICES[alert.alertname] : null;
  if (!known) return { title: UNKNOWN_ALERT_TITLE, sentence: alert.summary || alert.description || alert.alertname };
  return {
    title: known.title,
    sentence: known.sentence.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, label) => alert.labels[label] || "某个"),
  };
}
