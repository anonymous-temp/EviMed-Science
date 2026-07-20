# 药物安全分析 Agent (Drug Safety Analysis / Pharmacovigilance)

EviMed 平台药物警戒专项 agent —「安全性分析」Java 旧服务的 Python 重构。
当前已交付 **P2(骨架 + openFDA 数据层 + 输入归一)、P3(信号统计层)、
P4(LLM 分析链 + 报告生成)、P5(服务接入:REST + 出站 WS + evimed_runner)、
P6(OpenScience 开放域技能路由)**。

核心原则:**所有数字都来自确定性代码路径(openFDA + numpy/pandas),LLM 只做
文字解读与说明书对照,不参与任何计算**;任何失败场景都是显式类型化异常或带日志的
降级,没有 NPE 式裸 `KeyError`、没有静默吞异常、没有内部细节透传。

## 目录结构

```
药物安全分析agent/
├── safety_agent/
│   ├── core/                  # 配置 / 日志 / 异常体系 / 内存+磁盘双级 TTL 缓存
│   ├── openfda/               # openFDA live 数据层(httpx 异步;退避;双级缓存;label 查询)
│   ├── faers/                 # 冻结逐报告快照(同一 drug 对象绑定药名+ROLE_COD)
│   ├── normalize/             # 药品名/ADR 归一(规则优先,LLM 兜底仅留接口)
│   ├── signals/               # 信号统计层(纯 numpy/pandas;ROR/PRR/χ²/IC/EBGM)
│   ├── llm/                   # DeepSeek 异步客户端(flash/pro 双层;JSON 校验+修复重试)
│   ├── evidence/              # FDA label 对照(防编造校验)+ EviMed 指南检索客户端
│   ├── analysis/              # 六步编排管线 + overview 聚合 + interpret + CLI runner
│   ├── report/                # Markdown/CSV 渲染 + docx + pdf(LibreOffice)
│   └── api/                   # 服务接入层(P5)
│       ├── app.py             # FastAPI 路由 + 统一 {code,msg} 异常包装
│       ├── service.py         # ServiceContext:共享客户端/任务执行/轻量信号计算
│       ├── jobs.py            # 内存 job 注册表(阶段→progress 映射)
│       ├── ws_client.py       # 出站 Java WS 客户端(clientType=drug-safety-analysis)
│       └── oss.py             # OSS 报告上传(失败降级 base64)
├── tests/                     # pytest 离线单测 + 冻结 FAERS/论文回归基准
├── samples/                   # 真实管线样例报告(md+csv+docx+pdf)
├── start.py                   # 服务入口(uvicorn + lifespan 内 WS 客户端)
├── evimed_runner.py           # OpenScience specialist_jobs 契约适配器
├── requirements.txt  pytest.ini  conftest.py  .env.example  .gitignore
└── README.md
```

## 环境与运行

```bash
cd 项目代码/药物安全分析agent
~/.local/bin/uv venv --python 3.12 .venv
~/.local/bin/uv pip install --python .venv/bin/python -r requirements.txt
cp .env.example .env          # 填 DEEPSEEK_API_KEY 后启用 LLM;JAVA_WS_URL/TOKEN_URL 控制 WS

.venv/bin/python -m pytest tests/ -q     # 全部测试(无网络)
```

### 启动服务(REST + WS 并存)

```bash
.venv/bin/python start.py                    # 默认 0.0.0.0:6010,自动连 JAVA_WS_URL
.venv/bin/python start.py --no-ws            # 只起 REST
```

### REST 端点

| 端点 | 说明 |
|---|---|
| `GET /health` | `{"status":"ok","service":"drug-safety-analysis"}` |
| `POST /api/v1/adr/analyze` | body `{drug, reactions?, indication?, language?=zh}`。默认 202 `{"jobId"}` 异步;`?wait=true` 同步返回完整结果 JSON |
| `GET /api/v1/adr/jobs/{id}` | `{status: queued/running/succeeded/failed, progress, stage, error, result}`;未知 id → 404 `{code,msg}` |
| `GET /api/v1/adr/jobs/{id}/report` | text/markdown 报告;未完成 → 409 |
| `GET /api/v1/adr/jobs/{id}/report.docx` / `.pdf` | 文件流(产物在 `jobs/<id>/` 下) |
| `GET /api/v1/adr/signals?drug=&reaction=` | 轻量同步信号表 JSON(归一+2×2+指标,无概览/LLM);reaction 可逗号分隔多个 |

错误统一为 `{code, msg}`:400 归一失败 / 404 无数据或未知 job / 409 job 未完成 /
422 参数校验 / 429 openFDA 限流 / 502 openFDA 不可用;不透传堆栈与内部细节。

### 出站 WS 客户端

clientType=`drug-safety-analysis`,协议与其余 Python agent 一致:
`JAVA_TOKEN_URL` 轮询取 token → `websockets.connect(JAVA_WS_URL)`(显式 `proxy=None`
直连,规避 macOS 系统代理需要 python-socks 的问题)→ auth 帧 → 15s 心跳 →
按 parentId 分发会话。用户问题经规则提取药品名/ADR(「的ADR/的不良反应」等后缀剥离;
无后缀的「药的某反应」仅在该反应能确定性命中 MedDRA PT 时才拆分)。**CJK 处理链**:
提取的药名/ADR 词含中文时,经 `llm/fallbacks.py` 的 DeepSeek flash 翻译器
(极短 prompt、输出消毒、拒绝仍为中文的答案)译为英文通用名/MedDRA PT;
药名译文需经 openFDA 计数确认才提升为归一结果(ADR 译文回走确定性归一),
确认不了就保留原文、由管线给出明确"未检索到"——不静默、不猜词。
`finish.data.md` 为 OSS URL(OSS 未配置/失败时降级 base64 data URL)。
`MAX_CONCURRENT_SESSIONS` 控制会话上限。

### evimed_runner(OpenScience specialist_jobs 契约)

```bash
.venv/bin/python evimed_runner.py --request request.json --output-dir <dir>
# request.json: {"drug": 必填, "reactions": 可空数组, "outputLanguage": "zh"|"en"}
# 产物: safety-report.md/.docx/.pdf + signals.csv
# result.json: {"status":"succeeded","drug","reactions","report":"safety-report.md",
#               "signals":"signals.csv","artifacts":[...]};失败 status=failed 且退出码 1
```

EviMed 证据检索默认连接
`https://www.evimed.com/api-evimed/medicine-api/ai-api`。生产和本地均优先通过
`EVIMED_EVIDENCE_SEARCH_KEY_FILE` 注入仅所有者可读的密钥文件；也支持由受管密钥系统
注入 `EVIMED_EVIDENCE_SEARCH_KEY`，但禁止把真实密钥写入源码、示例或版本库。

### 一次性 CLI(不经服务)

```bash
.venv/bin/python -m safety_agent.analysis.runner \
    --drug atorvastatin --reactions myalgia,myopathy,rhabdomyolysis \
    --language zh --outdir samples/atorvastatin
```

### 跑一份完整分析(P4 管线,真实 openFDA + DeepSeek)

```bash
.venv/bin/python -m safety_agent.analysis.runner \
    --drug atorvastatin --reactions myalgia,myopathy,rhabdomyolysis \
    --language zh --outdir samples/atorvastatin
# 产出:report.md + signals.csv + report.docx + report.pdf(有 LibreOffice 时)
```

编程用法:

```python
from safety_agent.analysis.pipeline import AnalysisPipeline

pipeline = AnalysisPipeline(openfda=openfda_client, llm=llm_client,
                            evidence=evidence_client, on_stage=stage_cb)
result = await pipeline.run("atorvastatin", ["肌痛", "myopathy"])
markdown = render_markdown(result)   # 或 export_docx / export_pdf
```

## 当前阶段能力

### P2 数据层
`drug/event.json` search/count/total(药品/PT/日期/性别/年龄/严重性/结局/国别过滤)
+ `drug/label.json` 安全性章节;429/5xx 指数退避;内存+磁盘双级缓存(24h);
404→`NoResults`;非法聚合(如 `count=occurcountry` 未加 `.exact`)识别为查询错误
快速失败而非重试。可复现的报告级统计可配置 `FAERS_SNAPSHOT_PATH`:生产运行使用索引化
SQLite 快照(流式导入时按 case version 去重),JSON 仅用于小型回归夹具。分析在同一
drug 对象上同时匹配规范药名与 `ROLE_COD`;live openFDA
聚合不具备此对象绑定能力,只作为明确标注的报告级近似。

### P3 信号统计
ROR/PRR 及 95%CI、χ²(Yates 可选)、crude IC + BCPNN IC025、GPS
EBGM/EB05(DuMouchel 1999 双伽马混合先验);EBGM 按 `exp(E[log λ])` 计算,
零病例使用原始 n=0 而非 Haldane 伪计数。`fit_mgps_prior` 提供全矩阵边际似然
MLE、多起点优化、拟合数据指纹与 prior ID;未注入 fitted prior 时报告明确标为探索性。
ROR/PRR/IC 的零格仍自动 Haldane-Anscombe 并打标;R/openEBGM oracle 与论文冻结
回归测试均为离线 CI。

### P4 分析链与报告
- **六步管线**:归一 → 病例概览(总量/年度趋势/性别/年龄/结局/国别/合并用药/
  适应症,约 45 路并发 count,缓存后零网络)→ 目标 ADR 集(用户指定 + top10 PT)
  信号计算(共享边际,每 PT 仅 2 路新查询)→ 说明书对照(+可选 EviMed 证据检索)
  → LLM 解读(Pro)→ 组装。配置冻结快照时病例概览、top PT 与四格表全部来自同一
  immutable snapshot;未配置时 live openFDA 结果显式携带 approximate binding。
  阶段回调(供 P5 进度推送)+ 总超时(默认 300s)。
- **降级策略**:无数据→`NoDataError` 业务异常;归一失败→`NormalizationError`(带候选);
  LLM 失败/未配置→降级为"仅统计结果 + 方法学声明"的报告;证据层未配置→报告内注明未启用。
- **说明书对照**:LLM(flash)判定已标注/部分标注/未标注并给原文引用句;**防编造校验**
  ——引用句必须在抓取文本中逐字定位(压扁匹配,容忍大小写/空白/符号差异;可定位到
  任意章节,因 LLM 常引用 SPL 标题),定位失败的引用剔除、无有效引用的阳性判定降级为
  未标注,并在报告中注明剔除数。
- **报告**:Markdown + signals.csv(同源)+ docx(python-docx)+ pdf(本机
  LibreOffice headless,每次独立临时 profile 支持并发;缺失则跳过仅告警)。结构:
  概览→输入归一→病例概览→信号表→重点 ADR 解读→说明书对照→循证证据→局限性声明
  →可追溯查询 URL/冻结快照 provenance 附录。报告输出数据源、同对象绑定语义、
  ROLE_COD、时间窗、统计版本、snapshot/prior ID,不再把 live suspect 查询称为 PS-only。

## openFDA 连通性结论(2026-07-20 实测,macOS arm64,无代理)

- `https://api.fda.gov` **直连可达**,单次 count 查询约 1–1.9s。
- drug/event 检索必须用全限定字段路径(`patient.drug.medicinalproduct`,
  裸 `medicinalproduct:...` 会 404);count 聚合文本字段必须加 `.exact`
  (如 `occurcountry.exact`,否则 openFDA 返回 500+illegal_argument_exception);
  数值编码字段(`patient.patientsex`)的 count term 是整数不是字符串。
- live openFDA 的单次 count 查询仍用于连通性与探索性筛查;由于数组字段无法绑定同一
  drug 对象,历史实测值不再作为 PS-only 或论文级验收结果。论文级结果必须来自冻结
  逐报告快照并携带 snapshot hash。

## 样例报告(samples/,真实管线产出)

- `samples/atorvastatin/report.md`(13 个 PT 信号表、说明书对照三项均已标注并附原文引用)
- `samples/rituximab/report.md`(11 个 PT;pneumonia 信号筛查)
- 每份含:真实 ROR/PRR/χ²/IC/EBGM 数值表、signals.csv、docx、pdf、可追溯查询 URL。

## P5 冒烟结论(2026-07-20 本机实测)

- REST:`/health`、同步/异步分析、报告下载链路均已跑通。历史 metformin 数值来自
  live openFDA 报告级近似,仅证明服务链路可执行,不再作为科学正确性验收值;
  异步 202→jobs 轮询→succeeded(progress=100)→ /report、/report.docx、/report.pdf 均 200;
  未知 job 404、缺参 422 均为 `{code,msg}`。
- WS:token 一次获取成功,auth 帧发出后收到系统消息「认证成功,客户端ID:
  drug-safety-analysis-c8ebd86e」,与 HTTP 并存。(websockets 需显式 `proxy=None`
  绕开 macOS 系统代理对 python-socks 的依赖。)
- runner:metformin 真实跑通,`result.json status=succeeded`,四件产物齐全,退出码 0。

## OpenScience 开放域接入与后续验收

- **P6 已完成**:OpenScience 注册直接管理工具 `evimed_drug_safety_analysis`,通过
  `adr-analysis` Skill 的意图描述在药物不良反应、FAERS 信号与药物警戒场景中触发;
  执行链固定为 capabilities → start → poll,产物为报告、`signals.csv` 与任务证据。
- **P7 待生产凭据后完成**:逐入口(REST×4、runner、WS、开放域)执行真实任务验收与
  缺陷对照销号。代码回归不等同于生产实调用;只有注入真实 EviMed 证据凭据并产生
  新的终态任务回执后,才可声明该证据层和开放域药物安全链在目标环境已生效。
- 已知限制:未配置 fitted GPS prior 时 EBGM/EB05 仅供探索;live openFDA 无法同对象
  绑定目标药与 suspect role;年龄分桶不区分 patientonsetage 单位(近似,报告已声明);
  EviMed 证据检索层需
  配置 `EVIMED_EVIDENCE_SEARCH_KEY_FILE` 或受管 `EVIMED_EVIDENCE_SEARCH_KEY` 才会启用;
  job 存内存,服务重启后历史 job 404(设计如此)。
