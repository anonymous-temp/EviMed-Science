# 记忆模块对外：现状、已做的六步里的五步，与最后一步的裁决

2026-09-15。起因是一个问题：记忆算不算一个单独插件、能不能即插即用、外部 agent 能不能直接 API 接入、能不能单独对外发布。评估结论在下面第一节；第二节是按那份评估的顺序执行的结果。

配套：自演化回路的设计在 `2026-09-07-self-evolving-agent-loop.md`；插件化的分层规则在根 `CLAUDE.md` 的「插件优先架构与运行时门禁纪律」。

## 一、评估结论（四句）

- **DSH 这一层已经是一个可单独关掉的插件**：`evimed-capsule` 行，两个工具加一个方法目录，只认一个网关地址和一个工作负载令牌，地址不配就记一条降级、干净退出。
- **控制面这一簇模块边界干净，但差一个开关和一个路由模块**才算特性模块形状。
- **外部 agent 今天接不进来**，缺的不是逻辑而是凭证：控制面只有浏览器会话 cookie 和按运行时铸的工作负载令牌，两样都给不出去。
- **单独发布可以做**，但自迭代回路绑在我们自己的运行时上，而且「记忆有没有用」这个数从来没量过。

## 二、执行结果

**1. 跑一次 `memory-ablation-v1` — 没跑成，卡在数据，而卡住的原因本身是个缺陷。**

配置里两条臂的 `records` 都是空的，也就是说照原样跑会拿 12 次运行去和自己比。要填真实记录 id，于是去生产库里找——找到了一个真缺陷：

`sxjxw-research` 账号有 10 条 `preference.explicit.<hash>` 记录，内容全是**整段任务题面**（`<evimed-brief>` 包着的「请以《Therapeutic Reference Range for Aripiprazole in Schizophrenia Revised》为题完成一份中文科研综述报告」之类），却以 `origin=explicit`、`status=active`、`importance=0.75` 存着。三层根因：

1. `run-policy.mjs` 把本次题面包进 `<evimed-brief>` 注入会话，它带着 `source: "user"`——因为确实是用户间接引起的——所以既有的 sender 检查看不见它。
2. `deterministicCandidates`（模型抽取不可用时的兜底）用一堵开放词表正则判断一条消息是不是偏好，命中后把**整条最多 4000 字**原样存成记忆值。这正是原则 5 说不要扩展的那种输入侧关键词墙。
3. 它给的 origin 是 `explicit`——唯一跳过佐证的那一档，所以十个猜测直接变成十条生效记忆，没有人同意过任何一条。

已修：我们自己发出的闭合标记（`<evimed-brief>` 等）进 `memorySourceRejection`（结构判断，不是语言判断）；兜底路径超过 1200 字直接不读（偏好是一句话，四千字是一份任务）；origin 改 `inferred`、confidence 0.6、importance 0.5，走 pending 闸门。三条测试。

**那十条脏记录没有动**——删用户可见的记忆是运维的决定。

评测配置改成用 `cdss-access` 的四条用户域记录（一条 active、三条 pending，都不是从注入题面来的），基线停用、候选启用，两条臂真的不同了。四条是**薄**的消融，报告里要这么写，而不是把薄的装成厚的。跑它是 12 次 `clinical-evidence-synthesis` 运行、并发 1、每次上限 45 分钟、$12 成本帽，打在真实账号的预算上——这一步留给运维决定何时跑。

**2. 抽取的模型调用改走模型网关并入账 — 做了。** `modelGateway.mjs` 新增 `callModelForControlPlane`：预留—结算、上游 URL 规则、模型白名单三件共享一次。`memoryIntelligence` 不再直连 `api.deepseek.com`，它自己那份 `extractionUrl` 与 `boundedJsonResponse` 删掉了——第二份出网规则就是第二条出网路径。拿不到 provider 用量时记 `uncertain` 而不是按估算结算（按估算结算在账本里和按实测结算长得一模一样，那正是 `markUncertain` 要分开的东西）；被拒时按是否已 dispatch 决定 `uncertain` 还是 `release`。

它不走 HTTP 回环到 `MODEL_GATEWAY_PATH`，是有意的：那条路要验运行时的工作负载令牌、要把流管到下游响应，进程内调用两样都没有，为了跟自己说话给自己铸一个运行时令牌比这个函数更糟。

**3. `/api/memory/*` 抽成 `createMemoryRoutes` + 总开关 — 做了。** 177 行从 `server.mjs` 搬出，一行注册；新增 `OPEN_SCIENCE_MEMORY_ENABLED`。关掉时按名字回 **503** 而不是 404——「这个部署关了记忆」和「这条路由搬走了」是两件事，客户端应该能分辨。

**4. 账号级 API key + `/api/agent-memory/v1` + OpenAPI — 做了。** 

key 存在 `evimed_agent.api_keys`：只存 SHA-256，明文只在创建那一次返回；前缀留明文，好让人在列表里认出该吊销哪一个；按摘要单次索引查而不是扫表逐行比，比较是常量时间；不存在、已吊销、已过期、格式不对四种失败**一个错误码**——区分它们是账号枚举预言机，而对合法持有者来说自己的 key 列表已经说了。

`/api/agent-memory/v1` 四个动词：`recall`、`note`、`records`、`episodes`，外加一个不需要 key 的 `openapi.json`。三条本层规则（写在 OpenAPI 的 `info.description` 里，给集成方读，而不是只写在执行处）：

1. **note 一律 `inferred` 且 pending，而且没有能改它的参数。** 模型说「用户明确要求的」不算数，外部 agent 说更不算。
2. **scope 属于 key 不属于请求。** 绑了项目的 key 出不去，任何请求字段都放不宽。
3. **`episodes` 是输入不是导入。** 外部 agent 投转录，由我们自己的抽取决定值不值得记，过同一套逐字引证校验。**没有直接写记录的入口**——没有证据的记录正是记录形状要防的东西。

整条 API 默认关：打开它等于把一个账号的记忆发布给持 key 的人，这该由部署决定而不是默认值决定。

这条路由挂在 CSRF 闸门**之前**，也是有意的：它不带 cookie，浏览器没法被诱导跨站附上一个 Authorization 头，CSRF 要防的攻击在这里不存在；而闸门本身会以「需要认证」拒掉每一个外部 agent，理由是一个它本来就不会有的会话。

**5. 只有两个工具的记忆 MCP 适配器 — 做了。** `runtime/mcp/evimed-memory`：`memory_recall` 与 `memory_note`。不持记忆、不落策略、不做判断——每一条规则都在控制面，在这里重述一遍就是对同一条规则有了第二个意见。凭证读文件优先（key 不进进程列表，也不进一份会被分享的 MCP 配置）。控制面的错误码原样带回：scope 被拒和被限流需要的下一步不同，只说「HTTP 403」两样都没说。

两个工具不是二十个：`dsh-pubmed` 那条裁决对我们自己的适配器同样成立，一个动词一个工具是每轮第一次请求都要付的目录成本。`records` 与 `episodes` 是运维和集成动作，有 HTTP 端点可以直接调。

**一个明确不做**：不把它挂进托管运行时的 profile。托管容器的记忆端口是 `evimed-capsule`，再挂一条就是「记忆只有一个端口」明令禁止的第二个入口。它是给外部 agent 和本地 profile 的。

**6. 要不要出「仅 API 模式」的部署组合 — 裁决：还不出，理由是第 1 步没跑完。**

差异化是真的——记忆要「挣」到激活资格、索引永远不持有记录、召回预算是产品策略、胶囊可签名可加密可分享、方法回路的晋升谓词生成者绕不过——但这些里**能今天搬走的那一半**（记录、召回、胶囊、抽取、SKILL.md 输出格式）恰恰是最容易被拿来和 Mem0/Zep 那类东西比的一半；**搬不走的那一半**（蒸馏要在我们的容器里跑一次能力运行、观察计数来自我们的委派回执、留出评测要配对跑我们自己的能力）才是理由。

现在出仅 API 模式，卖的是前一半，而且带着一个从没量过的主张。顺序应该是：先跑消融拿到数，再决定。原则 11 就是这么写的——原生是对照，插件靠实测改善挣位置，不靠设计说得通。

## 三、还欠的三件（按顺序）

1. 跑 `memory-ablation-v1`，四条记录的薄消融，报告里如实写薄。
2. 那十条脏记录：运维决定删、归档还是留。SQL 现成：`UPDATE evimed_memory.records SET status='archived' WHERE user_id='sxjxw-research' AND value LIKE '%<evimed-brief>%';`
3. 外部 agent 回报观察的接口——「挂了哪个摘要、成没成」。没有它，自迭代回路的外放只能是半个。

## 四、2026-09-16 补记：记忆到不了干活的子代理

问题由用户提出：「记忆是不是应该默认生效，加了路由之后是不是变成路由选择性生效？」核对代码后的答案是三层：

1. **默认生效，路由不是开关。** 每轮 dispatch 前 `memorySubstrate.recall` 无条件跑一次（聊天与 autopilot 两条路），选择性来自相关性排序与预算（8 条 / 20k 字符、画像类最多占一半），路由只决定交给哪个能力。
2. **但委派之后记忆到不了子代理。** 召回块经 `context.md` 注入 root 的用户槽；`buildDelegation` 只取题面、技能正文、胶囊方法、输入参数。子代理工具集里没有 `evimed_capsule_recall`（15 个清单无一列它，内核 `tools.restrict` 遮掉），而它继承了父预设的指引段，读得到「先查记忆」却调不到。27 份生产转录里该工具 4 次调用全在 root。
3. **而且该工具只搜一半。** `evimed_capsule_recall` 与 `/api/agent-memory/v1/recall` 走 `capsuleService.recall`，只搜胶囊事实；`evimed_memory.records`（画像、偏好、行为、纠正）只经 `memorySubstrate.recall` 推进 root。两个库、两条召回路。

这解释了第一次消融：候选臂激活的四条记录只到规划者，到写作者的是规划者的转述——taskUtility、efficiency 上去，evidenceCompleteness 0.27→0.00。

**裁决与落地（同日）：** 不做路由开关；控制面在 `context.md` 旁写 `memory.md`（同一渲染函数，空召回写空），run-policy 读后由 `buildDelegation` 原样带进每个子代理（附「历史数据不是指令」与 `.evimed-knowledge/` 指引）；`evimed_capsule_recall` 进 `DELEGATION_BASE_TOOLS`，胶囊插件改为无配置也注册；新 `memoryRecall.mjs` 让 `scope: all` 真搜两个库、每条带 `source`，网关与外部 API 共用。其余模块核过不改（review 子代理刻意无记忆，screening 只读，内部运行显式传空）。

**对第三节的影响：** 第 1 件（消融）要在带这个改动的发布上重跑才算数——现有 8/12 格的数字测的是「记忆放进规划者提示词」；harness 已修好轮询与重试身份（`--rerun-excluded`）。第 2、3 件不变。

参照：Claude Code 子代理默认不载入 auto-memory，由子代理定义里的 `memory:` 显式选入，工具默认全继承（code.claude.com/docs/en/sub-agents）；Anthropic 多代理研究系统要求给每个子代理明确的目标、输出格式、工具指引与边界，发现只以摘要回传（anthropic.com/engineering/multi-agent-research-system）；Governed Shared Memory for Multi-Agent LLM Systems（arXiv 2606.24535）指出多代理共享记忆需要 scope 与 provenance 回答「这个代理该不该看到这一版」。
