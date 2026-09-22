
---

# 7. 集成方案：落在 EviMed 的哪里

![图 6](2026-09-21-medical-frontier-feed-assets/06-integration.png)

**一句话：一个控制面功能模块，加一个页面，加一个只读工具。** 不碰内核，不碰 socket，不新增任何对话关卡。模块关掉，对话、运行、交付一切照旧。

## 7.1 落在哪一层

| 层 | 动什么 | 不动什么 |
|---|---|---|
| 1 浏览器 | 新页面 `/app/frontier`；导航一行；收件箱多认一种来源 | 会话界面、内核界面 |
| 2 控制面 | 新模块 `frontier`：服务、工人、路由、库表、受保护抓取，形状与「主动科研」「知识库」一致；一个开关 `OPEN_SCIENCE_FRONTIER_ENABLED` | 鉴权、项目、运行账本、交付关卡 |
| 3 内部网关 | 新增一条 `/internal/frontier/v1/search`，凭运行令牌访问；对外抓取复用读网页那一套受保护传输 | 不绕过任何现有网关 |
| 4 领域包 | 信源登记表与四套词表（数据文件）；用量用途加 `frontier`；工具名与旁白各加一行 | 交付规则、契约 |
| 5–6 防腐层与 socket | **不动** | —— |
| 7 运行时镜像 | MCP 服务多一个只读工具 `frontier_search` | 预设、技能根 |
| 8 能力包 | `open-domain-answer` 的可选工具加一项；评测集加至少 3 个「最近有什么进展」类问题 | 十八个能力包的交付关卡 |
| 10 外部服务 | Crossref、NCBI、Europe PMC、openFDA 等都是匿名开放接口，无新凭据；第二阶段复用已上线的东京代理，并加北京主机上的无头浏览器与 Wechat2RSS 两个容器 | —— |

为什么不是能力包：能力包是「一次运行产出一份交付物」的单位，前沿动态是常驻的后台管线加一个页面，属于第 2 层功能模块——平台给这类东西规定的形状就是「服务 + 路由 + 租约工人 + 一个开关 + 自己的迁移」。以后要是做「围绕某个专题出一份前沿简报」这样的文件交付，那才是一个新的能力包，数据就从这个模块读。

## 7.2 新增与改动的文件

**新增（控制面 `apps/server/src/`）**

| 文件 | 职责 |
|---|---|
| `frontierPersistence.mjs` | `evimed_frontier` 的全部 DDL 与 `migrateFrontier(database)`；咨询锁、幂等、缺扩展就跳过对应索引 |
| `frontierService.mjs` | 查询（精选、全部、搜索、热点、事件、日报、信源）、个性化排序、收藏与关注、存入知识库的编排 |
| `frontierWorker.mjs` | 租约式工人，与 `AutopilotWorker` 同形：`start / tick / status / close`；三个循环：采集（领到期信源）、处理（领待处理条目）、编排（聚类、热点、日报、清理），队列在模块自己的表里（10.4.4） |
| `frontierFetch.mjs` | 组合 `webReadNetwork` 的钉扎传输、`RobotsPolicy`、`HostPacer`，返回 XML / JSON 原始字节；条件请求（平台读网页通道目前没有，这里新写）；每主机令牌桶；选择出口（直连、无头浏览器；海外那一路由边缘节点执行） |
| `frontierAdapters.mjs` | 九种读法，每种一个纯函数：原始响应 → 归一化条目 |
| `frontierEditor.mjs` | 初筛、打分、数字复核、聚类裁决、日报；所有模型调用走 `callModelForControlPlane`，用途 `frontier` |
| `frontierRoutes.mjs` | `createFrontierRoutes({ store, service, maxJsonBytes })`，浏览器接口 |
| `frontierGateway.mjs` | `createFrontierGatewayHandler(config, runtimeManager, { service })`，运行时工具的内部接口 |
| `edgeProxy.mjs`（平台已有，9 月 22 日上线） | 采集器对出口为 `relay` 的信源经它发请求：HTTPS 走东京代理的 CONNECT 隧道，端到端加密；代理不可用时只是这些信源暂停 |

**新增（其他）**

| 文件 | 职责 |
|---|---|
| `packages/domain/src/frontier-sources.json` | 信源登记表（由本方案的 `sources.json` 裁剪而来） |
| `packages/domain/src/frontierVocabulary.mjs` | 栏目、来源类型、证据类型、专科四套词表，及 PubMed 文献类型到证据类型的映射 |
| `apps/web/src/app/routes/FrontierPage.tsx`、`FrontierEventPage.tsx` | 页面 |
| `apps/web/src/components/frontier/*` | 卡片、与你相关、热点侧栏、日报、信源表、骨架屏 |
| `apps/web/src/lib/frontierClient.ts` | 接口客户端 |
| `runtime/mcp/evimed-research/frontier_search.py` | 只读工具，照 `kb_search.py` 的样子写 |
| `deploy/web/docker-compose.frontier.yml` | 北京主机上的两个容器：Wechat2RSS 与无头浏览器 `frontier-browser`（固定版本的 Chromium，内存封顶 1 GB，不开公网端口，只准访问登记表里的监管站域名） |
| `scripts/ops/seed-frontier-glossary.mjs` | 从药学基础数据生成术语表种子 |
| 对应测试 | `frontier*.test.mjs`、`frontier*.integration.test.mjs`、`FrontierPage.test.tsx`、`test_frontier_search.py` |

**改动（都是一两行的登记）**

| 文件 | 改什么 |
|---|---|
| `apps/server/src/config.mjs` | 配置项（7.4） |
| `apps/server/src/server.mjs` | `createWebApiApp` 里构造与注册；`startRecurringWork` / `pauseRecurringWork` 里加工人；内部网关路径加入分发与 `routeLabel`；`/api/me` 增加 `features.frontier`；就绪检查加 `frontier` 一项 |
| `apps/server/src/runtimeManager.mjs` | 开关打开时向容器注入 `EVIMED_FRONTIER_GATEWAY_URL` |
| `apps/server/src/productPersistence.mjs` | 任务种类加两项（`frontier-daily`、`frontier-rebuild`），各配一个约束迁移块 |
| `scripts/ops/postgres-backup.py` | 对 `item_vectors`、`fetches` 只导结构不导数据（10.4.6） |
| `packages/domain/src/usagePurpose.mjs` | 用途加 `frontier`（约束名随词表变化，迁移自动替换） |
| `apps/server/src/notificationService.mjs`、`imService.mjs` | 通知开关加 `frontier` 一项；日报通知的来源类型用现成的 `digest`，推送时机走现成的简报时间与 `pushNotBefore` 分支，不新增来源类型 |
| `apps/server/src/internalProjects.mjs` | `isInternalProject` 认 `evimed-frontier`，模型花费记在运营账户的这个内部项目下 |
| `apps/server/src/runtimeGatewayEntry.mjs` | `RUNTIME_GATEWAY_NAMES` 与 `publicRuntimeGatewayUrls` 加 `frontier`，AgentBay 上的会话才能用 `frontier_search` |
| `apps/server/src/server.mjs`（维护期） | 模块自己的领取语句也检查维护租约（`maintenanceAllowsClaims`），工人登记进维护期的后台活动清单（`inspectActivity`），维护窗口会等它写完 |
| `scripts/ops/configure-production-state.mjs`、compose `secrets:` | 生成 Wechat2RSS 的服务密码文件 |
| `apps/server/src/sourceService.mjs` | 连接器类型加 `web`（存入知识库用，第二阶段） |
| `apps/web/src/app/router.tsx`、`components/sidebar/Sidebar.tsx`、`app/routes/InboxPage.tsx`、`components/cards/Skeletons.tsx` | 路由、导航一行、收件箱跳转、骨架屏 |
| `packages/domain/src/toolNames.mjs`、`narration.mjs` | 工具名与旁白「查前沿动态：……」 |
| `runtime/mcp/evimed-research/server.py` | 挂载与分发，列入可选工具 |
| `runtime/skills/evimed/open-domain-answer/agent.yaml`、`SKILL.md` | 可选工具加一项，正文加两句用法 |
| `deploy/web/docker-compose.yml` | 环境变量逐项透传 |

## 7.3 接口草案

浏览器接口（登录态，列表带 ETag 与不透明游标）：

```text
GET  /api/frontier/status                      模块状态、最近采集与日报时间、信源健康数
GET  /api/frontier/items?view=selected|all&lane=&specialty=&topic=&window=24h|3d|7d|30d&q=&starred=1&cursor=&limit=
GET  /api/frontier/for-you                     与你相关（条目 + 每条的理由与出处记忆）
GET  /api/frontier/hot                         近 72 小时热点 Top 10
GET  /api/frontier/events/:publicId            事件页
GET  /api/frontier/dailies?limit=              日报索引
GET  /api/frontier/dailies/:date               某天日报
GET  /api/frontier/sources                     信源公开页（登记信息 + 健康状态）
POST /api/frontier/items/:id/star | unstar | hide | unhide | read
POST /api/frontier/follows        DELETE /api/frontier/follows/:id
POST /api/frontier/items/:id/save-to-library   存入当前项目的知识库（第二阶段）
```

运行时工具：

```text
frontier_search(q, lane?, specialty?, window = "30d", mode = "selected", limit = 8)
→ 每条返回：标题、导读、为什么值得看、来源名与来源类型、证据类型、发布时间、收录时间、
  原文链接、DOI / PMID / 注册号、标记（预印本、企业新闻稿、无摘要）、是否精选
```

工具说明只写三句：查什么、什么时候用、**结果是线索不是证据——要引用就用返回的 DOI 或链接去读原文**。参数写清必填与默认、范围与单位；结果写清事实、来源、口径和缺项。这是平台对工具的既定要求。

## 7.4 配置项

| 键 | 默认 | 含义 |
|---|---|---|
| `OPEN_SCIENCE_FRONTIER_ENABLED` | 关（第一阶段验收后改为生产默认开） | 总开关 |
| `OPEN_SCIENCE_FRONTIER_POLL_MS` / `_LEASE_MS` | 5000 / 600000 | 工人轮询与租约 |
| `OPEN_SCIENCE_FRONTIER_FETCH_CONCURRENCY` | 4 | 同时抓取数 |
| `OPEN_SCIENCE_FRONTIER_MODEL` | `deepseek-flash` | 管线里所有模型步骤共用这一个，不设分档 |
| `OPEN_SCIENCE_FRONTIER_DAILY_TIME` / `_TIMEZONE` | `07:30` / `Asia/Shanghai` | 日报定稿时间 |
| `OPEN_SCIENCE_FRONTIER_DAILY_BUDGET_CNY` | 10 | 每日模型预算，超出只采集不打分 |
| `OPEN_SCIENCE_FRONTIER_CONTACT` | 无（必填） | 联系邮箱，写进爬虫标识与 Crossref、NCBI 的礼貌参数 |
| `OPEN_SCIENCE_EDGE_PROXY_*`（平台已有） | 生产已配置 | 前沿动态复用平台的东京代理；出口为 `relay` 的信源经它读，不另设海外开关与密钥 |
| `OPEN_SCIENCE_FRONTIER_PROCESS_CONCURRENCY` | 2 | 同时处理的条目批数 |
| `OPEN_SCIENCE_FRONTIER_OFFPEAK` | 开 | 非紧急条目攒到模型半价时段处理 |

每个键都进 `docker-compose.yml` 的逐项透传清单，并登记到「环境变量真的到了容器」那个测试里——平台在这件事上出过事故：变量存在，但没有任何 compose 文件把它传进去。

## 7.5 与现有模块的接缝

| 现有模块 | 怎么用 | 备注 |
|---|---|---|
| 读网页（`webRead*`） | 订阅源和接口用它的受保护传输；公告与新闻正文用 `webReader.read()`；国内监管站点由自有无头浏览器容器渲染，和平台连 AgentBay 用的是同一个接口（`playwright-core` 的 `connectOverCDP`） | 新增 `OPEN_SCIENCE_FRONTIER_BROWSER_URL`（容器的调试口）；AgentBay 只作后备 |
| 模型网关与用量账本 | `callModelForControlPlane`，关闭思考、JSON 输出、温度 0 | 账本要求真实用户行，所以用一个不可登录的系统账户 |
| 嵌入与重排 | `KbEmbedder.embedDocuments` 做聚类向量；`MemoryRerank.order` 做个性化精排 | 两者未配置时，聚类退回到只按 DOI 与实体，个性化退回到只按标签 |
| 记忆 | `researchMemory.profile` 与胶囊画像，只读 | 记忆关掉则无「与你相关」 |
| 收件箱与飞书 | `NotificationService.create`，`noticeType: notify`，来源类型 `digest`，幂等键 `frontier-daily:<日期>`，分组键按天 | 推送时机沿用用户的简报时间；推到飞书的正文不带个人化理由（飞书绑定可能是群聊） |
| 知识库 | `SourceService.register`：开放获取论文走现成的按 DOI 取 PDF，网页走快照 | 新增 `web` 连接器类型 |
| 主动科研 | 第三阶段：`AutopilotService.create` 由事件生成议程，主题取事件的实体 | 预算与时区用用户已有默认 |
| 对话 | `newRuntimeUiIntent(draft)` 带草稿跳到 `/app/chat` | 不新增输入区 |

## 7.6 必须登记的地方

平台有几处「不登记就等于没上线」的检查，这个模块都要过：`serverComposition.test.mjs` 的周期任务清单（否则工人写了也不会被启动）；`deploymentEnvReachesTheContainer.test.mjs` 的运维开关清单；就绪检查 `frontier`；`audit:saas-alignment` 的模块证据路径；`evimedMcp.test.mjs` 的工具清单与 `vocabulary.test.mjs`；`check:tokens-css` 与前端禁用任意值的 lint；`PROGRESS.md` 每个里程碑一行。

## 7.7 对照开发约束

| 约束 | 这个模块怎么满足 |
|---|---|
| 按能力类别放逻辑 | 去重、文献类型、数字核对、限速、配额在代码；值不值得看、怎么讲清楚在模型 |
| 原生是对照组 | 对话工具上线前后做三组对照（不挂、挂、挂了再关），同一批问题、同一模型配置，多次采样；没有可见提升就不保留 |
| 普通问题零工具作答 | 工具只是可选项，不强制、不设调用顺序 |
| 不设整段回答的放行条件 | 模块不拦截、不改写任何回答 |
| 工程边界留在代码里 | 鉴权、租户、出站地址检查、预算都在代码；一个信源失败只影响它自己 |
| 限制保护资源而非观点 | 每个上限都有配置键和可观测计数：每站限速、并发、每日预算、响应大小 |
| 记忆是一个带出处的端口 | 只读记忆；「与你相关」每条都能指回一条具体记忆；记忆服务不可用时给状态，不装作命中 |
| 失败保留部分结果 | 导读生成失败，标题和原文链接照常给；日报生成失败，列表照常 |
| 新增规则前的五个问题 | 本模块不新增任何对话规则、路由或校验 |
