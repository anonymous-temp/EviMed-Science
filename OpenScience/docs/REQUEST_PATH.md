# 请求全链路与静默失败点

本文只写事实：一个请求从进入到产物落盘经过哪些段、每段的超时/重试/错误码语义是什么、
失败时谁会知道、以及哪些地方失败后**既不写日志、也不改变返回值、也不进账本**。
每条都给出文件与行号（行号对应写作时的 `main`）。不确定的一律标注「未核实」。
本文不含改进建议。

范围：`OpenScience/apps/server/src/`（HTTP 边界与运行时编排）、
`OpenScience/runtime/mcp/evimed-research/`（MCP 工具，只写仓库代码能确认的部分）、
`OpenScience/deploy/web/`（生产配置实际值）。
内核容器内部行为不在范围内。

> **2026-09-02 · 内核更换后的有效性说明。** 本文成稿于 OpenCode 作内核的时期，
> 全部行号对应当时的 `main`。2026-09-01 OpenCode 被整体删除，DSH 成为唯一内核，
> 因此下列部分**已经不再成立，不要照本文实现或排障**：
>
> - **[F] 运行时生命周期**：`startOpenCode` 这个入口不存在了；容器改为 DSH 运行时镜像，
>   控制面经 `dshMux.mjs` 与之通信。
> - **[G] 内核容器边界**：不再是「HTTP 端点逐条代理」。整条线是 `/api/remote.mux`
>   一条 WebSocket 上的多路逻辑流，方法名带斜杠（`session/create`、`session/prompt`、
>   `session/page`、`session/cancel`），事件走同一条 socket 上的 `$events` 流，
>   由控制面自签的 browser-session cookie 鉴权。
> - **浏览器→容器直通**：`/api/opencode/*` 已退役，返回 `410
>   runtime_passthrough_retired`；浏览器改用 `POST /api/runtime/sessions`、
>   `GET /api/runtime/sessions/:id/transcript`、`GET /api/runs/:id/events`。
> - **[J] 运行侧 preflight**：那份 3,039 行的 Python 交付检查已经删除。交付规则现在
>   只有一份实现，放在 `@evimed/domain`，运行侧经 `evimed_submit_deliverable` 抵达，
>   服务端经 `validateClinicalEvidencePackage` 抵达，由
>   `clinicalEvidenceSingleImplementation.test.mjs` 钉住两侧同判。
>
> 第 3 节的静默点清单没有随内核一起重测：其中每一条都指向仍然存在的文件，但引用的
> 行号与部分调用形态已经改变。把它当作「这些位置历史上确实静默失败过」的清单来用，
> 逐条核对现状之后再下结论。

---

## 1. 全链路分段

```
浏览器
  │  HTTPS
  ▼
[A] Caddy 边界           deploy/web/Caddyfile:1-14
  │  reverse_proxy open-science-web:8787；/internal/* 一律 404
  ▼
[B] Node HTTP 边界        server.mjs:1220-1222 createServer → void handle()
  │  ├─ 请求 id / 安全头 / CORS      server.mjs:436-454
  │  ├─ 三条 internal 网关分流(早退)  server.mjs:455-466   ← 在 try 之外
  │  └─ try { 限流 → CSRF → 路由 }    server.mjs:472-1183
  ▼
[C] 认证与项目作用域       store.mjs:138 ensureUser / 211 assertCsrf / 422 selectedProject / 555 requireProject
  │  ctx = {config, store, runtimeManager, commands, user, tenant, project}  server.mjs:429-434
  ▼
[D] 路由（分类器 + 安全网） server.mjs:791-846
  │  1. routeNamedSpecialist   specialistRouting.mjs:145-150   （点名即指令，最高优先）
  │  2. SpecialistClassifier   specialistClassifier.mjs:107-188（LLM 判断，默认开）
  │  3. routeOpenDomainSpecialist specialistRouting.mjs:152-192（正则安全网，只能"补"不能"改"）
  │  4. 都未命中 → open-domain-answer  server.mjs:834-846
  ▼
[E] 运行账本 agentRuns     server.mjs:847-894 → agentRuns.mjs:1572-1626 dispatch
  │  reserveRun(1505) → sendPrompt → markDispatch(1628) → scheduleMonitor(1883)
  │  账本 = <project>/.openscience/runs.jsonl，事件 started/dispatch/progress/finished
  ▼
[F] 运行时生命周期         runtimeManager.mjs
  │  start(3145) → 启动内核容器(3219) → 清理孤儿(3240-3304)
  │              → bootstrap: skills/agents/MCP/model provider(3316-3358)
  │              → spawn 或 RuntimeControllerClient.startRuntime(3388-3401)
  │              → waitUntilReady(3550-3592)
  │  特权 Docker 操作走 unix socket：runtimeControllerClient.mjs:79-165 ↔ runtimeControllerServer.mjs
  ▼
[G] 内核容器（DSH）        （内部行为不在本文范围）
  │  ├─ 服务端→容器：dispatchPrompt(3710) session/prompt
  │  ├─ 服务端→容器：sessionMessages(3616) / sessionStatus(3663)  ← 监控轮询
  │  └─ 浏览器→容器：无直通。`/api/opencode/*` 退役返回 410
  ▼
[H] MCP 工具 evimed-research   runtime/mcp/evimed-research/server.py（stdio JSON-RPC）
  │  public_sources.py / web_search.py / official_pages.py / open_access_fulltext.py
  │  meta_agent.py / specialist_jobs.py / science_connectors.py / drug_assessment.py
  ▼
[I] 外部边界（服务端持钥，运行时永不指定主机）
  │  ├─ modelGateway        modelGateway.mjs:306-427   /internal/model/v1/chat/completions
  │  ├─ publicSourceGateway publicSourceGateway.mjs:641-742 /internal/sources/v1/fetch
  │  ├─ webSearchGateway    webSearchGateway.mjs:192-273 /internal/search/v1/query
  │  └─ 专科适配器           runtimeManager.mjs:2009-2025 EVIMED_*_URL 注入容器
  ▼
[J] 交付门禁               agentRuns.mjs:1756-1824 → requiredSpecialistArtifacts(1015)
  │  → specialistCompletionOutcome(1047-1418)
  │  → @evimed/domain clinicalEvidence.mjs:3981 validateClinicalEvidencePackage / :2274 citationIntegrityIssues
  │    （apps/server/src/clinicalEvidenceQuality.mjs 现在只有 31 行，是转发到 domain 的薄壳）
  │  → 修复回环 agentRuns.mjs:1772-1805（clinical-evidence-synthesis，最多 2 次）
  │  运行侧同一套规则：@evimed/domain（唯一实现），经 evimed_submit_deliverable 抵达
  ▼
[K] 产物取回
     /api/files/preview|download  server.mjs:1134-1143 → sendWorkspaceFile(1595-1640)
     read_artifact / resolve_artifact commands.mjs:509 / 537
     项目导出 tar   server.mjs:975-982 → sendProjectArchive(1300)
```

---

## 2. 逐段语义表

### [A] Caddy 边界

| 项 | 值 | 依据 |
|---|---|---|
| 超时 | 未设置，Caddy 默认 | `Caddyfile:1-14` 无 `transport` 段 |
| 重试 | 无 | 同上 |
| 请求体上限 | 73408512 B | `Caddyfile:3`、`.env.example:270` |
| 错误码 | `/internal/*` → 裸 404 | `Caddyfile:7-8` |
| 谁会知道 | Caddy 访问日志（未核实是否开启），EviMed 侧无记录 | — |

### [B] Node HTTP 边界

| 项 | 值 | 依据 |
|---|---|---|
| 服务器级超时 | **未配置**，用 Node 默认（headersTimeout 60s / requestTimeout 300s） | `server.mjs:1220`、`index.mjs` 均未设 |
| 限流 | IP 600/60s；登录 20/5min；命令 120/60s | `config.mjs:496-509`、`server.mjs:1198-1218` |
| 重试 | 无 | — |
| 错误码 | `HttpError.code`，随 JSON 返回 | `security.mjs:130-140` |
| 谁会知道 | `errors.jsonl`（`server.mjs:1723-1740`）+ Prometheus（`server.mjs:251-316`）+ 调用方 | 仅限走到 `try` 里的路径 |
| **例外** | 三条 `/internal/*` 网关在 `try` 之前 `return`，**不进 errorAudit、不限流、不过 CSRF** | `server.mjs:455-466` |

### [C] 认证与项目作用域

| 项 | 值 | 依据 |
|---|---|---|
| 会话 TTL | 604800000 ms（7 天） | `config.mjs:382`、`.env.example:57` |
| CSRF | 非 GET/HEAD/OPTIONS 必须带 `X-Open-Science-CSRF`；devAuth 模式整体跳过 | `store.mjs:211-234` |
| 项目选择 | `X-Open-Science-Project` → `?projectId` → `"default"` | `store.mjs:422-429` |
| 超时/重试 | 无 | — |
| 错误码 | `unauthorized` 401 / `csrf_required` 403 / `project_not_found` | `store.mjs:222-234`、`:555` |
| 谁会知道 | 登录/登出/OIDC 走 `securityAudit`；其余走 `errorAudit` | `server.mjs:512-567` |

### [D] 路由

| 项 | 值 | 依据 |
|---|---|---|
| 触发条件 | 仅 `boundSession.mode === "open-domain"` | `server.mjs:825` |
| 分类器超时 | `clamp(modelGatewayTimeoutMs, 1000, 120000)` = **120000 ms** | `specialistClassifier.mjs:90` |
| 分类器重试 | 无 | `specialistClassifier.mjs:126` |
| 置信度阈值 | 0.75，低于阈值 → null（开放域） | `config.mjs:668-672`、`specialistClassifier.mjs:175` |
| 错误码 | 无对外错误码；一律 fail-safe 到开放域 | `specialistClassifier.mjs:183-185` |
| 谁会知道 | **stderr 一行**：`specialist classifier produced no verdict: <reason>`；账本记 `effectiveRouteReason` | `specialistClassifier.mjs:101-105`、`agentRuns.mjs:38` |
| 语义 | 正则只能"加"路由不能"改"分类器的判断；点名包名优先于两者 | `server.mjs:812-830` |

### [E] 运行账本 agentRuns

| 项 | 值 | 依据 |
|---|---|---|
| 监控轮询间隔 | 500 ms（常量，非配置） | `server.mjs:72`、`:365` |
| 停滞阈值 | `agentRunMonitorStallMs` 900000 ms → 1800 次「无进展」轮询 | `config.mjs:786-788`、`server.mjs:367-370` |
| 总时限 | `agentRunMonitorTimeoutMs` 4h → 28800 次轮询 | `config.mjs:541-543`、`server.mjs:366` |
| 两者性质 | **均为轮次计数，不是墙钟**；每轮 = 500ms + 1 次账本读 + 最多 3 次**无超时**的运行时 HTTP | `agentRuns.mjs:1889-1912` |
| 重试 | 仅 clinical-evidence-synthesis 的修复回环，最多 2 次 | `agentRuns.mjs:1439`、`:1774-1779` |
| 幂等 | `dispatchId` 去重，重复派发返回既有 run | `agentRuns.mjs:1517-1520`、`:1583-1584` |
| 错误码 | `runtime_monitor_stalled` / `runtime_monitor_timeout` / `runtime_stopped` / `runtime_canceled` / `runtime_tool_error` / `runtime_session_error` / `specialist_*` | `agentRuns.mjs:1904/1917/1715/1696/800/776` |
| 谁会知道 | 账本 `runs.jsonl`（started/dispatch/progress/finished）+ `GET /api/agent-runs` | `agentRuns.mjs:1455-1471` |

### [F] 运行时生命周期

| 项 | 值 | 依据 |
|---|---|---|
| 容器就绪总预算 | `runtimeProxyConnectTimeoutMs`（默认 30000，生产 90000） | `runtimeManager.mjs:3550-3552` |
| 单次就绪探针 | 500 ms | `runtimeManager.mjs:48`、`:3556-3562` |
| 就绪重试 | 每 100 ms 重探，直到总预算耗尽 | `runtimeManager.mjs:3585` |
| 空闲停机 | `runtimeIdleTimeoutMs` 1800000 ms，仅在 `activeProxies === 0` 时启动 | `runtimeManager.mjs:4396-4418` |
| 配额巡检 | 每 30000 ms 一次；连续失败 3 次才停机 | `runtimeManager.mjs:4337-4386`、`:1450` |
| 控制面 | unix socket，请求超时 10000（生产 30000）；spawn 等待固定 5000 | `runtimeControllerClient.mjs:73/115-117`、`runtimeControllerServer.mjs:233-251` |
| 错误码 | `runtime_start_timeout` 504 / `runtime_exited` / `runtime_spawn_failed` / `runtime_cleanup_failed` / bootstrap 透传具体 code | `runtimeManager.mjs:3587/3580/3583/3270/3352-3357` |
| 谁会知道 | `runtime.jsonl` 事件 + `.openscience` 运行时状态文件 + 返回给调用方 | `runtimeManager.mjs:656-667`、`:732-760` |

### [G] 内核容器边界（服务端一侧）

| 调用 | 超时 | 重试 | 错误码 | 谁会知道 |
|---|---|---|---|---|
| `dispatchPrompt` 3710 | `runtimeProxyRequestTimeoutMs` 120000（总时限） | 无 | `runtime_prompt_rejected` / `runtime_prompt_acceptance_unknown` | `runtime.jsonl` proxy 事件 + 账本 dispatchStatus |
| `sessionMessages` 3616 | **无**（`requestRuntime` 不传 signal，172-233 无 socket 超时） | 无 | `runtime_history_unavailable` 502 / `runtime_history_invalid` 502 | 抛出后被 `recordProgress` 吞掉（见 S4） |
| `sessionStatus` 3663 | **无**（同上） | 无 | `runtime_status_unavailable` / `runtime_status_invalid` | 被 `reconcileSession` 吞掉（见 S5） |
| `proxy` 4045 | 连接 30000/90000；非流式请求 120000；**SSE 流式无总时限** | 无 | `runtime_proxy_timeout` 504 / `runtime_unavailable` 502 / `runtime_proxy_forbidden` 403 | `runtime.jsonl` proxy 事件（写入失败被吞，见 S12） |

### [H] MCP 工具（运行时侧）

| 项 | 值 | 依据 |
|---|---|---|
| 公共源读超时 | `EVIMED_PUBLIC_SOURCE_TIMEOUT_SECONDS` 默认 20s，钳制 [1,60] | `public_sources.py:94-96`、`:206` |
| 全文/官方页读超时 | 显式 60s | `open_access_fulltext.py:36`、`official_pages.py:166` |
| OA PDF 读超时 | 60s，钳制 [1,120] | `public_sources.py:210`、`:236` |
| 联网检索读超时 | 60s | `web_search.py:102` |
| 专科作业 | **无任何墙钟限制**：`subprocess.run` 不带 `timeout=` | `specialist_jobs.py:540` |
| 重试 | 文献检索有 EviMed → legacy → PubMed 三级降级 | `public_sources.py:1075-1092` |
| 错误码 | 结构化 `{status:"error", error:{code,...}}`，由 `agentRuns.mjs:412-653` 分为可恢复/终止两类 | `agentRuns.mjs:412`、`:541` |
| 谁会知道 | 工具结果进会话历史 → 交付判定；作业日志写 workspace | `agentRuns.mjs:769-803` |

### [I] 外部边界网关

| 网关 | 超时 | 性质 | 重试 | 错误码 | 谁会知道 |
|---|---|---|---|---|---|
| modelGateway | 300000 ms | **空闲**（每个 chunk 重置） | 无 | `model_gateway_timeout` 504 / `model_gateway_rate_limited` 429 / `model_gateway_upstream_error` 502 / `model_gateway_token_invalid` 401 | 仅调用方；流已开始时**只有一行 stderr** |
| publicSourceGateway | 60000 ms | **总时限**（含 Unpaywall 解析 + 最多 4 个 PDF 候选） | 候选轮询最多 4 个 | `public_source_gateway_timeout` 504 / `public_source_pdf_not_open_access` 404 / `..._url_forbidden` 403 | 仅调用方，服务端无日志 |
| webSearchGateway | 30000 ms | **总时限**（覆盖两次尝试 + 500ms 间隔） | 2 次（共用同一个 AbortController） | `web_search_timeout` 504 / `web_search_unconfigured` 503 / `web_search_rate_limited` 429 | 仅调用方，服务端无日志 |
| 专科适配器 | 未在服务端设超时（URL 注入容器后由 MCP 侧发起） | — | — | `adapter_unavailable` / `adapter_http_error` / `adapter_circuit_open` | 工具结果 |

三者共同点：路径不以 `/api/` 开头 → `routePattern()` 归入 `"/static"`（`server.mjs:195`），
且在 `handle()` 的 `try` 之前返回（`server.mjs:455-466`），不进 `errors.jsonl`。

### [J] 交付门禁

| 项 | 值 | 依据 |
|---|---|---|
| 触发 | 终态为 `succeeded` 且 `run.effectiveAgentId` 非空 | `agentRuns.mjs:1756` |
| 超时 | 无（纯本地文件读 + 计算） | — |
| 重试 | 修复回环 ≤2 次，且仅当 errorCode ∈ `repairableEvidencePackageErrorCodes` **且** `qualityIssues` 非空 | `agentRuns.mjs:399-408`、`:1774-1779` |
| 降级 | `qualityDegradable` → 交付并打 `verification:"unverified"` + `qualityNotices` | `agentRuns.mjs:1806-1814` |
| 错误码 | `specialist_required_output_missing/stale`、`specialist_citation_invalid`、`specialist_citation_integrity_failed`、`specialist_cited_source_unrecorded`、`specialist_evidence_snapshot_*`、`specialist_evidence_traceability/provenance/integrity_failed`、`specialist_delegated_evidence_read`、`specialist_evidence_repair_failed`、`specialist_contract_unavailable` | `agentRuns.mjs:1055-1417` |
| 谁会知道 | 账本 finished 事件的 `errorCode` + `qualityNotices`（≤40 条，每条 ≤300 字符） | `agentRuns.mjs:30-31`、`:117-123` |
| 不变式 | 服务端拒收的，preflight 必须已经拦下；由 `test/clinicalEvidencePreflightAgreement.test.mjs` 钉住 | — |

### [K] 产物取回

| 项 | 值 | 依据 |
|---|---|---|
| 超时 | 无 | `server.mjs:1595-1640` |
| 预览体积上限 | `maxFileBytes` 52428800 B（下载不限） | `server.mjs:1608-1610` |
| 错误码 | `file_not_found` 404 / `not_a_file` 400 / `file_too_large` 413 | `server.mjs:1603-1610` |
| 谁会知道 | `audit.jsonl` 记 `file.download`/`file.preview` **completed**，写在 `writeHead` 之前 | `server.mjs:1622-1626` |
| 归档 | tar 直写，条目上限 10000，字节上限 1073741824 | `server.mjs:1392-1404`、`config.mjs:489-490` |

---

## 3. 静默点清单（本文核心）

判定标准：失败后**不写日志、不改变返回值、不进账本**三者同时成立，或仅剩一条无人消费的 stderr。

| # | 位置 | 触发条件 | 会被误读成什么 |
|---|---|---|---|
| ~~S1~~ **已修** | `server.mjs`（网关分派、`routePattern`、`appendErrorRecord`） | 三条 `/internal/*` 网关的任何失败 | ~~完全不进 `errors.jsonl`；Prometheus 里被标为 route=`/static`~~。三条网关处理器现接受 `onFailure` 回调，各自的 `sendError` 是唯一出口，失败进同一本 `errors.jsonl` 并带真实 route 标签；流已开始后被掐断的记为 `truncated: true`。分派也移进 try，处理器抛出不再是进程级未处理拒绝。测试：`server.test.mjs`「the internal gateways are labelled and ledgered」、`modelGateway.test.mjs`「a gateway failure is reported to the caller's ledger」 |
| ~~S2~~ **已修** | `runtimeManager.mjs`（`withRuntimeDeadline`） | 容器 socket 挂起（不关不答） | ~~监控轮询永久阻塞在 `await`~~。`sessionMessages` / `sessionStatus` 现经 `withRuntimeDeadline` 传 signal，超时以具名失败码结案 |
| ~~S3~~ **已修** | `server.mjs`（`sendWorkspaceFile` 的 `settle`） | 文件流读取中途出错 | `audit` 已写 `completed`（`:1622`）、`200` 与 `Content-Length` 已发出（`:1626`），随后 `res.destroy()`。读者拿到**被截断的报告**，账本与审计都显示成功 |
| S4 | `agentRuns.mjs:1858-1864` | `readSessionHistory` 抛任何异常 | `catch { return false }`，而 `false` 的语义是「本轮无进展」（`:1899-1900`）。运行时 502/连接重置 → 累计 idlePolls → 最终以 `runtime_monitor_stalled` 结案（`:1901-1907`）。**一个还在干活的 run 被判定为「卡死」**，与真正卡死不可区分 |
| S5 | `agentRuns.mjs:1739-1743` | `readSessionStatus` 抛任何异常 | `return run`，运行继续。内核对状态查询持续报错与「会话确实 busy」在账本上完全一样 |
| S6 | `agentRuns.mjs:1746-1751` | `runtimeWorkspaceRoot` 抛异常 | 静默回落到 `project.workspaceDir`。容器返回的绝对路径随后按错误的根做相对化，`artifactCandidates`（`:847-855`）逐条丢弃 → run 成功但 `artifacts: []`，看起来像「这次没写文件」 |
| S7 | `agentRuns.mjs:1765-1769` | `requiredSpecialistArtifacts` 内部任何 throw | 折叠成 `specialist_contract_unavailable`，真实原因丢失；且没有 `qualityIssues`，因此**永远进不了修复回环**（`:1776-1777` 要求 issues 非空）。一个完整的包被判死，原因不可恢复 |
| S8 | `agentRuns.mjs:1800-1802` | 修复提示发送失败 | `catch {}` 后一律记 `specialist_evidence_repair_failed`。「模型拒绝修复」与「运行时已经没了」在账本上同码 |
| S9 | `agentRuns.mjs:859-870` | 产物存在但打不开（EACCES / 符号链接 / 打开时被删） | `catch {}` 后从交付清单里剔除。run 仍成功，只是**产物比实际少**，没有任何一条记录说少了什么 |
| S10 | `agentRuns.mjs:696-702`、`:847-855` | 工具返回的路径不合法 | `catch { /* untrusted tool metadata is omitted */ }` 静默丢弃。证据来源从 provenance map 里消失，后续以 `specialist_evidence_provenance_failed` 的形式**归咎于运行**（`:1322-1334`），而真实原因是这里丢掉了它 |
| ~~S11~~ **已修** | `server.mjs`（`recordLedgerWriteFailure`） | `audit.jsonl` / `security.jsonl` / `errors.jsonl` 写入失败（配额、EACCES、轮转失败） | 三处都是 `.catch(() => {})`。请求照常成功。**审计链唯一无法记录的失败，就是它自己的失败** |
| S12 | `runtimeManager.mjs:656-667`、`:758-760` | `appendRuntimeEvent` / `recordRuntimeState` 写入失败 | 均 `.catch(() => {})`。`/api/logs/runtime` 与 `status()` 报出的是一个从未发生过的运行时状态 |
| S13 | `runtimeManager.mjs:3790-3797` | `onRuntimeStop` → `agentRuns.closeProject` 抛异常 | `.catch(() => {})`。容器已经没了，账本里的 run 却永远停在 `running`，且没人知道关闭失败过 |
| S14 | `runtimeManager.mjs:4136-4138`、`:4160-4164`、`:4226-4228` | 响应途中的配额探测失败 | 注释写明「a quota probe must not break a response already in flight」，异常被吞。目录缺执行位（`drw-r--r--`）导致 `directorySize`（`security.mjs:228-267`）EACCES 时，配额在整条代理路径上**静默失效** |
| ~~S15~~ **已修** | `store.mjs`（`listProjects`） | 项目根目录不可读 | `fs.readdir(root).catch(() => [])` → 返回空列表并补一个 default。用户看到的是「我的项目都被删了」 |
| ~~S16~~ **已修** | `specialist_jobs.py`（`_worker_is_alive`） | 后台 worker 被 SIGKILL / OOM | `status_job` 只读状态文件，**没有 `_worker_is_alive` 等价物**（对照 `meta_agent.py:365-380` 有）。状态永远停在 `running`，工具永远回答「还在跑，请继续轮询」 |
| ~~S17~~ **已修** | `specialist_jobs.py`（写失败留 stderr，且由 S16 的存活检查兜底） | 写失败状态时再次出错 | `except Exception: pass`，随后 `SystemExit(1)`。作业被永久留在 `running`（与 S16 叠加） |
| ~~S18~~ **已修** | `specialist_jobs.py`（`_execution_timeout_seconds`） | 专科 Python 进程挂死 | `subprocess.run` 无 `timeout=`，`start_job` 也无墙钟。唯一的上限是 4 小时的 run monitor，而 S2 可能让它也不生效 |
| ~~S19~~ **已修** | `public_sources.py`（降级链两级都报） | 降级链中 legacy 端点也失败 | `except PublicSourceError: pass`，只把第一层的错误放进 `warnings`。运行看到的是「EviMed 不可用」，看不到「legacy 也不可用」 |
| ~~S20~~ **已修** | `modelGateway.mjs`（`sendError` 的 `onFailure`） | 流已开始后出任何错 | `sendError` 只能 `res.destroy()`；唯一痕迹是 `:407-409` 的一行 stderr，不进 `errors.jsonl`、不进账本、不进指标。**截断的回答与「模型说完了」在下游完全一样** |
| S21 | `memoryIntelligence.mjs:286-294` | 模型抽取失败/超时 | 静默降级为确定性抽取；`extractionError` 只流向 `server.mjs:389-401` 的 `securityAudit(...).catch(() => {})`，而后者本身是 S11。配合 C1，生产环境可能长期处于「记忆抽取全灭」且无症状 |
| ~~S22~~ **已修** | `publicSourceGateway.mjs`、`webSearchGateway.mjs`（两处 `sendError` 的 `onFailure`） | 网关内任何异常 | `catch { sendError(res, error) }`，处理器自身**一行日志都不写**。错误码只回给容器；服务端侧无留痕（与 S1 叠加后是彻底不可观测） |
| ~~S23~~ **已修** | `index.mjs`（关停按实际结果返回码） | 关停时 `app.close()` 抛异常 | `.catch(() => {})` 后 `process.exit(0)`。未落盘的 run、未停的容器、未关的连接池都算「干净退出」，编排层看到的是成功 |

**合计 23 处静默点，已修 12 处（S1、S2、S3、S11、S15、S16、S17、S18、S19、S20、S22、S23），余 11 处。**

已修的四处是同一处结构问题的四个出口：运行时的全部对外流量走三条 `/internal/*` 网关，而这三条在 `handle()` 的 try 之外应答，因此既不进错误账本、也拿不到真实的 route 标签。修法是给每条网关唯一的失败出口 `sendError` 加一个 `onFailure` 回调，由请求侧填账本与指标；流已开始后才失败的那一种（S20）单独记 `truncated`，因为它是**唯一一种下游无法与成功区分**的失败。

S3 与 S11 是同一句话的另外两个位置：S3 的审计在第一个字节离开之前就写了 `completed`，读者拿到截断的报告而账本记录一次成功的交付——现在审计按**实际送出的字节**结算，未跑完的交付记 `failed`；S11 是三本账本各自吞掉自己的写入失败，于是磁盘满或权限丢失时请求照常成功、记录直接消失——现在按账本计数并经 `open_science_ledger_write_failures_total` 暴露，运维面板上非零即表示「这个进程已经不再产出用来查故障的那份记录」。

S16／S17／S18 是专科作业跑起来之后的同一处空洞：`status_job` 完全没有存活检查（`meta_agent` 有），
所以 worker 被 SIGKILL 或 OOM 掉之后，状态文件永远停在 `running`，工具就永远回答「还在跑，请继续轮询」；
写失败状态本身再出错（S17）会把作业永久留在同一个状态。现在补 `_worker_is_alive`（存活／死亡／判不出三态，
**判不出不等于死亡**），确认死亡时再读一次状态文件以避开竞态，然后落一个 `retryable` 的失败态。
另给专科子进程加自己的墙钟（`EVIMED_SPECIALIST_EXECUTION_TIMEOUT_SECONDS`，默认 10800 秒，60–14400 夹逼）——
此前唯一的上限是服务端 4 小时 run monitor，而那个按轮次计数，挂死的子进程能活过平台以为存在的每一条限制。

另外三处各自独立：S15 把不可读的项目根目录当成空目录，再补一个 default——用户看到的是一个崭新的账号，
等于被告知「你的项目都没了」；现在 ENOENT 仍算空，其余一律 `projects_unreadable` 报错。
S19 的降级链两级都失败时只报第一级，运行分不清「EviMed 不可用」和「连 legacy 也不可用」，
而这一区分决定这个缺口值不值得重试；现在两级都写进警告。
S23 关停时 `app.close()` 抛异常照样 `exit(0)`，编排层看到干净退出；现在按实际结果返回码，并留一行 stderr。
同时给账本写入加了收尾：交付审计现在按**实际送出的字节**结算，因此写入会晚于请求本身，
`close()` 必须等这些写完——否则最后发生的那件事正是唯一没被记下来的。

~~补充一条非「静默」但同源的结构问题：三条网关处理器若抛出未被自身捕获的异常，
将成为 `void handle(req, res)` 上的未处理 Promise 拒绝，即进程级崩溃而不是 500。~~
**已修**：三条网关的分派合并进一个 try，抛出记 `gateway_handler_failed` 并按 502 收尾；
若响应头已发出则销毁连接，与网关自身的语义一致。

---

## 4. 超时值一致性

### 4.1 全系统超时/周期一览

| 名称 | 代码默认 | 生产 `.env.example` | 性质 | 依据 |
|---|---|---|---|---|
| `sessionTtlMs` | 604800000 | 604800000 (`:57`) | 总时限 | `config.mjs:382` |
| `oidcTimeoutMs` | 10000 | 10000 (`:91`) | 单次请求 | `config.mjs:451` |
| `oidcFlowTtlMs` | 600000 | 600000 (`:92`) | 总时限 | `config.mjs:452` |
| `databaseConnectionTimeoutMs` | 10000 | 未设 | 建连 | `config.mjs:468-470` |
| `kernelTimeoutMs` | 10000 | 10000 (`:278`) | 总时限 | `config.mjs:478` |
| `commandTimeoutMs` | 120000 | 120000 (`:286`) | 总时限 | `config.mjs:526`、`server.mjs:1277-1297` |
| `runtimeProxyConnectTimeoutMs` | 30000 | **90000** (`:287`) | 连接 **+** 容器就绪总预算（两种语义） | `config.mjs:527-529` |
| `runtimeProxyRequestTimeoutMs` | 120000 | 120000 (`:288`) | 总时限（非流式） | `config.mjs:530-532` |
| `runtimeIdleTimeoutMs` | 1800000 | 1800000 (`:289`) | 空闲 | `config.mjs:533-535` |
| `runtimeQuotaCheckIntervalMs` | 30000 | 30000 (`:290`) | 周期 | `config.mjs:536-538` |
| `agentRunMonitorTimeoutMs` | 14400000 (4h) | **未设** | 轮次计数，非墙钟 | `config.mjs:541-543` |
| `agentRunMonitorStallMs` | 900000 (15min) | **未设** | 轮次计数，非墙钟 | `config.mjs:786-788` |
| `AGENT_RUN_MONITOR_INTERVAL_MS` | 500（硬编码） | 不可配 | 周期 | `server.mjs:72` |
| `runtimeControllerTimeoutMs` | 10000 | **30000** (`:161`) | 单次请求 | `config.mjs:570-572` |
| `runtimeControllerPollMs` | 500 | 500 (`:162`) | 周期 | `config.mjs:573-575` |
| 控制器 spawn 等待 | 5000（硬编码） | 不可配 | 总时限 | `runtimeControllerServer.mjs:233-251` |
| 控制器 `spawnSync` docker 调用 | 5000（硬编码） | 不可配 | 总时限 | `runtimeControllerServer.mjs:98/120/173/208/489/692` |
| 容器就绪单次探针 | 500（硬编码） | 不可配 | 单次请求 | `runtimeManager.mjs:48` |
| `evimedWorkloadTokenTtlSeconds` | 300 | 未设 | TTL；刷新在 ttl/2 = 150s | `config.mjs:648-652`、`runtimeManager.mjs:1745-1754` |
| `publicSourceGatewayTimeoutMs` | 60000 | 60000 (`:212`) | **总时限** | `config.mjs:702-706` |
| `webSearchTimeoutMs` | 30000 | 30000（`docker-compose.yml:249`） | **总时限**，含重试 | `config.mjs:722-724` |
| `modelGatewayTimeoutMs` | 300000 | 300000 (`:214`) | **空闲** | `config.mjs:732-734` |
| 分类器超时 | `clamp(modelGatewayTimeoutMs,1e3,1.2e5)` | 实际 120000 | 总时限 | `specialistClassifier.mjs:90` |
| `memosRequestTimeoutMs` | 8000 | 未设 | 单次请求 | `config.mjs:766-768` |
| `memoryExtractionTimeoutMs` | 120000 | **30000** (`:75`) | 总时限 | `config.mjs:794-796` |
| MCP 公共源读超时 | 20s（`EVIMED_PUBLIC_SOURCE_TIMEOUT_SECONDS`） | 未设 | socket 读 | `public_sources.py:94-96` |
| MCP 全文/官方页读超时 | 60s（硬编码） | 不可配 | socket 读 | `open_access_fulltext.py:36`、`official_pages.py:166` |
| MCP OA PDF 读超时 | 60s（硬编码） | 不可配 | socket 读 | `public_sources.py:210` |
| MCP 联网检索读超时 | 60s（硬编码） | 不可配 | socket 读 | `web_search.py:102` |
| `deepseekReleaseReceiptMaxAgeMs` | 86400000 | 86400000 (`:221`) | 总时限 | `config.mjs:755-759` |
| `backupIntervalSeconds` | 86400 | 86400 (`:129`) | 周期 | `config.mjs:412-414` |
| `backupHealthGraceSeconds` | 1800 | 未设 | 宽限 | `config.mjs:415-417` |
| Node HTTP `headersTimeout` / `requestTimeout` | Node 默认 60000 / 300000 | **代码未设置** | — | `server.mjs:1220` 无配置 |
| Caddy 上游超时 | Caddy 默认 | 未设置 | — | `Caddyfile:9-13` |
| `sessionMessages` / `sessionStatus` | **无** | 不可配 | — | `runtimeManager.mjs:3616/3663`、`requestRuntime:172-233` |
| 专科 Python 作业 | **无** | 不可配 | — | `specialist_jobs.py:540` |

### 4.2 相互矛盾之处

| # | 矛盾 | 事实 |
|---|---|---|
| C1 | **生产 .env 钉死的值，代码注释已声明必然失败** | `config.mjs:794-796` 默认 120000，注释写明「measured request takes 40-46s，旧的 30s 上限中止了每一次」；`deploy/web/.env.example:75` 仍是 `30000`。生效路径 `memoryIntelligence.mjs:254` 取 min(120000, 30000) = 30000 |
| C2 | **一个旋钮两种语义** | `runtimeProxyConnectTimeoutMs` 在 `proxy()`（`runtimeManager.mjs:4101-4104`）是单次连接预算，在 `waitUntilReady()`（`:3550-3552`）是**整个容器从启动到就绪的总预算**。生产 90000 是按后者调的，代码默认 30000 是按前者写的 |
| C3 | **内外层超时完全相等** | `commandTimeoutMs` = 120000（`config.mjs:526`）与 `runtimeProxyRequestTimeoutMs` = 120000（`config.mjs:530`）。一个经代理的命令，内层与外层同时到期，先返回哪个错误码（`command_timeout` / `runtime_proxy_timeout`，都是 504）是竞态 |
| C4 | **内层客户端超时 = 外层服务端总时限** | 服务端 `publicSourceGatewayTimeoutMs` 60000（`publicSourceGateway.mjs:648`）是包含 Unpaywall 解析与最多 4 个 PDF 候选的**总**预算；MCP 客户端读超时同样是 60s（`open_access_fulltext.py:36`、`public_sources.py:210`）。服务端精心构造的 504 `public_source_gateway_timeout` 与客户端 socket 超时同时到达，运行时通常拿到的是泛化的 `public_source_unavailable` |
| C5 | **"重试一次"在超时耗尽时不存在** | `webSearchGateway.mjs:198-245` 两次尝试共用同一个 `AbortController` 与同一个 30s 定时器。第一次尝试若耗尽预算，第二次从不发生；注释声称的「a single retry recovers the common case」只对快速失败成立 |
| C6 | **"15 分钟""4 小时"都不是时间** | `server.mjs:366-370` 把两者除以 500ms 换成轮次；而每轮除 500ms 外还包含一次账本读与最多 3 次**无超时**的运行时 HTTP（`agentRuns.mjs:1889-1912`）。真实墙钟阈值 ≥15min / ≥4h，上界不存在——因为下层调用根本没有超时（S2） |
| C7 | **空闲超时与总超时用同一个数** | `specialistClassifier.mjs:90` 复用 `modelGatewayTimeoutMs`，但后者在 `config.mjs:725-734` 明确定义为**流式空闲**时间，分类器用作**非流式单次总时限**；且 clamp 把生产的 300000 悄悄变成 120000，配置值从未是生效值 |
| C8 | **内外层量的不是同一件事** | 模型网关的 300s 空闲由每个 chunk 重置（`modelGateway.mjs:289`、`:323-331`）；其外层唯一的界是 `agentRunMonitorStallMs`，而后者的"进展"定义是**消息数与工具调用数**（`agentRuns.mjs:1866-1871`），不是字节。一次持续 >15 分钟、不产生新消息也不调工具的推理流：网关一直续命，run monitor 判 `runtime_monitor_stalled` |
| C9 | **模型网关之上没有任何总时限** | 无论单轮跑多久，`/internal/model/v1` 上层无墙钟（Caddy 屏蔽 `/internal/*`，Node 未设 `requestTimeout` 覆盖，`agentRuns` 只数消息）。一个每 4 分钟吐一个 chunk 的模型可以无限期占用连接 |
| C10 | **运维可调的值管不到真正会卡的地方** | `runtimeControllerTimeoutMs` 生产提到 30000，但控制器内部 `waitForSpawn` 与全部 `spawnSync` docker 调用是硬编码 5000（`runtimeControllerServer.mjs:233-251/98/120/173/208/489`）。docker 二进制慢于 5s 时，运维设置多少都无效 |
| C11 | **空闲停机永远等不到** | `runtimeIdleTimeoutMs` 30min 仅在 `activeProxies === 0` 时起算（`runtimeManager.mjs:4396-4418`），而 run monitor 每 ~500ms 调一次 `beginProxy/endProxy`。这在运行期是设计意图；但当 S2 发生时 `endProxy` 永不执行，30 分钟空闲停机对一个已经挂死的容器**结构上不可能触发** |
| C12 | **两个"证据获取"通道的超时相差 2 倍且方向相反** | `publicSourceGatewayTimeoutMs` 60000 > MCP 侧 20s 默认读超时（`public_sources.py:94-96`），即普通公共源调用中**客户端先于服务端放弃**；而全文/PDF 路径客户端是 60s，与服务端持平（C4）。同一个网关，两种内外层次序 |

**合计 12 处矛盾。**

---

## 5. 未核实

- Caddy 是否开启访问日志、以及其上游默认超时的具体数值——`Caddyfile` 未声明，未核实运行镜像的默认值。
- 内核容器内部对 `/internal/model/v1` 的 HTTP 客户端超时——属于容器内部行为，本文不推测。
- `docker-compose.yml` 是否为 `open-science-web` 覆盖 Node 的 `NODE_OPTIONS` 或其他运行时超时——未逐行核实。
- 生产实际部署使用的 `.env` 与仓库内 `.env.example` 是否一致——`.env` 不在仓库中，本文一律以 `.env.example` 为准。
- `errors.jsonl` / `security.jsonl` 的写入失败率——无遥测，无法核实 S11 的实际发生频率。
