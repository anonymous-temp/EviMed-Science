# MetaAgent 完整修订迭代文档

更新日期：2026-05-21

适用范围：`/Users/wangzeyuan/Desktop/meta`

本文档整合了当前代码审查、实际运行观察、用户体验反馈、统计与写作输出问题、以及后续实现建议。目标不是只列局部 bug，而是给出一份可执行的完整迭代路线图，覆盖安全、依赖、上传交互、全文解析、数据提取可信度、筛选与证据门控、报告写作一致性、resume/checkpoint、死代码、静默失败、性能、测试和上线验收。

## 1. 总体结论

MetaAgent 当前已经具备系统评价/Meta 分析自动化的骨架：PICO 规划、检索、筛选、全文解析、结构化提取、统计合并、图表生成、GRADE 和 manuscript generation 都有对应模块。但当前主要问题不是“缺少一个 prompt”或“某个统计公式错误”，而是以下闭环没有打通：

1. 用户上传原文后，系统没有清晰反馈“每个文件是否接收、下载、解析、匹配、OCR、失败”。
2. 从原文提取数据后，系统没有把“每个数字来自哪一页、哪张表、哪句原文、是否验证通过、置信度如何”暴露给用户。
3. EvidenceGate、ReportState、写作 prompts、最终一致性检查没有形成统一事实源，导致最终稿容易跨章节自相矛盾。
4. CLI 和 Web 流程存在双轨逻辑，EvidenceGate、outcome matching、PDF-only 规则、resume 和 narrative fallback 在不同入口表现不一致。
5. 静默失败过多：PDF 解析失败、MeSH 超时、NMA 失败、图表失败、advisory LLM 失败、JSON 解析失败等没有统一回流给用户。
6. 安全与可复现存在直接爆雷点：`.env` 未被 ignore，`requirements.txt` 混入本地 conda/Windows 路径。

优先级判断：

- P0：安全和可运行性，必须立即修。
- P1：用户信任闭环，直接影响“上传原文”和“提取后不放心”。
- P2：报告事实一致性和流程统一，直接影响最终输出质量。
- P3：架构债、死代码接入、性能和测试补强。
- P4：边角质量和投稿级导出。

### 1.1 2026-05-20 当前迭代进展

本轮已经完成并验证的首批改动：

1. P0 安全/可运行性：`.env`、`.env.local`、`deploy.env`、`output/` 已加入 ignore；新增脱敏 `.env.example`；`requirements.txt` 改为最小可安装依赖，并做了 venv smoke test。
2. PDF intake 后端基础：新增 `core/pdf_intake.py`，写入逐文件 manifest、解析状态、失败原因、页数/表格/字符数、SHA256 cache 命中信息；Web phase2 已保存并汇总 manifest。
3. extraction review 后端基础：新增 `core/extraction_review.py`、`extraction_overrides.json` revision/If-Match 语义；`OutcomeData` 增加 conflicts/override 字段；`extraction_audit.json` 增加 row_id、confidence、requires_review、conflict 统计。
4. 查询/检索硬化：QueryBuilder 增加 COVID-19/SARS-CoV-2 等高显著概念的确定性补回；PubMed 超时后接入 OpenAlex/Semantic Scholar fallback；OpenAlex abstract inverted index 已还原；fallback 查询增加 compact concept query；OpenAlex OA PDF URL 已传递给 downloader，cached screening 记录会从 `search_results.json` 回填 `pdf_url`。
5. 主效应门控：主结局 meta 只纳入 overall 行；目标和提取 outcome 的 day timepoint 不一致时拒绝匹配；同一 treatment/control 总样本签名的 preliminary/final 重复发表只保留更可信版本。
6. RoB/GRADE 诚实化：`StudyRoB.is_synthetic` 标记无全文合成 RoB；GRADE 遇到 synthetic/not assessed RoB 时不再给 `risk_of_bias=no concern`，而是强制 serious/very serious。
7. 已发表基准：建立 `docs/benchmarks/corticosteroids_covid_2020.md`，对照 WHO REACT/JAMA 2020；当前系统可生成报告，但 benchmark 仍失败，主要差距来自检索召回不足、JAMA PDF 403、abstract-only extraction 无完整事件数、以及写作事实源不统一。
8. 全文/文本获取强化：OpenAlex 多 PDF URL 候选、DOI 级 URL hydration、Europe PMC structured abstract fallback 已接入；5 篇 benchmark 候选中 3 篇拿到 PDF、2 篇明确标记为 `abstract_only`，并写入 `text_source_warnings.json`。
9. 论文身份键修复：新增 `paper_identity()`，统一使用 `pmid -> doi -> provider id -> title hash`，修复 DOI-only preprint 落入空 key 导致 parsed/extraction/RoB/reference 碰撞的问题。
10. RoB 工具选择修复：即使 extraction 漏填 study_design，只要标题/正文有 randomized/RCT 信号，也强制使用 RoB 2，不再把 RCT 漂到 Newcastle-Ottawa Scale。
11. 主效应 subgroup 硬闸增强：不仅看 `subgroup` 字段，也扫描 source quote/location 中的 subgroup 标记，防止 RECOVERY respiratory-support subgroup 被当成 overall 行。
12. 检索召回 smoke：新增 recall-first academic query（disease + corticosteroid drugs + randomized trial，去掉 comparator/outcome 限制）；OpenAlex fallback 从 29 条提高到 76 条候选，并能检出额外 RCT（如 METCOVID methylprednisolone、Edalatifard methylprednisolone）。
13. 写作事实源：新增 `core/manuscript_facts.py`，在 `WritingAgent.run()` 生成 `manuscript/manuscript_facts.json` 与 `manuscript_validation.json`；hard validators 已覆盖内部标签泄漏、虚假人工/双评审声明、未登记注册声明、搜索来源遗漏、abstract-only 证据警告、k<10 发表偏倚过度解释、PRISMA/主分析数量混写、GRADE 降级域混写、5 篇纳入综述 vs 3 篇进入主结局合并的语义冲突。
14. 写作 benchmark 修复结果：在 corticosteroids/COVID-19 基准上，稿件曾可通过 wording-level hard validator，显式标注 retrieval sources 为 internal literature database + OpenAlex，并统一 5 篇纳入综述 vs 3 篇贡献可合并主结局数据。随后 evidence-readiness gate 已把该 run 从 `passed=true` 改为 `passed=false` / `report_type=evidence_gap`，原因是主效应存在 abstract-only 来源和目标时点未被 source quote/location 直接验证；写作入口现在会直接生成 deterministic evidence-gap report，不再调用普通 LLM manuscript writer。
15. 新暴露的 resume 缺陷：即使只清掉 `manuscript` checkpoint 并从 manuscript resume，当前 CLI 仍会重算 effect sizes、meta-analysis、GRADE 和 figures，说明后段 checkpoint guard 还不完整；这应并入 Sprint 5 的 checkpoint DAG/step guard 验收。
16. 检索召回二次增强：multi-source fallback 已改为 recall-first 优先、按具体药物拆分 recall query、跑完所有变体后统一去重/排序/截断；新增 RCT-usefulness 排序，benchmark smoke 在 `max_results=30` 下已将 METCOVID 排到 #1、Edalatifard 排到 #2、CoDEX 保持在前 30。
17. 主结局选择二次增强：`_outcome_matches()` 已能识别无明确 day label 的 all-cause mortality，同时拒绝 21/90-day 和 cause-specific/composite-with-death 误匹配；主分析现在每个研究只选择最高优先级 primary-outcome row，避免同一 RECOVERY 研究被 `Death` 行重复入池。
18. 协议人群匹配增强：当协议要求 critical illness/ICU/mechanical ventilation，而研究本身是 broad hospitalized population 时，主效应选择会优先使用符合协议的患者亚组（例如 RECOVERY 的 invasive mechanical ventilation 亚组），而不是全住院人群总体行。
19. LLM/schema 容错增强：`StudyCharacteristics` 和 `OutcomeData` 已能规整常见 LLM 输出形态（如 `country` 列表、按治疗策略拆分的样本量 dict、合并干预臂事件数 dict）；`LLMClient` 增加 JSON balanced-object 修复、尾逗号修复、以及接近 `max_tokens`/finish_reason=`length` 的截断告警。
20. WHO REACT/JAMA 2020 benchmark 刷新：先前 `--resume` 跑到 4 个效应量（Dequin/CAPE COVID、Edalatifard、RECOVERY 机械通气亚组、REMAP-CAP pooled corticosteroids），DL random-effects RR 0.679（95% CI 0.499-0.926，I² 49.8%）；随后接入 Europe PMC direct PDF/fullTextXML 与 subgroup 修复后，最新完整后半段重跑拿到 4 篇 PDF + 2 篇 abstract-only，FT 纳入 5 篇、主分析 3 个效应量，DL random-effects RR 0.731（95% CI 0.621-0.860，I² 0.0%）。方向接近 WHO REACT，但仍不等价，主要差距来自 JAMA PDF 403、CoDEX 缺事件数、METCOVID 抽取不稳定、Edalatifard 被严格 FT 筛选排除，以及 Dequin 21-day/28-day 时点语义仍需人工确认。
21. 次要结局误合并修复：secondary outcomes 现在复用“每研究最佳行 + 协议人群 + 目标时间点”选择逻辑；没有明确 90-day 证据的 generic mortality/death 行不会再凑成 opportunistic 90-day meta-analysis。最新 benchmark 的 `secondary_outcomes` 已降为 0，GRADE 只评估主结局。
22. 写作 hard validator 继续加厚：新增修复 “four eligible RCTs” 与 “four analyzable RCTs” 混写、GRADE `imprecision=no concern` 却写 precision limitation、publication-bias 句子残留 `’s test/or )` 和使用 included-study `n` 代替 primary-analysis `k` 等问题。
23. 最新运行暴露的下一批硬闸：`extraction_audit.json` 有 49 行 outcome，其中 36 行 requires_review、27 行 conflict；当前系统虽然能生成 manuscript，但已经不再把它默认为 publication-ready。`manuscript_facts.json` 新增 `evidence_readiness`，当前 benchmark 因 `abstract_only_primary_effect` 和 `primary_timepoint_not_source_verified` 被分类为 `evidence_gap`。
24. 主效应选择可解释性：新增 `analysis/effect_selection_audit.json`，逐行记录 primary-outcome candidate 的 population_rank、outcome_rank、事件数、effect、是否入最终主分析以及排除原因。最新 benchmark 里 11 个候选行中 3 个进入最终主分析，CoDEX/METCOVID 因不可计算被排除，RECOVERY overall/氧疗亚组被协议人群规则排除或降级，REMAP-CAP 单臂策略行被 pooled corticosteroid contrast 去重；但这 3 个入池行仍因 source-backed target timepoint 未过 gate 而阻断投稿式报告。
25. Web 排队与并发名额修复：`start.py` 现在在 `MAX_SESSIONS` 命中时发送结构化 `service_busy` 事件（含 `queue_position`、`max_sessions`、running/queued 计数），不再只打一行“排队中”；同时修复 Phase 1 获取 semaphore 后等待用户 PDF 时泄漏并发名额的问题，改为 Phase 1 结束释放、Phase 2 开始重新排队获取。
26. Evidence readiness UI 后端事件：`start.py` 新增 `evidence_readiness` 结构化推送，读取 `manuscript_facts.json` + `manuscript_validation.json`，向前端暴露 `report_type`、`status`、blockers、warnings、selected primary rows、validation issue 计数和 source audit summary。EvidenceGate 直接判 evidence gap 的旧路径也会写入 facts/validation，不再只返回一段 markdown。
27. 用户修正提取值后端入口：Web 可发送 `type="extraction_override"` / `extraction_overrides`，后端按 `project_dir + expected_revision` 写入 `extraction_overrides.json`，即时应用到当前 `all_extractions.json` 并刷新 `extraction_audit.json`，同时清理 `effect_sizes/meta_analysis/grade/figures/manuscript` 下游 checkpoint，避免用户修正后仍使用旧分析结果。
28. Override 后下游重算入口：Web 可发送 `type="rerun_downstream"` / `rerun_after_overrides`，后端重新执行主效应选择、effect size、meta-analysis、GRADE（可用时）、核心图表与 manuscript facts，并回推新的 `downstream_rerun_done` + `evidence_readiness`。0 个可计算主效应会保持 `evidence_gap`，不会被误包装成 narrative。
29. Checkpoint DAG 第一版落地：`Project.clear_downstream(step)` 已按依赖图统一清理下游 checkpoint；Web extraction override 和 CLI 调整 protocol/search query 的路径已改用该入口，避免“新 PICO + 旧下游结果”的静默错乱。
30. GRADE indirectness 第一层规则化：`GRADEAgent._assess_indirectness()` 现在先跑确定性 P/I/C/O directness 检查，再让 LLM 补叙述；population/intervention/comparator/outcome mismatch、surrogate outcome、非随机研究信号会保守地决定最低 concern 级别，LLM 不能把规则判定降回 `no concern`。
31. Benchmark manifest 第一版：新增 `docs/benchmarks/corticosteroids_covid_2020.manifest.json` 和 `new_meta.core.benchmark_manifest`，把 WHO REACT/JAMA 七个 trial、NCT/PMID/DOI、事件数/总人数、OR anchor、相邻非 benchmark 研究写成机器可读数据。初版持久化 run 的 search recall 为 5/7=0.714，过 smoke 门 0.70，但离 publication-ready 的 7/7 仍差 COVID STEROID 与 Steroids-SARI；后续 registry seed probe 已把 search recall 提到 7/7，但 full-text/primary-analysis 还未重跑补齐。
32. Benchmark 项目级对照：`evaluate_project_against_benchmark()` 已能读取一个项目目录，输出 search recall、full-text recall、primary-analysis recall、selected-row 事件数总和与 published anchor 差异。当前持久化 COVID benchmark 项目：search 5/7、FT 4/7、主分析 3/7；主分析事件数为 183/678 vs 331/857，对照 JAMA anchor 222/678 vs 425/1025，明确显示差距来自缺 trial/缺事件数而不是写作层措辞。
33. ClinicalTrials.gov registry fallback：新增 `new_meta.tools.clinicaltrials`，并接入 `PaperRetriever._multi_source_fallback()`。Registry 记录会以 paper-like record 进入 screening，保留 `trial_registration`/`nct_id`、interventions、outcomes、eligibility。它针对 COVID STEROID / Steroids-SARI 这类 unpublished/registry-first trial；当前网络下 ClinicalTrials.gov live 请求超时，已用 `CLINICALTRIALS_TIMEOUT=5` 和 `ENABLE_CLINICALTRIALS_FALLBACK` 控制风险，mock 测试证明拿到 NCT04348305/NCT04244591 后 benchmark search recall 可达 7/7，后续 registry seed fallback 已在 live probe 中实现同一召回目标。
34. Registry fallback 稳定化：ClinicalTrials.gov fallback 现在支持 query cache、direct NCT fetch cache、NCT ID 自动提取、项目级 `papers/clinicaltrials_cache/` 和 `clinicaltrials_fallback_manifest.json`。每次 registry 请求会记录 `ok/cached/failed/skipped`，避免 resume/重试时反复打外部 API，也让 registry 失败可被 UI/benchmark 审计看见。
35. Benchmark 驱动的 registry 增强器：`augment_records_with_manifest_registry()` 可读取 benchmark manifest 中缺失 trial 的 NCT ID，按缺口定向抓取 ClinicalTrials.gov 记录，并输出 recall_before/recall_after、attempts、added records 审计。它只用于回归/基准评估，不把 benchmark 事件数写回系统；mock 测试覆盖“补齐 COVID STEROID/Steroids-SARI 后 5/7 -> 7/7”“拉取失败留审计”“已有 registry record 不重复追加”。
36. Manuscript-only resume 快速路径：当 `protocol/search_query/extraction/rob/effect_sizes/meta_analysis/grade/figures` 都已 checkpoint 且只缺 `manuscript` 时，CLI 现在直接从缓存加载 `meta_results.json`、extractions、RoB 和 GRADE，重写 references/manuscript 后返回，不再重算 effect sizes、meta-analysis、GRADE 和 figures。该路径有单元测试覆盖，先止住 benchmark 暴露的最常见晚期 resume 浪费；完整 step-by-step guard 仍归 Sprint 5。
37. PDF parsing checkpoint cache：CLI 的 `pdf_parsing` step 现在会把 `parsed_papers` 保存到 `papers/parsed_papers.json`，checkpoint 命中时优先读缓存，不再默认重解所有 PDF/HTML。旧项目若只有 checkpoint 没有 cache，会 fallback 重解并补写 cache；该 save/load 路径已有测试覆盖。后续仍需升级成带 content hash + parser version 的逐文件 cache。
38. Pipeline warnings 第一版：`Project.add_warning()` 已写入根目录 `pipeline_warnings.json`，并在 CLI 接入 PDF/fulltext 解析失败、低解析率、NMA 失败、GRADE 失败、figure/influence/p-curve 失败等高影响静默失败点。warning 包含 stage/code/message/context，已有追加写入测试覆盖；后续 Web 和最终报告可统一读取该文件，而不是散落在 logger 中。
39. Pipeline warnings 进入 Web evidence readiness payload：`_load_evidence_readiness_payload()` 现在会附带 `pipeline_warnings` 最近 50 条和 `pipeline_warning_count`，并把 `n_pipeline_warnings` 写入 ctx。前端只要渲染现有 `evidence_readiness` 事件，就能看到 PDF 解析、GRADE、图表等失败，不必另查日志或磁盘文件。
40. CLI/Web 统计路径继续收敛：`start.py` 的 Web phase2 与 full pipeline 主 meta-analysis/GRADE 段已改为调用 `new_meta.main._run_meta_analysis_from_effects()` 和 `_run_grade_from_cached_meta(force=True)`，不再各自手写 `meta_engine + publication_bias + GRADEAgent + MetaAnalysisResults`。这使 Web 用户 override 后重算、Web fresh run、CLI fresh run、CLI late resume 都共享同一 pooled effect / secondary outcome / subgroup / NMA / publication bias / GRADE 入口。
41. ClinicalTrials.gov fallback 稳定化第二层：外部 API 在当前环境可 5-20 秒连续超时；现在失败状态会按 `CLINICALTRIALS_FAILED_CACHE_TTL` 写入项目 cache，短期内返回 `cached_failed`，并由 `CLINICALTRIALS_FAILURE_LIMIT` 熔断剩余 registry query。实跑 COVID corticosteroid 检索时 registry 失败 2 次后其余 7 个 query 写入 `skipped=clinicaltrials_failure_limit_reached`，OpenAlex 检索继续完成，避免注册库不可达把整条检索拖垮；同时写入 `pipeline_warnings.json` 的 `clinicaltrials_fallback_failed`，使前端 evidence readiness 能解释 registry-first trial 可能缺失。
42. Registry-first protocol recall：新增 `_trial_protocol_recall_queries_for_academic_search()`，在 COVID + hydrocortisone + critical/respiratory context 下补跑 protocol/statistical-analysis-plan oriented query；同时调整 fallback ranking，让 `trial + protocol/statistical analysis plan` 这类 registry-first RCT 记录保留在 cap 前，而普通 study-design/rationale protocol 仍靠后。实跑同一 WHO REACT corticosteroid 检索，在 ClinicalTrials.gov 超时的情况下，COVID STEROID protocol paper 进入前 30，search recall 从 5/7 提升到 6/7；当时剩余缺口为 Steroids-SARI，已由后续 registry seed fallback 补齐到 search 7/7。
43. 测试合约同步 evidence readiness：旧 `tests/test_e2e.py` 曾在没有 `analysis/effect_selection_audit.json` 的情况下期待完整投稿式 manuscript；新 evidence-readiness gate 会正确阻断这种 mock。现在 e2e fixture 写入最小 source-backed primary-row audit，既能验证 publication-style writer，也不绕过证据门。当前验证：focused registry/retriever/extraction tests 29 passed；新增/改动 pytest 套件 166 passed；`tests/test_deep.py` 155/155；`tests/test_e2e.py` 通过，且 e2e 已把 8 张真实生成图转成 `figures_b64` 传入写作链路，覆盖图像嵌入、图例和 PRISMA 位置引用。
44. Cached meta-analysis resume 快速路径：当 `meta_analysis` checkpoint 和 `analysis/meta_results.json` 已存在、但 GRADE/figures/manuscript 任一缺失时，CLI 现在可直接从 `effect_sizes.json` + `meta_results.json` 恢复，继续跑缺失的 GRADE、图表和 manuscript，不再回到 Step 10 重算 effect sizes/pooling。回归测试将 pooling 函数 monkeypatch 为“被调用即失败”，验证该路径确实跳过 pooling；完整 `effect_sizes` only 起点仍留给 Sprint 5 的 step guard 收敛。
45. Cached effect-sizes resume 快速路径：当 `effect_sizes` checkpoint 和 `analysis/effect_sizes.json` 已存在、但 `meta_analysis` 及后续缺失时，CLI 现在从 cached `StudyEffect` 列表继续跑 meta-analysis/GRADE/figures/manuscript，不再重新遍历 extraction 计算主效应。新增 `_run_meta_analysis_from_effects()` 复用协议中的 fixed/DL/REML/HKSJ、secondary outcomes、subgroup、publication bias 和可选 NMA 规则；回归测试把 `_compute_study_effect()` monkeypatch 为“被调用即失败”，验证主效应不会被重算。
46. 正常 Step 11 与 resume 统一：CLI 正常路径在保存 `effect_sizes.json` 后，也改为调用 `_run_meta_analysis_from_effects()`、`_run_grade_from_cached_meta()` 和 `_generate_figures_from_cached_meta()`，不再维护一份独立的 Step 11/11b/12 大段复制逻辑。新增 helper 持久化测试验证 `_run_meta_analysis_from_effects()` 会保存 `meta_results.json` 并标记 `meta_analysis` checkpoint，降低正常运行与 late-stage resume 未来行为漂移的风险。
47. Web override downstream rerun 复用共享 helper：`start.py::_run_downstream_after_overrides_payload()` 已从手写 fixed/DL/REML/HKSJ pooling + leave-one-out + publication bias + GRADE 逻辑，改为调用 `_run_meta_analysis_from_effects()` 和 `_run_grade_from_cached_meta(force=True)`。新增 Web rerun 测试 monkeypatch 共享 helper，验证两条可计算主效应会进入共享 meta/GRADE 入口，并强制重算避免用户修正 extraction 后加载旧 GRADE checkpoint。
48. Registry seed fallback 补齐 Steroids-SARI 搜索召回：新增 `new_meta/data/registry_seed_trials.json` 与 `new_meta.tools.registry_seed`，在 ClinicalTrials.gov 超时/熔断后用本地 metadata-only registry seed 兜底 NCT04244591（Steroids-SARI）和 NCT04348305（COVID STEROID）。这些记录只作为召回/筛选线索，带 `metadata_only=true` 和 `source_warning=registry_seed_metadata_only`，不会提供事件数或绕过 evidence-readiness。实跑同一 WHO REACT corticosteroid retrieval probe，在 PubMed 与 ClinicalTrials.gov 均超时的情况下，`registry_seed` 进入 capped top 30，search recall 从 6/7 提升到 7/7；同时仍记录 `clinicaltrials_fallback_failed` warning，提示生产环境需要正式 registry mirror/AACT 支撑。
49. Metadata-only seed 防误用闸：registry seed 记录现在同时带 `text_availability="metadata_only"`、`fulltext_source="registry_seed_metadata"` 和 `needs_user_full_text=true`。PDF/full-text 下载阶段会直接跳过这类记录，不再对空 PMID/DOI 发起无意义网络抓取；`text_source_warnings.json` 会把 metadata-only 和 abstract-only 一起回流给 facts/evidence-readiness；DataExtractionAgent 若收到 metadata-only 记录会直接跳过并写 `metadata_only_extraction_skipped` warning。`manuscript_facts.json` 现在区分 `abstract_only_count`、`metadata_only_count` 和 `limited_source_count`，最终提示语改成 limited source text/metadata，避免把 registry metadata 伪装成摘要证据。新增测试确认 metadata-only seed 不触发全文下载，也不会被伪装成可抽取全文来源。
50. Benchmark patient-total validator：`BenchmarkPrimaryComparison` 现在显式输出 `observed_total_participants`、`expected_total_participants`、`participant_difference`、`patient_totals_passed` 和 `failure_reasons`。当前 WHO REACT 持久化项目被验证为 1535 vs 1703，差 -168，并带 `patient_total_mismatch`，因此不能用“方向接近”替代发表 anchor 对齐。新增测试覆盖完整 7 trial/1703 人通过、单 trial 或缺控制组人数失败、以及当前项目 gap 的结构化失败原因。
51. Manuscript patient-total hard validator：`manuscript_facts.json` 现在从 `analysis/effect_selection_audit.json` 的 selected primary rows 汇总 `primary_population.selected_total_participants`、干预/对照分母和事件数。`validate_and_repair_manuscript()` 会拦截 “1703 critically ill patients” 这类患者总数声明，如果正文数值和 selected primary rows 汇总不一致则报 `patient_total_mismatch` error；Web `evidence_readiness` payload 也暴露 `primary_population`，便于前端显示分母差异。
52. Manuscript primary-effect CI hard validator：最终写作校验现在不只检查 pooled effect 是否出现，还会在主效应数值附近解析 `95% CI`。如果正文写 `RR 0.73 (95% CI 0.50 to 0.90)`，但 `manuscript_facts.json` 是 `0.62 to 0.86`，会报 `primary_ci_mismatch` error；若主效应出现但附近找不到 CI，则报 `primary_ci_not_found` warning。新增测试覆盖 CI 错误和 CI 正确两条路径。
53. Manuscript artifact-reference hard validator：最终写作校验现在会解析正文中的 `Figure N`/`Fig. N`/`Table N` 引用，并要求对应编号有图片 alt、图注或表格标题定义；引用不存在的图/表会报 `missing_figure_reference` 或 `missing_table_reference` error。`WritingAgent` 的 PRISMA checklist 已改为只引用实际生成并传入的图号，figure embedding 与 figure legends 共享同一个 `_figure_number_map()`，避免 Figure 1/2/3/4 在正文、清单和图例中漂移。新增测试覆盖缺 Figure、缺 Table、已有定义通过，以及无图时 checklist 不再硬写 Figure 引用。
54. Manuscript study-label contribution validator：`manuscript_facts.json` 现在同时保存 `extracted_labels`、`primary_analysis_labels` 和 `non_primary_review_labels`。最终校验会在 primary/meta-analysis/quantitative-synthesis 贡献语境中拦截非主分析研究标签，例如把 `Brown 2022` 这类 review-only study 写成 “contributed to the primary meta-analysis” 会报 `non_primary_study_in_primary_claim` error；明确写 “did not contribute to the primary meta-analysis” 的否定句不会误伤。新增测试覆盖违规和正确叙述两条路径。
55. Manuscript secondary/subgroup effect validator：`manuscript_facts.json` 现在保存 `secondary_effects` 与 `subgroup_effects` 的 outcome、effect measure、pooled effect、95% CI、I² 等字段。最终校验会在结局名附近出现 `MD/RR/OR/... + 数值/95% CI` 时比对 facts；次要结局或亚组写错 pooled effect 会报 `secondary_effect_mismatch` / `subgroup_effect_mismatch`，写错 CI 会报 `secondary_ci_mismatch` / `subgroup_ci_mismatch`。未在正文报告的次要结局不会被强制要求出现，避免过度校验。
56. CLI figure embedding bridge：CLI fresh/resume 路径现在通过 `_load_figures_b64()` 从 `figures/*.png` 读取已生成图像，并按 `WritingAgent` 的 key contract 传入 `figures_b64`。覆盖键包括 `prisma_diagram`、`forest_plot`、`funnel_plot`、`rob_plot`、`contour_funnel_plot`、`sensitivity_plot`、`cumulative_forest`、`nma_network`。这修复了 Web 有图而 CLI manuscript 可能没有实际图像的问题；direct manuscript resume 测试已验证 cached figures 会传给 writer。
57. Minimal artifact package：新增 `core/artifact_package.py`，CLI fresh/resume/narrative 完成后会生成 `package/metaagent_export.zip`。当前 zip 包含 manuscript draft、`manuscript_facts.json`、`manuscript_validation.json`、`references.bib`、`pipeline_warnings.json`、extraction audit/overrides、effect-selection audit、meta/GRADE 结果、RoB 结果和 `figures/*.png`，并内置 `package_manifest.json`。这先解决“文件散落、没有投稿交付包”的问题；docx/PDF 导出仍保留在 Sprint 7 后续。
58. 事件数整数硬闸：`OutcomeData` 现在对 `events_*`、`total_*`、`n_*` 等计数字段执行严格整数语义。`29.3`、`29.3%`、`0.293`、rate/proportion-only 对象不会再被 `int()` 截断或四舍五入成事件数；如果对象同时包含 `rate` 与 `denominator` 但没有显式 `events/count`，事件数会置空并写入 `conflicts`，从 effect-size 入口自然被阻断。多臂显式事件数 dict 与嵌套 `{events,total}` dict 仍可正确求和。
59. Web extraction review queue 后端补强：`_load_extraction_review_payload()` 现在除完整 audit rows 外，还返回 `review_rows`、`conflict_rows`、`count_conflict_rows`，并给相关行打 `needs_user_count_verification=true`。`evidence_readiness` payload 同步携带前 50 条 review queue 与 count-conflict rows，让前端可以直接渲染“百分比/比例不能入池，需要用户补 numerator/denominator”的复核卡片，而不必自行解析磁盘 audit JSON。
60. PDF/full-text parse cache 加 parser version：`core/pdf_intake.py` 的内容哈希缓存现在按 `sha256 + parser_version` 命名并在 manifest 中暴露 `parser_cache_version`。同一 PDF、同一 parser 版本会秒返 `cache_hit=true`；解析器升级或缓存版本变化时会自动重解。CLI 下载得到的 PDF/HTML full text 也通过 `_parse_fulltext_source()` 走同一缓存，不再只让用户上传 PDF 享受秒返。
61. Web 进度显示全文解析缓存命中：`start.py` 两条 Web phase 路径现在累计 `n_fulltext_parse_cache_hits`，并在第 4 步完成摘要中显示“全文解析缓存命中：N 篇”。这让用户在重复上传/重跑时能直接看到哪些全文解析来自缓存，而不是只能从 intake manifest 或日志里推断。
62. Pipeline warnings 进入报告正文：`manuscript_facts.json` 现在包含 `pipeline_warnings`，`validate_and_repair_manuscript()` 会在 evidence-gap/普通报告中插入 “Pipeline Warnings” 摘要并在 validation `facts_summary.pipeline_warning_count` 记录数量。这样 PDF 403、外部 registry 超时、解析失败、图表/GRADE 失败不只存在于 Web payload 或磁盘 JSON，也会跟随最终 evidence-gap/failure artifact 一起交付。
63. Benchmark blocked-report gate：`evaluate_project_against_benchmark()` 新增 `manuscript_gate`，读取 `manuscript_facts.json`、`manuscript_validation.json` 和 `draft.md`。当 run 被判定为 `evidence_gap/failed` 或 validation 未通过时，如果 draft 仍含 `## Abstract`、`## Methods`、`## Results`（含中文标题）这类投稿式章节，benchmark 会以 `blocked_publication_sections` 失败，防止证据缺口报告回退成看似可投稿的普通 manuscript。
64. Benchmark blocked-report content gate：`manuscript_gate` 进一步检查 blocked/evidence-gap draft 中的 unsupported conclusion language，例如 `publication-ready`、`concludes ... effective`、`significantly reduced/improved`、中文“显著/证明/显示...有效/获益”等。命中时以 `blocked_unsupported_conclusion_language` 失败，避免证据缺口报告虽然标题干净、正文却暗示可投稿疗效结论。
65. Benchmark blocked-report issue-code gate：`manuscript_gate` 现在从 `evidence_readiness.blocker_codes` / `blockers[].code` 收集必须披露的阻断码；若无 readiness blockers，则回退到 validation issue kind。blocked draft 缺任一 code 会以 `blocked_missing_issue_codes` 失败。这样基准不只要求“不要写普通论文”，还要求 evidence-gap artifact 明确告诉用户是哪几个 blocker 需要处理。
66. Benchmark 主时点裁决 gate：`BenchmarkTrial` 现在可声明 `expected_primary_timepoint`、`accepted_timepoints`、`requires_timepoint_adjudication` 和 `timepoint_notes`；`compare_primary_analysis()` 会检查 selected primary row 的 source/timepoint/adjudication 字段，且不把 LLM 生成的 `outcome_name` 标签当成时点证据。若某研究使用可接受替代时点但没有 `timepoint_adjudication_note` / `accepted_timepoint` 等裁决记录，会以 `timepoint_adjudication_mismatch` 失败。WHO REACT manifest 已把 CAPE COVID 标成“28-day all-cause mortality 目标、21-day endpoint 可接受但必须显式裁决”，当前持久化 benchmark 项目会被明确标出 CAPE COVID `primary_timepoint_not_matched`，避免 21 天复合终点或无时点 source quote 被静默入池成 28 天死亡率。
67. Evidence readiness 支持时点裁决 override：`OutcomeData` / `effect_selection_audit.json` 现在带 `timepoint`、`accepted_timepoint`、`timepoint_adjudication`、`timepoint_adjudication_note`、`manual_adjudication` 字段。若 selected primary row 的 source quote/location 不直接验证目标 day，但用户/协议已通过 override 写入明确裁决，`build_manuscript_facts()` 会移除 `primary_timepoint_not_source_verified` blocker，并加入 `primary_timepoint_adjudicated` warning，保持投稿式报告可继续生成但在 UI/报告中显式留痕。
68. Web override 可写入时点裁决字段：`_save_extraction_override_payload()` 通过 `OutcomeData.model_fields` 校验字段后，会接受 `timepoint_adjudication_note` 等新字段、写入 `extraction_overrides.json`、即时应用到 `all_extractions.json` 并清理下游 checkpoint。新增回归测试确保 Web 消息能保存裁决备注，避免用户前端确认后后端 schema 不接收。
69. Web evidence-readiness 暴露时点裁决队列：`_load_evidence_readiness_payload()` 现在输出 `timepoint_adjudication_rows`，把 `primary_timepoint_not_source_verified` blocker 和 `primary_timepoint_adjudicated` warning 转成前端可直接渲染的行级任务；每行包含 source quote/location、当前 accepted/adjudication 字段、`requires_user_adjudication`、状态和 `suggested_overrides`（例如写入 `timepoint_adjudication_note`）。`extraction_review` compact rows 也同步带时点裁决字段，使用户在 review queue 中能看到并修正主时点语义问题。
70. 主分析计数 source-backed gate：`build_manuscript_facts()` 现在要求 selected primary row 的 `source_quote/source_location/source_section/source_quote_match` 中能找到入池使用的 `events_intervention/total_intervention/events_control/total_control` 四个整数；缺任一值会新增 `primary_counts_not_source_verified` blocker，并列出缺失的字段和值。当前 WHO REACT 持久化 benchmark 用新代码重算 facts 时，会明确指出 CAPE COVID 行缺 `total_intervention=76` 和 `total_control=73` 的 source backing，避免 “quote 里只出现 deaths，却把分母也当已验证”。
71. Web evidence-readiness 暴露主计数复核队列：`_load_evidence_readiness_payload()` 现在输出 `primary_count_verification_rows`，把 `primary_counts_not_source_verified` blocker 转成前端可直接渲染的行级任务；每行包含入池的四个 arm-level count、source quote/location、缺失的 `missing_values`，以及建议 override（更新 `source_quote` 和 `source_location` 为包含全部四个计数的原文表格/段落）。这把“数字从哪来”从报告错误变成可点击修正的复核动作。
72. Artifact package 内置 evidence readiness 复核清单：`create_artifact_package()` 现在会根据 `manuscript_facts.json` 生成 `review/evidence_readiness_review.json`，并在 `package_manifest.json.review` 中记录 blocker/warning/时点裁决/主计数复核行数。该 JSON 包含 blockers、warnings、selected primary rows、`timepoint_adjudication_rows` 和 `primary_count_verification_rows`，让用户离线打开 zip 包也能知道哪些行需要补原文 quote、修分母或裁决替代时点。
73. Web override 后下游重算会刷新交付包：`_run_downstream_after_overrides_payload()` 现在在 manuscript facts/validation 重算后调用 `create_artifact_package()`，返回 `package_path`，并把最新 `review/evidence_readiness_review.json` 打进 zip。这样用户保存 source quote、分母或时点裁决 override 后，触发 rerun 得到的下载包不会继续携带旧 blocker/review queue。
74. 第二个 published benchmark manifest：新增 `docs/benchmarks/sglt2_hfpef_2022.manifest.json` 和说明文档，编码 Vaduganathan et al. Lancet 2022 的 DELIVER + EMPEROR-Preserved LVEF >40% 子集 anchor：2 trials、12,251 participants、HR 0.80（95% CI 0.73-0.87）、aggregate counts 927/6128 vs 1121/6123。测试验证 DELIVER/EMPEROR-Preserved 可按 PMID/DOI 匹配，同时 DAPA-HF、EMPEROR-Reduced 等 adjacent HFrEF 记录不会误匹配到 HFmrEF/HFpEF 子集。
75. Benchmark published-anchor summary：`BenchmarkProjectReport` 现在包含 `anchor_summary`，CLI `python -m new_meta.core.benchmark_manifest ... --project` 会输出 published anchor 的 n_trials、n_participants、effect_measure、effect/CI、aggregate arm counts 和 expected_trial_ids。这样每个 benchmark report 都能直接比较“系统项目输出 vs 已发表论文 anchor”，不必人工回翻 manifest JSON。
76. Time-to-event effect measure 规划护栏：`ResearchPlanner` 现在在 `run()` / `refine()` 后执行确定性 effect-measure 规则。明确 time-to-event/survival 终点，或 SGLT2/HFmrEF-HFpEF 这类“cardiovascular death + heart-failure hospitalization/worsening HF”复合终点，会强制 `effect_measure="HR"`；普通 `28-day all-cause mortality` 等二分类死亡率仍保留 LLM/用户给出的 RR/OR。新增测试覆盖 SGLT2 HFpEF 复合终点从 RR 改 HR、普通死亡率不误改、显式 progression-free survival 改 HR。
77. Benchmark pooled-effect 对照：`BenchmarkProjectReport` 新增 `pooled_effect` gate，会读取项目 `analysis/meta_results.json` 的 primary pooled effect、95% CI、effect measure 和 `n_studies`，直接对照 manifest 中已发表 anchor。SGLT2 HFpEF benchmark 现在能判定项目是否复现 HR 0.80（95% CI 0.73-0.87，2 trials），并以 `effect_measure_mismatch`、`n_studies_mismatch`、`pooled_effect_mismatch`、`pooled_ci_mismatch` 等结构化失败原因说明差距。新增测试覆盖完全匹配、RR/HR 混用、CI 与 study count 偏离三类情况。
78. `date_range="2015-01-01 to present"` 解析修复：SGLT2 live run 暴露 `_parse_date_range()` 把 “2015 to present” 错当成 `end_year=2015`，导致内部库 400+ 条 2015 年后记录被过滤为 0。现在 `present/current/now/today/ongoing` 会解析为 `(start_year, current_year)`，并新增回归测试覆盖 `2015-01-01 to present`、`2015 to present` 和 `from 2015 to present`。
79. 合并检索 cap 前排序增强：SGLT2 live run 显示即使内部库有大量相关记录，按原始新近排序截断会让 2025/2026 综述和非目标小试验挤掉 DELIVER/EMPEROR-Preserved 主试验。`search_and_fetch()` 现在在硬 cap 前对合并结果进行 usefulness ranking，增加 SGLT2/HFpEF、preserved/mildly reduced EF、placebo、CV death/HF hospitalization、primary-trial title pattern 的权重，并用标题型短 query 补召回 `dapagliflozin/empagliflozin in heart failure with ... ejection fraction`。
80. 去重前缀/近似标题误杀修复：SGLT2 probe 暴露 `_deduplicate()` 用标题前 30 字符直接去重，会把 “Dapagliflozin in heart failure... rationale/design” 与 NEJM 主发表 “Dapagliflozin in Heart Failure...” 误判为重复；进一步排查又发现单纯 SequenceMatcher >0.95 会把 “Dapagliflozin in heart failure with preserved ejection fraction” 和 “Empagliflozin in Heart Failure with a Preserved Ejection Fraction” 当重复，从而丢掉 EMPEROR-Preserved 主发表。现在仅 DOI/PMID/精确标题/保守近似标题去重：首词不同的标题需相似度 >0.985 才合并，并新增测试确保同一 trial program 的 design paper 与 primary paper 可共存、不同 SGLT2 药物主文不会互相吞掉。
81. Benchmark primary-publication recall：`evaluate_project_against_benchmark()` 新增 `primary_publication_recall`，在普通 `search_recall` 之外专门检查 manifest 中期望的主发表 PMID/DOI 是否进入项目。这样 DELIVER/EMPEROR 的二级分析、design paper 或真实世界综述可以算作 trial-level search signal，但不能冒充主发表原文；SGLT2 测试覆盖“trial alias recall 2/2，但主发表仅 1/2，因此 publication-ready 召回失败”的场景。修复检索深度和去重后，最新 SGLT2 retrieval probe 在 `max_results=20` 下 `search_recall=2/2` 且 `primary_publication_recall=2/2`，DELIVER PMID 36027570 与 EMPEROR-Preserved PMID 34449189 均进入前 20。
82. Fallback 检索深度与筛选 cap 解耦：SGLT2 probe 暴露 `--max-papers 20` 不应同时限制外部 API 每源只抓 20 条候选；这会让同一试验项目的大量 secondary/design papers 把主发表挤出候选池。`_multi_source_fallback()` 现在至少抓取每源 50 条候选，再统一去重、排序、最终 cap 给 LLM 筛选。新增测试确认 `max_results=10` 时 fallback 仍以 `max_per_source=50` 检索，避免把用户筛选预算误当召回预算。
83. SGLT2 full benchmark 对照：2026-05-21 完整 live run（`output/benchmark_runs/20260521_073547_In_adults_with_heart_failure_with_mildly_reduced_o`）在修复检索后达到 `search_recall=2/2`、`primary_publication_recall=2/2`、主分析事件数/总人数完全匹配 published anchor（927/6128 vs 1121/6123，12,251 人），pooled HR 0.807（95% CI 0.740-0.880），与 Vaduganathan Lancet 2022 anchor HR 0.80（0.73-0.87）在预设容差内一致。
84. Benchmark primary-full-text gate：同一 SGLT2 full run 虽然统计结果对上，但两篇 NEJM 主发表均为 `abstract_only` 来源；新增 `primary_full_text_recall` gate 专门要求 expected PMID/DOI 的主发表具备 PDF/HTML/user_upload 等全文来源。当前 SGLT2 项目 `primary_full_text_recall=0/2`，这会让 benchmark 总体保持失败，避免“摘要数字算对了”被误认为可一键投稿。
85. Time-to-event endpoint 校验语义修正：SGLT2 这类 HR 主结局的 `expected_primary_timepoint` 本质是 time-to-event endpoint 定义，不是 28-day/90-day 这种随访窗口。`BenchmarkTrial.timepoint_kind="time_to_event"` 允许 source quote 中 “primary outcome + hazard ratio/HR” 作为来源验证，同时仍保留 COVID 28-day mortality 这类 strict time-window gate。
86. Evidence-gap 文稿 gate 降低误报：blocked/evidence-gap report 中“rather than a publication-ready meta-analysis”这类否定性措辞不再被当作 unsupported conclusion；`manuscript_facts` 的 evidence readiness note 也改成 “not cleared for publication-style synthesis”。真正的 “looks publication-ready / concludes effective” 仍会被 benchmark 拦截。
87. GRADE indirectness rating 顺序修正：`GRADEAgent._assess_indirectness()` 现在由规则层决定 rating，LLM 只补 narrative footnote；空的 P/I/C/design 抽取字段归为 “unverified”，不会被算作 mismatch 或 non-randomized。SGLT2 artifact 单独重跑 GRADE 后，主结局 indirectness 从错误的 `very serious` 降为 `serious`，总体 certainty 从 Very low 修正为 Low；真实阻断仍由 abstract-only primary evidence 承担。
88. Evidence-gap 后补全文入口：新增 `core/fulltext_uploads.py::attach_user_fulltexts_to_project()`，允许在项目已生成 evidence-gap 后再上传 PDF，按 PMID/DOI/题名/全文标题重叠匹配到已有 `abstract_only` 或 `metadata_only` 记录。匹配成功后会更新 `pdf_download_results.json`、`screening/full_text_screening.json`、`papers/parsed_papers.json`、`pdf_intake_manifest.json` 和 `text_source_warnings.json`，把记录标成 `text_availability="full_text"` / `fulltext_source="user_upload"`，并清理 `pdf_parsing` 及其下游 checkpoint，要求 resume 后重新解析、筛选、提取、统计和写作验证。
89. Web 补全文消息入口：`start.py` 新增 `fulltext_upload` / `user_fulltext_upload` / `attach_fulltext` 消息类型，接收 `project_dir` 与新上传 PDF 的 `fileIds`，从 MongoDB 下载后调用后补全文 helper，并返回结构化 `fulltext_upload_processed`。这让用户在看到 `abstract_only_primary_effect` blocker 后，可以补主发表全文而不是重开整个任务。
90. 后补全文不再伪造 unmatched 论文身份：后补全文 helper 对未匹配 PDF 只在 `pdf_intake_manifest.json` 中标记 `requires_user_review=true`，不会把它自动注入为 `user_pdf_0` 之类 synthetic PMID。用户需要先确认匹配/纳入后再让它进入下游，避免 PDF 上传本身改变证据集。
91. SGLT2 主全文 gate 的单元验证：新增测试证明 DELIVER/EMPEROR-Preserved 两篇 abstract-only 主发表在补充对应 PDF 后，`primary_full_text_recall` 可从失败变为 2/2 通过；同时验证后补全文会清理下游 checkpoint，使 resume 重新跑 extraction/evidence-readiness，而不是沿用旧 abstract-only 结果。
92. Evidence-readiness 全文上传队列：`_load_evidence_readiness_payload()` 新增 `fulltext_upload_rows`，把 `abstract_only_primary_effect` blocker 变成前端可直接渲染的上传任务。每行包含 row_id、study_id、PMID、DOI、title、source quote、accepted file hints 和 `suggested_upload={type:"fulltext_upload", project_dir,...}`。在 SGLT2 真实 run 上，该 payload 现在返回 2 条任务：PMID 34449189 和 36027570。
93. 后补全文后的 Web resume 闭环：`start.py` 新增 `resume_project` / `resume_after_fulltext` / `rerun_after_fulltext` 消息类型。用户上传主发表全文并匹配成功后，前端可以直接发送 `project_dir` 继续运行；后端通过 canonical CLI `python -m new_meta.main --resume ... --skip-confirm` 恢复项目，而不是在 Web 层复制一套新的 phase2 编排。返回结构化 `resume_project_started` / `resume_project_done`，包含 resume 前后 checkpoint、report_type、manuscript_path、package_path、stdout/stderr tail 和 evidence-readiness；失败会写 `pipeline_warnings.json`。新增测试覆盖成功恢复、CLI 失败回流、已完成项目跳过三类路径。
94. Benchmark summary card：`BenchmarkProjectReport` 新增 `summary_card`，把完整 benchmark JSON 压成前端/验收可读的状态卡：published anchor、observed primary effect、每个 gate 的 pass/fail、missing primary full texts 和 next_actions。SGLT2 的 abstract-only 场景现在会明确显示 `status="blocked"`、失败 gate 为 `primary_full_text_recall`、下一步为 `upload_full_texts`；benchmark CLI 也把 manuscript safety gate 纳入退出码，blocked report 若还含 Abstract/Methods 或不安全疗效结论会直接失败。
95. 后补全文匹配稳定化：真实 SGLT2 PDF 上传暴露 loose text-title overlap 会把 DELIVER/EMPEROR 两篇 NEJM 原文错配到 secondary/design paper。`fulltext_uploads.py` 现在先把上传文件 staging 到项目 `user_fulltexts/`，以文件名-主标题 exact/高相似匹配优先于全文松散重叠，并用 match-method priority 打破并列分数；未匹配文件仍只进入 review，不自动伪造 PMID。新增测试覆盖“文件名主标题优先于 loose overlap”和 staged path 持久化。
96. PDF side-column quote verification 修复：EMPEROR-Preserved NEJM PDF 的作者/机构侧栏插入到原句中，导致 `source_quote_verified=false`，进而 effect selection 错选 secondary AF analysis。`DataExtractionAgent._find_quote()` 新增 numeric-window fallback：当精确 quote 不连续时，只要关键数字和 primary outcome/hazard ratio 等语义短语在同一窗口内即可验证。SGLT2 rerun 后 EMPEROR-Preserved PMID 34449189 的主文行通过 source quote 验证，secondary AF paper 被 duplicate-primary filter 正确剔除。
97. Benchmark manuscript gate 语义拆分：`manuscript_gate` 不再把 `report_type="meta"` 且 validation failed 的稿件误当成 evidence-gap/failed blocked report。只有 evidence_gap/failed 路径才检查 forbidden Abstract/Methods/Results 和 blocked issue codes；meta 路径 validation failed 时明确给出 `manuscript_validation_failed` 和 issue kinds。这让 benchmark summary 能区分“证据缺口报告违规”和“投稿式正文事实校验失败”。
98. 写作安全阀与 deterministic repair：`WritingAgent.run()` 现在若 hard validation 仍失败，会把原投稿式草稿保存为 `manuscript/draft.rejected.md`，最终 `draft.md` 改写为 deterministic “Manuscript Validation Blocked” 报告，避免错误正文被当成成品。随后补齐三类确定性修复：相邻 secondary outcome 的效应量不再串读上一结局；主分析总样本量声明从 `manuscript_facts.json` 回填；未定义 Figure/Table 引用所在句子被删除并写入 fixed issue；non-primary study 的 `exclusion of ...` 敏感性分析语境不再误判为主分析入池。
99. SGLT2 全文修复 benchmark 通过：用户补充 DELIVER 与 EMPEROR-Preserved 两篇 NEJM PDF 后，修复项目 `output/benchmark_runs/20260521_094700_sglt2_hfpef_fulltext_repair_v3` 已达到 `search_recall=2/2`、`primary_publication_recall=2/2`、`primary_full_text_recall=2/2`、primary rows 2/2、aggregate counts 927/6128 vs 1121/6123 完全一致、pooled HR 0.807（95% CI 0.740-0.880）对齐 published anchor HR 0.80（0.73-0.87），且 `manuscript_validation.json passed=true`、benchmark `summary_card.status="passed"`。仍保留 evidence readiness warnings：3 条 limited source records、28 条 extraction review rows、6 条 conflict rows，说明系统已能生成通过硬闸的稿件，但投稿前仍需要用户完成 extraction review UI 复核闭环。
100. Extraction source cards：`start.py::_load_extraction_review_payload()` 现在不仅返回 row queue，还返回 `source_cards` / `review_cards`。每张卡把 study/title/PMID/DOI/PDF path、outcome、结构化数值字段、source quote/page/section/match、quote_verified、confidence、conflicts、当前 override revision 和 `suggested_override` 放在同一个对象里，支持前端做“点一个数字 → 看原文依据 → 修改字段 → rerun”的信任链交互。`artifact_package.py` 同步把这些卡片写入 `review/evidence_readiness_review.json`，离线 zip 也可审计。真实 SGLT2 package 刷新后包含 65 张 source cards、28 张 review cards。
101. Source-card contract 收敛：WebSocket payload 和离线 artifact 原来各自拼 source-card，存在字段漂移风险；现已抽到 `new_meta.core.extraction_review.build_extraction_source_cards()`，`start.py` 与 `artifact_package.py` 共用同一套 value field/source/override/review_reasons contract。新增 `docs/contracts/extraction_source_cards.md` 固化前端交互协议，并用测试覆盖 Web payload、artifact zip、core builder 三个入口。
101a. Source drawer 上下文补齐：`new_meta.core.extraction_review.build_source_context()` 会从 `papers/parsed_papers.json` 或本地全文文本中定位 `source_quote_match`，生成 `prefix/match_text/suffix/page/start_char/end_char`。离线 `review/extraction_review.html` 已用 `<mark>` 高亮匹配句；`start.py::_load_extraction_review_payload()` 现在也把同一 `source_context` 放进 WebSocket `extraction_review.source_cards[]`，前端可以直接实现“点数字 → 打开 source drawer → 看上下文高亮 → 确认/修改”的信任链。
102. 真实 PDF 上传错配修复：用户实际提供 DELIVER/EMPEROR-Preserved NEJM PDF 后，`fulltext_uploads.py` 首轮把 DELIVER 主文误匹配到 “According to Age” 二次分析（PMID 36029467），根因是“文件名标题是候选标题子串”被打成 1.0，盖过了主文 DOI/text evidence。现改为精确 filename-title 优先、候选标题包含文件名时按长度差降权，并新增 `test_attach_user_fulltext_prefers_exact_title_over_subgroup_title`。真实上传复测结果：DELIVER -> PMID 36027570、EMPEROR-Preserved -> PMID 34449189，均为 `filename_title`，解析出 41021/44039 字符和 4/5 张表。
103. 真实 PDF resume 全链路验证：复制项目 `output/benchmark_runs/20260521_112500_sglt2_hfpef_real_pdf_upload_fixed_match`，用用户真实 PDF 跑 attach -> parse -> resume -> extraction -> meta -> writing。核心统计复现 published anchor：primary rows 2/2，participants 12251，pooled HR 0.807（95% CI 0.740-0.880）vs Lancet anchor HR 0.80（0.73-0.87），benchmark `summary_card.status="passed"`，`manuscript_validation.json passed=true`。artifact package 含 64 张 source cards、31 张 review cards。
104. 写作 hard validator 自动修复升级：真实 PDF resume 暴露 LLM 在 Discussion 中把 `Gerasimos 2023` 这类非主分析/亚组记录写成 primary/meta-analysis 贡献，旧逻辑只能 blocking。`manuscript_facts.py` 现在会先删除“非主分析研究 + primary/pooled/meta-analysis contribution”句子，记录 `non_primary_study_claim_repaired`；删不净才继续报 `non_primary_study_in_primary_claim` hard error。同时补了 “Seven RCTs contributed data to the primary outcome analysis” 这种英文数字计数修复，避免正文把 review-included 数量写成 primary-pooled 数量。
105. FT screening role policy：真实 PDF 链路虽通过 gate，但 FT screening 一度把设计论文、二次分析、亚组分析和小型相关 RCT 送入 extraction，导致 7 篇进入提取、31 个 review cards 和大量 “insufficient HR/subgroup row skipped” warning。现已在 `ScreeningAgent` 加 deterministic role/routing：`primary_publication` 进入 `primary_extraction`，`secondary_analysis` / `design_or_protocol` / `adjacent_outcome_trial` 进入 `related_source_only` 并保留在 `full_text_screening.json` 审计中。真实 PDF 项目重跑后 FT screening 为 2 included / 8 excluded，extraction 仅跑 DELIVER 与 EMPEROR-Preserved，source cards 从 64 降到 16，review cards 从 31 降到 7，benchmark 仍 `passed=true`。
106. Role policy 反例修正：初版 role classifier 扫全文前 5000 字，EMPEROR-Preserved 主文里常见的 “with or without ...” 语句会误判为 secondary analysis；现只用标题识别 secondary/design，并在硬终点题目下用标题识别 CAMEO-DAPA 这类 mechanistic/surrogate endpoint trial 为 `adjacent_outcome_trial`。新增 `tests/test_screening_roles.py` 覆盖主文不被全文里的 subgroup 语言误伤、secondary/design/surrogate 记录不进入 extraction。
107. 离线 extraction review 页面：artifact package 现在除 `review/evidence_readiness_review.json` 外，还生成 `review/extraction_review.html`。该页面用同一套 source-card contract 渲染每个 outcome 的 study/outcome、结构化数值、source quote/page/section、verified 状态、conflicts、review reasons 与 override payload seed。真实 SGLT2 package 已刷新，`package_manifest.json.review.html_review=true`，HTML 包含 16 张 source cards / 7 张 review cards，可在前端完全接入前先作为用户可审计交付物。
108. Benchmark 对照报告进入交付包：`new_meta.core.benchmark_manifest` 新增 `--write-report`，会把 published-anchor 对照写入项目 `benchmark/benchmark_report.json` 与 `benchmark/benchmark_summary_card.json`；`artifact_package.py` 会把它们打进 zip，并额外生成 `review/benchmark_review.json` / `review/benchmark_review.html`。COVID corticosteroids 持久化项目刷新后，package manifest 显示 `benchmark_status="blocked"`、4 个 failing gates、5 个 missing primary full texts；离线 HTML 明确列出 `primary_publication_recall`、`primary_full_text_recall`、`primary_analysis`、`pooled_effect` 缺口，使“为什么不能直接投稿”可被用户审查，而不是只停留在 CLI 日志里。
109. Benchmark review 进入 Web evidence-readiness payload：新增 `new_meta.core.benchmark_review.build_benchmark_review_payload()`，`start.py::_load_evidence_readiness_payload()` 与 `artifact_package.py` 共用同一 contract，并在 payload 的 `benchmark` 字段暴露 `summary_card`、published anchor、observed primary、failing gates、missing primary full texts 和 next actions。真实项目验证：SGLT2 payload 为 `status="passed"`、0 failing gates；COVID corticosteroids payload 为 `status="blocked"`、4 failing gates、5 missing primary full texts。新增 `docs/contracts/benchmark_review.md` 固化前端接入协议。
110. Benchmark source acquisition checklist：`benchmark_review` payload 新增 `source_acquisition_tasks`，把“缺哪些材料”拆成可执行任务。`full_text_upload` 用 PMID/DOI/NCT/title hints 让用户补 DEXA-COVID 19、CoDEX、CAPE COVID 原文/补充材料；`primary_source_request` 用 NCT/alias hints 请求 COVID STEROID 与 Steroids-SARI 的 primary paper、registry results、supplement 或 JAMA appendix；`timepoint_adjudication_source` 请求 CAPE COVID 21-day endpoint 与 28-day benchmark 的裁决依据。COVID package 刷新后 `benchmark_source_acquisition_tasks=6`，Web payload 同步返回这 6 条任务；SGLT2 passed 项目为 0 条任务。
111. Benchmark source upload intake：新增 `new_meta.core.benchmark_sources.attach_benchmark_sources_to_project()` 与 WebSocket `benchmark_source_upload` / `attach_benchmark_source` / `benchmark_source` 消息。用户补来的 appendix、registry result、supplement 会被 staging 到 `benchmark/sources/<trial_id>/`，写入 `benchmark/benchmark_source_manifest.json`，并在对应 `source_acquisition_tasks` 上显示 `uploaded_sources` / `source_uploaded_needs_review`；它不会自动改 extraction 或 meta-analysis，避免一份补充材料上传后无声污染证据集。artifact package 现在也打包 `benchmark/benchmark_source_manifest.json` 并在 package manifest 记录 `benchmark_attached_source_tasks`。
112. Benchmark source parse preview：`benchmark_sources` 上传入口现在会对用户补来的 PDF/文本/HTML/CSV 做轻量解析预览，记录 `parse_status`、`parse_error`、`text_chars`、`page_count`、`table_count` 和 `text_preview`；解析失败也不丢文件，而是在 manifest 和 task card 上显示失败原因。`review/benchmark_review.html` 会在 Source Acquisition Tasks 表里显示已上传文件的解析状态、文本长度和表格数，让用户马上知道“文件接住了没有、有没有读出文本/表格”。
113. Benchmark source parsed artifacts：上传材料解析成功时，完整 parsed JSON 会保存到 `benchmark/source_parsed/<sha256>.json`，manifest/task card 暴露 `parsed_path`，artifact package 也会打包这些 parsed source artifact。Web payload 只传 preview 与路径，避免把整份 appendix/全文塞进 WebSocket，同时让后续 quote candidate / extraction override 可以稳定读取完整解析结果。
114. Benchmark source quote candidates：`benchmark_review` 现在会读取已解析的上传来源，在 source acquisition task 的 `expected_counts` 或 timepoint adjudication 目标可在原文中匹配时，为 `uploaded_sources[]` 生成 `quote_candidates[]`。候选包含 matched values、原文 quote、source page/location 和 `suggested_override` seed，并在 `review/benchmark_review.html` 中显示候选数量与匹配数字。它仍是 review-only，不会自动写入 extraction 或改变 pooled effect，必须由用户保存 override 后再 downstream rerun。
115. Benchmark source decision ledger：新增 `benchmark_source_decisions.json` 与 WebSocket `benchmark_source_decision` / `save_benchmark_source_decision` 消息。用户可以对某个 quote candidate 标记 accepted/rejected，带 `source_decision_revision` 做并发保护；accepted candidate 会在 `benchmark_review` 和离线 HTML 中显示为 `source_candidate_accepted_needs_override` / `accepted by ...`。这一步只记录人工裁决和证据链，不自动改变 extraction 或 pooled effect，为下一步“从 accepted source 生成/应用 extraction override”留下审计轨迹。
116. COVID benchmark 来源补充实测：根据用户提供的分享页链接，已用浏览器获取 WHO REACT/JAMA 2020 正文与 Figure 2 图片，下载 EudraCT COVID STEROID results、COVID-NMA Steroids-SARI trial detail，并保存到 `output/benchmark_source_downloads/covid_react_2020/`。Figure 2 OCR 会把 `6/15` 等短数字误读，因此保留原图 `who_react_figure2.png`，同时保存人工核对的 `who_react_figure2_transcribed.txt` 作为可解析 source。该 source 已 attach 到 COVID benchmark 项目并接受 4 个 primary-count candidates：DEXA-COVID 19 `2/7 vs 2/12`、CoDEX `69/128 vs 76/128`、COVID STEROID `6/15 vs 2/14`、Steroids-SARI `13/24 vs 13/23`。这一轮同时暴露了裁决语义边界：CAPE COVID 的 21-day 原文结果和 WHO REACT 28-day Figure 2 anchor 不能靠 trial paper 本身自动裁决，必须引入 benchmark source 或用户明确接受。
117. Quote candidate 假阳性修复：EudraCT COVID STEROID results 页含 `6/16 vs 2/14`，但 URL/注册号中也出现 `15`，旧算法会把长 HTML 中分散数字拼成 `6/15 vs 2/14` 假候选。`_snippet_containing_values()` 现在要求所有匹配数字位于同一个短窗口内，避免离散数字误配。新增回归测试覆盖 EudraCT-like 长文本，不再为分散数字生成候选。
118. Benchmark source application ledger：新增 `core/benchmark_source_apply.py`、`benchmark/benchmark_source_applications.json` 和 WebSocket `benchmark_source_apply` / `apply_benchmark_source_candidates` / `apply_accepted_benchmark_sources` 消息。`benchmark_source_decisions.json` 仍只表示人工裁决；真正改动 extraction 必须通过显式 apply 动作完成，并写入 application revision、candidate ids、updated_by、manual_adjudication、source_quote_verified、override_revision。它可以创建 manual-adjudication extraction stub，也可以更新已存在研究的 outcome，但不会静默覆盖原 LLM 抽取历史。
119. Accepted source → extraction → rerun 闭环：source application 会更新 `extraction/all_extractions.json`，重建 `extraction_audit.json` / extraction review payload，并调用 `Project.clear_downstream("extraction")` 清掉 effect_sizes、meta_analysis、grade、figures、manuscript 等下游 checkpoint。这样用户点“接受并应用来源数字”之后，后续 pooled effect、GRADE、manuscript 和 artifact 包会基于同一份审计后的 extraction，而不是只在 benchmark UI 上显示一个已接受标签。
120. Primary-count discrepancy tasks：`benchmark_review` 现在不仅为缺失 trial 生成 source acquisition task，也会为“已经匹配到 primary row，但事件数/总人数与 published anchor 不一致”的 trial 生成 `primary_count_discrepancy:<trial_id>` 任务。任务包含 expected_counts、observed_counts、count_mismatches、row_id 和 suggested_override，优先要求用户提供/接受能解释差异的 source。COVID benchmark 中该机制识别并处理了 CAPE COVID、REMAP-CAP、RECOVERY 三个已匹配但计数不一致的行。
121. Source candidate 稳定性与精确定位：quote candidate 现在优先返回匹配数字所在句子/表格行，避免把相邻 subgroup/fixed-effect 汇总文字带进 source quote；`benchmark_source_decisions` 可在 quote context 轻微再生成后，凭 source sha、task id、candidate type 和 matched values 找回已接受决策；source application 对 `primary_count_discrepancy` 先按 explicit `row_id` 更新，防止同一研究多个 mortality 行时误写到错误 outcome。主效应选择 audit 也改为 PMID 优先对齐 effect id，避免 manual stub 的 final-primary 标记丢失。
122. COVID benchmark source adjudication 后结果：在 WHO REACT/JAMA 2020 corticosteroids benchmark 项目中，应用 7 个已接受 source candidates/discrepancy candidates，并把协议效应量对齐为 fixed-effect OR 后，主分析行达到 7/7，汇总事件数完全对齐 published anchor：corticosteroid 222/678 vs usual care 425/1025，participant_difference=0。MetaAgent 计算 fixed-effect OR 0.659（95% CI 0.532-0.817），对齐 WHO REACT published OR 0.66（95% CI 0.53-0.82）。当前 benchmark overall 仍保持 blocked，因为 primary publication/full-text recall gate 仍未满足；这证明统计和 source override 链路已能对齐 anchor，但 fresh one-click 流程还缺全文召回与协议/效应量裁决产品化。
123. Benchmark artifact 完整性：artifact package 已打包 `benchmark_source_manifest.json`、`source_parsed/*.json`、`benchmark_source_decisions.json`、`benchmark_source_applications.json`、`benchmark_report.json`、`benchmark_summary_card.json`、`review/benchmark_review.json` 和 `review/benchmark_review.html`。package manifest 会统计 `benchmark_source_acquisition_tasks`、`benchmark_attached_source_tasks`、`benchmark_source_applications`、`benchmark_status` 和 failing gates，让离线交付包也能解释“哪些 published-anchor 差异已由用户裁决，哪些仍阻断投稿式输出”。
124. 用户补充 OA/registry source 后的 benchmark gate 修复：2026-05-22 用户提供 PMC/JAMA OA、ClinicalTrials.gov、EudraCT、COVID-NMA 链接和 DEXA/COVID STEROID PDF 后，来源已保存到 `output/benchmark_source_downloads/covid_react_2020/user_links_20260522/`，并 attach 到 COVID benchmark 项目。`benchmark_manifest` 现在会把明确标记为 `primary_source` / `primary_full_text` / `registry_result` 的 `benchmark_source_manifest` 记录纳入 primary-source/full-text gates；普通 `benchmark_source`、Figure 2 转录、截图仍不能冒充主全文。当前 COVID benchmark 变为 `benchmark_status="passed"`：primary source/full-text 7/7，primary analysis 7/7，pooled OR 对齐 published anchor；原始 search recall 仍保留为 5/7，用来反映 fresh 检索本身还没完全一键召回。
125. Source-acquired limited-text blocker 修正：`manuscript_facts` 现在会检查显式 primary/full-text benchmark sources，若 source 文本中匹配 abstract-only warning 的 PMID/DOI/title，则不再继续把该研究标成 `abstract_only_primary_effect`。同时 Web downstream effect-selection audit 会保留 `accepted_timepoint`、`timepoint_adjudication_note`、`manual_adjudication` 和 `user_override_applied`，避免已裁决的 28-day/closest-timepoint 来源在 manuscript facts 阶段再次被误判为未验证。当前 COVID facts 重新计算为 `report_type="meta"`、`status="needs_review"`、无 blocker，剩余问题是 extraction review/conflict warnings 和 LLM 写作重跑。
126. 当前剩余断点从“证据不可用”转为“产品化重跑与用户复核”：COVID benchmark 通过后，最主要差距不再是 published anchor 统计对不上，而是 fresh pipeline 仍不能自动从检索拿到所有 registry-first 主来源；Web UI 还需要把新增 source cards/source gates/source applications 渲染成可点击复核流；LLM provider 连接失败时，GRADE/写作会退化或阻断，需要成本/连接状态提示和可恢复的 manuscript-only rerun。
127. Fresh pipeline 自动补 registry-first 主来源：`PaperRetriever.download_pdfs()` 现在会把 ClinicalTrials.gov API v2 记录直接物化成 `clinicaltrials_registry` 文本来源；对 `registry_seed` 记录，若本地 seed 带 `source_urls`，则会自动抓官方 registry/result 页面并保存为 `registry_seed_source` 文本来源，而不是一律停在 `metadata_only`。同时 `fetch_europe_pmc_fulltext()` 在 Europe PMC XML/HTML 不可用时会再尝试 `pmc.ncbi.nlm.nih.gov/articles/<PMCID>/` 正文 HTML。这样 fresh run 即使没有用户手工上传，也能自动吃到一部分 registry-first/PMC OA 主来源。
128. Manuscript-only 强制重写与 deterministic meta fallback：CLI 新增 `--rerun-manuscript-only`，Web `resume_project` 也支持 `rerun_manuscript_only=true`，即使 manuscript checkpoint 已存在，也可基于 cached protocol/extraction/meta/GRADE/figures 强制只重写稿件。`WritingAgent.run()` 现在在 publication-style 路径遇到 LLM 故障时，不再直接把项目卡死或回退成 evidence-gap，而是输出 deterministic meta manuscript skeleton（Abstract/Methods/Results/Discussion/Conclusion 由 `manuscript_facts.json` 渲染），同时保存 `manuscript_validation.json` 和 `pipeline_warnings.json`。
129. DashScope / BaiLian Qwen 兼容配置：`config.py` 与 `core/llm.py` 现在支持 `DASHSCOPE_*` / `LLM_*` 环境变量。DashScope compatible-mode 基址可配置为 `https://dashscope.aliyuncs.com/compatible-mode/v1`；当启用联网搜索且模型为 `qwen3.6-plus`/`qwen3.6-flash`/`qwen3.7-max` 时，LLM client 会自动切到 Responses API 并传 `tools=[{\"type\":\"web_search\"}]`；非思考模式通过 `LLM_ENABLE_THINKING=0` 控制；普通结构化 JSON 输出仍保持 chat-completions 路径，避免 Responses/search 与 schema 模式互相绊住。
130. 正式稿长度与 Qwen 连接兜底：`config.py` 新增分任务 token budget（planning/screening/extraction/writing/GRADE），默认 extraction=16K、writing=32K；写作 prompt 的 Introduction/Methods/Results/Discussion 目标长度提高到接近期刊正式稿，章节调用不再使用 1500/3000/4096 的短上限。`LLMClient.structured_output()` 增加 JSON repair 二次模型调用，修复本地字符串修复无法处理的残缺 JSON；DashScope Responses API 在缺 `workspaceid` 或流式空文本时，会自动降级到 Chat Completions + `extra_body.enable_search=true`，保留 non-thinking 与 streaming。实测 `qwen3.6-plus`、联网搜索、non-thinking、streaming 路径可经 fallback 返回文本。
131. COVID benchmark 正式稿实测产物：基于用户补齐来源并完成 source adjudication 的项目 `output/20260523_003812_Systemic_corticosteroids_compared_with_usual_care` 已用最新写作器重写。新 `draft.md` 为 7,051 词，`manuscript_validation.json passed=true`，`report_type="meta"`，`main_word_count=4645`；交付包 `package/metaagent_export.zip` 含 draft.md、draft.docx、references.bib、检索式、图表、analysis/extraction/grade/rob artifacts、benchmark report 和 review HTML。Benchmark gate 重新评估为 `passed`：search recall 7/7、primary source/full text 7/7、primary analysis 7/7、222/678 vs 425/1025 完全对齐、固定效应 OR 0.659（95% CI 0.532-0.817）对齐 JAMA anchor OR 0.66（0.53-0.82）。
132. Fresh one-click 缺口已收窄但仍需更多 benchmark：早先同题目从零运行 `output/benchmark_runs/20260523_000009_Systemic_corticosteroids_compared_with_usual_care` 使用 qwen3.6-plus 完成但退化为 narrative synthesis，暴露 search recall 2/7、primary-publication recall 2/7、primary analysis 为空等问题。后续通过 registry-first source 物化、known-source recovery、source application、protocol/effect override 和 manuscript-only resume 逐步补齐到当前 passed 项目；但这仍是 COVID corticosteroids 单 benchmark，下一阶段需要用 SGLT2 HFpEF 和更多疾病域验证 fresh one-click 的泛化能力。
133. Qwen Responses 熔断从 session 级升级为进程/model 级：DashScope Responses API 一旦对同一 `base_url + model` 返回空文本、缺 workspaceid 或触发 fallback，`LLMClient` 会把该组合加入进程级 disabled set；后续新建 client 也直接走 Chat Completions + `extra_body.enable_search=true`，保留 non-thinking/streaming/search，不再每个 agent 重新踩一次空 Responses。回归测试 `test_dashscope_responses_empty_fallback_is_shared_across_clients` 固化该行为。
134. 写作后处理补齐正式稿语言问题：`WritingAgent` 的 publication-body polish 现在会修复由模板 PICO 直接拼出来的僵硬句子，并清理 “risk-of-bias and GRADE judgments” 这类重复表达；回归测试 `test_publication_body_polish_repairs_template_pico_sentence_and_redundant_conclusion` 固化。该修复不改变事实表，只改善正式稿可读性。
135. SGLT2 benchmark 正式稿刷新：真实 PDF 项目 `output/benchmark_runs/20260521_112500_sglt2_hfpef_real_pdf_upload_fixed_match` 用当前写作器重写后，`draft.md` 从 4,823 词提升到 6,816 词，`main_word_count=5751`，benchmark 仍为 `passed`：search recall 2/2、primary full text 2/2、primary analysis 2/2、927/6128 vs 1121/6123 完全一致，pooled HR 0.807（95% CI 0.740-0.880）对齐 Lancet anchor HR 0.80（0.73-0.87）。这证明正式长度 writer 不只在 COVID corticosteroids benchmark 生效。
136. Generic fact-locked 摘要标签修复：非 COVID 题目会在摘要使用短临床标签（例如 `SGLT2 inhibitors`、`placebo`、`cardiovascular death or heart failure hospitalization`），而不是把完整 PICO eligibility 句塞入 Objective/Conclusion。复数干预名会用 `were associated` 而不是 `was associated`。回归测试 `test_writing_agent_uses_generic_fact_locked_writer_for_non_covid_meta` 覆盖。
137. GRADE k=2 inconsistency 修正：`GRADEAgent._assess_inconsistency()` 不再因为 2-study prediction interval 跨 null 就自动把 I²=0%、Q 不显著的合成降级为 inconsistency serious；prediction interval 在 k<3 时只作为说明，不作为降级依据。SGLT2 refreshed GRADE 从 Moderate/serious inconsistency 修正为 High/no concern inconsistency。回归测试 `test_grade_inconsistency_does_not_downgrade_k2_for_prediction_interval_only` 覆盖。
138. DashScope Responses 快速 fallback：在启用 qwen3.6-plus 联网搜索时，Responses API 仍可能 HTTP 200 但流式空文本。`LLMClient` 现在对 DashScope Responses search endpoint 最多短重试 2 次，然后直接 fallback 到 Chat Completions + `extra_body.enable_search=true`，避免每个新进程白等 5 次指数退避。回归测试 `test_dashscope_responses_empty_fallback_uses_short_retry_budget` 覆盖。
139. Published-anchor model preference gate：benchmark manifest 现在会把 published anchor 对应的 `model_preference` 写入 `anchor_summary`、`pooled_effect` comparison、summary card 和 observed-primary 摘要。若项目用 OR 但 random model 对照 fixed-effect published anchor，`compare_pooled_effect()` 会报告 `model_preference_mismatch`，不再只用 pooled effect 数值差异笼统提示。
140. Protocol/effect-model adjudication payload：`benchmark_review` 新增 `protocol_adjudication_tasks`。当 pooled-effect gate 因 effect measure、model preference、effect 或 CI 不匹配失败时，payload 会返回 published anchor、observed primary、failure reasons，以及可直接给前端使用的 `suggested_protocol_patch`（例如 `effect_measure=OR`、`model_preference=fixed`）。这样 COVID benchmark 里“要不要按 JAMA anchor 用 fixed-effect OR”会成为显式用户/协议裁决点，而不是手改 JSON。
141. Artifact package review summary 补齐：`package_manifest.json.review` 新增 `benchmark_protocol_adjudication_tasks`，离线包也能看出是否存在 protocol/effect-model 裁决任务。当前 COVID passed package 该计数为 0，同时 summary card 明确显示 published anchor 和 observed primary 均为 fixed-effect OR；未来 fresh run 若落在 RR/random，会在 review 包里暴露该任务。
142. Protocol override 后端入口：`start.py` 新增 `protocol_override` / `protocol_overrides` / `save_protocol_override` 消息类型和 `_save_protocol_override_payload()`。它只允许修改 analysis-level protocol 字段（`effect_measure`、`model_preference`、`tau_estimator`），写入 `protocol.json` 与 `protocol_overrides.json` 审计账本，并按变更粒度清理下游 checkpoint：effect measure 改动清 `effect_sizes` 及以后，model/tau 改动清 `meta_analysis` 及以后。
143. Protocol override 可执行闭环：Web handler 会返回 `protocol_override_saved`，并在可用时同步推送新的 `benchmark_review` 与 `evidence_readiness`。Artifact package 会包含 `protocol_overrides.json`，保证用户按 published-anchor 建议调整 OR/fixed 之后，离线包能解释协议为什么变了。回归测试 `test_protocol_override_web.py` 覆盖保存、审计、checkpoint 清理和未知字段拒绝。
144. Known-source protocol preference 审计统一：新增 `core/protocol_overrides.py`，Web 手动 `protocol_override` 和 CLI known-source recovery 共用同一套字段校验、值规范化、`protocol_overrides.json` 审计和下游 checkpoint 清理逻辑。WHO REACT Figure 2 这类已知来源若把协议从 RR/random/REML 调整到 OR/fixed/DL，会写入 `updated_by="known_source_recovery"`、reason=`Known source preference: ...`，不再只藏在 `extraction/known_source_protocol_preferences.json`。回归测试扩展到自动 preference application、审计 ledger 和 checkpoint 清理。
145. 长正文 LLM 截断续写：`LLMClient` 现在区分文本型长输出和 JSON/structured 输出。普通写作文本若遇到 `finish_reason="length"`，会保留已生成正文，追加“从断点继续、不要重复”的 assistant/user continuation 消息，并把后续流式或非流式内容拼回同一个结果；JSON-like 输出仍使用加大 token 的整段重试，避免半截 JSON 拼接成非法结构。流式 chat completion 现在也记录 `finish_reason`，能把 `length` 写入 `llm_usage_manifest.json` 并触发同样的续写路径。`.env.example` 明确列出 extraction=16K、writing=32K 等分任务 token budget，避免新环境只看到 8192 默认值。
146. Citation-fix artifact 审计补齐：批量新增参考文献时，同一候选来源可在多个章节复用同一个新编号；`manuscript_citation_fixes.json` 会区分首次 `add_reference` 和后续 `reuse_reference_citation`。Artifact package 的 review JSON/HTML/manifest 现在同时统计新增参考文献数、复用引用编号数，以及所有引用修复中仍需人工复核的条目数，避免离线包只看到“新增1条参考文献”而看不到“多处正文插入同一编号”。
147. 正式稿段落级 citation anchor 补强：`WritingAgent._backfill_publication_inline_citations()` 不再只给 Introduction/Methods/Discussion 的第一段补一处引用；当 References 中已有足够的背景/方法学/试验来源时，会按章节类型给长引言、方法、结果和讨论补足多个未引用段落，同时跳过表格、列表、代码块和已有引用段落。COVID benchmark 旧稿经同一函数模拟后，Introduction/Discussion 从 0 个行内引用提升到各 3 个，citation audit 从 fail 降为仅 low-density warning；SGLT2 旧稿因只有 2 条参考文献，仍保守地保留 warning，等待 Evimed/PubMed enrichment 新跑补齐参考文献表。
148. Manuscript polish 性能和审计修复：实测 SGLT2 长稿深度 polish 在旧分块下触发 14+ 个串行 Qwen 请求且仍未结束，根因是 `_split_rewrite_units()` 把每个短段落都当成单独 chunk，56k 字稿被切成 101 个 LLM 调用。现在短段落会按 `max_rewrite_chars` 合并，SGLT2 同稿降为 19 个 chunks；新增 `MANUSCRIPT_POLISH_MAX_LLM_CHUNKS`（默认 6，可设 0/2 做快速模式），超出预算的 chunks 保留原文并在 `manuscript_polish_audit.json`、Web manuscript quality payload、artifact review HTML/manifest 中记录 `attempted_chunks`、`skipped_chunks`、`total_rewrite_chunks`、`polish_budget_exhausted`。预算耗尽 issue 会合并为一条 review item，前端显示为 `needs_review`，不再让用户误以为系统卡死或无限等待。
149. 正式稿全局 citation density backfill：段落级 anchor 只能保证每个核心章节“有引用”，但长正式稿仍可能低于投稿级引用密度。现在 `WritingAgent._backfill_publication_inline_citations()` 在段落锚点后继续执行全稿密度兜底：当主文达到正式稿长度时，以 `6.0 citations/1000 words` 和至少 6 个独立被引参考文献编号作为 deterministic floor，按章节类型追加背景/方法学/试验/确定性相关 citation cluster，并分散到引用较少的可引用段落。SGLT2 实跑稿从 38 个主文引用编号、5.54/1000 words 提升到 42 个、6.17/1000 words；`citation_audit` 现在 failed/warning issues 均为 0，且 unique cited references 为 14/14。
150. Manuscript polish 事实保护收紧：LLM polish 不再把 fenced search strategy / 代码块送入 rewrite budget，避免模型删除或改写完整检索式；prompt 明确禁止把 `associated with`、`HR 0.81` 等保守表述强化成 `reduced risk`、`lower risk` 或 `benefit`。Directional guard 同时收窄方法学排序词的假阳性（如 `higher-ranked`、`lower-priority`），保留真正疗效方向逆转和否定丢失的拦截。SGLT2 实跑 polish 从 3/6 accepted、6 个 fact-guard issue 改善到 4/6 accepted、3 个 fact-guard issue；剩余 rejected chunks 仍为方向性结论保护，按“宁可少润色，不可强化疗效断言”处理。
151. Manuscript polish 快速模式与 style audit 校准：deterministic cleanup 现在会在 LLM budget 检查前运行，因此即使 `MANUSCRIPT_POLISH_MAX_LLM_CHUNKS=0` 或预算耗尽，安全模板句（`It is important to note that`、`It should be noted that`、`In conclusion,`、`值得注意的是`、`综上所述`）仍会被清理，并修正英文句首大小写。Style audit 同步收窄到可润色正文段落，跳过表格、图表、补充材料、代码块和参考文献；句子切分不再把 `0.81`、`0.74`、`p=0.678` 等小数点切成新句。SGLT2 实跑稿的 style score 从旧审计的 3 降为 2，剩余问题只保留真实的 repeated sentence starts 和 lexical diversity，不再被表格、图注或数值碎片污染。
152. Manuscript polish 重复句首进一步收敛：style audit 现在把 `Heterogeneity was low (I²..., Cochran Q..., p...)` 这类固定统计结果句式排除出 repeated prose opening；deterministic cleanup 同时改写 `When the selected endpoint was time-to-event/binary...` 和 `The manuscript therefore reports...` 这类高频方法学模板句首。SGLT2 实跑稿更新后，`manuscript_polish_audit` 从 4/6 accepted、3 个 fact-guard issue、style score 2 进一步改善到 5/6 accepted、2 个 fact-guard issue、style score 1；剩余 style issue 只剩 lexical diversity，说明审计和改写都更贴近真正正文质量。
153. Manuscript polish 词汇多样性审计领域化：英文 `lexical_diversity` 不再用全词计数直接惩罚 `the/of/and/for` 等功能词，而是优先按内容词计算，并把投稿级技术稿阈值从通用散文阈值校准到 0.28。新增回归测试覆盖“功能词和固定方法学框架较多、但医学内容词足够多样”的技术段落，避免把合格 meta-analysis 正文误判为 AI 模板。SGLT2 实跑稿重新生成后，`citation_audit` 仍为 0 issue（14 条参考文献、42 个主文引用、6.16/1000 words、Introduction 11 个引用），`manuscript_polish_audit` 的 after style score 从 1 降为 0，剩余 AI style issues 为 0；投稿包保持 `status=ready_with_warnings`，唯一 warning 是保守事实保护拒绝了 2 个可能强化疗效方向的 polish chunk，并记录 `polish_budget_exhausted` 供人工决定是否提高预算。
154. Manuscript polish fact-guard 口径修正：directional guard 现在忽略 `lower certainty rating`、`reduces the risk that certainty is overstated`、`reduced to a threshold`、`mildly reduced ejection fraction` 等非临床疗效语境，避免把方法学/证据确定性润色误判为疗效方向变化；真实疗效反转（如 `reduced mortality`→`increased mortality`）和否定丢失（`did not reduce mortality`→`reduced mortality`）仍被回归测试拦截。SGLT2 实跑后 accepted chunks 从 4/6 升到 5/6，directional rejection 从 2 个降到 1 个。Artifact package 同时把 `polish_budget_exhausted` 从 `fact_guard_issues` 中剥离，submission readiness 现在显示 `fact_guard_issues=1; budget_exhausted=True`，不再把“预算覆盖不完整”误报成事实保护失败。
155. Manuscript polish targeted/default scope：新增 `MANUSCRIPT_POLISH_REWRITE_SCOPE` 和 CLI/Web `manuscript_polish_scope`，默认 `targeted`，只把仍有模板句、重复句首、低句长变异或低内容词多样性的 chunk 送入 LLM；`all` 保留为深度润色模式。干净 chunk 仍会经过确定性安全清理，但不计入 LLM rewrite budget，也不会触发 `polish_budget_exhausted`。SGLT2 实跑默认 targeted 后，polish 从原先 6 个串行 Qwen chunk 降为 0 个 LLM chunk：`non_target_chunks=19`、`targeted_chunks=0`、`after_style_score=0`、`polish_budget_exhausted=false`，submission readiness 从 `ready_with_warnings` 变为 `ready`，citation audit 仍为 0 issue（14 refs、42 citations、6.08/1000 words）。
156. Citation audit 投稿级参考文献深度兜底：之前 `publication_reference_count_below_target` 只依赖 `manuscript_facts.report_type="meta"` 且 `primary_effect.n_studies>=2`，如果正式长稿缺失或漏填 facts，就可能绕过 20 条参考文献的投稿级阈值。现在 citation audit 增加文本形状兜底：当稿件具备 Abstract/Introduction/Methods/Results/Discussion 结构且主文达到投稿级长度时，即使缺 `manuscript_facts.json`，也会把 `publication_reference_depth_required=true` 并提示 `publication_reference_count_below_target`。该修复只影响引用深度 warning，不把缺 facts 的稿件升级到其它全套硬门，避免误伤 evidence-gap 或短稿。
157. 数值结果句同句引用 backfill：章节级引用不足以让用户信任具体 HR/CI/I² 句子。`WritingAgent._backfill_publication_inline_citations()` 现在会在 Results/Discussion/Conclusion（含中文“结果/讨论/结论”）中扫描数值效应句；若该句无引用，则优先用试验/注册来源 citation cluster 补到同一句，而不是只在段末或章节首补一个泛引用。新增中文回归测试覆盖“同一结果段已有试验引用，但 HR/CI 句本身无引用”的场景，避免生成稿出现数字无法点开溯源的问题。
158. 数值效应引用来源类型校验：有引用不等于有可信来源引用。Citation audit 现在会区分任意引用与试验/注册/来源报告引用；若 HR/CI/I²/P 值句只引用 GRADE、PRISMA、指南或其它方法学来源，会产生 `numeric_effect_claim_lacks_source_citation` warning，并在 HTML/manifest 中记录 `numeric_effect_claims_without_source_citations` 和推荐试验引用。`WritingAgent._backfill_publication_inline_citations()` 同步补强：如果数值句已有方法学引用但缺试验来源，会把试验 citation 追加到该句本身，避免被后续句子的段末引用掩盖。Web `manuscript_quality` payload 也会把已有错误引用和推荐 source-report citation 暴露为 actionable issue，前端可直接引导用户把来源报告补到同一句数值声明后。
159. 数值效应来源引用的 References 兜底：旧项目、恢复项目或手工稿件可能没有 `search/evidence_context.json`，但 References 已列出随机试验或注册结果。Citation audit 现在在结构化 evidence context 之外，会回读稿件 References 中的 trial/registry 条目作为数值效应来源候选；Web `manuscript_quality` 推荐器也会在 context 缺失时使用该 numbered reference，避免用户看到“引用来源不对”却没有可点选的 `[1] Trial report` 修复建议。
160. 中文 manuscript polish 模板腔覆盖扩展：中文正式稿常见的“总体而言”“需要指出的是”“总的来看”“需要说明的是”“从整体来看”此前不会被 `audit_manuscript_style()` 识别，也不会在 targeted/快速 polish 中确定性清理。现在这些短语纳入 template phrase audit 和 deterministic cleanup；即使 `MANUSCRIPT_POLISH_MAX_LLM_CHUNKS=0`，也会在保留 HR/CI、GRADE、引用编号和结论方向的前提下清掉模板开头，降低中文输出的机械感。
161. Web polish style review 明细化：旧 `manuscript_polish_audit.json` 可能只有顶层 `template_phrase_hits`，而 `ai_style_signal.issues` 里只有 `code/count`，导致前端只能提示“有模板短语”却不显示具体短语。现在 Web `manuscript_quality.polish.style_review.remaining_issues/resolved_issues` 会从顶层 audit 回填 `phrases`，使用户能直接看到“总体而言”“需要说明的是”等待删改短语。
162. 真实 RCT 题名的 source-report 识别：References 兜底此前主要依赖题名里出现 `randomized trial`、`clinical trial`、`trial report` 或注册号；但 NEJM/JAMA 常见原始 RCT 题名可能只是“Dapagliflozin in Heart Failure...”这类药物-疾病标题，导致 HR/CI 句只引用 GRADE/PRISMA 时无法自动推荐原始试验来源。现在新增共享 `reference_classification`，citation audit 和 `WritingAgent` 补引共用同一套保守规则：显式 trial/registry 仍优先，同时允许高影响临床期刊 + 治疗药物/药物类别 + 临床人群/结局词的组合被识别为数值效应 source report。SGLT2 DELIVER/EMPEROR 真实 NEJM 题名已用回归测试覆盖。
163. Source-report classifier 泛化到药物-结局 RCT 题名：上一条修复仍偏向已知药物清单，SELECT 等真实高影响 RCT 标题“Semaglutide and Cardiovascular Outcomes in Obesity without Diabetes”同样不含 `trial` 字样，可能漏识别。现在 classifier 增加药物样后缀（如 `-glutide`、`-flozin`、`-mab` 等）+ 临床结局/疾病词的保守组合，同时显式排除 `systematic review`、`network meta-analysis`、`guideline`、`protocol` 等非原始结果来源，避免把综述/指南当成数值效应 source report。
164. References 角色分类替代局部关键词补丁：为避免继续按题名特例堆规则，`reference_classification` 现在输出可复用的 source roles（如 `included_trial`、`clinical_guideline`、`prior_review`、`reporting_guideline`、`certainty_framework`、`publication_bias_method`）。Citation audit 的 Introduction/Methods/Discussion 推荐器在缺少 `evidence_context.json` / `methodology_context.json` 时，会从 numbered References 中按角色兜底推荐引用：指南/既往综述支撑背景声明，PRISMA/GRADE/Cochrane/统计方法支撑方法声明，既往综述/指南/GRADE/发表偏倚方法支撑讨论语境声明。这把“引用覆盖不足”从单点修复提升为统一的引用角色识别原则。
165. LLM polish 后二次 citation backfill：真实生成英文/中文 SGLT2 稿件时发现，LLM polish 候选即使通过事实保护，仍可能让 HR/CI、Methods 或 Discussion 中的新句子缺少同句来源引用。现在 `_polish_project_manuscript()` 在保存 polish 后会再次运行 `WritingAgent._backfill_publication_inline_citations()`，并在 `manuscript_polish_audit.json.post_polish_citation_backfill` 记录是否应用。原则是：任何 LLM 润色输出都必须再经过引用角色感知的后处理，而不是只依赖 polish 前的 citation backfill。
166. Citation audit 推荐项自动补引：真实英文/中文 SGLT2 稿件经 polish 后仍留下多条有明确 `recommended_citations` 的句级 warning。现在 `_polish_project_manuscript()` 会临时运行 citation audit，并用 `WritingAgent._backfill_citation_audit_recommendations()` 只对 audit 已给出推荐编号的句子补引，结果写入 `post_polish_citation_audit_backfill`。原则是：audit 能给出确定推荐的引用缺口应自动修复；没有推荐来源的 claim 保留给人工复核，不用猜。
167. 医学中文稿语言门校准：中文正式稿含 HFmrEF/HFpEF、SGLT2、GRADE、HR/CI、OpenAlex 和 fenced Boolean 检索式时，旧语言检测会把主文误判为 `mixed` 并阻断 submission readiness。现在 artifact package 和 Web manuscript quality 的语言检测会先剔除 References、fenced code blocks、表格和图片行，再判断正文语言；中文医学稿允许必要英文缩写，真正“只有标题中文、正文英文”的稿件仍会被拦截。
168. 正文作者身份收敛：SGLT2 中英文实跑稿暴露出 Introduction/Discussion 把“来源核验、审稿 handoff、自动解析、数值一致性、透明性”等流程说明写进正文，导致稿件像 AI 系统报告而不是临床 Meta 分析。现在 generic publication fallback 的引言和讨论改为临床问题导向：基线风险、绝对获益、复合终点组成、时间到事件解释、适用人群、安全性、肾功能、费用/偏好、亚组和未来研究。流程、溯源、修订和审计语言应留在 Methods、Supplementary Materials 或 review package，不能作为 Discussion 的主要意义、优势或局限。
169. 大引用簇重复收敛：真实中文稿多次出现 `［3，5，7，20，23］` 这类同一宽泛引用簇，显得机械且不符合高水平综述写法。`WritingAgent._backfill_publication_inline_citations()` 现在在引用密度补齐后运行 repeated-cluster limiter：同一个 3 个及以上编号的 citation cluster 首次保留，后续重复会按相邻小组拆成更窄、更贴近段落的引用；章节 fallback 也把 Discussion 引用从“指南+GRADE+综述+方法大包”收窄为更小的上下文引用。

## 2. 已观察到的实际运行问题

### 2.1 SGLT2 心衰 Meta 分析试跑观察

试跑题目：

> In adults with heart failure with mildly reduced or preserved ejection fraction, do SGLT2 inhibitors compared with placebo reduce cardiovascular death or hospitalization for heart failure?

对照背景：该主题已有发表的随机试验综合 Meta 分析可对照，常见主要效应量为 HR，重点试验包括 EMPEROR-Preserved、DELIVER 等。

实际暴露问题：

1. ResearchPlanner 曾将主要效应量规划为 `RR`，但该主题核心结局是 time-to-event，发表证据通常报告 HR；当前已加确定性 HR 护栏。
2. QueryBuilder 的 MeSH validation 多次 NCBI 超时，日志里有 timeout，但用户侧仍需要更清晰的“检索策略降级”提示。
3. 2026-05-21 live run 暴露 `date_range="2015-01-01 to present"` 被错误解析成截至 2015 年，内部库 400+ 条记录被过滤为 0；当前已修复 start-to-present 解析。
4. 2026-05-21 live run 首轮 T/A screening 为 0 篇，原因是 fallback 先用过宽 `randomized trial` 查询且 cap 前没有排序，前 20 条多为不相关 RCT；当前已补 SGLT2/HFpEF recall query 和 cap 前 usefulness ranking。
5. 同一 SGLT2 trial program 有 design、subgroup、secondary analysis 和 primary publication 多篇论文；旧标题前缀去重会误删主发表原文，当前已改成保守去重。
6. 修复后完整重跑已能检出并筛入 DELIVER/EMPEROR-Preserved 主发表，主分析事件数、总人数和 pooled HR/CI 与发表 anchor 基本一致：HR 0.807（95% CI 0.740-0.880）vs published HR 0.80（95% CI 0.73-0.87）。
7. 统计能对上不等于可投稿：该 run 的两篇 NEJM 主发表均只拿到 abstract-only 文本，evidence-readiness 正确阻断 publication-style manuscript，生成 `evidence_gap` report，并列出 `abstract_only_primary_effect` blocker。
8. 新增 benchmark gate 显示 `primary_full_text_recall=0/2`，说明下一步产品重点不是再调 pooled HR，而是让用户上传/补全主发表全文，并在 extraction review UI 核验来源页码、表格和 quote。
9. GRADE 在本轮暴露了另一个风险：抽取字段为空时，旧逻辑把 P/I/C/design 缺失误算成 mismatch/non-randomized；当前已改成 “unverified” 规则，避免 GRADE 用 LLM vibes 过度降级。
10. 用户补充两篇 NEJM 原文 PDF 后，首次后补全文匹配暴露文件名/标题优先级不足，曾错配到 EMPEROR AF secondary analysis 和 DELIVER design paper；当前已修复 staging、filename-title priority、match-method tie break。
11. PDF 侧栏文本插入会破坏 source quote exact match；当前通过 numeric-window fallback 修复，EMPEROR-Preserved 主文 PMID 34449189 的 quote/event/total/HR 均能验证。
12. 后补全文 + resume 后，SGLT2 benchmark 已从 `primary_full_text_recall=0/2` 变为 2/2，primary rows、aggregate counts、pooled HR/CI、manuscript gate 全部通过。当前最终状态：`summary_card.status="passed"`，observed HR 0.807（95% CI 0.740-0.880），总样本 12,251，participant_difference=0。
13. 写作阶段仍暴露了典型 LLM 漂移：虚构总样本量、引用不存在的 Figure 8/9、相邻 secondary outcome 效应串位、把 sensitivity exclusion 误判为 primary contribution。当前已用 `manuscript_facts.json` 回填、artifact reference repair、窗口化 secondary effect 校验和 exclusion negation 规则修复；若 hard validation 仍失败，会输出 validation-blocked report 而不是错误 manuscript。
14. SGLT2 通过后仍有用户信任层工作：`evidence_readiness.status="needs_review"`，且 extraction audit 有 65 张 source cards、28 张 review cards。后端现在已把这些卡片通过 WebSocket payload 和 artifact zip 暴露出来；前端仍需把它们渲染成可点击的数字-原文-编辑交互。
15. 运行被中断或早停时，只生成前段 artifact 的问题已通过后补全文 `resume_project` 先解决一条关键用户路径；完整 parent_id 级 Web resume 和统一 `core/pipeline.py` 仍是后续收敛点。

### 2.2 既有二甲双胍输出观察

既有输出样本中出现过以下问题：

1. PRISMA 数字自相矛盾，例如识别记录为 0，却又有 26 篇全文评估。
2. Methods 章节声称两名独立评审员、人工作业、多个数据库检索，但实际流程并不支持这些事实。
3. 纳入研究为 0 时，仍然生成类似纳入研究描述、GRADE 或图表残留章节。
4. 被剔除或间接证据研究被错误地当作主要结果引用。
5. 图表以 base64 嵌入 markdown，投稿使用不便。

## 3. 当前代码中已经部分缓解的问题

以下事项已有局部修复，但仍需 UI 化、流程统一或进一步硬化。

### 3.1 已部分修复：用户 PDF 不应被摘要替代

Web 流程中已加强：第二阶段仅让有 `fulltext_available` 且有 `pdf_path` 的文献进入全文筛选和数据提取；无全文 PDF 的 T/A 候选被跳过。

剩余问题：

- CLI `new_meta/main.py` 仍有“无 PDF 时 proceeding with abstract-only analysis”的路径。
- 前端只展示概览，没有展示每篇 PDF 的解析/匹配明细。
- 用户 PDF 匹配仍是启发式，没有让用户确认匹配结果。

### 3.2 已部分修复：提取审计文件

`DataExtractionAgent` 已写出：

- `extraction/extraction_audit.json`
- `extraction/extraction_audit.md`

并对 `source_quote` 做原文匹配验证，填充 `source_quote_verified`、`source_quote_match`、`source_page`。

剩余问题：

- 前端没有展示审计文件。
- 低置信度和 quote 未验证的数据没有阻断合并。
- 用户无法编辑/确认提取值。
- 没有冲突检测和人工裁决持久化。

### 3.3 已部分修复：median/IQR/range 字段

Study schema 和 effect size 计算已支持 median/IQR/range 到 mean/SD 的转换。

剩余问题：

- UI 没告诉用户该数值是转换得来。
- 写作中应注明“由中位数/IQR 近似转换”，目前未形成强制事实字段。

### 3.4 已部分修复：写作 prompt 禁止虚构方法学事实

`writing_prompts.py` 已加入禁止虚构 human reviewers、PROSPERO、未使用数据库等规则。

剩余问题：

- Prompt 规则不是硬约束。
- `writing_agent.py` 仍是逐章 LLM 生成，后处理偏补丁式。
- 最终一致性检查多数只 warning，不阻断输出。

### 3.5 已部分修复：REML 和 subgroup 统计问题

REML tau² 已从不稳定迭代改为受限似然优化；subgroup difference 不再伪装成一个 pooled result。

剩余问题：

- k=2 时 REML 应明确 fallback 到 DL 或固定规则。
- Paule-Mandel 和 trim-and-fill 仍有边角策略可加强。

## 4. P0：必须立刻处理

### 4.1 Secret 泄漏风险

问题：

- `.env` 当前未被 `.gitignore` 可靠屏蔽。
- `.env` 里可能包含真实 `LLM_API_KEY`、OSS key、Mongo URI username/password。
- `git status` 曾显示 `?? .env`，一次 `git add .` 就可能泄漏。

修改建议：

1. 更新 `.gitignore`：

```gitignore
# Secrets
.env
.env.local
.env.*.local

# Runtime outputs
output/
*.log
```

2. 若 `.env` 曾被 staged，执行：

```bash
git rm --cached .env 2>/dev/null || true
```

3. 新增 `.env.example`：

```dotenv
LLM_API_KEY=
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o

PUBMED_EMAIL=
NCBI_API_KEY=

MONGO_URI=
OSS_ACCESS_KEY_ID=
OSS_ACCESS_KEY_SECRET=
```

4. 现有所有 key 按已泄漏处理，全部 rotate。

验收标准：

- `git check-ignore .env` 返回 `.env`。
- `git status --short` 不再显示 `?? .env`。
- 仓库搜索不到 `sk-`、`OSS_ACCESS_KEY_SECRET` 明文、Mongo URI 密码。

### 4.2 requirements.txt 不可复现

问题：

- 当前 `requirements.txt` 混入 `package @ file:///C:/miniconda3/...` 这类本地路径。
- 新机器 `pip install -r requirements.txt` 会失败。

修改建议：

先手写最小运行依赖：

```txt
openai==2.30.0
anthropic==0.89.0
pydantic>=2.6,<3
pydantic-settings
python-dotenv
numpy>=1.26,<3
scipy>=1.12,<2
pandas>=2.0
matplotlib>=3.8
pdfplumber>=0.11
biopython==1.87
requests>=2.31
fastapi
uvicorn[standard]
websockets
```

后续再使用 `uv` 或 `pip-compile` 生成 lock。

验收标准：

- 新建虚拟环境可安装成功。
- `python3 tests/test_deep.py` 通过。
- `python3 tests/test_e2e.py` 通过。
- Web 入口 `start.py` 可启动。

## 5. P1：PDF 上传与全文解析闭环

### 5.1 当前问题

用户所谓“上传 PDF”实际上是：

1. WebSocket 收到 `fileIds`。
2. 后端从 MongoDB/Java API/远端存储拉取文件。
3. 保存到 `output/user_pdfs/{parent_id}/`。
4. 再进入 PDF matching 和 parsing。

痛点：

- 没有真正的多文件上传端点。
- 没有单文件下载进度。
- 没有单文件解析进度。
- 120 秒下载超时会失败，但用户看不到具体哪一篇失败。
- PDF parsing 失败只 logger warning。
- 扫描件没有默认 OCR 兜底。
- 多栏排版、跨页表格没有质量提示。
- 解析完没有预览。
- 用户无法确认 PDF 匹配到哪篇 PubMed 记录。
- 用户无法主动覆盖去重/匹配决定。
- 不能中途追加 PDF 或恢复 PDF 阶段。

### 5.2 目标体验

用户上传 PDF 后，前端立即展示每个文件卡片：

```txt
File                          Status       Pages   Text chars   Tables   Match
EMPEROR-Preserved.pdf          Parsed       14      52231        8        PMID 34449189, score 0.94
scan_001.pdf                   OCR needed   10      0            0        Waiting OCR
unknown_article.pdf            Parsed       8       30122        3        Unmatched, user supplied
duplicate.pdf                  Cached       14      52231        8        Same hash as EMPEROR-Preserved.pdf
```

用户点击卡片可看到：

- 文件名
- 下载状态
- 解析状态
- 页数
- 文本字符数
- 表格数量
- OCR 是否启用
- 匹配候选列表
- 失败原因
- 重新解析/重新匹配按钮

如果同一 PDF 内容哈希已经解析过，卡片应直接显示“已解析（缓存命中）”，并秒返页数、文本长度、表格数和匹配结果，避免用户重复上传同一篇时再次等待 30 秒以上。

### 5.3 后端设计：pdf_intake_manifest

新增 `pdf_intake_manifest.json`：

```json
{
  "session_id": "parent_id",
  "created_at": "2026-05-20T18:00:00Z",
  "files": [
    {
      "file_id": "mongo-file-id",
      "filename": "EMPEROR-Preserved.pdf",
      "local_path": "output/user_pdfs/.../EMPEROR-Preserved.pdf",
      "download_status": "ok",
      "download_error": null,
      "parse_status": "ok",
      "parse_error": null,
      "parser_used": "pdfplumber",
      "ocr_used": false,
      "page_count": 14,
      "text_chars": 52231,
      "table_count": 8,
      "empty_pages": [],
      "matched_pmid": "34449189",
      "matched_title": "...",
      "match_score": 0.94,
      "match_method": "doi|pmid|title|text_overlap|manual",
      "source_type": "user_upload",
      "requires_user_review": false
    }
  ]
}
```

### 5.4 WebSocket 事件

新增结构化事件：

```json
{
  "type": "pdf_intake_update",
  "file_id": "...",
  "filename": "...",
  "stage": "download|parse|ocr|match",
  "status": "running|ok|failed|needs_review",
  "current": 3,
  "total": 12,
  "summary": {
    "page_count": 14,
    "text_chars": 52231,
    "table_count": 8,
    "match_score": 0.94
  },
  "error": null
}
```

### 5.5 解析策略

优先级：

1. `pdfplumber`
2. PyMuPDF fallback
3. 两者都少文本时，启用 OCR
4. MinEru 可配置为高级 fallback，但无 token 时不能直接失败

规则：

- `text_chars == 0` 或多数页面空文本：标记 `parse_status=empty_text`，进入 OCR。
- OCR 失败也必须写 manifest，不得静默跳过。
- 表格提取要记录页码和表格编号。
- 每个 table 应加 `[PAGE N] Table M` 标记，便于 source quote 定位。

### 5.6 并发

PDF 下载和解析应并发：

- 下载：asyncio/aiohttp 并发，限制并发数 4-8。
- 解析：CPU/IO 混合，可用 `ThreadPoolExecutor` 或 `ProcessPoolExecutor`，限制并发数 4-8。
- 每个文件完成后立即推送进度，不等整个 batch。

### 5.7 用户 PDF 身份

不要把用户 PDF 伪装为 PubMed 论文。

建议字段：

```json
{
  "source_type": "user_upload",
  "source_id": "user_pdf:uuid",
  "pmid": null,
  "matched_pmid": "optional"
}
```

下游展示：

- PubMed 来源：显示 PMID/DOI。
- 用户上传来源：显示“用户上传全文”，若匹配到 PubMed 则显示匹配信息。

## 6. P1：数据提取可信度闭环

### 6.1 当前问题

Schema 中已有字段：

- `source_location`
- `source_quote`
- `source_page`
- `source_section`
- `source_quote_verified`
- `source_quote_match`
- `extraction_confidence`

但问题是：

- UI 不展示。
- `extraction_confidence` 以前没有稳定赋值。
- quote 未验证不阻断。
- 冲突数字没有检测。
- 用户不能编辑。
- overrides 不持久化。
- EvidenceGate 对“是否来自原文”验证不足。

### 6.2 目标体验：提取结果复核表

前端展示：

```txt
Study        Outcome       Field             Value       Source                         Verified   Confidence   Action
Smith 2022   HbA1c         mean_intervention  -1.13%     Table 2, p.5 "change -1.13%"   yes        high         Edit
Smith 2022   HbA1c         sd_intervention     0.42      Table 2, p.5 "SD 0.42"         yes        high         Edit
Lee 2021     CV death/HHF  HR                  0.80      Fig 3, p.7 "HR 0.80..."        no         low          Review
```

用户点击 value：

- 展开原文 quote。
- 显示所在页。
- 显示匹配片段。
- 显示 parser 来源。
- 可编辑值并保存。

### 6.3 extraction_audit.json 扩展

建议结构：

```json
{
  "summary": {
    "studies": 5,
    "outcomes": 12,
    "verified_quotes": 9,
    "unverified_quotes": 2,
    "low_confidence": 1,
    "conflicts": 2
  },
  "rows": [
    {
      "study_id": "...",
      "study_label": "Smith 2022",
      "outcome_name": "HbA1c",
      "field": "mean_intervention",
      "value": -1.13,
      "unit": "%",
      "source_page": 5,
      "source_section": "Results",
      "source_location": "Table 2",
      "source_quote": "change -1.13%",
      "source_quote_verified": true,
      "source_quote_match": "change -1.13%",
      "extraction_confidence": "high",
      "requires_user_review": false
    }
  ],
  "conflicts": []
}
```

### 6.4 低可信度阻断规则

建议默认规则：

- `source_quote_verified == false`：进入待确认队列。
- `extraction_confidence == low`：进入待确认队列。
- 存在冲突：进入待确认队列。
- 未确认前不进入 effect size computation。

可配置：

```env
ALLOW_UNVERIFIED_EXTRACTIONS=false
ALLOW_LOW_CONFIDENCE_EXTRACTIONS=false
```

### 6.5 用户 overrides

新增 `extraction_overrides.json`：

```json
{
  "overrides": [
    {
      "study_id": "...",
      "outcome_name": "HbA1c",
      "field": "mean_intervention",
      "old_value": -1.13,
      "new_value": -1.10,
      "reason": "User verified Table 2 value",
      "user_id": "...",
      "revision": 3,
      "updated_at": "..."
    }
  ]
}
```

所有下游流程必须先 merge overrides：

1. effect size
2. meta-analysis
3. GRADE
4. writing
5. audit export

并发语义：

- 每条 override 必须有 `revision`、`updated_by`、`updated_at`。
- 前端保存时携带当前 revision，后端按 ETag/If-Match 语义校验。
- revision 不一致时返回 conflict，让用户刷新或手动合并。
- 第一版可接受 last-write-wins，但必须写入 audit log，不能静默覆盖。

### 6.6 冲突检测

新增 `ConflictNote` schema：

```python
class ConflictNote(BaseModel):
    field: str
    abstract_value: str | float | int | None = None
    table_value: str | float | int | None = None
    body_value: str | float | int | None = None
    recommended_value: str | float | int | None = None
    reason: str = ""
    requires_user_confirmation: bool = True
```

检测策略：

- 同一 study/outcome/field 在 abstract、tables、body 中出现不同值。
- event count 和 total 在不同区域不一致。
- HR/RR/OR 与 event count 推导方向矛盾。
- table 中 ITT population 与 per-protocol population 混淆。

处理：

- 冲突写入 audit。
- 前端高亮。
- 用户确认后写 override。

## 7. P1：筛选流程诚实化

### 7.1 当前问题

Title/abstract screening 中所谓 Reviewer 2 只是同一模型不同 temperature，不是独立评审。

问题：

- 报告不能写“两名独立评审员”。
- Cohen's kappa 若计算后不影响流程，意义有限。
- Full-text screening 阶段没有真正双评审。

### 7.2 两种可选路径

快速诚实版：

- UI 和报告都写：`single-pass automated screening`。
- 不再写 independent reviewers、dual screening、adjudication。
- kappa 不展示或仅作为 internal stability check。

增强双评审版：

- Reviewer 1：当前主模型。
- Reviewer 2：不同模型或严格不同 prompt。
- 冲突：第三模型/规则仲裁。
- `kappa < 0.6`：触发用户确认或提示筛选不稳定。
- T/A 和 FT 阶段都要一致支持。

建议先做快速诚实版，避免报告事实违规。

## 8. P1：决策点、进度与 resume 体验

### 8.1 当前问题

- Web 流程没有 CLI 里的低召回/低筛选结果决策点。
- Broad-query fallback 静默触发，用户不知道检索策略变宽。
- Web 状态主要在内存里，断线后恢复能力弱。
- 进度只有大 step，缺少“第几篇/共几篇”和 ETA。

### 8.2 结构化决策点

统一推送：

```json
{
  "type": "decision_point",
  "stage": "search|ta_screening|full_text|extraction",
  "reason": "low_recall|low_include|many_unverified_extractions",
  "counts": {
    "records_found": 5,
    "ta_included": 1
  },
  "advice": "...",
  "suggested_actions": [
    {"id": "broaden_pico", "label": "放宽 PICO"},
    {"id": "continue", "label": "继续"},
    {"id": "abort", "label": "终止"}
  ]
}
```

### 8.3 细粒度进度

所有 agent 增加 `progress_cb(current, total, current_item, stage)`：

- PDF 下载：第 N/M 篇
- PDF 解析：第 N/M 篇
- T/A 筛选：第 N/M 篇
- FT 筛选：第 N/M 篇
- Data extraction：第 N/M 篇
- RoB：第 N/M 篇
- 图表：第 N/M 张

排队体验：

- 当前 `MAX_SESSIONS` 命中时，不应只返回“排队中，请稍候”。
- 新增结构化事件：

```json
{
  "type": "service_busy",
  "max_sessions": 16,
  "active_sessions": 16,
  "queue_position": 3,
  "estimated_wait_seconds": 420,
  "message": "当前并发已满，您排在第 3 位。"
}
```

- 等待期间定期推送 `queue_position_update`。
- 如果系统不支持排队，只能拒绝时，也必须明确返回容量上限和建议重试时间。

当前实现进展：

- `start.py` 已发送 `service_busy` 结构化事件，包含 `queue_position`、`max_sessions`、`running_sessions`、`queued_sessions`、`eta_seconds`。
- 已修复 Phase 1 完成后等待用户 PDF 期间仍占用/泄漏 semaphore 的问题；Phase 2 启动前会重新进入并发队列。
- 仍待补：等待期间的周期性 `queue_position_update` 和基于历史任务时长的 ETA 估算。

### 8.3.1 Evidence readiness 结构化回流

写作完成后，Web 入口必须发送独立事件，让前端可以做“证据就绪/待复核”面板，而不是让用户从 markdown 里读警告。

当前实现事件：

```json
{
  "type": "evidence_readiness",
  "report_type": "evidence_gap",
  "status": "blocked",
  "action_required": true,
  "blocker_codes": ["abstract_only_primary_effect", "primary_timepoint_not_source_verified"],
  "blockers": [],
  "warnings": [],
  "selected_primary_rows": [],
  "validation": {
    "passed": false,
    "issue_count": 7,
    "error_count": 4,
    "warning_count": 3
  }
}
```

待补：

- 前端将 `selected_primary_rows` 与 `extraction_review.rows` 合并展示为“点击数字 → 查看 source quote / page / table / blocker”。
- 用户确认或覆盖后写入 `extraction_overrides.json`，后端已支持 revision/If-Match、即时应用到当前 extraction、刷新 audit、清理下游 checkpoint，并已补最小可用的“一键重新运行 effect selection + manuscript facts”后端消息；前端仍需把按钮和 review queue 串起来。
- `action_required=true` 时禁用“投稿式导出”，只允许导出 evidence-gap report 或继续复核。

### 8.3.2 Extraction override Web 消息

当前支持请求：

```json
{
  "type": "extraction_override",
  "project_dir": "output/.../project",
  "expected_revision": 0,
  "override": {
    "study_id": "32876697",
    "outcome_index": 10,
    "field": "events_intervention",
    "value": 20,
    "reason": "User verified Table 76",
    "updated_by": "user"
  }
}
```

返回：

```json
{
  "type": "extraction_override_saved",
  "ok": true,
  "current_revision": 1,
  "applied_overrides": 1,
  "cleared_checkpoints": ["effect_sizes", "meta_analysis", "grade", "figures", "manuscript"],
  "requires_rerun": true
}
```

若 revision 冲突，返回 `ok=false`、`error="revision_conflict"` 和服务端当前 revision，前端应提示用户刷新复核表后重试。

### 8.3.3 Override 后下游重算 Web 消息

用户保存 override 后，前端可立即触发下游重算：

```json
{
  "type": "rerun_downstream",
  "project_dir": "output/.../project"
}
```

后端会：

1. 读取当前 `protocol.json`、`extraction/all_extractions.json`、`risk_of_bias/rob_results.json`。
2. 重新运行主结局 effect-selection audit 与 `analysis/effect_sizes.json`。
3. 当可计算主效应 `k>=2` 时重跑 meta-analysis、GRADE（失败时写 warning）、核心 figures。
4. 重建 `manuscript_facts.json`、`manuscript_validation.json` 和 `manuscript/draft.md`。
5. 推送 `downstream_rerun_done`，并随后推送新的 `evidence_readiness`。

为避免刷新页面后单独点击“重算”时漏用用户修正，rerun 启动时会先重新应用当前 `extraction_overrides.json` 到 `all_extractions.json`，再进入 effect selection。

返回：

```json
{
  "type": "downstream_rerun_done",
  "ok": true,
  "applied_overrides": 1,
  "n_effects": 3,
  "n_selection_rows": 11,
  "report_type": "evidence_gap",
  "warnings": [],
  "evidence_readiness": {}
}
```

注意：`n_effects=0` 时必须保持 `evidence_gap`；`n_effects=1` 才允许进入 narrative artifact；`n_effects>=2` 且 readiness 无 blocker 才能进入 publication-style meta report。

### 8.4 Resume

Web session 应绑定 `parent_id -> Project.base_dir`。

断线重连：

1. 找到 parent_id 对应项目目录。
2. 读取 checkpoint。
3. 读取 `pdf_intake_manifest.json`、`extraction_audit.json`、`pipeline_warnings.json`。
4. 恢复 UI 状态。

## 9. P2：EvidenceGate 与事实源统一

### 9.1 当前问题

EvidenceGate 在 Web 流程中已有调用，但 CLI 仍走本地 `_outcome_matches()` 和独立 effect size gate。问题从“完全没用”变成“双轨不一致”。

双轨风险：

- CLI 和 Web 纳入结果不同。
- outcome matching 阈值不同。
- Narrative/meta-analysis fallback 不同。
- ReportState 在 Web 更完整，CLI 报告仍可能漂移。

### 9.2 修改建议

1. 将 outcome matching 统一到 `new_meta.core.evidence_gate.outcome_matches`。
2. 删除或废弃 `new_meta/main.py` 本地 `_outcome_matches()`。
3. CLI 和 Web 都在 extraction 后强制执行：

```python
gate = EvidenceGate(protocol)
gate_result = gate.evaluate(extracted_studies)
report_state = build_report_state(gate_result, ...)
```

4. `gate_result` 决定后续路线：

- `EVIDENCE_GAP`
- `NARRATIVE_ONLY`
- `META_ANALYSIS_ELIGIBLE`
- `NEEDS_USER_CONFIRMATION`

5. Gate warning 写入 `pipeline_warnings.json`。

### 9.3 EvidenceGate 应新增检查

除现有 SD=0、events>total 等逻辑异常，还应检查：

- outcome 是否 quote verified。
- extraction confidence 是否 low。
- 是否存在 unresolved conflicts。
- effect measure 是否与 outcome 类型匹配。
- HR/RR/OR 是否被错误混用。
- median/IQR 转换是否有足够字段。

### 9.4 CLI/Web 单一 Pipeline 入口

当前 `main.py` 和 `start.py` 不是同一个 pipeline 的两个入口，而是两份相似编排逻辑。长期风险是改了 CLI 忘了 Web，或 Web 接了 EvidenceGate 但 CLI 仍走旧路径。

修改建议：

1. 新增 `new_meta/core/pipeline.py`。
2. 抽出：

```python
run_phase1(topic, output_dir, *, progress_cb=None, options=None) -> Phase1State
run_phase2(phase1_state, output_dir, *, user_pdf_paths=None, progress_cb=None, options=None) -> PipelineResult
run_cli(args) -> PipelineResult
```

3. CLI `main.py` 只负责 argparse、打印和调用 pipeline。
4. Web `start.py` 只负责 WebSocket/session/消息转换和调用 pipeline。
5. 旧 checkpoint 项目可通过 `legacy_mode=true` 暂时走兼容读取逻辑，1-2 个 release 后移除。

验收标准：

- CLI 和 Web 对同一 phase state 得到同一 GateResult、ReportState 和 manuscript_facts。
- EvidenceGate、PDF-only、outcome matching、narrative fallback 只在 pipeline 中实现一份。

当前实现进展：

- CLI normal run、CLI cached effect-size resume、CLI cached meta-analysis resume 已共用 `_run_meta_analysis_from_effects()` / `_run_grade_from_cached_meta()`。
- Web override downstream rerun、Web phase2、Web full pipeline 的主 meta-analysis/GRADE 段已迁到同一 helper。
- 仍待补：把 PDF matching、full-text screening、evidence-gap/narrative branch、figure artifact generation 也抽到 `core/pipeline.py`，并补 Web/CLI 同一 fixture 的端到端对照测试。

## 10. P2：报告写作一致性

### 10.1 当前问题

`writing_agent.py` 是大型单体，按章节独立 prompt：

- title
- abstract
- introduction
- methods
- results
- discussion
- conclusion
- tables
- figures
- references

风险：

- 每节各自发挥，数字不一致。
- Methods 容易虚构人工评审、多数据库、PROSPERO。
- Abstract 可能使用错误 PRISMA 数字。
- Results 可能描述不应纳入的研究。
- n=0/k<2 时模板退化不清。
- 图表不存在但仍被引用。

### 10.2 manuscript_facts.json

写作前生成唯一事实源：

```json
{
  "report_type": "meta_analysis|narrative|evidence_gap|failed_systematic_review",
  "databases": ["Internal literature database", "PubMed"],
  "search_query": "...",
  "search_date": "...",
  "human_reviewers": false,
  "manual_adjudication": false,
  "registered_protocol": false,
  "prisma": {
    "records_identified": 120,
    "records_after_dedup": 98,
    "title_abstract_screened": 98,
    "full_text_assessed": 12,
    "studies_included": 4
  },
  "sources": {
    "database": 98,
    "user_upload": 7
  },
  "direct_eligible_rct": 4,
  "analyzable_primary": 3,
  "total_sample_size": 12890,
  "primary_effect": {
    "measure": "HR",
    "pooled": 0.80,
    "ci_lower": 0.73,
    "ci_upper": 0.88,
    "i_squared": 0.0,
    "model": "random"
  },
  "secondary_outcomes": {
    "pooled": [],
    "narrative_only": [],
    "not_extractable": []
  },
  "figures_generated": ["prisma_diagram", "forest_plot"],
  "grade_performed": true,
  "rob_performed": true,
  "warnings": []
}
```

所有 `_write_X()` 只能引用 facts，不再自由生成数字。

### 10.3 硬约束与重写

生成后执行 hard validators：

1. 禁止词/事实违规：
   - two independent reviewers
   - 双人独立
   - hand extraction
   - PROSPERO
   - Embase/CENTRAL/Web of Science/CNKI/Wanfang 未在 facts 中出现时禁止

2. PRISMA 数字一致：
   - Abstract/Methods/Results 中所有记录数必须与 facts 一致。

3. 纳入数一致：
   - `included studies`、`纳入研究`、`RCTs` 不得偏离 facts。

4. 统计值一致：
   - pooled effect、CI、p、I²、tau² 与 facts 一致。

5. 图表一致：
   - 不存在的 figure 不得引用。
   - narrative/evidence gap 不得引用 forest/funnel plot。

6. k 限制：
   - k<10 不报告 Egger/Begg。
   - k<3 不做 subgroup/sensitivity/influence。
   - k<2 不称 meta-analysis performed。

处理策略：

- 轻微措辞问题：自动替换。
- 章节事实错误：重写该章节。
- 重写后仍失败：阻断输出并写 `pipeline_warnings.json`。

### 10.4 n=0/k<2 退化路径

需要明确区分：

1. `failed_systematic_review`
   - 无足够全文或无可纳入研究。
   - 输出失败原因、检索/上传/筛选摘要、下一步建议。
   - 不生成假装完整的系统评价。

2. `evidence_gap`
   - 有证据检索过程，但无直接符合 PICO 的 RCT。
   - 输出 evidence gap map。
   - 不生成 RoB/GRADE 评级。

3. `narrative_only`
   - 有直接研究，但无法定量合并。
   - 只做描述性综合。
   - 明确哪些 outcome 不能合并及原因。

4. `meta_analysis`
   - 主结局至少 k>=2 且数据可计算。

### 10.5 次要结局处理

当前 `N < 2` 的 secondary outcomes 可能静默丢弃。应改成：

```json
{
  "secondary_outcomes": {
    "pooled": [
      {"name": "all-cause mortality", "k": 3}
    ],
    "narrative_only": [
      {"name": "KCCQ-CSS", "k": 1, "reason": "only one study"}
    ],
    "not_extractable": [
      {"name": "renal composite", "reason": "reported without extractable HR/events"}
    ]
  }
}
```

正文必须显式说明。

## 11. P2：checkpoint/resume 依赖清理

### 11.1 当前问题

用户修改 protocol/PICO 后，只清理部分上游 checkpoint，下游 extraction/rob/effect_sizes/meta_analysis/grade/figures/manuscript 可能仍保留旧结果。

这会导致：

- 新协议 + 旧提取结果。
- 新筛选 + 旧 meta-analysis。
- 新纳入数 + 旧报告。

### 11.2 依赖 DAG

新增统一依赖：

```python
DOWNSTREAM = {
    "protocol": [
        "search_query", "search", "ta_screening", "pdf_download", "pdf_parsing",
        "ft_screening", "extraction", "rob", "effect_sizes", "meta_analysis",
        "grade", "figures", "manuscript"
    ],
    "search_query": [
        "search", "ta_screening", "pdf_download", "pdf_parsing", "ft_screening",
        "extraction", "rob", "effect_sizes", "meta_analysis", "grade",
        "figures", "manuscript"
    ],
    "search": [
        "ta_screening", "pdf_download", "pdf_parsing", "ft_screening",
        "extraction", "rob", "effect_sizes", "meta_analysis", "grade",
        "figures", "manuscript"
    ],
    "ta_screening": [
        "pdf_download", "pdf_parsing", "ft_screening", "extraction", "rob",
        "effect_sizes", "meta_analysis", "grade", "figures", "manuscript"
    ],
    "ft_screening": [
        "extraction", "rob", "effect_sizes", "meta_analysis", "grade",
        "figures", "manuscript"
    ],
    "extraction": [
        "rob", "effect_sizes", "meta_analysis", "grade", "figures", "manuscript"
    ],
    "effect_sizes": [
        "meta_analysis", "grade", "figures", "manuscript"
    ],
    "meta_analysis": [
        "grade", "figures", "manuscript"
    ],
    "grade": [
        "manuscript"
    ],
    "figures": [
        "manuscript"
    ]
}
```

新增 `clear_downstream(step)`，禁止散落手写 checkpoint 清理。

当前实现进展：

- `new_meta.core.project.Project.clear_downstream(step, include_self=False)` 已实现依赖 DAG。
- `start.py` 的 extraction override 清理已改用 `clear_downstream("extraction")`。
- `main.py` 中用户调整 protocol/search query、缓存 search 异常重跑等路径已改用 `clear_downstream(...)`。
- 已补 checkpoint DAG 回归测试；仍待把 Web phase1/phase2 的所有 resume 分支逐步收敛到同一入口。

### 11.3 PDF parsing cache

当前有 checkpoint 也可能重解 PDF。应保存：

- `parsed_papers/{source_id}.json`
- 文件 hash
- parser version
- OCR flag

若 hash 和 parser version 未变，不重新解析。

## 12. P2：静默失败治理

### 12.1 问题清单

静默或弱提示点：

1. Advisory LLM 失败返回固定字符串。
2. MeSH/NCBI 超时只记录 logger。
3. PDF 下载失败只 warning。
4. PDF 解析失败只 warning。
5. NMA 失败后 `nma_result=None`，下游分不清没要求还是失败。
6. 图表生成失败只 warning，最后仍打印路径。
7. JSON 解析失败直接 raise 或 fallback 不透明。
8. RoB 无全文时合成结果，下游当真。
9. 自动 broad query fallback 用户不知道。

### 12.2 pipeline_warnings.json

统一写：

```json
{
  "warnings": [
    {
      "stage": "mesh_validation",
      "severity": "warning",
      "code": "NCBI_TIMEOUT",
      "message": "MeSH validation timed out for Heart Failure",
      "user_visible": true,
      "recoverable": true,
      "details": {}
    }
  ],
  "errors": []
}
```

### 12.3 用户可见规则

最终报告附录和前端都展示：

- 哪些 PDF 没读出来。
- 哪些检索源超时。
- 哪些图表没生成。
- 哪些 outcome 未合并。
- 哪些数据未验证。

严重程度：

- `info`：流程降级但结果可用。
- `warning`：结果解释受影响。
- `error`：该阶段失败。
- `blocking`：不能生成可信报告。

## 13. P2：死代码和半成品处理

### 13.1 multi_search.py

状态：Semantic Scholar + OpenAlex + citation chaining 已写但未接入。

建议：接入 phase 1 检索。

输出统一：

```json
{
  "source_type": "pubmed|semantic_scholar|openalex|internal_db|citation_chain",
  "source_id": "...",
  "title": "...",
  "doi": "...",
  "pmid": "...",
  "year": 2024
}
```

PRISMA 应区分 records_from_database 和 records_from_other_sources。

### 13.2 NMA node_splitting

状态：`nma.py` 定义 node_splitting，但 main NMA 块未调用。

建议：

- NMA fit 后调用 node_splitting。
- 结果写入 `analysis/nma_consistency.json`。
- 若 inconsistency 显著，GRADE inconsistency 自动降级。
- 报告中只在 network meta-analysis 模式下展示。

### 13.3 EvidenceGate

状态：Web 已部分接，CLI 未统一。

建议见第 9 节。

### 13.4 outcome_matches 双轨

状态：

- `main.py` 本地 fuzzy threshold 0.5。
- `evidence_gate.py` 有另一套 threshold。

建议：

- 保留一套。
- 增加 outcome alias/ontology mapping。
- 对主要结局必须更严格，避免把近似但不同的 endpoint 混合。

## 14. P2：LLM JSON 健壮性

### 14.1 当前问题

`llm.py` 严格要求返回合法 JSON。部分模型会输出：

- markdown fence
- JSON 前后散文
- 尾随逗号
- 注释
- 单引号
- 半截 JSON

### 14.2 repair 策略

新增 `_repair_json()`：

1. 去掉 ```json fence。
2. 抽取最外层 `{...}` 或 `[...]`。
3. 平衡括号。
4. 去尾随逗号。
5. 尝试 `json.loads`。
6. 失败后重试一次：

> Respond with only valid JSON matching the schema. No markdown, no prose.

7. 再失败写入 `pipeline_warnings.json`，并标记该 paper extraction failed。

### 14.3 Token Budget 和截断告警

问题：

- 单一 `LLM_MAX_TOKENS=8192` 对长文 extraction 和完整 manuscript writing 都偏小。
- 输出接近 `max_tokens` 时，JSON 很可能被截断；这类截断 `_repair_json()` 通常修不好。

修改建议：

1. 区分任务预算：

```env
LLM_MAX_TOKENS_DEFAULT=8192
LLM_MAX_TOKENS_PLANNING=4096
LLM_MAX_TOKENS_SCREENING=8192
LLM_MAX_TOKENS_EXTRACTION=16384
LLM_MAX_TOKENS_WRITING=32768
LLM_MAX_TOKENS_GRADE=8192
LLM_CONNECT_TIMEOUT_SECONDS=8
LLM_READ_TIMEOUT_SECONDS=120
LLM_WRITE_TIMEOUT_SECONDS=30
LLM_POOL_TIMEOUT_SECONDS=8
```

2. LLM client 检测 finish reason：

- `length` / `max_tokens` / provider 等价字段：写入 `pipeline_warnings.json`。
- structured output 若因 length 截断，应自动重试一次，要求继续或缩短输出。
- 外部调用必须拆分 connect/read/write/pool timeout；connect 卡住时应快速重试，read timeout 则保留足够长的写作/抽取生成窗口。

3. 记录每次调用：

```json
{
  "stage": "extraction",
  "model": "qwen-plus",
  "prompt_tokens": 21000,
  "completion_tokens": 15890,
  "max_tokens": 16384,
  "finish_reason": "length",
  "truncation_risk": true
}
```

4. 如果 extraction 输出接近预算，例如 completion_tokens > 0.9 * max_tokens，应标记高风险并阻断未经确认的数据进入合并。

## 15. P2：RoB 和 GRADE 可信度

### 15.1 当前问题

- RoB prompt 未完整实现 Cochrane RoB 2 signaling questions。
- 没全文时可能生成 “Insufficient information” 风格结果，下游 GRADE 当真。
- RoB 结果没有清楚区分真实评估 vs 合成占位。

### 15.2 修改建议

1. 将 RoB 2 五域及 signaling questions 完整纳入 schema/prompt：
   - randomization process
   - deviations from intended interventions
   - missing outcome data
   - measurement of outcome
   - selection of reported result

2. 新增字段：

```python
is_synthetic: bool = False
source_quote_verified: bool | None = None
supporting_quotes: list[str] = []
```

3. 无全文/证据不足：

- `is_synthetic=True`
- `overall_judgment="no_information"`，不要伪装成正式 RoB 2 judgment。
- GRADE 对 `is_synthetic=True` 的 RoB 不做正式 downgrade 表格计算，而是标注 `not formally assessed`。直接 downgrade 会让用户误以为 GRADE 已正式完成，反而误导。

4. UI 展示每个 RoB 域的 quote 和页码。

### 15.3 GRADE Indirectness 规则化

当前 indirectness 容易变成 LLM vibes。建议改成规则评分 + LLM 叙述：

规则维度：

```json
{
  "population_similarity": 0.0,
  "intervention_similarity": 0.0,
  "comparator_similarity": 0.0,
  "outcome_similarity": 0.0,
  "surrogate_outcome": false,
  "post_hoc_subgroup": false,
  "non_rct_design": false,
  "wrong_followup_window": false,
  "requires_downgrade": true,
  "reasons": []
}
```

建议阈值：

- P/I/C/O 任一相似度 < 0.6：serious indirectness。
- surrogate outcome：至少 serious。
- post-hoc subgroup 且非预设：serious。
- 主要结局窗口不匹配：serious。
- 多个 serious flag：very serious。

LLM 只负责把规则结果写成 GRADE footnote，不负责自由判定。

当前实现进展：

- `GRADEAgent._rule_based_indirectness()` 已落地第一版，覆盖 P/I/C/O 文本匹配、critical-care 人群硬信号、surrogate outcome marker 和非随机研究信号。
- `_assess_indirectness()` 仍会调用 LLM 生成叙述，但最终 rating 由规则判定决定；LLM 不能因为空字段或自由叙述上调/下调 certainty。
- 空的 population/intervention/comparator/design 字段会被记录为 unverified，而不是 mismatch 或 non-randomized。这样抽取缺失会保守触发 serious directness uncertainty，但不会伪造成研究设计不匹配。
- 已补 fixture：critical-care protocol vs non-intubated ward population 必须触发 indirectness；mortality protocol 下 biomarker score 必须触发 surrogate indirectness；空 P/I/C/design 只触发 unverified serious；missing design 默认初始证据级别为 RCT 假设，高风险由 evidence-readiness/full-text gate 另行处理；`non-randomized cohort` 不会被 `randomized` 子串误判为 RCT。
- 仍待补：数值化 similarity 分数入 `GRADEDomain` 或附属 audit、post-hoc subgroup 标识、follow-up window 规则，以及将 effect-selection 的 population/timepoint adjudication 直接传给 GRADE。

## 16. P2：统计与效应量策略

### 16.1 核心统计引擎评价

目前核心统计引擎总体较好：

- OR/RR/MD/SMD/HR 基础公式合理。
- fixed/random pooling 基础正确。
- HKSJ、REML、NMA fit/SUCRA、Egger、trim-and-fill、PET-PEESE 等已有实现。
- 现有 `tests/test_deep.py` 覆盖 155 个确定性 check。

### 16.2 需补强点

1. Effect measure 规划：
   - time-to-event outcome 默认 HR。
   - binary event count 默认 RR/OR。
   - continuous 默认 MD/SMD。

2. REML：
   - k<3 fallback 到 DL 或固定策略。

3. Paule-Mandel：
   - 增加步长保护或 bounded optimization。

4. Trim-and-fill：
   - side 不应固定 right。
   - 可根据 Egger 截距或 funnel asymmetry 判断方向。

5. Secondary outcomes：
   - k<2 不静默丢弃，进入 narrative-only list。

6. Median/IQR 转换：
   - facts 中标记 `derived_from_median_iqr=true`。
   - 报告中注明转换方法。

## 17. P2：检索策略与 PubMed 合规

### 17.1 PubMed 配置

问题：

- 默认 `PUBMED_EMAIL` 若是假邮箱，不符合 NCBI policy。
- 未配置 API key 时限流低。
- NCBI 超时没有用户可见提示。

建议：

- `.env.example` 明确要求真实 email。
- 无 email 时启动 warning。
- 记录 NCBI rate limit/timeout 到 `pipeline_warnings.json`。
- PubMed request 增加 retry/backoff 和明确错误类型。
- `MAX_SEARCH_RESULTS` 设置硬保护：默认保持较小；若用户调大，单次 PubMed `retmax` 不得超过 9999。
- 大检索必须使用 WebEnv/query_key 或稳定 cursor 分页，避免 offset 翻页时排序漂移和漏页。
- 触发大检索分页时写 warning，告诉用户结果排序、检索时间和分页策略。

### 17.2 MeSH validation 降级

当 MeSH validation 超时：

- 不应简单标记 MeSH not found。
- 应标记 `mesh_validation_status=timeout`。
- QueryBuilder 应使用 tiab fallback，并在报告限制中说明。

## 18. P2：前端/报告输出格式

### 18.1 当前问题

- 输出主要是 markdown。
- 图表 base64 嵌入 markdown，不利于投稿。
- `.bib`、图表原图、审计文件没有打包成完整 artifact。
- 没有 docx/PDF。
- 表格交叉引用和图表编号不稳定。

### 18.2 修改建议

输出目录标准化：

```txt
manuscript/
  draft.md
  draft.docx
  draft.pdf
  manuscript_facts.json
figures/
  figure_1_prisma.png
  figure_2_forest.png
tables/
  table_1_characteristics.csv
  table_2_rob.csv
references/
  references.bib
audit/
  pdf_intake_manifest.json
  extraction_audit.json
  pipeline_warnings.json
package/
  metaagent_export.zip
```

第一阶段可以先实现 artifact zip，不必立即做 docx/PDF。

## 19. P3：性能和并发

### 19.1 当前瓶颈

- PDF parsing 串行。
- 图表生成串行。
- 大段全文重复传给 LLM。
- 没有 prompt/context cache。

### 19.2 修改建议

1. PDF parsing 并发：
   - `asyncio.gather` 或 executor。
   - 每篇完成后推送进度。

2. 图表生成并发：
   - matplotlib 不完全线程安全，优先 `ProcessPoolExecutor`。
   - 每张图生成结果写 manifest。

3. LLM prompt cache：
   - 对全文前处理摘要/表格抽取做缓存。
   - 对支持 cache 的 provider 启用 context cache。

4. Large paper handling：
   - 不再简单 head/tail truncation。
   - 先结构化抽取 sections/tables，再按 outcome 定向检索相关片段。

### 19.3 LLM 成本可见性

问题：

- 用户跑 100 篇 review 时不知道大概花多少钱。
- 长流程中后期才 quota error，体验很差。

修改建议：

1. LLM client 维护 per-provider 价格表：

```json
{
  "openai:gpt-4o": {"input_per_1m": 5.0, "output_per_1m": 15.0},
  "dashscope:qwen-plus": {"input_per_1m": null, "output_per_1m": null}
}
```

2. 每次调用记录到 `llm_usage_manifest.json`：

```json
{
  "stage": "data_extraction",
  "paper_id": "...",
  "model": "qwen-plus",
  "input_tokens": 18000,
  "output_tokens": 4200,
  "estimated_cost_usd": 0.0
}
```

3. 前端展示累计 token 和估算成本。
4. 支持阈值：

```env
LLM_COST_WARNING_USD=10
LLM_COST_HARD_LIMIT_USD=25
```

5. 超过 warning 阈值时触发 decision point，让用户选择继续、降级模型、减少 PDF、暂停。

## 20. P3：测试体系

### 20.1 当前测试评价

优点：

- `tests/test_deep.py` 的统计 check 有价值。
- `tests/test_e2e.py` 能覆盖流程骨架。
- 新增的 `tests/test_phase_fixes.py` 可覆盖部分修复。

不足：

- E2E 是 mock LLM，不能证明真实模型提取可信。
- 缺少真实 PDF fixture。
- 缺少 UI/WS event contract 测试。
- 缺少安全扫描测试。

### 20.2 新增测试建议

1. Security test：
   - `.env` 被 ignore。
   - repo 不含 secret pattern。

2. Requirements test：
   - 新 venv install smoke test。

3. PDF intake fixture：
   - 文本 PDF。
   - 扫描 PDF。
   - 多栏 PDF。
   - 表格跨页 PDF。

4. Extraction gold set：
   - 5 篇人工标注论文。
   - outcome fields expected。
   - source quote expected。
   - effect size expected。

5. Report facts test：
   - 给定 facts，报告不得出现 forbidden claims。
   - PRISMA 数字一致。
   - k<10 不出现 Egger/Begg。

6. Resume DAG test：
   - 改 protocol 后下游 checkpoint 全清。

7. WebSocket contract test：
   - `need_pdf`
   - `pdf_intake_update`
   - `decision_point`
   - `extraction_review`
   - `pipeline_warning`
   - `finish`

8. Hard validator regression test：
   - 构造包含禁用词的 mock manuscript，例如“两名独立评审员”、未使用数据库、PROSPERO。
   - 构造 PRISMA 数字错误。
   - 构造不存在图表引用。
   - 构造 k<10 但报告 Egger/Begg。
   - 每条 validator 必须命中，并验证自动修复或阻断结果。

9. Published benchmark manifest test：
   - 每个 published benchmark 有机器可读 manifest：expected trial set、NCT/PMID/DOI、事件数、总人数、published effect anchor。
   - Search/screening artifact 必须通过 `evaluate_benchmark_recall()`，否则 benchmark run 失败。
   - Smoke 门可以低于 1.0，但 publication-ready 门必须是 1.0，并列出 missing trials。
   - Manifest 必须列出相邻但非 benchmark 的 decoy records，避免把 METCOVID/Edalatifard 这类近似研究误当 WHO REACT/JAMA 主试验集召回成功。

## 21. P3：小坑和边角

### 21.1 作者名解析

问题：

- `authors[0].split()[0]` 会把 `von Humboldt` 解析成 `von`。

建议：

- 引入 `nameparser`。
- 或至少处理 `de|van|von|der|al` 等 surname particles。

### 21.2 参考文献

建议：

- DOI/PMID 优先。
- 用户上传无 PMID 时用 PDF metadata 或 extracted title/year/authors。
- unmatched PDF 标注 user-supplied。

### 21.3 输出语言

问题：

- 中文/英文混杂风险。

建议：

- `manuscript_facts.json` 增加 `language`。
- 所有 section writer 强制同一语言。
- 最终校验英文 heading/中文 heading 混杂。

## 22. 建议迭代路线图

### Sprint 0：安全和可运行性（0.5-1 天）

任务：

1. `.gitignore` 增加 secret/output/log。
2. 新增 `.env.example`。
3. rotate 现有 key。
4. 重写 `requirements.txt`。
5. 新 venv 安装 smoke test。

验收：

- 无 secret 可被误提交。
- 新机器能安装并跑测试。

### Sprint 1：PDF Intake 闭环（5-7 天）

任务：

1. 新增 `pdf_intake_manifest.json`。
2. 下载/解析逐文件状态写 manifest。
3. WebSocket 推 `pdf_intake_update`。
4. PDF parsing 并发。
5. PyMuPDF fallback。
6. OCR fallback 接口。
7. PDF hash cache 命中秒返。

验收：

- 上传 10 篇 PDF 时，用户能看到每篇状态。
- 扫描件不会静默空文本。
- 解析失败可见、可重试。
- 重复上传同一 PDF 时显示缓存命中。

### Sprint 2：Extraction Review 闭环（3-5 天）

任务：

1. 扩展 `extraction_audit.json`。
2. 前端展示 source quote/page/confidence。
3. quote 未验证/低置信度进入待确认。
4. 新增 `extraction_overrides.json`。
5. 下游 merge overrides。
6. 新增冲突检测。
7. 用户确认 PDF 匹配 UI。
8. Override revision/ETag 冲突处理。

验收：

- 每个进入 meta-analysis 的数字都有可见来源。
- 用户可修改并影响下游结果。
- 未验证数据默认不进入定量合并。

### Sprint 3：EvidenceGate 与事实源统一（3-5 天）

任务：

1. CLI/Web 都接 EvidenceGate。
2. outcome matching 统一。
3. 新增 `manuscript_facts.json`。
4. ReportState 从 GateResult 构建。
5. 写作所有章节引用 facts。
6. 抽 `new_meta/core/pipeline.py`，CLI/Web 共享 phase1/phase2。
7. 对旧 checkpoint 增加 `legacy_mode=true` 兼容开关。

验收：

- CLI/Web 同一输入同一事实状态。
- 报告不会出现 facts 中不存在的数据库/人工评审/PROSPERO。
- 旧项目 resume 不会因 pipeline 抽象立即断裂；legacy mode warning 可见。

### Sprint 4a：报告硬校验框架和 report_type 拆分（2-3 天）

任务：

1. 实现 final hard validators。
2. report_type 四态拆分。
3. 图表存在性校验。
4. hard validator regression tests。

验收：

- validator 能命中禁用词、错误 PRISMA、不存在图表、k 限制违规。
- 报告类型由 facts 决定，不由各章节自由发挥。

### Sprint 4b：四种报告模板和 outcome 退化表达（3-5 天）

任务：

1. evidence_gap/narrative/failed/meta 四种模板具体内容。
2. 章节重写机制。
3. secondary outcome narrative-only 显示。
4. n=0/k<2/k<10 的正文和图表规则。

验收：

- n=0 不生成假 meta-analysis。
- k<2 不生成 pooled effect。
- k<10 不报告 Egger/Begg。
- PRISMA 数字跨章节一致。

### Sprint 5：静默失败治理与 resume（2-4 天）

任务：

1. `pipeline_warnings.json`。
2. 所有 warning/error 用户可见。
3. checkpoint dependency DAG。
4. Web parent_id resume。
5. MeSH timeout 降级提示。

验收：

- 失败不会被吞。
- 断线可恢复。
- 修改 PICO 后不会复用旧下游结果。

### Sprint 6：检索增强与 RoB 2（4-7 天）

任务：

1. 接入 `multi_search.py`。
2. PRISMA 多来源统计。
3. RoB 2 signaling questions。
4. synthetic RoB 标记。
5. GRADE 处理 synthetic/no_information。

验收：

- 召回改善。
- RoB/GRADE 不把占位结果当真实评价。

### Sprint 7：投稿级导出与性能（3-6 天）

任务：

1. artifact zip。
2. 图表独立文件。
3. references.bib 打包。
4. docx/PDF 导出。
5. 图表并发。
6. LLM prompt/context cache。

验收：

- 用户拿到完整投稿材料包。
- 运行时间明显下降。

## 23. 风险与依赖

### 23.1 高风险

- OCR 依赖安装复杂，可能影响部署。
- 多模型双筛选会增加成本。
- 用户 overrides 会引入审计和责任边界，需要记录修改来源。
- Facts hard validation 可能导致报告生成失败率短期上升。

### 23.2 中风险

- multi_search 多源 dedup 会影响 PRISMA 计数。
- EvidenceGate 统一后可能改变既有输出。
- Resume DAG 需要谨慎迁移旧项目。

### 23.3 低风险

- `.gitignore`、`.env.example`。
- requirements 最小化。
- pipeline_warnings。
- PDF manifest。

## 24. 最终验收清单

安全：

- [ ] `.env` 不可被 git add。
- [ ] 所有已泄漏 key 已 rotate。
- [ ] `.env.example` 完整。

可运行：

- [ ] 新 venv 安装成功。
- [ ] 核心测试通过。

上传：

- [ ] 每个 PDF 有 intake manifest。
- [ ] 下载/解析/OCR/匹配状态前端可见。
- [ ] 失败可重试。
- [ ] 用户可确认 PDF 匹配。

提取：

- [ ] 每个定量字段有 source quote/page。
- [ ] quote verification 前端可见。
- [ ] low confidence 阻断或确认。
- [ ] conflicts 可见并可裁决。
- [ ] overrides 影响下游。

筛选：

- [ ] 不再虚构双评审。
- [ ] 若启用双评审，Reviewer 2 真独立。
- [ ] 冲突筛选有裁决机制。

EvidenceGate：

- [ ] CLI/Web 统一调用。
- [ ] outcome matching 单一实现。
- [ ] GateResult 决定 report type。

写作：

- [ ] 所有章节使用 manuscript_facts。
- [ ] final validator 硬阻断事实错误。
- [ ] n=0/k<2/k<10 路径正确。
- [ ] 不引用不存在图表。
- [ ] secondary outcomes 不静默丢弃。

失败处理：

- [ ] 所有 stage warning 写入 pipeline_warnings。
- [ ] 前端展示关键 warning。
- [ ] 报告附录列出限制。

Resume：

- [ ] checkpoint DAG 清理正确。
- [ ] Web 断线后可恢复。

输出：

- [ ] markdown、图表、bib、audit、facts 打包。
- [ ] 后续支持 docx/PDF。

测试：

- [ ] 统计 tests 通过。
- [ ] WebSocket contract tests。
- [ ] PDF fixture tests。
- [ ] extraction gold-set tests。
- [ ] report facts tests。

## 25. 保留并继续强化的优点

以下部分不应大改，只需接入和硬化：

1. 统计引擎核心结构。
2. Pydantic v2 schema 体系。
3. LLM client retry/backoff 和 schema injection 框架。
4. Project/checkpoint 框架。
5. EvidenceGate 的设计方向。
6. ReportState 的单一事实源方向。
7. extraction audit 的后端基础。
8. Web 两阶段流程的产品方向。

## 26. 推荐立即行动顺序

最小可交付版本建议：

1. 先修 `.env`、`.gitignore`、`requirements.txt`。
2. 做 `pdf_intake_manifest.json` 和逐文件 WebSocket 状态。
3. 把 `extraction_audit.json` 推到前端，并支持用户编辑 overrides。
4. CLI/Web 统一 EvidenceGate。
5. 引入 `manuscript_facts.json`。
6. 写 final hard validators。
7. 补 checkpoint DAG 和 pipeline warnings。

其中第 2 步 PDF intake 与第 3 步 extraction review 可以并行推进，因为主要改动代码边界不同：前者集中在上传/下载/解析/匹配状态，后者集中在提取审计、用户确认和下游 merge。

这条路径能最快解决用户最直观的不信任：上传不知道有没有成功、提取不知道数字从哪来、报告不知道是不是乱写。

## 26.1 Sprint 质量门

每个 Sprint 结束必须通过对应质量门，不能只算“代码写完”。

- Sprint 0：安全门。`.env` 被 ignore；requirements 新环境安装；核心测试通过。
- Sprint 1：PDF intake 门。10 篇 PDF 批量上传有逐文件 manifest；失败、OCR、缓存命中均用户可见。
- Sprint 2：Extraction review 门。每个进入合并的字段都有 quote/page/confidence；override 可影响 effect size。
- Sprint 3：事实源门。CLI/Web 共享 pipeline；同一输入得到同一 GateResult/ReportState/facts。
- Sprint 4a：校验门。hard validator regression tests 全通过。
- Sprint 4b：报告门。n=0/k<2/k<10 四类路径不产生违规报告。
- Sprint 5：稳定性门。checkpoint DAG、warnings、resume 合约测试通过。
- Sprint 6：证据质量门。multi-source 检索、RoB 2、indirectness 规则化有 fixture 测试。
- Sprint 7：交付门。artifact zip 包含 manuscript、figures、tables、bib、audit、facts、warnings。

## 27. 审查意见覆盖矩阵

本节用于确认所有已提出审查意见均已纳入文档，不以“概括过”代替落地项。

| 编号 | 审查点 | 文档位置 | 处理状态 |
| --- | --- | --- | --- |
| P0-1 | `.env` 未进 `.gitignore`，存在真实 secret 泄漏风险 | 4.1, Sprint 0, 验收清单 | 已纳入，要求 ignore、`.env.example`、rotate key |
| P0-2 | `requirements.txt` 混入本地 conda/Windows 路径，新机器安装失败 | 4.2, Sprint 0 | 已纳入，要求最小依赖和新 venv smoke test |
| P1-3a | PDF 上传实际是 fileIds/MongoDB 拉取，不是真上传 | 5.1, 5.2, Sprint 1 | 已纳入，要求 intake manifest 和真实上传体验 |
| P1-3b | PDF 下载无进度、无重试、120s 超时用户无感 | 5.3, 5.4, 12.1, 12.2 | 已纳入，逐文件状态和 warning 回流 |
| P1-3c | PDF 解析失败只 warning 后 continue | 5.3, 5.4, 12.1, 12.2 | 已纳入，失败写 manifest 和 pipeline warnings |
| P1-3d | `pdfplumber.extract_text()` 对扫描件为空，无 OCR 默认兜底 | 5.5, Sprint 1, 风险与依赖 | 已纳入，要求 PyMuPDF 和 OCR fallback |
| P1-3e | 多栏排版、跨页表格没有处理或质量提示 | 5.5, 20.2 | 已纳入，要求表格页码标记和 PDF fixture |
| P1-3f | 用户 PDF 被伪造成 `user_pdf_0`，不是对等来源 | 5.7, 18.2 | 已纳入，要求 `source_type/source_id/matched_pmid` |
| P1-3g | 用户不能覆盖匹配/去重决定，不能中途追加 | 5.2, 5.4, 8.4 | 已纳入，要求匹配确认、resume 状态恢复 |
| P1-3h | PDF 解析串行，前端干等 | 5.6, 19.2 | 已纳入，要求并发解析和逐文件推送 |
| P1-3i | 解析后没有预览，看不到识别文本/表格/失败页 | 5.2, 5.3, 5.4 | 已纳入，要求文件卡片和解析摘要 |
| P1-4a | `source_quote/source_page/confidence` 字段藏在磁盘，UI 不暴露 | 6.1, 6.2, 6.3, Sprint 2 | 已纳入，要求 extraction review UI |
| P1-4b | `extraction_confidence` 没稳定赋值或没被使用 | 6.3, 6.4 | 已纳入，要求置信度进入待确认规则 |
| P1-4c | `_validate_source_quotes()` 只验证，不惩罚、不重试 | 6.4, 9.3 | 已纳入，要求未验证阻断/确认 |
| P1-4d | `extraction_audit.md/json` 写磁盘但前端不显示 | 6.2, 6.3, Sprint 2 | 已纳入 |
| P1-4e | 摘要/表格/正文数字冲突无检测 | 6.6 | 已纳入，新增 ConflictNote 和用户裁决 |
| P1-4f | 用户修改提取值无法持久化 | 6.5 | 已纳入，新增 `extraction_overrides.json` |
| P1-4g | EvidenceGate 只查逻辑异常，不验证数字源自原文 | 9.3 | 已纳入，要求 quote/confidence/conflict 进入 Gate |
| P1-5a | `writing_agent.py` 逐章 prompt 拼接，跨章一致性差 | 10.1, 10.2 | 已纳入，引入 `manuscript_facts.json` |
| P1-5b | Methods 虚构两名独立评审员/人工流程 | 10.3, 7.2 | 已纳入，事实违规 hard validation |
| P1-5c | PRISMA 数字自相矛盾 | 10.3 | 已纳入，跨章节硬校验 |
| P1-5d | n=0/k<2 退化路径混乱 | 10.4 | 已纳入，拆分 failed/evidence_gap/narrative/meta |
| P1-5e | 被剔除文献或间接证据被当主要结果引用 | 10.2, 10.4, 9.2 | 已纳入，GateResult 和 report_type 控制 |
| P1-5f | 空图表/残留 Figures 章节 | 10.3, 18.2 | 已纳入，图表存在性校验和 artifact 规范 |
| P1-5g | 只有 markdown、base64 图，缺 docx/PDF/投稿包 | 18.1, 18.2, Sprint 7 | 已纳入 |
| P1-5h | 次要结局 N<2 静默丢弃 | 10.5, 16.2 | 已纳入，narrative-only outcomes |
| P1-6a | “双评审员”是同模型不同 temperature，不是真独立 | 7.1, 7.2 | 已纳入，快速诚实版或真双评审版 |
| P1-6b | Cohen's kappa 算了但不影响流程 | 7.2 | 已纳入，kappa 低触发确认 |
| P1-6c | FT 阶段没有双评审 | 7.2 | 已纳入，若启用双评审则 T/A 和 FT 都支持 |
| P1-7a | Web 没有 resume，状态在内存 | 8.4, 11 | 已纳入；后补全文 `resume_project` 已实现，通用 parent_id resume 仍待收敛 |
| P1-7b | CLI 决策点 Web 缺失，broad fallback 静默 | 8.2, 12.1 | 已纳入，结构化 decision_point |
| P1-7c | 进度只有 step，无篇级进度/ETA | 8.3 | 已纳入，progress_cb |
| ADD-1 | `MAX_SESSIONS=16` 命中时排队体验弱，无位置/ETA | 8.3 | 已纳入，service_busy 和 queue_position_update |
| ADD-2 | `LLM_MAX_TOKENS=8192` 对长文 extraction/writing 有截断风险 | 14.3 | 已纳入，分任务 token budget 和截断告警 |
| ADD-3 | GRADE indirectness 过度依赖 LLM vibes | 15.3 | 已纳入，P/I/C/O 相似度和 surrogate/post-hoc 规则化 |
| ADD-4 | LLM token/cost 不可见，quota 风险后置暴露 | 19.3 | 已纳入，llm_usage_manifest 和 cost decision point |
| ADD-5 | `main.py` 与 `start.py` 是流程拷贝，非单一编排入口 | 9.4, Sprint 3 | 已纳入；后补全文 resume 已改委托 CLI，完整 `core/pipeline.py` 仍待 |
| ADD-6 | `extraction_overrides.json` 缺并发/多用户语义 | 6.5 | 已纳入，revision 和 ETag/If-Match |
| ADD-7 | PDF 内容哈希缓存没有强调用户可见秒返 | 5.2, Sprint 1 | 已纳入，Cached 卡片和 hash cache |
| ADD-8 | 缺 hard validator 自身回归测试 | 20.2, Sprint 4a | 已纳入，mock manuscript validator tests |
| ADD-9 | synthetic RoB 的 GRADE 反应需明确，不应又 downgrade 又正式评级 | 15.2 | 已纳入，not formally assessed |
| ADD-10 | PubMed efetch/retmax 大检索分页上限与漏页风险 | 17.1 | 已纳入，retmax<=9999 和 WebEnv/cursor 分页 |
| ADD-11 | Sprint 1 工时低估，匹配确认 UI 应移到 Sprint 2 | Sprint 1, Sprint 2 | 已纳入，Sprint 1 改 5-7 天，匹配确认移入 Sprint 2 |
| ADD-12 | Sprint 4 过重，应拆 4a/4b | Sprint 4a, Sprint 4b | 已纳入 |
| ADD-13 | PDF intake 和 extraction review 可并行 | 26 | 已纳入，并行授权 |
| ADD-14 | 路线图缺质量门 | 26.1 | 已纳入，Sprint quality gates |
| P2-8a | `multi_search.py` 未调用 | 13.1, Sprint 6 | 已纳入，建议接入 |
| P2-8b | NMA `node_splitting()` 未调用 | 13.2 | 已纳入，接入 NMA consistency/GRADE |
| P2-8c | EvidenceGate CLI/Web 双轨或未统一 | 9.1, 9.2, 13.3 | 已纳入，统一调用 |
| P2-8d | `_outcome_matches` 双轨阈值不一致 | 9.2, 13.4 | 已纳入，统一 outcome matcher |
| P2-9 | Protocol 修改后 checkpoint 下游清理不完整 | 11.1, 11.2 | 已纳入，DOWNSTREAM DAG |
| P2-10a | `_get_advisory()` 裸 except，失败假建议 | 12.1, 12.2 | 已纳入，pipeline warnings |
| P2-10b | NMA 失败和未请求 NMA 混在一起 | 12.1, 12.2, 13.2 | 已纳入，状态区分 |
| P2-10c | 图表生成失败后仍打印路径 | 10.3, 12.1, 18.2 | 已纳入，图表存在性校验 |
| P2-10d | PDF 解析失败吞没 | 5.3, 12.1, 12.2 | 已纳入 |
| P2-11 | LLM JSON 无字符串修复兜底 | 14.1, 14.2 | 已纳入，`_repair_json()` |
| P2-12a | PDF 解析串行 | 5.6, 19.2 | 已纳入 |
| P2-12b | 17 块图表串行 | 19.1, 19.2 | 已纳入，进程池 |
| P2-12c | 大论文文本反复传 LLM，无 cache | 19.1, 19.2 | 已纳入，prompt/context cache |
| P2-13a | RoB prompt 不是真 RoB 2 signaling questions | 15.1, 15.2 | 已纳入 |
| P2-13b | 无全文时合成 RoB，下游当真 | 15.1, 15.2 | 已纳入，`is_synthetic` 和 GRADE 降级 |
| P3-14 | 作者名解析 `split()[0]` 错 | 21.1 | 已纳入 |
| P3-15 | PubMed 默认邮箱不合规/API key 缺失/限流 | 17.1 | 已纳入 |
| P3-16a | REML k=2 fallback | 16.2 | 已纳入 |
| P3-16b | Paule-Mandel 步长保护 | 16.2 | 已纳入 |
| P3-16c | Trim-and-fill side 自动判断 | 16.2 | 已纳入 |
| P3-17a | `test_deep.py` 统计测试有价值 | 20.1, 25 | 已纳入，保留 |
| P3-17b | `test_e2e.py` mock，真实可信度不足 | 20.1, 20.2 | 已纳入，新增 gold-set |
| GOOD-1 | 统计引擎核心正确，别大改 | 16.1, 25 | 已纳入 |
| GOOD-2 | LLM client retry/backoff/schema injection 方向好 | 25 | 已纳入 |
| GOOD-3 | Pydantic v2 schema 设计好 | 25 | 已纳入 |
| GOOD-4 | checkpoint 框架方向好，只是清理漏 | 11, 25 | 已纳入 |
| RUN-1 | 实跑 SGLT2 主题时 HR/RR 规划不匹配 | 2.1, 16.2 | 已纳入 |
| RUN-2 | MeSH validation 超时用户无感 | 2.1, 17.2, 12 | 已纳入 |
| RUN-3 | 中断后只到 protocol checkpoint，恢复体验弱 | 2.1, 8.4, 11 | 已纳入 |
| BENCH-1 | Accepted benchmark source 只停留在 review 状态，不能安全进入 extraction | 118, 119 | 已实现显式 apply 和 application ledger |
| BENCH-2 | 已匹配 trial 的 primary row 计数和 published anchor 不一致时缺少用户裁决任务 | 120 | 已实现 `primary_count_discrepancy` task |
| BENCH-3 | Quote candidate context 再生成会导致已接受决策失效 | 121 | 已实现 source sha/task/type/values fallback |
| BENCH-4 | 同一研究多行 outcome 时 source override 可能写错行 | 121 | 已实现 `row_id` 优先定位与 PMID/effect id 对齐 |
| BENCH-5 | COVID benchmark 需要真实对照 published anchor，而不只看报告是否生成 | 122 | 已记录 7/7 primary rows、222/678 vs 425/1025、OR 0.659 对齐 published OR 0.66 |
| BENCH-6 | 离线交付包缺少 source decision/application 审计链 | 123 | 已打包 decisions、applications、parsed sources、benchmark review/report |
| BENCH-7 | 用户补充 PMC/registry/full-text source 后，benchmark gate 仍不认主来源 | 124 | 已实现显式 `primary_source`/`primary_full_text` gate 补充，普通 source 不计入 |
| BENCH-8 | 用户已补全文后 manuscript facts 仍保留 abstract-only blocker | 125 | 已按 source 文本匹配 PMID/DOI/title 解除 limited-source blocker |
| BENCH-9 | accepted timepoint/manual adjudication 字段未进入 Web downstream audit | 125 | 已补齐 effect-selection audit 字段传递 |
| BENCH-10 | benchmark 通过后仍需区分 fresh one-click 缺口和 user-assisted source acquisition | 126 | 已记录：search recall 仍反映 fresh 检索，primary-source gates 反映用户补源后状态 |
| BENCH-11 | fresh pipeline 对 registry-first trial 只有 metadata seed，没有自动抓官方来源 | 127 | 已实现 ClinicalTrials 结构化来源物化和 registry seed `source_urls` 自动抓取 |
| BENCH-12 | Europe PMC 命中 PMCID 但 XML/HTML 壳页失败时缺少 PMC 正文 fallback | 127 | 已实现 `pmc.ncbi.nlm.nih.gov/articles/<PMCID>/` HTML fallback |
| BENCH-13 | manuscript checkpoint 已存在时无法强制只重写稿件 | 128 | 已实现 CLI/Web manuscript-only forced rerun |
| BENCH-14 | publication-style 写稿时 LLM 故障会把项目卡死或继续停在旧 evidence-gap 稿 | 128 | 已实现 deterministic meta manuscript fallback |
| BENCH-15 | 百炼 Qwen3.6 联网搜索需要 Responses API，但当前 LLM client 只会 chat completions | 129 | 已实现 DashScope Responses API 自动路由和安全 env 配置 |
| BENCH-16 | COVID benchmark 对齐 published anchor 需要 OR/fixed，但此前 effect/model mismatch 只是一条泛化失败 | 139 | 已实现 benchmark summary/report 中 expected/observed `model_preference` 对照和 `model_preference_mismatch` gate |
| BENCH-17 | 用户或前端不知道该怎样把 effect/model mismatch 转成可执行修改 | 140 | 已实现 `protocol_adjudication_tasks`，包含 published anchor、observed primary 和 `suggested_protocol_patch` |
| BENCH-18 | 离线 export 包没有汇总 protocol/effect-model 裁决任务数量 | 141 | 已加入 `package_manifest.json.review.benchmark_protocol_adjudication_tasks` |
| BENCH-19 | `suggested_protocol_patch` 若没有后端执行入口，前端按钮仍然只是提示 | 142, 143 | 已实现 Web `protocol_override` 保存、审计、下游 checkpoint 清理和 review 回推 |
| BENCH-20 | 协议裁决后缺少离线审计文件解释 OR/fixed 为什么被改 | 143 | 已将 `protocol_overrides.json` 写入项目并纳入 export package |
| BENCH-21 | known-source recovery 自动改协议时仍是隐性行为，未进入同一条 override 审计链 | 144 | 已抽 `core/protocol_overrides.py`，CLI 自动 preference 和 Web 手动 override 共用审计与 checkpoint 清理 |
| ADD-15 | 长稿件/流式输出被 `max_tokens` 截断后只整段重试或丢失前半段，正式论文生成不稳 | 145 | 已实现文本型截断续写拼接、流式 finish_reason 捕获；JSON 型仍整段重试，避免结构化输出被拼坏 |
| ADD-16 | 长正式稿有章节引用但全稿引用密度仍偏低，Introduction/Discussion 仍显得参考文献不足 | 149 | 已实现全稿 citation density 和 unique cited references deterministic backfill，并用 SGLT2 实跑稿验证 citation audit 0 issue |
| ADD-17 | Manuscript polish 会误改检索式代码块，且 LLM 容易把保守结果表述强化成疗效断言 | 150 | 已隔离 fenced code blocks、强化 prompt 中的方向性禁令，并收窄 methodological rank terms 的 guard 假阳性 |
| ADD-18 | 快速 polish / 预算耗尽时没有实际清理模板腔，style audit 又把表格、小数、图注误当正文问题 | 151 | 已把 deterministic cleanup 前置到 LLM budget 之前，并将 style audit 限定到可润色正文、修复小数点误分句 |
| ADD-19 | style audit 仍把固定统计结果句式和可安全替换的方法学模板开头算作重复句首 | 152 | 已过滤 heterogeneity 统计报告句式，并用 deterministic cleanup 改写 selected-endpoint 与 manuscript-therefore 模板开头 |
| ADD-20 | style audit 用全词词汇多样性惩罚技术稿常见功能词，导致 SGLT2 稿剩余 AI 风格误报 | 153 | 已改为英文内容词多样性和技术稿阈值，并用 SGLT2 实跑确认 after style score=0 |
| ADD-21 | manuscript polish 把 certainty/方法学方向词和 budget exhausted 都混入 fact-guard，warning 解释不清 | 154 | 已收窄非临床方向词语境，并将 budget exhausted 独立显示，不计入 fact_guard_issues |
| ADD-22 | 默认 polish 把所有干净段落也送入 LLM 或计入预算，导致慢且一键成稿常带 budget warning | 155 | 已新增 targeted 默认 scope，干净 chunk 不消耗 LLM 预算；SGLT2 默认重跑 package 达到 submission ready |
| ADD-23 | 正式长稿缺失 `manuscript_facts` 时会绕过投稿级 20 条参考文献阈值，导致“看起来 ready 但引用仍偏少” | 156 | 已让 citation audit 根据正文结构和主文长度兜底触发 publication reference depth warning |
| ADD-24 | 结果/讨论/结论章节已有引用，但 HR/CI/I² 等具体数值句仍无同句引用，用户点数字时无法建立信任链 | 157 | 已加入数值效应句 citation backfill，优先将试验/注册来源补到同一句；覆盖中英文章节标题 |
| ADD-25 | HR/CI/I² 句虽然有引用，但只引用 GRADE/PRISMA/指南等方法学或背景来源，仍无法证明数字来自原始试验 | 158 | 已加入数值效应 source-type audit 和同句试验来源补引；manifest/HTML/Web actionable payload 会显示已有错误引用和推荐补充的 source-report citation |
| ADD-26 | 旧项目缺 `evidence_context.json` 时，即使 References 里有 trial report，数值效应 source-type audit 也无法推荐可修复的来源引用 | 159 | 已从 numbered References 中兜底识别 trial/registry 来源，并把候选同步到 Web actionable recommendations |
| ADD-27 | 中文 polish 只清理“值得注意的是/综上所述”，漏掉“总体而言/需要指出的是”等高频模板腔 | 160 | 已扩展中文 template phrase audit 与 deterministic cleanup，快速/targeted polish 无 LLM 预算时也能清理 |
| ADD-28 | Web style review 只显示 template_phrase_hits 的 code/count，不显示具体剩余模板短语，用户不知道该删什么 | 161 | 已从 polish audit 顶层 `template_phrase_hits` 回填 `remaining_issues/resolved_issues.phrases` |
| ADD-29 | 真实 NEJM/JAMA 原始 RCT 题名不一定含 `randomized trial`，导致 References 兜底无法把 DELIVER/EMPEROR 识别为 HR/CI source report | 162 | 已新增共享 reference classifier；citation audit 与写作补引都会识别“高影响临床期刊 + 治疗词 + 临床人群/结局词”的 source-report 条目 |
| ADD-30 | 真实药物-结局 RCT 题名可能不在已知药物清单内，如 SELECT 的 semaglutide 题名，References 兜底仍可能漏掉 | 163 | 已加入药物样后缀 + 临床结局/疾病词的保守识别，并排除 meta-analysis/guideline/protocol 等非原始来源 |
| ADD-31 | 旧项目/手工稿只有 References、缺 context JSON 时，Introduction/Methods/Discussion 的 citation audit 能发现缺引用但不能推荐具体文献 | 164 | 已把 reference classifier 升级为 source-role 输出，并让背景/方法/讨论推荐器从 numbered References 按角色兜底 |
| ADD-32 | LLM polish 后可能引入或保留缺少同句来源引用的 HR/CI、Methods、Discussion 句子 | 165 | 已在 `_polish_project_manuscript()` 后追加 reference-role-aware citation backfill，并写入 `post_polish_citation_backfill` 审计 |
| ADD-33 | Polish 后 citation audit 已明确推荐引用编号，但 CLI 只生成 warning、不自动补到句子 | 166 | 已新增 citation-audit-recommended sentence backfill，只自动应用有推荐编号的安全补引，并记录审计 |
| ADD-34 | 中文医学稿因英文缩写和 fenced 检索式被误判为 mixed，导致中文 submission readiness 被阻断 | 167 | 已在 package/Web 语言检测中剔除 References、代码块、表格、图片行，并允许中文正文中的医学英文缩写 |
| ADD-35 | Introduction/Discussion 把自动化流程、来源核验和审稿 handoff 当作意义/优势/局限，稿件作者身份错位 | 168 | 已把 generic fallback 改成临床解释导向，并增加中英文测试拦截流程自述语言 |
| ADD-36 | 同一个大 citation cluster 在 Discussion 多段重复出现，如 `［3，5，7，20，23］` | 169 | 已新增 repeated citation cluster limiter，并把讨论补引收窄到更小引用组 |
