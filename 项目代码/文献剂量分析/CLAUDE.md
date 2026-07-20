# AI驱动文献计量分析系统

## 项目概述
CLI工具：PubMed检索 → 元数据清洗 → 网络分析 → CiteSpace复现 → 洞察生成 → 报告撰写

## 关键路径
- `src/bibliometric/cli.py` - CLI入口 (click框架)
- `src/bibliometric/pipeline.py` - 分析管线编排
- `src/bibliometric/config.py` - 配置管理 (deploy.env / .env)

## 模块结构
- `pubmed/` - PubMed数据获取 (connector, parser, search_strategy)
- `cleaning/` - 元数据清洗与消歧 (normalizer, dedup, ror_lookup)
- `analysis/` - 分析引擎 (statistics, matrix_builder, network_analyzer, burst_detector, timeline_engine, frontier_detector, cluster_labeler, citation_simulator, bib_laws)
- `export/` - VOSviewer兼容输出 (vosviewer)
- `visualization/` - 图表生成 (trend_charts, network_charts)
- `insight/` - 洞察挖掘与AI叙事 (miner, ai_narrator, templates)
- `report/` - Markdown报告生成 (generator, results_sections)

## 运行方式
```bash
cd /Users/wangzeyuan/Desktop/文献计量分析
source venv/bin/activate
PYTHONPATH=src python3 -m bibliometric analyze "topic" --date-range 2018-2025 --max-records 2000
```

## CLI参数
- `topic` (必填) - 研究主题
- `--date-range / -d` - 日期范围 YYYY-YYYY
- `--max-records / -n` - 最大检索量 (默认 2000)
- `--output-dir / -o` - 输出目录
- `--modules / -m` - 模块选择 (trend,network,burst,timeline,frontier,insight,report)
- `--api-key` - NCBI API key (覆盖 .env)
- `--email` - NCBI email (覆盖 .env)
- `--verbose / -v` - 调试日志

## Claude Code Skills
- `/bibliometric` - 运行完整文献计量分析管线
- 用法: `/bibliometric "semaglutide obesity" -d 2018-2025 -n 2000`

## 代码规范
- 单文件 ≤ 800行, 单函数 ≤ 30行, 嵌套 ≤ 3层
- 每个文件头部写 [IN]/[OUT]/[POS] 注释
