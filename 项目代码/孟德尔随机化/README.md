# Mendelian Randomization Service

Python 服务默认使用 DeepSeek V4 的两档模型路由：意图、翻译和实体提取使用 Flash，科研推理、结果解读和报告生成使用 Pro。

## 本地配置

直接在项目原有的 `.env` 中配置：

```dotenv
DEEPSEEK_API_KEY=your_key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_FLASH_MODEL=deepseek-v4-flash
DEEPSEEK_PRO_MODEL=deepseek-v4-pro
```

Keep `.env` local and untracked. Commit only `.env.example`; each deployment
must inject its own credentials.

## 启动与验证

```bash
python start.py
curl http://127.0.0.1:8003/health
python -m pytest tests/test_deepseek_routing.py -q
python -m compileall mr_agent start.py
```

## Local summary-statistics analysis

`mr_agent.tools.mr_executor.run_mr_local` accepts paired `DataSource` objects.
Local exposure files use OpenGWAS LD clumping by default. A failed clumping
request stops analysis; it never silently substitutes unselected instruments.

For an already selected instrument set, set `instruments_preclumped=True` and
provide `clumping_provenance` identifying the source and its selection method.
This is a declared input property, not independent LD verification. The engine
records it in `instrument-selection.json` and the report states that LD was not
rechecked. Two local files in this mode require no OpenGWAS API request. The
hosted runner's current text-only request contract is a separate integration
boundary and does not yet expose these local-file fields.

MR-PRESSO permutation bounds are represented by `presso_global_pval` together
with `presso_global_pval_relation` (`=` or `<`); consumers must preserve that
relation instead of rendering an upper bound as an exact p-value. Radial MR
reports the heterogeneity Q-test probability and the number of outlier rows,
not the causal-effect probability or the number of data-frame columns.
