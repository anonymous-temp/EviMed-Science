# 虚拟临研 · 构建契约（P0）

2026-09-28 · 分支 `feature/virtual-clinical-research` · 工作树 `/home/coder/worktrees/wt-vcr` · 对应方案 `docs/superpowers/specs/2026-09-28-EviMed虚拟临研平台方案.md`

这份文件是七个工作包之间唯一的共同契约。**方案是需求，这份文件是接口。**两者冲突时以方案为准，并在这里改。

## 0. 纪律

1. **只在 `/home/coder/worktrees/wt-vcr` 里写。** 主工作树 `/home/coder/workspace/EviMedScience` 有别的会话在发布，一个字都不要改。
2. **不装任何东西**：不跑 `pnpm install`、`pip install`、`npm i`、`docker build`、`R install.packages`。磁盘紧张，依赖已经准备好（R 包在 `/home/coder/R/vcr-4.3`）。
3. **只写自己那一包的文件**（第 2 节）。要改别人的文件，写进汇报里，由主线程合。
4. **提交**：不要 `git commit`、不要 `git stash`、不要切分支。
5. **测试**：`node --test apps/server/test/<你的文件>.test.mjs` 可直接跑（node_modules 已就位）。前端用 `pnpm --filter @ai4s/web exec vitest run <file>`。
6. **不新增阻断检查**（原则 4）。新检查一律 advisory。
7. **数字不由模型产生**（原则 1）。确定性计算全部在引擎或代码里。
8. 代码、注释、提交信息一律英文；界面文案简体中文；注释写"隐藏知识"，不复述代码。

## 1. P0 已经做完的（不要重写）

| 文件 | 内容 |
|---|---|
| `packages/domain/src/vcrVocabulary.mjs` | 全部封闭词表 + `intendedUseCeiling` / `missingModelEvidence` / `twinLabel` / `roleAllows` |
| `packages/domain/src/vcrEngineJob.mjs` | 引擎协议：`validateEngineJob` / `validateEngineResult` / `canonicalScenarioJson` / `replicatesForMcse` / `mcseOf` / `replicateFloor` / `VCR_ENGINE_METHODS` / `VCR_JOB_METHODS` |
| `packages/domain/src/vcrLineage.mjs` | `lineageNode` / `affectedNodes` / `recomputePlan` / `reviewStateFor` |
| `packages/domain/src/vcrContracts.mjs` | 五个合约的 findings（全部 advisory） |
| `packages/domain/index.mjs` | 以上全部已导出，可 `import { … } from "@evimed/domain"` |
| `packages/domain/src/{contractKinds,contractRegistry,gateIssueText,toolNames,usagePurpose}.mjs` | 五个合约种类、五个工具名、用途 `vcr` 已登记 |
| `apps/server/src/vcrPersistence.mjs` | `evimed_vcr` 全部 39 张表 + `migrateVcr` + `vcrSchemaSql`（已在本机 PostgreSQL 上验证可建、可重复执行） |
| `apps/server/src/vcrStoreBase.mjs` | `VcrStoreBase`（transaction / query / rows / one / nextVersion / audit）、`vcrId`、删除路径 |
| `apps/server/src/config.mjs` | `vcrEnabled` `vcrAudience` `vcrPreviewUsers` `vcrPollMs` `vcrLeaseMs` `vcrDailyBudgetCny` `vcrEngineUrl` `vcrEngineTimeoutMs` `vcrMaxConcurrentJobs` `vcrJobCpuSeconds` `vcrStudyCpuBudget` `vcrDataPlaneDir` |

主线程（P0）另外负责：`server.mjs` 的组装与注册、`/api/me` 的 `features.vcr`、发布清单、走查脚本登记。**工作包不要碰这几处。**

## 2. 文件归属

| 包 | 只写这些文件 |
|---|---|
| **A 数据平面与成员** | `apps/server/src/vcrDataPlane.mjs`、`vcrAccess.mjs`、`vcrMembers.mjs`、`vcrDataStore.mjs`、`scripts/vcr/profile_snapshot.py`；测试 `apps/server/test/vcrDataPlane*.test.mjs`、`vcrAccess*.test.mjs`、`vcrMembers*.test.mjs` |
| **B 引擎** | `项目代码/vcr-engine/**`（R + Python + Dockerfile + tests + README） |
| **C 证据参数化** | `apps/server/src/vcrEvidence.mjs`、`vcrEvidenceStore.mjs`、`trialRegistryClient.mjs`、`capabilities/vcr-evidence/**`、`capability-skills/vcr-evidence/**`、`evals/vcr-evidence/**`；测试 `apps/server/test/vcrEvidence*.test.mjs` |
| **D 编排与能力** | `apps/server/src/vcrService.mjs`、`vcrRoutes.mjs`、`vcrStore.mjs`、`vcrOrchestrator.mjs`、`vcrWorker.mjs`、`vcrGateway.mjs`、`vcrJobs.mjs`、`vcrEngineClient.mjs`、`vcrRender.mjs`、`vcrNotify.mjs`、`vcrSeal.mjs`、`runtime/mcp/evimed-research/vcr_platform.py`、`capabilities/vcr-{protocol,analysis,package}/**`、`capability-skills/vcr-{protocol,analysis,package}/**`、`evals/vcr-{protocol,analysis,package}/**`；测试 `apps/server/test/vcr{Service,Routes,Orchestrator,Gateway,Jobs,Render,Seal}*.test.mjs` |
| **E 匹配与招募** | `apps/server/src/vcrMatching.mjs`、`vcrRecruit.mjs`、`vcrMatchStore.mjs`、`capabilities/vcr-matching/**`、`capability-skills/vcr-matching/**`、`evals/vcr-matching/**`；测试 `apps/server/test/vcrMatching*.test.mjs`、`vcrRecruit*.test.mjs` |
| **F 前端** | `apps/web/src/app/virtual-research/**`、`apps/web/src/components/vcr/**`、`apps/web/src/lib/vcrClient.ts`、`apps/web/src/app/router.tsx`、`apps/web/src/components/sidebar/Sidebar.tsx`、对应 `*.test.tsx`；Vue 补丁 `docs/superpowers/specs/2026-09-28-virtual-clinical-research-assets/vue-patch/*.patch` |
| **G 验收** | `apps/server/test/vcrAcceptance*.test.mjs`、`apps/server/test/vcrNumeric*.test.mjs`、`evals/vcr-acceptance/**`、`项目代码/vcr-engine/tests/numeric/**`（与 B 商量，G 只加不改） |

## 3. 控制面接口

### 3.1 浏览器 `/api/vcr/*`（D 实现）

模块关或不在开放范围：**全部 404 `vcr_not_enabled`**（GEO 的做法）。别人的研究一律 404 `vcr_study_not_found`。信封 `{ data: … }`。

```
GET    /api/vcr/studies                     研究列表（含步骤进度、数据档位、需要关注的事）
POST   /api/vcr/studies                     新建（建普通项目 + studies 行）
GET    /api/vcr/studies/:id                 总览
PATCH  /api/vcr/studies/:id                 名称、预期用途、预算、状态
DELETE /api/vcr/studies/:id
GET    /api/vcr/studies/:id/:tab            tab ∈ population|patients|comparator|trial|matching|data
POST   /api/vcr/studies/:id/run             「让 AI 做」：{ step }
POST   /api/vcr/studies/:id/jobs            直接排一个确定性作业：{ kind, scenario, … }
GET    /api/vcr/studies/:id/jobs/:jobId
POST   /api/vcr/studies/:id/jobs/:jobId/cancel
POST   /api/vcr/studies/:id/budget          确认追加计算预算（人停的第二处）
POST   /api/vcr/studies/:id/assumptions     新版本假设卡
POST   /api/vcr/studies/:id/reviews         复核签注
POST   /api/vcr/studies/:id/decisions       决策记录
POST   /api/vcr/studies/:id/export          { kind } → exports 行
GET    /api/vcr/studies/:id/export/:exportId
GET    /api/vcr/models                      模型与方法库（跨研究）
GET    /api/vcr/precedents                  先例检索（C 的读模型）
POST   /api/vcr/studies/:id/members         成员与角色（A 的读写，D 挂路由）
POST   /api/vcr/studies/:id/referrals/:referralId/contact   协调员逐人确认（人停的第一处，E 实现判定）
```

路由指标折叠函数 `vcrRoutePattern(pathname)` 由 D 导出，形状照 `geoRoutePattern`。

### 3.2 运行时通道 `/internal/vcr/v1/{read,write,simulate}`（D 实现）

- 凭证是运行时自己的令牌，**令牌决定账户与研究**，请求里没有账户参数（GEO 的做法）。
- `read`：`{ what: "study"|"assumptions"|"population"|"comparator"|"trial"|"precedents"|"matching"|"results"|"snapshot_profile", …}`；**只回聚合与结构**，行级数据永不出现；人数 < `VCR_MIN_CELL_SIZE` 的格子合并或隐去。
- `write`：逐项校验、逐项拒绝、从不整批失败（`geoWrites.mjs` 的做法）。可写：研究定义、入排条件、假设卡、人群定义、对照设计、试验情景、决策记录、报告文字。**不可写**：结果数字、counts、执行记录。
- `simulate`：`{ action: "start"|"status", kind, scenario, … }` → `{ jobId, state, progress }`。和 `meta_analysis` 同形状。

### 3.3 引擎通道（D 的 `vcrEngineClient.mjs` ↔ B 的引擎）

HTTP，`OPEN_SCIENCE_VCR_ENGINE_URL`：

```
POST /jobs            body = 完整 job（见 §4），头 Authorization: Bearer <工作负载令牌>
                      → 202 { jobId, accepted: true }
GET  /jobs/:jobId     → { jobId, state, progress:{done,total}, cpuSeconds }
POST /jobs/:jobId/cancel → { canceled: true }
GET  /jobs/:jobId/result → 完整 result（见 §4）
GET  /health          → { ok, engineVersion, rVersion, methods:[…], packageLockHash }
```

引擎**只读**作业里点名的快照文件（`inputs[].location`），不挂整个数据卷；结果写到作业指定的输出目录。

## 4. 引擎作业协议（`@evimed/domain` 的 `vcrEngineJob.mjs` 是权威）

```jsonc
{
  "jobId": "job_…", "studyId": "std_…", "kind": "design_simulation",
  "method": "design.simulate", "methodVersion": "1.0.0", "protocolVersion": 1,
  "seed": 20260928, "replicates": 20000, "cpuSecondsLimit": 600,
  "inputs": [ { "kind": "assumption", "id": "asm_…@3", "hash": null, "value": {…} },
              { "kind": "snapshot",   "id": "snp_…",   "hash": "<sha256>", "location": "/data/…parquet" } ],
  "scenario": { "design": {"kind":"two_arm_fixed", …}, "endpoint": {"type":"time_to_event", …},
                "truth": {…}, "analysis": {…}, "accrual": {…}, "performance": ["power","type_one_error", …] }
}
```

回来：

```jsonc
{
  "jobId": "job_…", "protocolVersion": 1, "status": "succeeded|failed|canceled|not_estimable",
  "method": "design.simulate", "methodVersion": "1.0.0",
  "scenarioHash": "<sha256 of canonicalScenarioJson(scenario)>", "seed": 20260928, "replicates": 20000,
  "notEstimableRule": null,
  "counts": { "realPatients": 0, "events": 138, "effectiveSampleSize": null, "generatedRecords": 3600000 },
  "measures": [ { "name": "power", "value": 0.812, "simulated": true, "mcse": 0.0031,
                  "interval": { "kind": "monte_carlo", "low": 0.806, "high": 0.818 } } ],
  "diagnostics": {…},
  "tables": [ { "name": "operating-characteristics", "location": "…csv", "sha256": "…" } ],
  "manifest": { "engineVersion": "1.0.0", "rVersion": "R 4.3.3", "packageLockHash": "…",
                "startedAt": "…", "finishedAt": "…", "cpuSeconds": 42.1, "outputHash": "…" }
}
```

规则：**仿真出来的每个 measure 必须带 `mcse`**；失败不写 0；`not_estimable` 必须带 `notEstimableRule`（词表在 `VCR_NOT_ESTIMABLE_RULES`）。

## 5. 能力包（C、D、E）

- 五个：`vcr-protocol`、`vcr-evidence`、`vcr-analysis`、`vcr-matching`、`vcr-package`。
- 全部 `visibility: public` + `display.listed: false`（不能 internal，否则绑定会话 403）。
- 每个：`capabilities/<id>/capability.yaml` + `SKILL.md`（放 `capability-skills/<id>/`）+ `scripts/preflight.py` + `evals/<id>/briefs.json`（≥3 条真实 brief）。
- `produces` 的合约种类用 P0 已登记的五个：`vcr-study-package`、`vcr-simulation-report`、`vcr-comparator-analysis`、`vcr-cohort-snapshot`、`vcr-matching-assessment`。
- `safetyClass`：分析类用 `general`；`vcr-matching` 的招募材料与患者说明用 `clinical`。
- 清单生成脚本 `scripts/build/generate-capability-manifests.mjs` 由主线程统一跑一次，**不要各自跑**。
- preflight.py 要四处一致（`capabilities/`、`capability-skills/`、`runtime/skills/evimed/`、prepack 生成的 socket 副本）——**只写 `capabilities/` 与 `capability-skills/` 两处，主线程负责同步其余**。

## 6. 前端（F）

- 路由：`/app/virtual-research`（首页）、`/app/virtual-research/:studyId/:tab?`。
- 侧栏：`科研工具` 之后依次 `虚拟临研`（Lucide `users-round`）、`循证 GEO`；`Sidebar.test.tsx` 的相邻断言同步改。
- 首页：页头「虚拟临研」+「新建研究」；四个动作卡（创建虚拟队列 / 创建虚拟患者 / 构建合成对照 / 模拟临床试验）→ 进入新对话并挂模块标签；下面三个页签（研究 / 模型与方法 / 试验先例）；有招募角色的账号多一栏「招募待办」。
- 研究页：页头（名称、数据档位、预期用途、七步进度轨、「对话」、「⋯」）+ 七个页签（总览 人群 虚拟患者 对照 试验 匹配与招募 数据与证据）。
- 规范：设计规范 v2.1——一种强调色、标题下不写说明、页签 ≤7、数据页 `wide` 1200、四态（加载/空/出错可重试/成功）另加三态（部分结果/模型或数据不适用/结果已过期）。
- 每个数字可下钻；四个数固定出现在人群、对照、试验三页的数字带；来源视觉编码：观察实线实心、文献与重建虚线、模型与合成浅色区间带、假设值带「假设」标签。
- 关闭时整行不出现，页面给一句话（照 `GeoOffPage`）。

## 7. 验收归属（方案 §12）

| 场景 | 主要负责 |
|---|---|
| AC-01、AC-35 T0 全链路 | D（G 写夹具） |
| AC-02、AC-09、AC-27 计数与来源 | B + G |
| AC-03、AC-06、AC-17、AC-26 数据边界 | A + G |
| AC-04、AC-31 可复现 | B |
| AC-05、AC-16、AC-21 版本与过期 | D |
| AC-07、AC-08、AC-30 对照与加权 | B |
| AC-10、AC-11、AC-28、AC-29 仿真精度 | B |
| AC-12 事件时间定义 | B |
| AC-13、AC-34 适用性与降级 | D |
| AC-14、AC-15、AC-36 匹配 | E |
| AC-18 联系授权 | E |
| AC-19、AC-38 作业失败、取消、预算 | D |
| AC-20 报告数字由结果渲染 | D |
| AC-22 出组不开启结局分析 | A + E |
| AC-23 预测登记 | D |
| AC-24 真实 brief | C、D、E 各自的 evals |
| AC-25 证据可溯源 | C |
| AC-32 结局封存 | D（`vcrSeal.mjs`）+ A（快照 `sealed_fields`） |
| AC-33 AI 设定可见 | D + F |
| AC-37 入组预测回测 | B + E |
| N01～N22、C2-01～C2-26 数值用例 | B（G 复核） |

## 8. 汇报格式

做完在最后一条消息里给：改了哪些文件（路径 + 一句话）、跑了哪些测试（命令 + 结果数字）、没做完的和原因、需要主线程改的共享文件（精确到行）、以及你认为方案里写错或做不到的地方（照实说，不要绕过）。

## 9. 主线程在建设过程中做的裁决（P0，2026-09-28）

1. **小格子抑制比方案字面更严**：只隐一个低于门槛的格子能被总数反推，所以按最小优先继续吸收，直到合并桶本身 ≥10 且至少含 2 个格子；吸不满就整表不给。被抑制的格子只保留它是什么，丢掉全部数字。
2. **0 也算低于门槛**：公开的 0 加公开的总数等于一个确切人数。代价是含 0 格子的 2×2 表会整表抑制。
3. **事件数按人数抑制**（推翻 A 包的第一版判断）：三个事件至少是三个人。仿真产出不走这个函数（里面没有人），所以不会误伤。
4. **`grants.grantee` 三种形式**：账号 id、`role:<角色>`、`study:<研究id>`。合作方授权「这个研究上的所有协调员」时不写死人名。
5. **坏的分析表不落库**：抛 `vcr_analysis_table_invalid` 并写一条 `outcome=denied` 的审计；页面要解释原因就读 audit，不加状态列。
6. **`field_mode='allow'` 且 `fields` 为空 = 整源授权**（DDL 默认就是空）。封存列与标识列在此之前已被拒。
7. **合并（`evidence_pool`）在引擎里做**，不改 `项目代码/meta`；`trial_registry_record` 的实现走控制面 C 包，运行时只经网关。
8. **模型与方法库的首版目录由 D 播种**（三个数学参考仿真器 + `VCR_ENGINE_METHODS`），幂等。
