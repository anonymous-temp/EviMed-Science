# 医学 SCI 论文自动审稿系统

> Medical SCI Paper Automated Review System

基于 **Plan-Retrieve-Argue** 架构的 AI 驱动医学论文自动预审系统，遵循国际报告指南（CONSORT, PRISMA, STROBE 等）。

## 核心特性

- **Plan-Retrieve-Argue 架构**: 三层智能审稿流程，确保判断有据可依
- **Evidence Gate 机制**: FAIL 判定必须有证据支持，降低误判率
- **Coverage Meter**: 自动追踪文档解析覆盖率
- **11 种国际权威 Checklist**: 覆盖 99%+ 医学研究类型
- **高并发低延迟**: 单篇论文审稿 < 3 分钟

## 快速开始

### 1. 安装依赖

```bash
git clone https://github.com/your-repo/Paper-Reading.git
cd Paper-Reading
pip install -r requirements.txt

# 可选：安装 Marker 获得更好的 PDF 解析质量
pip install marker-pdf
```

### 2. 配置 API

```bash
# 使用 DeepSeek API（默认）
export DEEPSEEK_API_KEY="your-api-key"
export DEEPSEEK_FLASH_MODEL="deepseek-v4-flash"
export DEEPSEEK_PRO_MODEL="deepseek-v4-pro"
```

### 3. 运行审稿

```bash
# 命令行方式
python -m src.main /path/to/manuscript.pdf

# Python 脚本
python
>>> from src.main import ReviewOrchestrator
>>> import asyncio
>>>
>>> orchestrator = ReviewOrchestrator(use_pra_architecture=True)
>>> state, author_report, editor_report = asyncio.run(
...     orchestrator.review_manuscript("paper.pdf")
... )
```

### 4. 查看结果

报告保存在 `review_output/` 目录：
- `{job_id}_author_report.md` - 面向作者的修改建议
- `{job_id}_editor_report.md` - 面向编辑的决策建议

## 系统架构

### Plan-Retrieve-Argue 三层架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    Stage 1: Parse                               │
│              文档解析 + Marker 高质量提取                          │
└──────────────────────────┬──────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│                    Stage 2: Analyze                             │
│         结构化 IR 生成 + Coverage Meter 覆盖率追踪                 │
└──────────────────────────┬──────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│                    Stage 3: Guard                               │
│              安全检查 + 伦理合规验证                               │
└──────────────────────────┬──────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│               Stage 4: Plan (NEW)                               │
│     Review Planner 生成审稿策略，识别 3-6 个高风险领域              │
└──────────────────────────┬──────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│              Stage 5: Retrieve (NEW)                            │
│     Material Engine 收集中性证据，不做主观判断                      │
└──────────────────────────┬──────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│                    Stage 6: Review                              │
│          并发执行方法学 + 统计学 + 认知审稿                         │
└──────────────────────────┬──────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│               Stage 7: Argue (Enhanced)                         │
│     Editor Synthesizer + Evidence Gate 生成最终报告               │
└──────────────────────────┬──────────────────────────────────────┘
                           ↓
            ┌──────────────┴──────────────┐
            ↓                             ↓
┌──────────────────────┐      ┌──────────────────────┐
│    Author Report     │      │    Editor Report     │
│   (详细修改建议)       │      │   (送审决策建议)       │
└──────────────────────┘      └──────────────────────┘
```

### 关键创新点

1. **Review Planner**: 根据研究类型智能规划审稿重点
2. **Material Engine**: 中性证据收集，分离事实与判断
3. **Evidence Gate**: 确保 FAIL 判定有 NOT_FOUND 证据支持
4. **Coverage Meter**: 追踪文档解析覆盖率，未覆盖区域降级为 UNCERTAIN

## 项目结构

```
Paper-Reading/
├── src/
│   ├── agents/                    # Agent 模块
│   │   ├── review_planner.py      # [NEW] 审稿规划器
│   │   ├── methodology_reviewer.py # [Enhanced] 素材引擎 + 方法学审稿
│   │   ├── document_analyzer.py   # [Enhanced] 文档分析 + Coverage Meter
│   │   ├── editor_synthesizer.py  # [Enhanced] 报告合成 + Evidence Gate
│   │   ├── cognitive_reviewer.py  # 认知审稿
│   │   ├── statistician_reviewer.py # 统计学审稿
│   │   ├── integrity_guard.py     # 安全与伦理检查
│   │   └── rubric_orchestrator.py # Rubric 编排
│   │
│   ├── schemas/                   # 数据模型
│   │   ├── plan_retrieve_argue.py # [NEW] PRA 架构数据结构
│   │   ├── document_ir.py         # 文档 IR
│   │   ├── rubric.py              # Rubric 相关
│   │   ├── review_state.py        # 审稿状态
│   │   ├── reports.py             # 报告模型
│   │   └── cognitive_review.py    # 认知审稿结果
│   │
│   ├── services/                  # 核心服务
│   │   ├── document_parser.py     # [Enhanced] Marker + pypdf 解析
│   │   ├── severity_calibrator.py # [NEW] 严重性标定服务
│   │   ├── llm_gateway.py         # LLM 统一接口
│   │   ├── evidence_retriever.py  # 三阶段证据检索
│   │   └── ocr_parser.py          # OCR 解析
│   │
│   ├── rubrics/                   # 11 种 Checklist
│   │   ├── consort_2010.yaml      # RCT
│   │   ├── prisma_2020.yaml       # 系统综述/Meta分析
│   │   ├── strobe.yaml            # 观察性研究
│   │   ├── tripod_ai.yaml         # AI/ML 预测模型
│   │   └── ...                    # 更多 Checklist
│   │
│   ├── api/                       # REST API
│   │   └── main.py                # FastAPI 应用
│   │
│   ├── utils/                     # 工具模块
│   │   └── rubric_loader.py       # Rubric 加载器
│   │
│   └── main.py                    # [Enhanced] 主入口 + PRA 流程
│
├── tests/                         # 测试
├── requirements.txt               # 依赖
└── README.md
```

## 支持的研究类型与 Checklist

| 研究类型 | Checklist | 评估项 |
|---------|-----------|-------|
| RCT (随机对照试验) | CONSORT 2010 | 25 |
| 系统综述/Meta分析 | PRISMA 2020 | 25 |
| 观察性研究 | STROBE | 33 |
| AI/ML 预测模型 | TRIPOD-AI | 25 |
| 诊断准确性研究 | STARD 2015 | 27 |
| 病例报告 | CARE 2013 | 28 |
| 动物实验 | ARRIVE 2.0 | 20 |
| 定性研究 | COREQ | 32 |
| 卫生经济学评价 | CHEERS 2022 | 26 |
| 临床指南 | GRADE | 24 |
| 未映射类型 | Universal Rubric | 21 |

**总计**: 11 个 Checklist，286 评估项

## API 服务

### 启动服务

```bash
uvicorn src.api.main:app --host 0.0.0.0 --port 8000
```

### API 端点

| 方法 | 端点 | 描述 |
|-----|------|------|
| GET | `/health` | 健康检查 |
| POST | `/api/v1/review/submit` | 提交审稿任务 |
| GET | `/api/v1/review/{job_id}/status` | 查询任务状态 |
| GET | `/api/v1/review/{job_id}/report/author` | 获取作者报告 |
| GET | `/api/v1/review/{job_id}/report/editor` | 获取编辑报告 |
| GET | `/metrics` | Prometheus 监控指标 |

### 使用示例

```python
import requests

# 提交审稿
with open('manuscript.pdf', 'rb') as f:
    response = requests.post(
        'http://localhost:8000/api/v1/review/submit',
        files={'file': f}
    )
job_id = response.json()['job_id']

# 查询状态
status = requests.get(f'http://localhost:8000/api/v1/review/{job_id}/status')
print(status.json())

# 获取报告
report = requests.get(f'http://localhost:8000/api/v1/review/{job_id}/report/author')
print(report.json()['content'])
```

## 配置选项

### ReviewOrchestrator 参数

```python
orchestrator = ReviewOrchestrator(
    llm_api_key="your-key",           # LLM API 密钥
    llm_provider="deepseek",          # LLM 提供商
    rubrics_dir=None,                 # 自定义 Rubric 目录
    use_pra_architecture=True         # 启用 Plan-Retrieve-Argue 架构
)
```

### 环境变量

| 变量 | 描述 | 默认值 |
|-----|------|-------|
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥 | - |
| `DEEPSEEK_FLASH_MODEL` | 轻量任务模型 | deepseek-v4-flash |
| `DEEPSEEK_PRO_MODEL` | 复杂评审模型 | deepseek-v4-pro |
| `LOG_LEVEL` | 日志级别 | INFO |

## 性能指标

| 指标 | 目标值 |
|-----|-------|
| 端到端延迟 (8000词论文) | < 3 分钟 |
| 结构化信息提取准确率 | > 95% |
| 研究类型识别准确率 | > 98% |
| LLM 调用次数 | ~17 次 |

## 开发

### 运行测试

```bash
pytest tests/ -v
pytest tests/ --cov=src --cov-report=html
```

### 添加新 Checklist

1. 在 `src/rubrics/` 创建 YAML 文件
2. 在 `RubricLoader` 添加研究类型映射

```yaml
# src/rubrics/new_checklist.yaml
name: New Checklist
version: "1.0"
applicable_to:
  - Study Type

items:
  - item_id: NEW_1
    item_number: "1"
    question: "评估问题"
    evaluation_criteria: "评估标准"
    evidence_location_hint: "methods.section"
    severity_if_missing: MAJOR
```

## 许可证

MIT License

## 贡献

欢迎提交 Issue 和 Pull Request。

---

**免责声明**: 本系统为辅助工具，所有判断仅供参考，不替代人类专家的专业审稿。最终的稿件质量评估和发表决策应由合格的同行评议专家做出。
