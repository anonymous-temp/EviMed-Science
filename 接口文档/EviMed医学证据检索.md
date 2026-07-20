# EviMed 医学证据检索 API

版本：V1.0

## 公共约定

- Base URL：`https://www.evimed.com/api-evimed/medicine-api/ai-api`
- 方法：`POST`
- 请求体：`application/json`
- 鉴权：`Authorization: Bearer <api_key>`
- 成功响应：`{"code":200,"msg":"success","data":{...}}`
- 常见错误：`400` 参数错误、`401` 密钥缺失或无效、`403` 账户不可用、`429` 频率超限、`500` 服务端异常。

API Key 只能由 SaaS 服务端密钥文件或受管密钥服务提供。禁止写入源码、前端、日志、
接口文档或版本库。运行时通过受限服务端网关注入密钥，Agent 只能提交已校验的业务参数。

```bash
export EVIMED_BASE_URL='https://www.evimed.com/api-evimed/medicine-api/ai-api'
export EVIMED_API_KEY='replace-with-your-key'
curl -X POST "${EVIMED_BASE_URL}/review/api/literature" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${EVIMED_API_KEY}" \
  -d '{"query":"阿司匹林 心血管预防","count":10}'
```

无需使用的可选参数应省略，不能传空字符串、空数组或 `0` 占位。`query` 建议不超过
200 个字符；平台网关另外施加长度、数量、枚举、年份和响应体大小上限。

## 接口清单

| 能力 | 路径 | 主要结果 |
|---|---|---|
| 药品说明书 | `/review/api/instruction` | NMPA、FDA、EMA、PMDA 说明书候选记录 |
| 医学文献 | `/review/api/literature` | 文献元数据、摘要、研究类型、来源链接 |
| 临床指南 | `/review/api/guide` | 指南元数据、摘要和正文 |
| 指南文本块 | `/review/api/guide-block` | 与问题最相关的指南片段及精排信息 |
| 临床试验 | `/review/api/clinical-trial` | ChiCTR、ClinicalTrials.gov、Cochrane Central 记录 |
| 专利 | `/review/api/patent` | 全球专利发现记录 |

## 药品说明书

`POST /review/api/instruction`

| 参数 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `query` | string | 是 | 通用名、商品名、英文名或适应症 |
| `count` | integer | 否 | 每个来源默认 10，上限 200 |
| `source` | string[] | 否 | `nmpa`、`fda`、`ema`、`pmda` |

响应 `data` 按 `nmpa`、`fda`、`ema`、`pmda` 分组。通用字段包括
`genericNames`、`englishName`、`tradeNames`、`enterpriseName`、`specifications`、
`indication`、`url`。NMPA 记录还可能包含禁忌、注意事项、不良反应、相互作用、特殊
人群、警示语、药理毒理、医保与支付限制等字段。索引结果不是“当前有效说明书”证明，
用于关键结论前必须回溯相应监管机构的当前正式文件。

## 医学文献

`POST /review/api/literature`

| 参数 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `query` | string | 是 | 自然语言检索词 |
| `count` | integer | 否 | 默认 10，上限 100 |
| `articleTypes` | string[] | 否 | 系统综述、RCT、队列、病例对照等文档规定类型 |
| `startYear` / `endYear` | integer | 否 | 发表年份范围 |
| `hasPdf` | boolean | 否 | 仅筛选有全文标记的记录 |
| `language` | string | 否 | `zh` 或 `en` |
| `minImpactFactor` / `maxImpactFactor` | number | 否 | 影响因子范围 |
| `journalTiers` | string[] | 否 | `北大核心`、`科技核心`、`南大核心` |

响应 `data.total` 和 `data.list[]`；记录可包含 `id`、`title`、`authors`、`abstract`、
`journal`、`year`、`impactFactor`、`studyType`、`language`、`aiSummary`、
`coreJournals` 和按来源组织的 `url`。AI 摘要与索引元数据仅用于发现，不能据此推断
研究设计、证据等级、结局或效应量。

## 临床指南和指南文本块

完整契约见[指南检索](./指南检索.md)。

- `/review/api/guide` 返回指南记录，支持 `count`、年份、`publishers[]` 和 `language`。
- `/review/api/guide-block` 返回问题相关片段，支持单个模糊 `publisher`、年份和语言；
  默认只返回最新版本，不提供历史版本检索。

## 临床试验

`POST /review/api/clinical-trial`

| 参数 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `query` | string | 是 | 检索词 |
| `count` | integer | 否 | 默认 10，上限 100 |
| `registry` | integer | 否 | `0` ChiCTR、`1` ClinicalTrials.gov、`2` Cochrane Central |
| `startYear` / `endYear` | integer | 否 | 注册或发表年份范围 |
| `status` / `phase` | string[] | 否 | 对应注册库的原始枚举 |
| `studyType` | string[] | 否 | 仅 `registry=0` |
| `hasArticles` | integer[] | 否 | 仅 `registry=1`，`[0]` 或 `[1]` |
| `source` | string | 否 | 仅 `registry=2`：`PubMed`、`Embase`、`ICTRP`、`CT.gov`、`CINAHL` |
| `minSampleSize` / `maxSampleSize` | integer | 否 | 样本量范围 |

ChiCTR/ClinicalTrials.gov 记录可包含 `title`、`registrationNo`、`status`、
`registrationDate`、`phase`、`sampleSize`、`studyType`、`conditions`、
`primarySponsor`、`interventions` 和 `url`。Cochrane Central 记录可包含 `year`、
`journal`、`cochraneId`、`source`、`publicationType` 与 `keywords`。注册记录不等于结果
发表，也不能证明疗效或安全性。

## 专利

`POST /review/api/patent`

| 参数 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `query` | string | 是 | 自然语言或技术关键词 |
| `count` | integer | 否 | 默认 10，上限 100 |

响应记录可包含 `id`、`title`、`patentNumber`、`patentType`、`patentAbstract`、
`patentee`、`designer`、`applicationDate`、`announcementDate`、`source`、`claims` 和
`url`。专利记录不是临床证据、监管批准、法律意见或自由实施结论；重大决策需审阅完整
专利族并由合格法律人员判断。

## 平台接入

OpenScience 通过 `evimed_literature_search`、`evimed_guideline_search`、
`evimed_clinical_trial_search`、`evimed_patent_search` 和 `evimed_drug_label_search` 暴露
这些能力。所有调用保留来源、检索时间和证据访问级别；上游不可用时必须显式降级或失败，
不得生成伪证据。
