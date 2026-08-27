# 对外接口文档

> **基础地址（`{host}`）：** `https://www.evimed.com/`

---

## 通用说明

### 请求方式

- 全部为 **POST**
- `Content-Type: application/json`
- 字符编码：**UTF-8**

### 鉴权

所有接口需在 Header 中携带 API 密钥：

```http
Authorization: Bearer {secretKey}
```

### 统一响应结构

**成功：**

```json
{
  "code": 200,
  "msg": "success",
  "data": {}
}
```

**失败：**

```json
{
  "code": 401,
  "msg": "当前api_key不存在"
}
```

**响应 code 说明：**

| code | 含义 |
|------|------|
| 200 | 成功 |
| 400 | 参数错误 |
| 401 | 密钥不存在或未传 |
| 403 | 余额不足 |
| 429 | 请求频率过高 |
| 500 | 服务端异常 |

---

## 接口一：文献 / 指南检索

### 接口信息

| 项目 | 内容 |
|------|------|
| 请求地址 | `POST {host}api-evimed/medicine-api/ai-api/review/api/v2/literature-guide` |
| 功能 | 按 `type` 检索文献或指南 |

### 请求参数

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| query | string | 是 | — | 检索关键词 |
| type | string | 否 | `literature` | `literature`（文献）/ `guide`（指南） |
| useLlm | boolean | 否 | `false` | `true`：模型分词；`false`：分词器分词 |
| searchBlock | boolean | 否 | `false` | 仅指南侧有效；`true` 时额外返回指南文本块 |
| count | int | 否 | `10` | 返回条数，上限 100 |
| startYear | int | 否 | — | 发表/发布年份起 |
| endYear | int | 否 | — | 发表/发布年份止 |
| articleTypes | string[] | 否 | — | 文献研究类型过滤，见下表 |
| hasPdf | boolean | 否 | — | 是否仅返回有全文的文献 |
| language | string | 否 | — | 文献语言：`zh` / `en` |
| minImpactFactor | number | 否 | — | 文献最小影响因子 |
| maxImpactFactor | number | 否 | — | 文献最大影响因子 |
| journalTiers | string[] | 否 | — | 期刊等级：`北大核心`、`科技核心`、`南大核心` 等 |
| publishers | string[] | 否 | — | 指南制定者过滤，如 `NCCN`、`CSCO` |

**articleTypes 可选值：**

`系统综述/Meta分析`、`传统综述`、`随机对照试验`、`队列研究`、`病例对照研究`、`横断面研究`、`病例系列`、`病例报告`、`专家意见和评价`、`动物实验`、`体外实验`、`指南/共识`、`经济学评价`、`其他`、`临床试验`

### 请求示例

**文献检索（默认）：**

```json
{
  "query": "司美格鲁肽 肥胖 2型糖尿病",
  "count": 10,
  "startYear": 2020,
  "endYear": 2025,
  "articleTypes": ["随机对照试验", "系统综述/Meta分析"],
  "language": "zh"
}
```

**指南检索（含文本块）：**

```json
{
  "query": "2型糖尿病 二甲双胍",
  "type": "guide",
  "useLlm": false,
  "searchBlock": true,
  "count": 5,
  "publishers": ["中华医学会"]
}
```

### 响应参数

**顶层 `data`：**

| 字段 | 类型 | 说明 |
|------|------|------|
| literature | object | `type=literature` 时返回 |
| guide | object | `type=guide` 时返回 |

**`data.literature`：**

| 字段 | 类型 | 说明 |
|------|------|------|
| total | long | 命中总数 |
| list | array | 文献列表 |

**`data.literature.list` 单项字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 文献 ID |
| title | string | 标题 |
| authors | string[] | 作者 |
| abstract | string | 摘要 |
| journal | string | 期刊 |
| year | string | 发表年份 |
| impactFactor | number/null | 影响因子 |
| language | string | 语言 |
| aiSummary | string | AI 摘要 |
| studyType | string[] | 研究类型 |
| coreJournals | string[] | 核心期刊标签 |
| url | object | 外链，key 为来源名（如 Pubmed、CNKI） |

**`data.guide`：**

| 字段 | 类型 | 说明 |
|------|------|------|
| total | long | 命中总数 |
| list | array | 指南列表 |
| blocks | array | `searchBlock=true` 时返回文本块；否则为空数组 |

**`data.guide.list` 单项字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 指南 ID |
| title | string | 标题 |
| year | string | 年份 |
| publisher | string | 制定者 |
| summary | string | 内容摘要 |
| publicationDate | string | 发布日期 |
| fullText | string | 全文文本（如有） |
| url | string | 详情页链接 |

**`data.guide.blocks` 单项字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| guideId | string | 所属指南 ID |
| text | string | 文本块内容 |
| language | string | 语言 |
| title | string | 指南标题 |
| year | string | 年份 |
| publisher | string | 制定者 |

### 响应示例

**type=literature：**

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "literature": {
      "total": 128,
      "list": [
        {
          "id": "64f1a2b3c4d5e6f7a8b9c0d1",
          "title": "司美格鲁肽在肥胖患者中的疗效与安全性",
          "authors": ["张三", "李四"],
          "abstract": "本研究旨在评估……",
          "journal": "中华内分泌代谢杂志",
          "year": "2024",
          "impactFactor": 3.52,
          "language": "zh",
          "aiSummary": "司美格鲁肽可显著降低体重……",
          "studyType": ["随机对照试验"],
          "coreJournals": ["北大核心"],
          "url": {
            "CNKI": "https://example.com/cnki/xxx",
            "Pubmed": "https://pubmed.ncbi.nlm.nih.gov/xxx"
          }
        }
      ]
    }
  }
}
```

**type=guide：**

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "guide": {
      "total": 12,
      "list": [
        {
          "id": "guide_001",
          "title": "中国2型糖尿病防治指南（2024版）",
          "year": "2024",
          "publisher": "中华医学会糖尿病学分会",
          "summary": "本指南对2型糖尿病诊疗提出推荐……",
          "publicationDate": "2024-03-01",
          "fullText": "",
          "url": "https://example.com/guide/guide_001"
        }
      ],
      "blocks": []
    }
  }
}
```

### curl 示例

```bash
curl -X POST '{host}api-evimed/medicine-api/ai-api/review/api/v2/literature-guide' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer sk-your-secret-key' \
  -d '{
    "query": "司美格鲁肽 肥胖",
    "type": "literature",
    "useLlm": false,
    "count": 5
  }'
```

---

## 接口二：说明书检索

### 接口信息

| 项目 | 内容 |
|------|------|
| 请求地址 | `POST {host}api-evimed/medicine-api/ai-api/review/api/v2/instruction` |
| 功能 | 检索药品说明书，默认范围 NMPA + FDA |

### 请求参数

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| query | string | 是 | — | 检索关键词（药品名等） |
| useLlm | boolean | 否 | `false` | `true`：模型分词；`false`：分词器分词 |
| count | int | 否 | `20` | 返回条数，上限 200 |
| source | string[] | 否 | `["nmpa","fda"]` | 数据来源：`nmpa`、`fda`、`ema`、`pmda` |

### 请求示例

```json
{
  "query": "司美格鲁肽注射液",
  "useLlm": false,
  "count": 10,
  "source": ["nmpa", "fda"]
}
```

### 响应参数

**`data` 按来源分组：**

| 字段 | 类型 | 说明 |
|------|------|------|
| nmpa | array | 国家药监局说明书 |
| fda | array | FDA 说明书 |
| ema | array | EMA 说明书（未查询时为空数组） |
| pmda | array | PMDA 说明书（未查询时为空数组） |

**单项字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| genericNames | string | 通用名 |
| englishName | string | 英文名 |
| enterpriseName | string | 生产企业 |
| tradeNames | string | 商品名 |
| specifications | string | 规格 |
| indication | string | 适应症 |
| url | string | 详情页链接 |
| source | string | 来源：`nmpa` / `fda` / `ema` / `pmda` |

### 响应示例

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "nmpa": [
      {
        "genericNames": "司美格鲁肽注射液",
        "englishName": "Semaglutide Injection",
        "enterpriseName": "诺和诺德（中国）制药有限公司",
        "tradeNames": "诺和泰",
        "specifications": "1.34mg/ml，3ml",
        "indication": "用于2型糖尿病患者的血糖控制……",
        "url": "https://example.com/instruction?source=nmpa&name=xxx.pdf",
        "source": "nmpa"
      }
    ],
    "fda": [
      {
        "genericNames": "OZEMPIC",
        "englishName": "semaglutide",
        "enterpriseName": "Novo Nordisk",
        "tradeNames": "OZEMPIC",
        "specifications": "2 mg/1.5 mL",
        "indication": "Improve glycemic control in adults with type 2 diabetes……",
        "url": "https://example.com/instruction?source=fda&name=xxx.pdf",
        "source": "fda"
      }
    ],
    "ema": [],
    "pmda": []
  }
}
```

### curl 示例

```bash
curl -X POST '{host}api-evimed/medicine-api/ai-api/review/api/v2/instruction' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer sk-your-secret-key' \
  -d '{
    "query": "司美格鲁肽",
    "source": ["nmpa", "fda"]
  }'
```

---

## 接口三：临床试验检索

### 接口信息

| 项目 | 内容 |
|------|------|
| 请求地址 | `POST {host}api-evimed/medicine-api/ai-api/review/api/v2/clinical-trial` |
| 功能 | 检索临床试验数据 |

### 请求参数

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| query | string | 是 | — | 检索关键词 |
| count | int | 否 | `10` | 返回条数，上限 100 |
| registry | int | 否 | `0` | `0` ChiCTR；`1` ClinicalTrials.gov；`2` Cochrane Central |
| startYear | int | 否 | — | 注册/发表年份起 |
| endYear | int | 否 | — | 注册/发表年份止 |
| status | string[] | 否 | — | 招募状态 |
| phase | string[] | 否 | — | 试验阶段 |
| studyType | string[] | 否 | — | 研究类型（仅 `registry=0`） |
| hasArticles | int[] | 否 | — | 关联文献（仅 `registry=1`）：`0` 无 / `1` 有 |
| minSampleSize | long | 否 | — | 最小样本量 |
| maxSampleSize | long | 否 | — | 最大样本量 |
| source | string | 否 | — | Central 数据来源（`registry=2`）：PubMed、Embase、ICTRP 等 |

**phase 中文示例：** `I期临床试验`、`II期临床试验`、`III期临床试验`、`IV期临床试验`、`其他/N/A`

**phase 英文示例：** `Phase 1`、`Phase 2`、`Phase 3`、`Phase 4`、`Not Applicable`

### 请求示例

**中文临床试验（ChiCTR，registry=0）：**

```json
{
  "query": "司美格鲁肽 肥胖",
  "registry": 0,
  "count": 10,
  "startYear": 2020,
  "endYear": 2025,
  "phase": ["III期临床试验"],
  "studyType": ["干预性研究"]
}
```

**英文临床试验（ClinicalTrials.gov，registry=1）：**

```json
{
  "query": "semaglutide obesity",
  "registry": 1,
  "count": 10,
  "status": ["Recruiting/招募中"],
  "phase": ["Phase 3/3期临床试验"],
  "hasArticles": [1]
}
```

**Cochrane Central（registry=2）：**

```json
{
  "query": "GLP-1 receptor agonist weight loss",
  "registry": 2,
  "count": 10,
  "startYear": 2018,
  "endYear": 2025,
  "source": "PubMed"
}
```

### 响应参数

**通用：**

| 字段 | 类型 | 说明 |
|------|------|------|
| total | long | 命中总数 |
| list | array | 结果列表 |

**registry=0 / 1（ChiCTR / ClinicalTrials.gov）list 单项：**

| 字段 | 类型 | 说明 |
|------|------|------|
| title | string | 试验标题 |
| registrationNo | string | 注册号 |
| status | string | 招募状态 |
| registrationDate | string | 注册日期 |
| phase | string | 试验阶段 |
| studyType | string | 研究类型 |
| sampleSize | string | 样本量 |
| conditions | array | 适应症/疾病 |
| primarySponsor | string | 主要申办方 |
| interventions | array | 干预措施 |
| url | string | 详情链接 |

**registry=2（Cochrane Central）list 单项：**

| 字段 | 类型 | 说明 |
|------|------|------|
| title | string | 标题 |
| year | string | 年份 |
| journal | string | 期刊 |
| url | string | 链接 |
| publicationType | string | 发表类型 |
| cochraneId | string | Cochrane ID |
| source | string[] | 数据来源 |
| keywords | string[] | 关键词 |

### 响应示例

**registry=0（ChiCTR）：**

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "total": 23,
    "list": [
      {
        "title": "司美格鲁肽治疗肥胖的随机对照试验",
        "registrationNo": "ChiCTR22000xxxxx",
        "status": "招募中",
        "registrationDate": "2023-06-15",
        "phase": "III期临床试验",
        "studyType": "干预性研究",
        "sampleSize": "300",
        "conditions": ["肥胖", "2型糖尿病"],
        "primarySponsor": "某某医院",
        "url": "https://www.chictr.org.cn/showproj.html?proj=xxxxx"
      }
    ]
  }
}
```

**registry=1（ClinicalTrials.gov）：**

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "total": 45,
    "list": [
      {
        "title": "A Study of Semaglutide in Adults With Obesity",
        "registrationNo": "NCT04184622",
        "status": "completed",
        "registrationDate": "2019-12-01",
        "phase": "Phase 3",
        "studyType": "Interventional",
        "sampleSize": "1961",
        "conditions": ["Obesity", "Overweight"],
        "interventions": ["Drug: Semaglutide"],
        "url": "https://www.clinicaltrials.gov/ct2/show/NCT04184622"
      }
    ]
  }
}
```

### curl 示例

```bash
curl -X POST '{host}api-evimed/medicine-api/ai-api/review/api/v2/clinical-trial' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer sk-your-secret-key' \
  -d '{
    "query": "semaglutide obesity",
    "registry": 1,
    "count": 10
  }'
```

---

## 错误响应示例

**密钥未传 / 无效：**

```json
{
  "code": 401,
  "msg": "当前api_key不存在"
}
```

**余额不足：**

```json
{
  "code": 403,
  "msg": "余额不足"
}
```

**参数错误：**

```json
{
  "code": 400,
  "msg": "检索关键词不能为空"
}
```

---
---

## 接口四：AI 综述生成

### 接口信息

| 项目 | 内容 |
|------|------|
| 请求地址 | `POST {host}api-evimed/medicine-api/ai-api/review/api/stream` |
| 功能 | 根据标题和大纲流式生成 AI 医学综述，实时返回正文内容及引用数据 |
| 响应格式 | SSE 流（每行为一个 JSON 对象） |

### 请求参数

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| title | string | 是 | — | 综述标题 |
| outline | string | 否 | — | 大纲；`status=2` 时必传 |
| startYear | string | 否 | `1900` | 证据检索起始年份 |
| endYear | string | 否 | `2025` | 证据检索截止年份 |
| zhJournal | string[] | 否 | — | 中文期刊等级筛选：`科技核心`、`北大核心`、`CSSCI`、`CSCD` |
| enJournal | string[] | 否 | — | 英文期刊等级筛选：`JCR (Q1)`、`JCR (Q2)`、`JCR (Q3)`、`JCR (Q4)`、`JCR (N/A)` |
| status | integer | 是 | — | `0` 自动生成大纲并直接生成正文；`1` 仅生成大纲；`2` 根据回传大纲生成正文 |

### 请求示例

```json
{
  "title": "阿司匹林",
  "status": 0
}
```

### curl 示例

```bash
curl -X POST '{host}api-evimed/medicine-api/ai-api/review/api/stream' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer sk-your-secret-key' \
  -d '{"title":"阿司匹林","status":0}'
```

---

### 响应格式（SSE 流）

每行返回一个 JSON 对象：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 搜索 ID |
| finished | boolean | 是否完成（`true` 表示流结束） |
| type | string | 固定为 `data` |
| outline | string | 大纲内容（`status=1` 时返回） |
| content | string | 正文增量内容 |
| quote | object | 本段引用数据，结构因 `quote_type` 而异 |

**`quote.quote_type` 可选值：** `文献`、`指南`、`说明书`、`临床试验`、`专利`

---

#### quote 子结构：文献

| 字段 | 类型 | 说明 |
|------|------|------|
| title | string | 文献标题 |
| summary | string | 摘要 |
| year | string | 发表年份 |
| author | string[] | 作者列表 |
| literatureTitle | string | 文献引用格式 |
| journal | string | 期刊名称 |
| partition | string[] | 期刊等级标签 |
| images | string[] | 文献相关图片 |
| url | object | 原文链接（sci_hub、Pubmed、谷歌学术、汉斯、Cochrane、CQVIP、知网、万方、CBM、embase、Semantic Scholar、evimed） |
| question | string | 文献问答对——问题 |
| answer | string | 文献问答对——答案 |
| block | string | 引用文献解析的文本块 |
| id | string | 文献 ID |
| belong | string[] | 数据来源 |

**示例：**

```json
{
  "quote_type": "文献",
  "title": "阿司匹林抵抗的真性红细胞增多症及原发性血小板增多症患者临床特征及凝血状态分析",
  "year": "2021",
  "author": ["王子卿", "胡晓梅"],
  "journal": "临床血液学杂志",
  "partition": ["科技核心"],
  "url": {
    "CNKI": "https://chkdx.cnki.net/kcms/detail/...",
    "evimed": "https://www.evimed.com/details?id=..."
  },
  "question": "阿司匹林抵抗的发生率及凝血功能特征有何特点？",
  "answer": "本研究分析了63例骨髓增殖性肿瘤患者……",
  "id": "2_277_623c458d72c7d58c0206ba6f"
}
```

---

#### quote 子结构：指南

| 字段 | 类型 | 说明 |
|------|------|------|
| title | string | 指南标题 |
| year | string | 发表年份 |
| fbdate | string | 指南发表时间 |
| language | string | 语言：`zh` / `en` |
| author | string[] | 作者 |
| zdz | string | 指南制定者 |
| keywords | string[] | 关键词 |
| cc | string | 指南来源出处 |
| url | string | 指南详情页链接（evimed 平台） |
| block | string | 引用的文本块 |
| nrjs | string | 指南简介 |
| id | string | 指南 ID |

---

#### quote 子结构：说明书

| 字段 | 类型 | 说明 |
|------|------|------|
| genericNames | string | 药品标准名称 |
| enterpriseName | string | 厂商名称 |
| indication | string | 适应症 |
| tradeNames | string | 商品名 |
| url | string | 说明书详情链接 |
| id | string | 说明书 ID |

**示例：**

```json
{
  "quote_type": "说明书",
  "genericNames": "阿司匹林片",
  "enterpriseName": "修正药业集团天汉药业有限公司",
  "indication": "用于普通感冒或流行性感冒引起的发热……",
  "url": "https://www.evimed.com/drug-details?source=nmpa&name=xxx.pdf",
  "id": "2c22805205d485ca6c64dee88a5930e7"
}
```

---

#### quote 子结构：临床试验

| 字段 | 类型 | 说明 |
|------|------|------|
| title | string | 临床试验标题 |
| belong | string | 来源：`chictr`、`ClinicalTrials` |
| studyType | string | 研究类型 |
| studyPhase | string | 研究阶段 |
| registerDate | string | 注册时间 |
| registerNo | string | 注册号 |
| url | string | 试验详情链接 |
| id | string | 试验 ID |

**示例：**

```json
{
  "quote_type": "临床试验",
  "title": "内源性黏膜保护剂对低剂量阿司匹林诱导的小肠黏膜损伤的作用",
  "belong": "chictr",
  "studyType": "干预性研究",
  "studyPhase": "其它",
  "registerDate": "2024-05-10",
  "registerNo": "ChiCTR2400084094",
  "url": "https://www.chictr.org.cn/showproj.html?proj=229987",
  "id": "67763170c3917d12a1d0a77e"
}
```

---

#### quote 子结构：专利

| 字段 | 类型 | 说明 |
|------|------|------|
| title | string | 专利标题 |
| patentAbstract | string | 专利摘要 |
| announcementDate | string | 专利通告时间 |
| designer | string[] | 专利设计人 |
| patentee | string | 专利所属单位 |
| url | string | 专利原文链接 |
| id | string | 专利 ID |

**示例：**

```json
{
  "quote_type": "专利",
  "title": "一种治疗心血管疾病的缓释片及其制备方法",
  "patentAbstract": "本发明公开了一种阿司匹林双嘧达莫缓释片……",
  "announcementDate": "2012-12-26",
  "designer": ["詹辉", "马志平", "解静萍", "任武贤"],
  "patentee": "北京亚宝生物药业有限公司",
  "url": "https://d.wanfangdata.com.cn/patent/...",
  "id": "673cf8a74e2c8fb69b59de99"
}
```

---

### 完整响应示例

```json
{
  "id": "123456",
  "finished": false,
  "type": "data",
  "content": "阿司匹林作为经典抗血小板药物……）[28] |",
  "quote": {
    "quote_type": "临床试验",
    "belong": "chictr",
    "studyType": "干预性研究",
    "studyPhase": "上市后药物",
    "id": "67762f51c3917d12a1cfa227",
    "title": "PCI1年后阿司匹林联合不同剂量氯吡格雷与单纯阿司匹林治疗疗效和安全性对比观察",
    "url": "https://www.chictr.org.cn/showproj.html?proj=8290",
    "registerDate": "2011-01-09",
    "registerNo": "ChiCTR-TRC-11001249"
  }
}
```

流结束时：

```json
{
  "id": "123456",
  "finished": true,
  "type": "data",
  "content": ""
}
```

### 错误响应

| 状态码 | 说明 |
|--------|------|
| 400 | 请求异常 |
| 401 | 当前 api_key 不存在 |
| 403 | 余额不足 |
| 404 | 请求的资源未找到 |
| 429 | 请求频率过高（Too Many Requests） |
| 500 | 服务端异常 |

---

## 接口五：AI 科研选题

### 接口信息

| 项目 | 内容 |
|------|------|
| 请求地址 | `POST {host}api-evimed/medicine-api/ai-api/api/scientific-research/stream` |
| 功能 | 根据选题标题流式生成科研选题分析内容 |
| 响应格式 | SSE 流（每行为一个 JSON 对象） |

### 请求参数

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| type | string | 是 | 综合接口请求类型，固定传 `科研选题` |
| data | object | 是 | 科研选题请求参数，见下表 |

**data 对象：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | string | 是 | 科研选题标题 |
| status | integer | 是 | 生成状态（参考接口四 status 参数含义） |

### 请求示例



### curl 示例



### 错误响应

| 状态码 | 说明 |
|--------|------|
| 400 | 请求异常 |
| 401 | 当前 api_key 不存在 |
| 403 | 余额不足 |
| 404 | 请求的资源未找到 |
| 429 | 请求频率过高（Too Many Requests） |
| 500 | 服务端异常 |

---

## 接口六：AI 搜索

### 接口信息

| 项目 | 内容 |
|------|------|
| 请求地址 | `POST {host}api-evimed/medicine-api/questions/api/stream` |
| 功能 | 根据检索词流式返回 AI 搜索结果及引用数据，支持多轮对话与深度思考模式 |
| 响应格式 | SSE 流（每行为一个 JSON 对象） |

### 请求参数

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query | string | 是 | 检索条件 |
| flag | boolean | 是 | 是否开启深度思考：`true` / `false` |
| id | string | 否 | 多轮问答时传入上一轮返回的 `id` 以维持对话上下文 |

### 请求示例

```json
{
  "id": "123456",
  "flag": true,
  "query": "阿司匹林"
}
```

### 响应格式（SSE 流）

每行返回一个 JSON 对象：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 本轮搜索 ID（多轮对话时回传） |
| finished | boolean | 是否完成（`true` 表示流结束） |
| type | string | 固定为 `data` |
| content | string | 正文增量内容 |
| analysing_content | string | 数据分析增量内容 |
| reasoning_content | string | 深度思考思维链增量内容（`flag=true` 时返回） |
| quote | object | 本段引用数据，按 `quote_type` 区分：`文献`、`指南`、`说明书`、`临床试验`、`专利` |

> quote 各子类型的字段定义与示例详见 **接口四 — quote 子结构** 部分。

### 完整响应示例

```json
{
  "id": "123456",
  "finished": false,
  "type": "data",
  "content": "）[28] |",
  "analysing_content": "",
  "reasoning_content": "",
  "quote": {
    "quote_type": "临床试验",
    "belong": "chictr",
    "studyType": "干预性研究",
    "studyPhase": "上市后药物",
    "id": "67762f51c3917d12a1cfa227",
    "title": "PCI1年后阿司匹林联合不同剂量氯吡格雷与单纯阿司匹林治疗疗效和安全性对比观察",
    "url": "https://www.chictr.org.cn/showproj.html?proj=8290",
    "registerDate": "2011-01-09",
    "registerNo": "ChiCTR-TRC-11001249"
  }
}
```

流结束时：

```json
{
  "id": "123456",
  "finished": true,
  "type": "data",
  "content": ""
}
```

### curl 示例

```bash
curl -X POST '{host}api-evimed/medicine-api/questions/api/stream' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer sk-your-secret-key' \
  -d '{
    "id": "123456",
    "flag": true,
    "query": "阿司匹林"
  }'
```

### 错误响应

| 状态码 | 说明 |
|--------|------|
| 400 | 请求异常 |
| 401 | 当前 api_key 不存在 |
| 403 | 余额不足 |
| 404 | 请求的资源未找到 |
| 429 | 请求频率过高（Too Many Requests） |
| 500 | 服务端异常 |
---

## 接口七：AI 研究方案

### 接口信息

| 项目 | 内容 |
|------|------|
| 请求地址 | `POST {host}api-evimed/medicine-api/generate/api/stream` |
| 功能 | 根据研究标题流式生成 AI 研究方案内容及引用数据，支持多轮对话与深度思考模式 |
| 响应格式 | SSE 流（每行为一个 JSON 对象） |

### 请求参数

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | string | 是 | 研究方案标题 |
| flag | boolean | 是 | 是否开启深度思考：`true` / `false` |
| id | string | 否 | 多轮问答时传入上一轮返回的 `id` 以维持对话上下文 |

### 请求示例

```json
{
  "flag": true,
  "title": "阿司匹林"
}
```

多轮对话：

```json
{
  "id": "123456",
  "flag": false,
  "title": "阿司匹林"
}
```

### curl 示例

```bash
curl -X POST '{host}api-evimed/medicine-api/generate/api/stream' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer sk-your-secret-key' \
  -d '{"flag":true,"title":"阿司匹林"}'
```

---

### 响应格式（SSE 流）

每行返回一个 JSON 对象：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 本轮搜索 ID（多轮对话时回传） |
| finished | boolean | 是否完成（`true` 表示流结束） |
| type | string | 固定为 `data` |
| content | string | 正文增量内容 |
| analysing_content | string | 数据分析增量内容 |
| reasoning_content | string | 深度思考思维链增量内容（`flag=true` 时返回） |
| quote | object | 本段引用数据，按 `quote_type` 区分：`文献`、`指南`、`说明书`、`临床试验`、`专利` |

> quote 各子类型的字段定义与示例详见 **接口四 — quote 子结构** 部分。

### 完整响应示例

```json
{
  "id": "123456",
  "finished": false,
  "type": "data",
  "content": "）[28] |",
  "analysing_content": "",
  "reasoning_content": "",
  "quote": {
    "quote_type": "临床试验",
    "belong": "chictr",
    "studyType": "干预性研究",
    "studyPhase": "上市后药物",
    "id": "67762f51c3917d12a1cfa227",
    "title": "PCI1年后阿司匹林联合不同剂量氯吡格雷与单纯阿司匹林治疗疗效和安全性对比观察",
    "url": "https://www.chictr.org.cn/showproj.html?proj=8290",
    "registerDate": "2011-01-09",
    "registerNo": "ChiCTR-TRC-11001249"
  }
}
```

流结束时：

```json
{
  "id": "123456",
  "finished": true,
  "type": "data",
  "content": ""
}
```

### 错误响应

| 状态码 | 说明 |
|--------|------|
| 400 | 请求异常 |
| 401 | 当前 api_key 不存在 |
| 403 | 余额不足 |
| 404 | 请求的资源未找到 |
| 429 | 请求频率过高（Too Many Requests） |
| 500 | 服务端异常 |
