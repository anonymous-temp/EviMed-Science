# EviMed 发布与交付检查表

> **【存档说明 · 2026-09-07】本文件是 2026-07-19 的快照（第 6 条与「上线执行顺序」各自带着
> 2026-09-03 的就地更正，日期写在原处），其中按能力组织的那部分已被重写后的产品形态取代。
> 请按下面的分工读，不要把整份文件当作现状：**
>
> - **已被取代：「专项 Agent 生产交付状态」表。** 它按九个专项入口 + 八个外部专项适配器
>   组织；今天这九项各自是 `OpenScience/capabilities/` 下的一个能力包——
>   `adr-analysis`、`off-label-analysis`、`comprehensive-drug-evaluation`、`drug-selection`、
>   `meta-analysis`、`mendelian-randomization`、`bibliometric-analysis`、
>   `research-topic-selection`、`peer-review`。表中前四行所依赖的五个 Java 服务
>   （`项目代码/` 下的循证药品综合评价、循证药品综合评价 agent、超说明书用药、药品遴选、
>   安全性分析）已于 2026-07-24 冻结并移出仓库：工作区根 `.gitignore` 里以
>   `# Archived Java services (frozen 2026-07-24)` 起头的那段就是那次移出，工作区根
>   `CLAUDE.md` 记着同一件事。新的证据/评价能力一律落在 `OpenScience/` 里，不再回写这五个
>   服务。「已完成的代码门禁」表同理，其中「桌面 tag 构建」一行所依赖的桌面形态已删除。
> - **当前的逐能力状态在 `OpenScience/evals/acceptance-ledger.json`**：`OpenScience/capabilities/`
>   下每个能力包一行，带该能力 `capability.yaml` 里的 `visibility`，记录它最靠前的一次真实
>   交付及其结局。「一个能力包一行」不是靠人盯：`pnpm check:acceptance-ledger`
>   （`OpenScience/evals/capability-audit/verify_acceptance_ledger.py`）校验它与代码树一致，
>   `pnpm test:web` 里也跑一遍。
> - **仍然有效：下面十条「正式发布前的外部阻断项」与「上线执行顺序」。** 十条阻断项一字未改，
>   其中两条要连着本说明读：第 4 条锁的是上述已归档 Java 服务的工具链，只有真要动那棵归档树
>   时才成立；第 10 条的桌面签名以桌面形态为前提，而唯一的前端是 `OpenScience/apps/web`
>   （`OpenScience/AGENTS.md` 的仓库地图：Tauri 壳、它的 Rust 命令层与 `packages/sdk` 已于
>   2026-09-04 删除）。「上线执行顺序」里只改了一处：同样以桌面形态为前提的 `pnpm check:tauri`
>   在 `OpenScience/package.json` 里已经没有这个脚本，留着只会报错，因此在原处写明后删去；
>   其余命令逐条仍在 `OpenScience/package.json` 里。
> - **2026-09-29 增补：文末「虚拟临研：只有部署后才能做的检查」一节。** 它是新写的、不是快照，
>   记的是「虚拟临研」模块发版前必须在部署好的栈上做完的六件事，以及这些结果记在哪里。
> - 架构与部署以 `OpenScience/AGENTS.md`、`OpenScience/docs/WEB_DEPLOYMENT.md` 为准。**当前的
>   未完清单与排期是 `docs/superpowers/plans/2026-10-02-evimed-next-stage-research-workbench.md`
>   的第 11 节（2026-10-03 定稿，该计划的前文是 10 月 2 日的基线与实施记录，不覆盖第 11 节）。**
>   `docs/superpowers/plans/2026-09-07-gap-closure-todo.md` 是 2026-09-07 当天的缺口盘点，
>   只作历史快照读，其中的「仍缺」不再等于现状。

更新日期：2026-07-19

## 当前结论

代码基线可以进入“受控单节点试点”的交付准备阶段，但在下列外部条件完成前，不应宣称
已经可以面向公众正式发布，也不应承诺 9 个专项 Agent 全部可用。现有前端、统一 Harness、
专项 Skill、运行记录、工件溯源、Notebook、知识库、模型网关和安全边界不需要重新设计。

生产 Compose 已启用 `OPEN_SCIENCE_REQUIRE_ALL_SPECIALIST_ADAPTERS=true`。任何一个面向用户
展示的专项适配器缺失时，`/api/ready` 会失败，避免出现“按钮存在、后台没有执行能力”的
假上线。

## 已完成的代码门禁

| 项目 | 状态 | 说明 |
|---|---|---|
| 中文 EviMed 产品界面 | 已完成 | 页面标题、Logo、登录、导航和科研工作流入口已经统一 |
| 统一开放域 Harness | 已完成 | DSH 内核、Skills、MCP、文件、Notebook、Runs、Provenance 共用一套底座 |
| 9 个专项入口 | 已完成 | 药品安全性、超说明书、综合评价、药品遴选、Meta、MR、文献计量、科研选题、论文审稿 |
| 生产适配器配置透传 | 已完成 | 服务端注册的 15 个 `EVIMED_*_URL` 均进入 Compose 与环境模板 |
| 专项完整性门禁 | 已完成 | 生产环境缺少任一必需专项适配器时 readiness 失败 |
| Meta 生产服务 | 已完成 | Meta 镜像已纳入 Compose，并使用文件型模型密钥与工作负载签名 |
| 发布质量门禁 | 已完成 | 桌面 tag 构建必须先通过 lint、Web/Server/E2E、依赖审计、合规审计、构建和 Rust 检查 |
| 源码凭据门禁 | 已完成 | `pnpm audit:source-secrets` 检查主仓库、专项源码和接口文档，不输出密钥内容 |
| 发布身份 | 已完成 | 产品名、Bundle ID、安装包工件和 Release Manifest 均使用 EviMed |

## 专项 Agent 生产交付状态

| 专项 Agent | 代码/Skill | 本地执行 | SaaS 生产要求 |
|---|---|---|---|
| 药品安全性分析 | 已有 | 依赖现有业务服务 | 配置病例查询与信号分析两个 HTTPS 适配器 |
| 超说明书用药分析 | 已有 | 依赖现有业务服务 | 部署并配置超说明书证据适配器 |
| 综合药品评价 | 已有 | 依赖现有业务服务 | 部署并配置综合评价适配器 |
| 药品遴选评价 | 已有 | 依赖现有业务服务 | 部署并配置药品遴选适配器 |
| 自动化 Meta 分析 | 已有 | 已有 | Compose 已内置；上线前完成真实模型与端到端验收 |
| 孟德尔随机化 | 已有 | `evimed_runner.py` | 将 Runner 封装成签名校验的 HTTP 服务并配置 URL |
| 文献计量分析 | 已有 | `evimed_runner.py` | 将 Runner 封装成签名校验的 HTTP 服务并配置 URL |
| 科研选题 | 已有 | `evimed_runner.py` | 将 Runner 封装成签名校验的 HTTP 服务并配置 URL |
| 论文审稿 | 已有 | `evimed_runner.py` | 将 Runner 封装成签名校验的 HTTP 服务并配置 URL |

四个 Python Runner 在桌面/本地模式可直接使用宿主路径，但 Docker SaaS 运行时看不到宿主
源码目录，因此必须部署为 HTTP 服务；不能用本地成功代替生产可用性验收。

## 正式发布前的外部阻断项

这些工作需要域名、账号、基础设施或法律/运营负责人，不能由代码仓库自行完成：

1. **轮换已经出现过的全部凭据。** 源码中的明文已移除，但曾写入旧配置、文档、测试、
   本地运行日志或对话的 DeepSeek、数据库、Redis、Elasticsearch、Kafka、OSS、Tavily 等
   凭据都必须在对应控制台撤销并重建。仅删除文本不能使旧密钥失效。
2. **建立正式版本库与不可变版本。** 将清理后的交付范围纳入受控 Git 仓库，完成代码审查，
   以不可变 commit/tag 构建；禁止把 `.env`、运行数据、日志、语料全文、缓存和本地密钥打包。
3. **部署并探活全部专项服务。** 为上表 8 个外部专项能力配置 HTTPS URL、工作负载签名、
   超时、资源限制和健康检查，并用每个页面的真实任务完成一次端到端 smoke。
4. **锁定旧专项服务的构建工具链。** 现有旧服务不是统一 Java 版本：药品安全、超说明书、
   综合评价和药品遴选按其 POM 使用 JDK 8，综合评价 Agent 使用 JDK 21。药品遴选还需要
   提供私有 `com.evimed:parent:1.0.0` Maven 父 POM/仓库及合法的 Aspose 依赖。必须在固定
   工具链中完成编译、镜像构建和容器 smoke，不能用本机较新 JDK 的失败或成功替代验收。
5. **确定生产域名、TLS 和登录方式。** 配置正式域名；在 OIDC 与本地账号中选定一种，关闭
   开发登录；验证 Cookie、反向代理和跨域设置。
6. **签发 DeepSeek 发布凭据（链路已重建，2026-09-03）。** 签发端现在启动真运行时容器、
   把模型网关指向本进程以便计数、让模型走一次 research MCP 归一化并写一个文件，再从
   `session/*` 事件里读证据；没测到的一律不签，并按名报错。两条运维后果：**必须在部署内部
   运行**（`receipt` compose profile 那个容器，需要运行时控制器套接字与运行时网络），
   以及**必须排在 `release:manifest` 之后**——网关拒绝启动清单没有指名的镜像。
   `--fake` 仍被显式拒绝（`deepseek_release_mode_invalid`），不是被忽略。
7. **生成并验证发布清单。** 构建固定版本 Web/Runtime/Proxy 镜像，生成
   `release-manifest.json`，验证镜像 ID、Skills 摘要、源码 revision 和构建时间。
8. **落实最低限度运维。** 指定告警接收人，配置加密备份、保留周期，并至少做一次恢复演练。
9. **完成最小法律交付物。** 确认第三方 Skills、连接器和数据源许可证；发布隐私政策、服务条款、
   数据删除/导出渠道和科研辅助免责声明。无需引入临床签署流程。
10. **桌面分发时完成签名。** macOS 需要 Developer ID 签名和 notarization；Windows 需要代码
   签名证书。未签名安装包只适合内部测试，不适合公开下载。

## 上线执行顺序

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm ci:web
# 桌面形态删除后 `pnpm check:tauri` 已不存在于 `package.json`，此处不再调用；
# Web 交付的全量门禁就是上面的 `pnpm ci:web`（它内含 test:web 与全部审计）。

# 在目标主机和真实生产 env 上执行。顺序按 2026-09-03 的实测更正了两次：
#   ① 签发凭据要启动运行时容器，而启动计划拒绝清单没有指名的镜像
#      —— 所以 release:manifest 必须先于 preflight:deepseek:release；
#   ② 运行时控制器会核对调用方的 releaseId 与自己是否相同
#      （`runtime_controller_release_mismatch`）—— 所以签发必须在
#      **新栈起来之后**，用新控制器。这两条不是可以调换的偏好：
#      前者由 buildRuntimeLaunchPlan 强制，后者由 controllerHealth 强制。
pnpm release:manifest
pnpm verify:release-manifest
pnpm preflight:host --env-file deploy/web/.env
# 切换软链 + compose up（含 receipt profile）。此时 /api/ready 只会红在回执一项。
pnpm preflight:deepseek:release   # 新控制器就位后才可能成功
pnpm smoke:deployment
```

上线验收必须确认 `/api/health` 与 `/api/ready` 同时成功，并逐一从 9 个专项页面发起任务、
产生真实工件、检查引用/数据/日志/溯源和失败提示。验收后保留 release manifest、测试报告、
恢复演练记录和镜像摘要，作为本次交付证据。

## 虚拟临研：只有部署后才能做的检查（2026-09-29）

「虚拟临研」默认关闭（`OPEN_SCIENCE_VCR_ENABLED=false`，见 `deploy/web/.env.example`）。代码能证明的部分
在 CI 里：三个 `vcr-*` 作业在装好锁定 R 库的机器上跑全部引擎数值用例、引擎服务测试和两个依赖 R 的
集成测试。下面六件事代码证明不了——它们要一个部署好的栈、真实的模型和生产形状的数据。**六件都做完并
记录之前，模块保持关闭，也不把 `OPEN_SCIENCE_VCR_AUDIENCE` 从 `operators` 放开。**

**记在哪里。** 「一个能力包一行」的验收账本 `evals/acceptance-ledger.json` 没有 AC 行，放不下 AC-35，
所以：第 4 项的五次真实运行写进账本里五个 `vcr-*` 能力行的 `realDelivery`（`pnpm check:acceptance-ledger`
校验）；六项的日期、release id 和量出来的数字，追加到本节末尾的「记录」表。没记录的检查等于没做。

1. **新 `.env` 的键到达 web 容器。** 新 release 的 `.env` 是从上一版拷来的，不含新键；web 服务的环境变量
   由 compose 逐项传入，主机上若有私有 override 覆盖了 web 的 `environment`，它的合并表也要带上新键。
   - 只比名字，不回显值：`.env.example` 里「虚拟临研」一段的每个名字（`OPEN_SCIENCE_VCR_*`、
     `EVIMED_VCR_ENGINE_IMAGE`）都在新 release 的 `.env` 里，尤其 `OPEN_SCIENCE_VCR_ENGINE_URL`、
     `OPEN_SCIENCE_VCR_ENGINE_TOKEN_HOST_FILE`、`OPEN_SCIENCE_VCR_ENGINE_RECEIPT_KEY_HOST_FILE`、
     `OPEN_SCIENCE_VCR_DATA_PLANE_HOST_DIR`。
   - 起栈后进容器看名字：`docker exec <web> sh -c 'env | cut -d= -f1 | grep "^OPEN_SCIENCE_VCR_" | sort'`
     必须列出 `ENABLED`、`AUDIENCE`、`ENGINE_URL`、`ENGINE_TOKEN_FILE`、`ENGINE_RECEIPT_KEY_FILE`、
     `DATA_PLANE_DIR`、`MAX_CONCURRENT_JOBS`、`JOB_CPU_SECONDS`、`STUDY_CPU_BUDGET`；两个密钥文件在容器里
     存在且各不少于 32 字节。
   - **通过：** `/api/ready` 的 `vcr` 一项 `status: "ok"`、`engine: "wired"`，`warnings` 里没有
     `vcr_engine_unconfigured`（它的 `engineReason` 会指出是哪个文件）、`vcr_data_plane_not_configured`、
     `vcr_engine_catalogue_mismatch`。回执密钥配了却读不到或不足 32 字节时，这一项是失败的
     （`vcr_engine_receipt_key_unusable`，`details.reason` 是文件的原因）——但引擎照常可用，结果按输出哈希核对，
     只是没有用密钥验回执；口令文件有问题才会让引擎按未配置处理。

2. **引擎镜像构建与锁核对。** 生产主机连不上 Debian、PyPI、CRAN，走镜像：`OPEN_SCIENCE_APT_MIRROR`、
   `OPEN_SCIENCE_PIP_INDEX_URL`、`OPEN_SCIENCE_VCR_CRAN_MIRROR`，且 CRAN 镜像必须是同一个快照日期
   （`OPEN_SCIENCE_VCR_CRAN_SNAPSHOT_DATE`，默认等于 `项目代码/vcr-engine/Dockerfile` 的
   `ARG CRAN_SNAPSHOT_DATE`）——版本来自日期，日期不同就是另一组数字。
   - 构建：`docker compose --profile vcr build evimed-vcr-engine`。构建日志里要有
     `package lock verified: <N> packages`（构建自己的锁核对：缺包、版本不符、多出没列的包都会让构建失败）
     和 `engine <版本> R 4.3.3 with <N> methods`（N 等于 `@evimed/domain` 里 `VCR_ENGINE_METHODS` 的个数，数字不写死在这里；方法注册表与 `@evimed/domain` 的快照一致）。
   - 起来后带令牌请求 `/health`：`ok: true`、`rVersion` 为 4.3.3，`packageLockHash` 的前 12 位等于该 commit
     的 CI `vcr-engine` 作业里数值用例头一行 `vcr-engine … | lock <12 位>`——生产跑的就是 CI 测过的那组包。
   - **通过：** 三条都成立，且该 commit 的 `vcr-r-library`、`vcr-engine`、`vcr-seam` 三个作业是绿的。

3. **数据平面与 `/jobs` 的权限。** 患者级文件在数据平面目录里，绝不能被任何运行时读到；引擎只读它，
   只写自己的 `/jobs`。
   - 主机目录 `OPEN_SCIENCE_VCR_DATA_PLANE_HOST_DIR`：属主是 web 容器的用户、属组 10001、模式 0750；两个密钥
     文件模式 0440、属组 10001。
   - web 容器里在 `/data-plane` 写一个探针文件再读回；引擎容器（uid 10001）能读它、**写不进** `/data-plane`
     （只读绑定），能写 `/jobs`（`docker exec <engine> sh -c 'touch /jobs/.probe && rm /jobs/.probe'`）；
     一次性的 `evimed-vcr-jobs-init` 已成功退出。
   - 任意一个运行时容器的挂载里没有数据平面：`docker inspect <runtime> --format '{{json .Mounts}}'` 不含
     `/data-plane`，也不含它的主机路径。引擎容器只接在 `vcr-engine-internal` 网络上，出不了网。
   - 用一个空的 T0 研究提交一次 `design.analytic` 作业，回执验签通过、作业目录出现在 `/jobs`。
   - 病历文件转换（PDF / Word 在部署内转成文字，不发给外部解析服务）：上传一份可复制文字的 PDF 和一份 `.docx`，
     各得到文字；上传一份扫描件，得到「请提供文字版」的拒绝，数据平面里没有留下东西。**转换的暂存在数据平面里，
     从不写进 `open-science-data`**：暂存目录是 `studies/<研究>/.intake/<尝试>/`（一份只读副本加一个空的输出目录，
     0700，转换后整个目录被删，引擎的位置语法写不出这个路径）。转换进行中在宿主机上看
     `<OPEN_SCIENCE_VCR_DATA_PLANE_HOST_DIR>/studies/*/.intake/`，文件 0400、目录 0700、属主是 web 用户，转换后为空；
     web 与控制器共用的数据卷里（`/data/`）转换前后都没有新增文件。转换跑在运行时控制器起的一次性容器里：
     `docker ps -a --filter label=open-science.vcr-intake` 转换后为空；转换进行中对它 `docker inspect`，`NetworkMode`
     为 `none`、挂载只有两个——只读的单个文件 `/input/document.<pdf|docx>` 和 `/output`，来源都在
     `OPEN_SCIENCE_VCR_DATA_PLANE_HOST_DIR` 之下，不含 `open-science-data` 卷或它的任何子路径；容器用户读得了那份
     0400 的文件、写得了那个 0700 的目录（即与 web 用户同一个 uid，或 `OPEN_SCIENCE_RUNTIME_CONTAINER_USER` 指向它）。
     控制器环境里有这个主机路径（`docker exec <控制器> printenv OPEN_SCIENCE_VCR_DATA_PLANE_HOST_DIR`）；没有它，
     上传 PDF / Word 会得到「本部署暂时不能转换」。镜像里要有 `/opt/evimed/mcp/evimed-research/vcr_record_extract.py`
     与 `vcr_curve_digitize.py`、`source_material_extract.py`、`vcr_import_convert.py`（随研究 MCP 的 Python 源码一起发，增量发布即可），控制器协议版本为 11（第三个操作 `materials`，见下文「知识库资料的表格与页码」；第四个操作 `convert`，见下一条）。曲线数字化
     的暂存是已发表的图、不是患者数据，仍在 `/data/vcr-intake/digitize/`，转换后为空。
   - 标准格式导入（FHIR R4 / OMOP CDM / CDISC ADaM 在部署内转成数据表，同一个一次性容器的第四个操作 `convert`）：数据页上传
     一份 FHIR NDJSON 批量导出（或 `.zip`）、一份 OMOP CDM 的 CSV 表 `.zip`、一份 ADaM 的 `.xpt`，各得到 `fhir_*` / `omop_*` / `adam_*` 数据表、
     一份数据字典和一份「按标准格式生成」的字段映射草稿（每一列带值的来源：源系统记录的是「观察」，导入算出来的是「计算」），导入报告列出读到、
     导入和没导入的部分及原因；传一份不是该标准的文件（例如把 CSV 当 FHIR），得到「这个文件不是你选的那种标准格式」，数据平面里没有留下东西。
     转换进行中对容器 `docker inspect`：`NetworkMode` 为 `none`、挂载只有 `/input/import.<ext>`（只读）和 `/output`，来源都在
     `OPEN_SCIENCE_VCR_DATA_PLANE_HOST_DIR` 之下；控制器环境里有 `OPEN_SCIENCE_VCR_DATA_MAX_BYTES`（与 web 一致，它是单张表的大小上限）。
     CDISC 试点的 `adtte.xpt`（254 例、152 个事件；CDISC 条款不许修改）只能在 CI 里下载做参照核对，不进仓库。
   - 欧盟 CTIS 注册源（试验先例的第三个来源，经 CTIS 公开站点自己的 JSON 接口，`euclinicaltrials.eu/ctis-public-api` 的 `POST /search` 与 `GET /retrieve/<EU CT 号>`；
     接口没有 EMA 的正式文档，形状是 2026-10-04 从线上记录的）：从部署好的 web 容器里 `curl -s -X POST https://euclinicaltrials.eu/ctis-public-api/search -H 'content-type: application/json'
     -d '{"pagination":{"page":1,"size":1},"searchCriteria":{"containAll":"breast cancer"}}'` 得到 `totalRecords` 大于 0；在先例页做一次检索，「注册源覆盖」里「EU CTIS」是「结构化记录 · 上次读取成功」，
     候选里有 EU CT 号的试验；到不了这个站点的部署（出口受限）上同一行是「上次读取失败」，其余注册源的候选照常返回、不会因为它变慢超过一次超时。
     WHO ICTRP 一行写「使用条款禁止商业使用，不接入」，不是「未查询」。
   - **通过：** 上面每条都成立，且探针文件已删。

4. **五个能力的真实 DSH 运行。** `vcr-protocol`、`vcr-evidence`、`vcr-analysis`、`vcr-matching`、`vcr-package`
   各在生产栈上用真实 DSH + DeepSeek 跑一次，走真实路径（绑定到该能力的会话，不是直接调网关），在**一次性
   项目**里、不进任何人的对话。每个能力取 `evals/<能力>/briefs.json` 里的一条真实 brief，并做多轮追问、补充
   数据、换主体、边界与工具失败（停掉引擎，`vcr_simulate` 应当说不可用、对话照常继续）。记下运行 id、调用
   的工具、浪费的调用、代码版本（release id）和实际输出。
   - **通过：** 五个能力各有一次交付、其合约校验器通过；账本里五个 `vcr-*` 行的 `realDelivery` 由
     `not-run` 改成真实结局，`pnpm check:acceptance-ledger` 通过。

5. **AC-35 计时。** 方案 §12：不上传任何数据，从一句话到研究包在 2 小时内完成（示例研究）。在部署好的栈上
   用一个全新的 T0 研究，从第一句话计时到研究包交付，用秒表，不用估计。
   - 记：起止时刻、总用时、七步进度轨每一步的完成、该研究耗掉的 CPU 秒（研究预算那一行）、release id。
   - **通过：** 总用时不超过 2 小时，七步全部完成，中间没有要人接手的失败，也没有上传任何数据。
     超时不算通过：写下每一步的耗时，超时的那一步就是要修的。

6. **生产副本上的迁移。** 模块在控制面启动时建自己的 `evimed_vcr` 模式，所以它第一次见到生产数据库就是发版
   本身。先在副本上演一遍：用备份演练的 `scripts/ops/postgres-backup.py restore-clone` 把最近一份加密备份
   还原成克隆库（名字 `evimed_restore_<时间>_<id>`），然后
   `node scripts/vcr/migrate-check.mjs <克隆库 URL>`（在装好依赖的 `OpenScience/` 检出目录里跑，或 `docker exec` 进 web 容器里跑——镜像带着 `scripts/vcr`）。脚本拒绝任何不是克隆库或测试库的库。
   - 它证明的是迁移只增不改、可重复：模块之外每张表的行数迁移前后不变；迁移在两条连接上各跑一次
     （第二次是第二个 web 副本启动时会做的）都成功；模块声明的表全部存在。
   - 记：`firstRunMs`（生产体量下第一次迁移用了多久）。答案里的 `unvalidatedConstraints` 会列出以 `NOT VALID`
     加的约束（转诊联系需要批准人）：副本上没有违反它的行再对生产 `VALIDATE`，否则先查那些行。
   - **通过：** 答案 `ok: true`、`problems: []`。

### 记录

| 项 | 日期 | release id | 结果（数字） | 谁做的 |
|---|---|---|---|---|
| 1 环境键到达 web 容器 | | | | |
| 2 引擎镜像与锁核对 | | | | |
| 3 数据平面与 `/jobs` 权限 | | | | |
| 4 五个能力真实运行 | | | | |
| 5 AC-35 计时 | | | | |
| 6 生产副本上的迁移 | | | | |

## 知识库资料的表格与页码（2026-10-04）

知识库资料解析后，平台还从解析服务给的 Markdown 里确定性地读出表格（表号、表头、行列地址、图注与脚注、n/N (%) 等封闭格式的数值），
并对 PDF 用**原件字节**在一次性容器里（运行时控制器的 intake 容器，第三个操作 `materials`，无网络、一份只读副本）读出每页文字，
把每张表的每一行对到它所在的页；电子表格（`.xlsx`）在同一个容器里读单元格，CSV 在本进程里按行列读。解析服务不给页、不给区域、不给合并单元格，
这些在记录里就是「未知」，不会被猜出来。每份资料的账本在源记录的 `coverage.materials`：抽取版本、原件 SHA-256、数值的
已定位 / 页码待定 / 页码未知 / 未能提取 / 失败各多少。部署后要做的检查：

1. 容器与配置：控制器环境里 `OPEN_SCIENCE_VCR_INTAKE_*` 与 web 一致；镜像里有 `/opt/evimed/mcp/evimed-research/source_material_extract.py`；
   `OPEN_SCIENCE_SOURCE_MATERIALS_ENABLED` 未设或为 true。运行时控制器的 `/v1/health` 报告协议版本 11。
2. 用一个普通账号向知识库上传一份含临床表格（含 n (%)、脚注）的可复制文字 PDF，等它读完：
   `GET /api/sources/<id>` 的 `payload.coverage.materials` 里 `status` 是 `extracted` 或 `partial`、`pages.status` 是 `mapped`、`extraction` 带解析服务版本、
   `sourceSha256` 与文件 SHA-256 相同；`GET /api/sources/<id>/materials` 列出表与图，`GET /api/sources/<id>/materials/tbl-1` 的每个单元格有 `r`、`c`、
   字符区间 `s`–`e`，每个数值所在行有 `rowPages`；挑 5 个数值，在 PDF 里翻到该页核对（定位到的页必须是它真在的页）。
3. 再上传一份续表（同一张表跨页）、一份扫描件 PDF、一份补充材料 `.xlsx`：续表在账本里是 `continued`（同表头 `ambiguous`，文字写了「续」才是 `stated`），
   扫描件 `pages.status` 是 `no_text_layer`、`origin` 是 `ocr`、数值全是「页码未知」，`.xlsx` 的每个单元格地址是 `Sheet!B7` 这样的真实地址、公式没有缓存值的单元格没有数值。
4. 用一份这样的资料做一次带引文的证据报告：打开报告里的「依据」，被核对通过的引文下一行是「位置：表 2 第 3 行第 2 列 · 页码未知」这样的位置（保存的原文没有分页标记时页码是未知，
   不是错）；找不到的位置写「位置未知」。
5. 停掉控制器（或设 `OPEN_SCIENCE_SOURCE_MATERIALS_ENABLED=false`）再上传一份 PDF：资料照常读完、可检索、可理解，账本里 `pages.reason` 是 `locator_unavailable`，
   数值计入「页码未知」，不是失败，也不影响该资料的任何其他功能。
6. 宿主机上 `docker ps -a --filter label=open-science.vcr-intake` 在读完后为空，`/data/vcr-intake/materials/` 为空。

## 可延期但不阻断首发

- 全量 i18n 框架；当前中文优先即可。
- 列表 `j/k` 导航、分隔条键盘微调、删除撤销等体验增强。
- 多区域主动-主动、自动故障转移等重型容灾；首发先满足加密备份与可恢复。
- 医学、统计、药物警戒三方签署和版本重新验证流程；本产品定位为科研 Agent，不按临床
  签署系统建设。
