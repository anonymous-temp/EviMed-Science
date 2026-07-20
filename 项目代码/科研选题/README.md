# 科研选题智能分析Agent系统 V5.1

## 系统概述

科研选题智能分析Agent系统是一个基于**大语言模型(LLM)**和**PubMed文献数据**的科研知识生态结构诊断与研究战略生成系统。

系统将任意形式的科研输入转化为结构化分析报告，包含六大核心分析模块：
- **M1 问题全景** — 领域发展脉络、核心瓶颈与系统性局限
- **M2 研究生态系统** — 发表平台分层、技术路线图、关键研究力量
- **M3 证据体系** — 关键矛盾、证据空白与未解决的核心问题
- **M4 科学矛盾** — 正在撕裂领域的核心争论与对立观点
- **M5 突破性机会** — 被忽视的研究空白与跨领域创新方向
- **M6 研究议程** — 按优先级排序的具体研究问题与设计建议

输出结构化、学术级中文科研分析报告，附带真实PMID引用和Vancouver格式参考文献。

---

## 核心特性

- **开放式输入**：接受任意形式的自然语言输入，无需预设模板
- **输入安全校验**：空输入/过短/非医学/Prompt注入自动拦截
- **智能标准化**：LLM驱动的实体识别、PICO构建、查询词扩展
- **多源检索**：PubMed NCBI E-utilities + Elasticsearch 并行检索
- **搜索诊断**：分级降级策略（0篇拒绝/1-4篇警告/5-19篇部分/20+完整分析）
- **分阶段架构**：检索与规划 → 六模块逐步分析 → 章节化报告生成
- **安全JSON解析**：5层容错策略处理LLM输出
- **中文报告输出**：生成结构化、学术级中文分析报告
- **DeepSeek V4 双模型路由**：轻量任务使用 Flash，复杂分析和报告使用 Pro
- **可视化图表**：自动生成文献计量学图表
- **结构化日志**：全链路logging替代print，支持日志级别配置

---

## 技术架构

```
输入 → 安全校验 → 标准化(LLM) → 多源检索(PubMed+ES) → 搜索诊断 → 分析规划 → M1-M6逐步执行 → 章节化报告生成
```

### 核心组件

| 组件 | 说明 |
|------|------|
| 输入校验 | 空输入/过短/Prompt注入/非医学内容拦截 |
| 输入标准化 | LLM驱动的实体抽取、PICO构建、同义词扩展、领域检测 |
| 多源检索 | PubMed NCBI E-utilities + Elasticsearch 并行检索 |
| 搜索诊断 | 基于检索结果数量的分级降级策略 |
| 分析引擎 | M1-M6 六大模块逐步执行 |
| 报告生成器 | 素材收集→大纲→引文池→逐章生成→Vancouver参考文献 |
| 图表生成 | Matplotlib可视化图表 |

---

## 快速开始

### 1. 安装依赖

```bash
# 创建虚拟环境
python -m venv venv
source venv/bin/activate  # Linux/Mac
# 或: venv\Scripts\activate  # Windows

# 安装依赖
pip install -r requirements.txt
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑.env文件，配置以下关键参数
```

**必需配置**：
```env
# DeepSeek V4 双模型配置
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=your_deepseek_api_key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_FLASH_MODEL=deepseek-v4-flash
DEEPSEEK_PRO_MODEL=deepseek-v4-pro
```

**可选配置**（不使用时保持默认即可）：
```env
# 数据库
MONGODB_URL=mongodb://localhost:27017
REDIS_URL=redis://localhost:6379/0

# Elasticsearch
ES_HOST=localhost
ES_PORT=9200
```

### 3. 启动服务

```bash
# 开发模式
python3 start.py --reload

# 生产模式
python start.py
```

---

## API接口

### 提交分析任务

```bash
curl -X POST http://localhost:8000/api/v1/analysis/submit \
  -H "Content-Type: application/json" \
  -d '{"input_text": "利妥昔单抗治疗肾病综合征"}'
```

响应：
```json
{
  "status": "accepted",
  "task_id": "TASK_20260208_XXXXXX",
  "message": "任务已提交，正在处理中。",
  "estimated_completion_time_seconds": 180
}
```

### 查询任务状态

```bash
curl http://localhost:8000/api/v1/analysis/status/{task_id}
```

### 获取分析报告

```bash
curl http://localhost:8000/api/v1/analysis/report/{task_id}
```

### 快速分析（同步）

```bash
curl -X POST http://localhost:8000/api/v1/analysis/quick \
  -H "Content-Type: application/json" \
  -d '{"input_text": "利妥昔单抗治疗肾病综合征"}'
```

---

## Docker部署

### 1. 构建并启动

```bash
# 构建并启动所有服务
docker-compose up -d

# 查看日志
docker-compose logs -f api
```

### 2. 仅启动核心服务（无需MongoDB/Redis）

```bash
# 修改docker-compose.yml注释掉不需要的服务
docker-compose up -d api
```

---

## 配置说明

### 环境变量

| 变量 | 说明 | 必需 |
|------|------|------|
| `DEEPSEEK_API_KEY` | DeepSeek API密钥 | ✅ |
| `DEEPSEEK_BASE_URL` | DeepSeek API基础URL | ✅ |
| `DEEPSEEK_FLASH_MODEL` | 轻量任务模型 | ✅ |
| `DEEPSEEK_PRO_MODEL` | 复杂分析与报告模型 | ✅ |
| `NCBI_API_KEY` | PubMed NCBI API Key（提升频率限制到10次/秒） | ❌ |
| `ALLOWED_ORIGINS` | CORS允许的前端域名列表 | ❌ |
| `LOG_LEVEL` | 日志级别（DEBUG/INFO/WARNING/ERROR） | ❌ |
| `MONGODB_URL` | MongoDB连接URL | ❌ |
| `REDIS_URL` | Redis连接URL | ❌ |
| `ES_HOST` | Elasticsearch主机 | ❌ |

### LLM模型配置

通过 DeepSeek 的 OpenAI 兼容接口调用两个模型层级：

- `deepseek-v4-flash`：意图识别、查询结构化、闲聊等轻量任务
- `deepseek-v4-pro`：M1-M6 深度分析、报告生成和报告追问

---

## 项目结构

```
research_topic_agent/
├── app/                      # FastAPI应用
│   ├── main.py              # API路由（含输入校验、CORS、速率限制）
│   ├── celery_app.py        # Celery配置
│   └── tasks.py             # 异步任务
├── config/                   # 配置
│   ├── settings.py          # 系统配置（Pydantic Settings，环境变量驱动）
│   └── prompts.py           # Prompt配置（通用化，无硬编码领域）
├── core/                     # 核心逻辑
│   ├── input_processor.py   # 输入校验与意图识别
│   ├── conversation.py      # 对话管理
│   ├── new_planner.py       # 任务规划器
│   ├── new_analysis_engine.py # 分析引擎
│   └── new_report_generator.py # 报告生成器（管线式架构）
├── modules/                  # 分析模块
│   └── new_analysis_modules.py # M1-M6 六大分析模块
├── models/                   # 数据模型
│   └── schemas.py           # Pydantic模型（含SearchDiagnostics）
├── services/                 # 服务层
│   ├── llm_service.py       # LLM服务（含安全JSON解析）
│   ├── pubmed_service.py    # PubMed检索（并发控制+NCBI API Key）
│   ├── search_service.py    # 检索服务
│   └── task_service.py      # 任务服务（UUID任务ID+搜索诊断）
├── utils/                    # 工具函数
│   └── __init__.py          # safe_parse_json 等
├── deploy/                   # 部署配置
│   └── k8s-deployment.yaml  # Kubernetes配置
├── charts/                   # 生成的图表目录
├── requirements.txt          # 依赖
├── Dockerfile               # Docker镜像
├── docker-compose.yml       # Docker编排
├── start.py                 # 启动脚本
├── .env.example             # 环境变量模板
├── .gitignore               # Git忽略规则
└── README.md                # 说明文档
```

---

## 示例分析结果

### 输入
```
利妥昔单抗治疗肾病综合征
```

### 输出报告结构
```
# 科研选题深度分析报告

## 一、执行摘要
- 核心趋势与关键发现

## 二、问题全景
- 领域核心瓶颈与系统性局限

## 三、研究生态系统
- 发表平台分层、技术路线图、关键研究力量

## 四、科学矛盾
- 正在撕裂领域的核心争论

## 五、突破性机会
- 被忽视的研究空白与跨领域创新

## 六、推荐研究议程
- 按优先级排序的具体研究问题（含设计建议）

## 七、结论 + 参考文献（Vancouver格式，含真实PMID）
```

---

## 许可证

MIT License

---

## 版本历史

- **V5.1** (2026-02-21): 生产加固——输入安全校验、搜索诊断分级降级、安全JSON解析、UUID任务ID、CORS/速率限制、全链路logging、报告生成管线重构
- **V5.0** (2026-02-08): 重构为分阶段架构，新增可视化图表，优化LLM查询生成流程
- **V4.0** (2026-02): 6大核心模块架构
- **V3.0** (2026-02): 初始版本，10模块架构
