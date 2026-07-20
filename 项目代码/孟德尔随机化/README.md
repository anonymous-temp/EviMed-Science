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
