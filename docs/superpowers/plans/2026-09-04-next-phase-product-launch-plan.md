# 下阶段任务：把 EviMed Science 做成可对外开放的产品（2026-09-04）

一句话：**内核换钉到 0.1.2-rc.1，DSH 网页作为托管对话面被 EviMed 产品壳包住，入口是 `https://82.156.128.153/` 裸根，任何研究者都能注册登录、在自己的租户里跑出过门禁的交付物。** 工具 license（OpenGWAS、Materials Project 网络等）另立项目，本计划不含。

**用户裁决（2026-09-04，已生效，覆盖本文初稿的 §5 三问）**：① DSH web UI 为主界面，生态里能复用的插件直接集成，尽量吃 DSH 内核与框架的现成能力；② 不再提 OpenScience / OpenCode，历史残留删掉；③ 域名与备案暂缓——先把产品跑起来；④ 裸根 `/` 从 cro-demo 手里收回；⑤ 身份先做**本地注册**，OIDC 等产品跑顺再说。

本计划是执行清单，不是设计文档。设计仍以 `docs/superpowers/specs/2026-08-22-evimed-dsh-plug-harness-design.md`（下称 SPEC）为准；与 SPEC 冲突之处由批次 0 的决策记录 #26 收口。

## 1. 现状核对（2026-09-04 08:30Z，全部为实测事实）

**现网**

- 版本 `evimed-20260904-bf10ff35`，`/api/ready` 18/18，`saasProfile.profile = individual-saas`，`technicalSaas: true`，但两项是**声明未配置**而非达标：`oidc-identity`、`external-recovery`（`OPEN_SCIENCE_SAAS_PROFILE_UNCONFIGURED`）。备份 `mode: local`。
- 身份：`OPEN_SCIENCE_AUTH_MODE=local`，仅一个 bootstrap 账号，无注册入口（`store.createUser` 存在但没有路由）。
- 内核：`0.1.2-alpha.5`。
- 入口：`https://82.156.128.153`，与另外十余个应用共用一台 nginx（`/etc/nginx/sites-enabled/cro-qa` 与 `evimed-science` 两个 server 块，十几个 include 片段）。裸根 `/` 被 `snippets/cro-demo.conf` 的 `location = /` 占用；EviMed 只拿到 `location /` 兜底。证书是 Let's Encrypt 的 IP 证书，6 天一续（`evimed-certbot-renew.timer` 在跑）。`evimed.com` 解析到阿里云（`101.201.39.91` 等），`science.evimed.com` / `app.evimed.com` 无解析。
- 主机：4 核、15 GiB（已用 7.7 GiB）、磁盘 81%。

**前端壳（`apps/desktop`，托管形态）**

- 导航 5 项（新任务 / 知识库 / 科研笔记本 / 能力模板 / 运行记录 + 设置图标），SPEC §23.1 要求十项。
- 会话页是 F0 最小版：`RunStreamSessionPage.tsx` 136 行 + `lib/runStream.ts` 722 行；`/api/me` 给的 `sessionView` 为 `run-stream`。这就是被评价为「交互太差」的那一页——它从未被要求超过 P0 验收所需。
- 附 B 未删：`LiveSessionPage.tsx`、`lib/runtime.ts`、`packages/sdk`、`apps/desktop/src-tauri`、`runtime/harness` 都在；52 个源码文件仍提 OpenCode。
- 项目选择藏在 `components/settings/WebProjectsCard.tsx` 与 `thread/WorkspaceChip.tsx`，没有顶层项目切换器。

**DSH 网页（今日上线的部分）**

- 已按项目代理：`/api/runtime-ui/<projectId>/`，文档 / 资源 / WebSocket 均可用；从中发起的会话已被台账认领、被路由、受门禁约束（`route=adopted:runtime-ui:llm:0.97`）。
- **`ui` surface 没有方法名单**（`runtimeManager.proxy` 的 `surface === "ui"` 分支只放行、不过滤）。DSH 浏览器端能调用的方法（从 `dsh-client-*` 包 lib 中枚举）包括 `settings/update`、`settings/replace`、`credentials/set`、`llm/listProviders`、`llm/discoverModels`、`session/selectModel`、`workspace/create|delete|rename`、`directoryPicker/*`、`agentPresets/select|copy|deletePreset`、`goals/*`。容器 `DSH_HOME=/runtime/dsh-home` 在**可写卷**上（rootfs 只读、CapDrop ALL、无出网），所以登录用户可以从 DSH 页面持久改写自己项目运行时的设置文档与模型选择。控制面自己的调用走 `wire.denied`（`packages/contracts/dsh/wireSplit.mjs` 列了九个禁用命名空间），UI 代理没有套用这份名单。
- DSH 页面自带并会显示：settings（general / models / plugins / plugin-inventory）、workspace、model-selection、directory-picker、permission-presets、agent-preset 面板。托管用户不该看见其中任何一个。
- 镜像 `evimed-runtime` profile 的 bundle 为 `dsh-base + dsh-web-app + @evimed/dsh-socket`，因此 41 个 `dsh-client-*` 包全部在镜像里。

**计量 / 记忆 / 其他轨**

- `packages/domain/src/metering.mjs`（258 行：资源类型、峰谷窗口、参考价目、`priceUsage`、`estimateCost`、`spendingPermission`、告警阈值、保留期）**零引用**；`billingIntegrated: false`。模型网关不写 `usage_events`。
- 记忆现跑 `evimed-memos:0.31.1-evimed`（usememos）；`deps-version.json` 钉的 MemTensor/MemOS 2.0.30 未部署，C0 未开始。
- Autopilot（A 轨）、OpenList（U 轨）无代码。

**DSH 0.1.2-rc.1**

- npm 于 2026-09-03 06:21Z 发布，`latest` / `next` 均指向它；GitHub 发布说明是 0.1.2 线自 0.1.1-rc.2 起的累计说明，不是 rc.1 独有变更。
- 把两版完整闭包（各 224 个 `@deepseek-ai/*` 包，alpha.5 侧用 overrides 精确钉住）逐文件比对：**只有 `dsh-client-ui-sidebar/lib/client.js` 一行版本字符串不同**。rc.1 就是 alpha.5 重新打标。换钉是机械操作，但流程不省：`--dump-config` 两版 diff 仍要跑（预期为空）。

**与 SPEC 的冲突（必须收口）**

SPEC D12、§16 #10、§18.1 结论、ARCH §14、FEPLAN「不把容器里的 DSH 网页开出去」「UI 件不进托管镜像」五处一致写明托管面不用 DSH 网页；用户 2026-09-04 裁决「直接换成 DSH web UI 为主」，并要求产品级入口。两者不能并存，否则 F 轨与镜像规则每一步都在两份真相间摇摆。

## 2. 目标形态（「做完」的定义）

1. 入口是 `https://82.156.128.153/` 裸根。未登录到登录页，登录后到工作台。**URL 里没有项目 id，没有 `/api/`。** 域名与备案后议。
2. 工作台 = EviMed 壳（SPEC §23.1 的导航、顶部项目切换器、运行记录 / 交付物 / 证据 / 账户）+ 对话区 = **DSH 网页嵌入**（托管加固：方法名单、隐藏设置类面板、EviMed 主题与品牌、中文默认）。
3. 任何人可注册登录（先本地注册），每人一个独立租户；**用量计量与日 / 周上限先于开放注册**（SPEC 锁定项 #19「额度先于功能」）。
4. 内核 `0.1.2-rc.1`；附 B 五棵树删除。
5. `individual-saas` 就绪的声明项只剩 `oidc-identity`（本地注册不冒充它），`external-recovery` 真正配上。

## 3. 任务清单（四批，按依赖排序）

### 批次 0 · 决策与收口（0.5 天）

- **T0.1 决策记录 #26 写入 SPEC §16**：托管对话面改为「EviMed 壳 + DSH 网页嵌入 + 托管加固」。同步改写 D12 / #10 / §18.1 结论 / §18.3 改造范围（`LiveSessionPage`、`components/thread/*` 由「重写」改为「删除」，会话层不再自建）/ §18.7 F1–F2 条目 / ARCH §14 / FEPLAN 的两条「明确不做」（其前提「无人加载该页面」已不成立）。理由：用户裁决 + §16 #22 生态优先。ARCH `2026-08-26` 状态节同步。
- **T0.2 三问已决**（见开头裁决）。

### 批次 1 · 内核与安全底座（1–1.5 天，含一次发版）

- **T1.1 换钉 alpha.5 → rc.1**：`deps-version.json`、根 `package.json` 的 9 处 overrides、`seam-manifest.json`、契约测试、`deploy/runtime-dsh/Dockerfile` ARG、`dump-config.baseline.json`、release manifest；两版 `--dump-config` diff；重建 runtime 镜像（腾讯镜像六个 build-arg）；`test:web` 全绿；发版；`PROGRESS.md` 一行。验收：`/api/ready` 的 `runtime.kernelVersion = 0.1.2-rc.1`，托管 e2e 通过。
- **T1.2 UI 代理套用方法名单**：`ui` surface 复用 `wire.denied` 与 `CONTROL_PLANE_BANNED_NAMESPACES`（settings / credentials / workspace / goals / llm / agentTeams / directoryPicker / messageFeedback / sessionReferenceResolver 全命名空间，另加 `agentPresets/select|copy|deletePreset`、`session/selectModel`、`session/openWorkspacePath`）。被禁方法经 UI 代理答 403 并写审计行；WebSocket 隧道内的同名 unary 帧同样过滤（名单在一处，两条路径共用）。测试：每个被禁方法一条；真浏览器回归对话、附件、审批、提问卡不受影响。**这是安全项，先于任何产品化工作上线。**
- **T1.3 隐藏 DSH 页内的设置类面板**：优先在 profile patch 层 `disabled` 对应 client 行（`dsh-client-ui-settings*`、`-workspace`、`-model-selection`、`-directory-picker-*`、`-permission-presets`、`-agent-preset`、`-goal`），零代码；行 id 以 `--dump-config` 输出为准。若禁用行导致页面加载失败，再写一个最小 client 插件只做隐藏。镜像规则改为「client-ui 包只允许显式列出的集合」，测试断言。
- **T1.4 品牌与主题**：`dsh-client-ui-theme` 配色替换为 EviMed 设计令牌（terracotta `#c15f3c`），`brand-official` 行替换为 EviMed 品牌行，locale 默认 `zh-CN`。验收：截图入 `docs/ui-ux-audit/`。

### 批次 2 · 产品壳与入口（3–4 天，含一次发版）

> **T2.1 / T2.2 / T2.3 / T2.4 / T2.5 / T2.6 已完成（2026-09-04）**，见 `STATUS` S480–S486 与 `OpenScience/PROGRESS.md`。两处与初稿不同，都记在这里而不是悄悄照做：
> ① **当前项目仍存在浏览器本地**，没有做 `PUT /api/me/current-project`。URL 里没有项目 id（用户提的正是这一条），服务端持久化只影响换一台设备时落在哪个项目，代价是要同时改 `InMemoryStore` 与 `PostgresStore` 两侧。改为先修真正的故障：`/api/me` 现在会捕获 `project_not_found` 回落到 default 并把真正选中的项目回给浏览器——此前从另一台设备删掉当前项目，这台浏览器就再也打不开账户，重新登录也没用。
> ② **删除范围比初稿大**：`isTauri` / `hasCommandBackend` 两个常量、`lib/tauri.ts` 的 25 个只在桌面下有意义的函数、`lib/runs.ts`（本地 SQLite 运行索引）与 RunsPage 的桌面视图一并删除，因为它们在删掉 Rust 壳之后一律走「不是桌面」那条分支。可达性扫描另外扫出 14 个因此变孤儿的模块。

- **T2.1 入口与路由**：`/` 未登录→`/login`，已登录→`/app`。壳内路由：`/app/chat`（新任务）、`/app/runs`（运行记录）、`/app/files`（知识库）、`/app/notebooks`（科研笔记本）、`/app/capabilities`（能力模板，原 `/agents`）、`/app/account`（账户与额度）、`/app/settings`（设置）。`/agenda`、`/inbox`、`/capsule` 随 A / B / C 轨落地，导航先不显示。项目 = 顶部切换器；**当前项目存服务端**（`/api/me` 返回 `currentProjectId`，`PUT /api/me/current-project` 切换），URL 不带 id。
- **T2.2 对话区嵌入**（批次 1 已落地其主体）：`/app/chat` 内 iframe 指向内核界面**自己的源**（同主机、独立端口）。路径前缀方案已被实测否掉——应用用 `location.origin` 拼绝对路径，`/plugins/…` 与 `/api/<方法>` 在前缀下落回我们自己的 SPA，页面在启动时就死。项目由该源的 cookie 记住（`?project=` 一次性钉入）。切换项目即换 iframe。
- **T2.3 运行面板与门禁可见**：壳在对话区旁展示该会话对应运行的 `status / verification / deliverables / receipt`（数据源已有：认领 + 路由 + `agentRuns` 台账 + `GET /api/runs/:id/events`），交付物下载、修复回环提示、`unchecked` 的原因说明。`RunsPage`（1158 行）保留并接同一数据。
- **T2.4 删除旧会话层与附 B**：`LiveSessionPage.tsx`、`components/thread/*` 中只服务旧页的部分、`lib/runtime.ts`、`packages/sdk`、`apps/desktop/src-tauri`、`runtime/harness`、`SessionRoute` 的双视图开关与 `/api/me.sessionView`；grep 断言 OpenCode 残留只剩评测历史产物（附 B 第三类）。`apps/desktop` 改名 `apps/web` 随此 PR（SPEC §9.8）。
- **T2.5 nginx：收回裸根**：把 `location = /` 从 `/etc/nginx/snippets/cro-demo.conf` 里去掉（那条精确匹配优先于本站的 `location /`），EviMed 拿回 `https://82.156.128.153/`；cro-demo 自身的 `/cro-demo/` 路径不动，只失去裸根。同时为内核界面的源加一个 443 之外的 TLS 端口（`OPEN_SCIENCE_RUNTIME_UI_PUBLIC_ORIGIN`），证书复用现有 IP 证书。域名与备案暂缓，不做。
- **T2.6 「Research session not found」**：壳的 research_session 与 DSH 的 kernel session 是两套概念，旧页面用前者定位后者失败。嵌入后壳不再自己开会话，该路径随 T2.4 删除；`/api/research-sessions` 若无其他消费者一并退役。

### 批次 3 · 多用户与开放（4–6 天，含一次发版）

> **进度（2026-09-04）**：T3.1 本地注册、T3.2 计量与上限、T3.3 每账号项目数上限已完成（`STATUS` S487–S495）。三处与初稿不同：
> ① **注册默认关**，且这一轮不打开——初稿自己写了「额度先于功能」，所以先让计量与上限在生产跑一轮。
> ② 上限没有做 `credit_ledger` 与手工充值。先做的是**度量**：`metering.mjs` 写好一个多月零引用，平台能定价却从不计数，所以第一步是让模型网关成为那个调用方；余额是下一步，而且在有余额之前，拒绝用 `credits_daily_limit_reached` / `credits_weekly_limit_reached` 而不是 `credits_exhausted`——后者的文案承诺充值。
> ③ T3.3 真正缺的不是初稿列的那三条，而是**项目数**：存储配额与运行时上限本来就有，但账号在任一上限处再建一个项目就又有一份。
>
> **T3.4 外部备份缺输入**（S496）：需要一个 S3 兼容桶（地域 + 桶名）、一对访问密钥、端点地址。这三样到位之前 `external-recovery` 只能继续声明未配置——不猜、不假装达标。

- **T3.1 身份：本地注册**（用户裁决：先本地，OIDC 后议）。`POST /api/auth/register`（用户名 + 口令，口令下限沿用当前 6 字节，`hashPassword` 已有，`createUser` 已有，只缺路由与页面），注册即建租户与默认项目；登录页加「注册」；速率限制复用 `authRateLimiter`；开关 `OPEN_SCIENCE_SELF_REGISTRATION_ENABLED`，默认关，本部署开。`saasProfileUnconfigured` 继续声明 `oidc-identity`——本地注册**不是** `individual-saas` 的达标项，声明它就是不假装达标。
- **T3.2 计量与上限（B0 最小集，先于开放注册）**：模型网关按请求写 `usage_events`（用户 / 项目 / 运行 / 峰谷 / tokens）；`credit_ledger` + 手工充值 ops 命令；每用户日 / 周上限，超限 `credits_exhausted` 拒派发并在 UI 直达提示；`/app/account` 显示用量与余额。接入已写好的 `metering.mjs`，不另起价目。对账测试：计量与网关日志误差 0（SPEC §13 B 轨退出标准）。
- **T3.3 每用户配额接到租户**：`MAX_RUNNING_RUNTIMES_PER_USER`、项目数、存储上限；容器资源限制已有。
- **T3.4 外部备份**：对象存储备份 + 恢复演练证据（`backup:object` / `restore:object` / `probe:object` 已有），去掉 `external-recovery` 声明 → `individual-saas` 零声明。
- **T3.5 开放前验收**：`audit:saas-alignment`、`audit:hosted-compliance`、`CI=true pnpm ci:web`、托管 e2e、部署冒烟；一名真实新用户从注册到拿到一份过门禁的交付物的全程录屏留档；主机容量核对（当前并发运行时上限 4，按预期用户数调整或加机器）。

### 批次 4 · 并行或其后（不在本阶段承诺）

- 工具 license 项目（另立）：OpenGWAS 令牌、Materials Project 网络路径、其余连接器凭证。
- C0：MemOS 2.0.30 自托管替换 usememos（deps-version 已钉，未部署）。
- B1：计划卡预估 / 实时计量 / `/inbox` 通知；A 轨依赖 P1 + C1 + B0。
- FEPLAN B 轨「借交互」（任务 DAG、Mermaid 卡片）：嵌入 DSH 后其 plan / workflow-run / trajectory 面已提供大半，重新评估后再排。

## 4. 排期

| 批次 | 窗口 | 发版 |
|---|---|---|
| 0 + 1 | 09-05 ～ 09-06 | 1 次（rc.1 + 加固） |
| 2 | 09-08 ～ 09-11 | 1 次（壳 + 入口） |
| 3 | 09-12 ～ 09-19 | 1 次（OIDC + 计量 + 外部备份） |
| 开放试用 | 09-22 当周 | 域名备案未完成则先以 IP 根路径开放 |

## 5. 已决

域名与备案暂缓；裸根收回；身份先本地注册。三项均已并入上面的任务。

## 6. 明确不做

- 不再为 React 壳重写会话层（SPEC §18.3 / §18.7 的 F1–F2 重写条目作废，改为嵌入）。
- 不新增阻断点（仍是 SPEC §29.3 的六个）；不做审批流；不做团队 / 组织；不做商业计费（先额度）。
- 不碰工具 license。
- 不给托管前端建插槽体系 / 微前端（FEPLAN 路 C 维持不做）。
